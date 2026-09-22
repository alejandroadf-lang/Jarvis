// The speech-to-speech model on the other end of the call.
//
// Not the same shape as anything else in this app. Every other model call here
// is request/response: send a prompt, wait, get an answer. This one is a
// WebSocket that stays open for the length of the call, with audio going both
// ways continuously and events arriving unprompted — the caller starting to
// speak, the model deciding it has finished, a tool call mid-sentence.
//
// Audio never gets decoded here. Twilio sends G.711 μ-law at 8kHz and the
// Realtime API accepts exactly that format, so the bytes are relayed base64
// in both directions untouched. Transcoding would add latency to the one path
// where latency is the entire product.
//
// Model and voice are env-overridable like every other OpenAI name in this
// app (see agents/openai.js for why: OpenAI renames and retires models faster
// than this file gets edited, and a stale default should be a Railway
// variable, not a redeploy).
//
// This speaks the GA Realtime interface, not the beta one, and the difference
// was found on the first live phone call: OpenAI answered "The Realtime Beta
// API is no longer supported" and the call ended after one second. The beta
// header, the flat session fields (`input_audio_format`, `voice`,
// `turn_detection` at the top level) and the `response.audio.*` event names
// are all gone. GA nests audio under `session.audio.input` / `.output`, names
// the μ-law format `audio/pcmu`, and emits `response.output_audio.delta`.
// The test harness sends the GA names too, on purpose: a fake that still
// emits beta events would keep every test green while every real call died.

import { WebSocket } from 'ws';
import { readSecret } from '../env.js';

// Overridable for the same reason the model name is, plus one more: without
// it nothing can stand a fake endpoint in front of this, and the bridge's
// interruption and delivery behaviour is only observable against a real
// socket. An unreachable default would be a bug nobody could write a test for.
function realtimeUrl() {
  return (process.env.OPENAI_REALTIME_URL || '').trim() || 'wss://api.openai.com/v1/realtime';
}

export function realtimeModel() {
  return (process.env.OPENAI_REALTIME_MODEL || '').trim() || 'gpt-realtime';
}

export function realtimeVoice() {
  return (process.env.OPENAI_REALTIME_VOICE || '').trim() || 'marin';
}

// --- Noise ------------------------------------------------------------------------
//
// The founder's second finding from the first live call: "noise is also
// impacting a lot the conversation". On a phone line that shows up three
// ways, and each has its own knob below. Background noise is heard as the
// caller starting to speak, so the desk stops mid-sentence (barge-in); the
// noise then counts as a turn, so the desk answers nothing (turn detection);
// and what the model does hear is muddier (noise reduction).

// How sure the detector must be that it is hearing speech, 0–1.
//
// 0.5 is the API default and was tuned for a microphone near a mouth in a
// quiet room. A phone line is eight-kilohertz μ-law with the street, the
// café and the handset's own hiss on it, so the bar is higher here. Fixed
// rather than a Railway variable at the founder's request, so a call can be
// tested with nothing to set; raise it here if background noise is still
// taken for the caller, lower it if quiet callers are not heard.
export const VAD_THRESHOLD = 0.6;

// The API's own noise reduction on the caller's audio, before detection and
// before the model. near_field is for a microphone close to the mouth — a
// handset is one; far_field is for a laptop across a table. Fixed for the
// same reason as the threshold. If a caller sounds clipped, this is the line
// to change.
export const NOISE_REDUCTION = 'near_field';

/**
 * How long the caller has to keep talking before the desk is cut off.
 *
 * Every burst of noise arrives as speech_started. Cutting the model off on
 * each one is what makes a noisy call sound like a desk that cannot finish a
 * sentence. So the model is told NOT to interrupt itself on speech_started
 * (`interrupt_response: false`), and this file interrupts it instead — once
 * the caller has been speaking for this long. A real interruption is barely
 * later than before; a blip never interrupts at all, because speech_stopped
 * arrives first and cancels the timer.
 */
export const BARGE_IN_MS = 250;

/** The tool the voice uses to reach the actual company. */
export const ASK_THE_TEAM = {
  type: 'function',
  name: 'ask_the_team',
  description:
    'Put a question to the company — the CEO and their org. Use this for anything needing judgment, ' +
    'research, a decision, or an action in the world. Returns immediately; the answer arrives later in ' +
    'the call. Do not use it for anything already in COMPANY STATE, which you can answer yourself.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'The question, written as the founder would put it in writing. Include the context from the ' +
          'call that the team needs — they cannot hear it.',
      },
      say_while_waiting: {
        type: 'string',
        description:
          'One short natural sentence to say out loud immediately, in the language of the call. ' +
          'Example: "Let me put that to them."',
      },
    },
    required: ['question', 'say_while_waiting'],
  },
};

/**
 * Opens the realtime session.
 *
 * Returns a handle rather than an event emitter: the Twilio bridge needs a
 * small, named surface (send audio, cut the model off, hand back a tool
 * result) and giving it the raw socket invites the bridge to grow protocol
 * knowledge it should not have.
 *
 * @param {object} opts
 * @param {string} opts.instructions - the standing brief for the call
 * @param {string} opts.greeting - what to say first
 * @param {(audioBase64: string) => void} opts.onAudio - μ-law bytes to play
 * @param {() => void} opts.onSpeechStarted - the caller began talking
 * @param {(call: {id: string, name: string, args: object}) => void} opts.onToolCall
 * @param {(text: string) => void} opts.onTranscript - what was said, for the log
 * @param {(turn: {ms: number, what: string}) => void} [opts.onLatency] - how long
 *   the caller waited for the model's first sound, per turn. "greeting" is
 *   measured from the socket opening; every other turn from the moment the
 *   model decided the caller had stopped speaking. The founder's "there is a
 *   lot of latency" is unanswerable without this: the log showed the call
 *   connecting and ending and nothing in between.
 * @param {(err: Error) => void} opts.onError
 * @param {() => void} opts.onClose
 */
export function openRealtimeSession({
  instructions,
  greeting,
  // Which tools the model may call. The founder's line gets ask_the_team; a
  // public support line gets lookup_issue and open_ticket and never
  // ask_the_team, which would let any caller make this company do work.
  tools = [ASK_THE_TEAM],
  onAudio = () => {},
  onSpeechStarted = () => {},
  onToolCall = () => {},
  onTranscript = () => {},
  onLatency = () => {},
  onError = () => {},
  onClose = () => {},
}) {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set, so the company cannot take calls.');

  // No `OpenAI-Beta: realtime=v1` header: sending it selects the retired beta
  // interface, and OpenAI closes the socket with an error instead of talking.
  const socket = new WebSocket(`${realtimeUrl()}?model=${encodeURIComponent(realtimeModel())}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  let open = false;
  const queued = [];
  const openedAt = Date.now();
  // Pending barge-in: set on speech_started, cleared by speech_stopped if
  // the "speech" ended before it counted as one.
  let bargeIn = null;
  // Whether the model is mid-reply. A cancel with nothing to cancel comes
  // back as "Cancellation failed: no active response found" — the red line
  // on every call in Railway's log, once per time the caller spoke into a
  // silence. Now the cancel is only sent when there is a reply to stop.
  let responseActive = false;
  // The turn the caller is waiting on, if any: when it began and what it is.
  // Cleared by the first audio of the reply, so a reply streaming in many
  // deltas is measured once, to its first sound — which is what a caller
  // experiences as the wait.
  let waiting = { since: openedAt, what: 'greeting' };

  function send(event) {
    const payload = JSON.stringify(event);
    if (open) socket.send(payload);
    else queued.push(payload); // Twilio audio can arrive before the model is ready.
  }

  socket.on('open', () => {
    open = true;
    send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions,
        audio: {
          input: {
            // Twilio's native format, both directions. No transcoding.
            format: { type: 'audio/pcmu' },
            // Whisper on the inbound leg as well, purely so the call can be
            // logged and so a question handed to the team is the founder's
            // own words rather than the voice model's paraphrase of them.
            transcription: { model: 'whisper-1' },
            // The model decides when the caller has stopped talking.
            // Server-side detection rather than push-to-talk, because this
            // is meant to feel like a call and a call has no button.
            // See the Noise section at the top of this file.
            noise_reduction: { type: NOISE_REDUCTION },
            // 500ms of silence before the model takes its turn. This is
            // the one latency knob that is ours: every reply waits at
            // least this long after the caller's last word. 600 was the
            // first guess; 500 is the API's own default and the founder
            // found the calls slow. Lower and the model starts answering
            // mid-sentence on a phone line, where pauses are longer.
            turn_detection: {
              type: 'server_vad',
              threshold: VAD_THRESHOLD,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              // Interruption is decided here, not by the API, so that a
              // burst of noise does not stop the desk mid-sentence. See
              // BARGE_IN_MS.
              interrupt_response: false,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: realtimeVoice(),
          },
        },
        tools,
        tool_choice: tools.length ? 'auto' : 'none',
      },
    });

    // Speak first. The caller dialled; silence on answer reads as a failed
    // connection and they hang up.
    if (greeting) {
      send({ type: 'response.create', response: { instructions: greeting } });
    }

    for (const payload of queued.splice(0)) socket.send(payload);
  });

  socket.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return; // A frame we cannot parse is not worth killing a call over.
    }

    switch (event.type) {
      case 'response.output_audio.delta':
        if (waiting) {
          onLatency({ ms: Date.now() - waiting.since, what: waiting.what });
          waiting = null;
        }
        if (event.delta) onAudio(event.delta);
        break;

      // The caller may have started talking over the model. If they keep
      // going for BARGE_IN_MS it was speech and the bridge is told, so it
      // can stop playing audio the caller is no longer listening to — a
      // model that talks through an interruption is the single most
      // unnatural thing a voice agent does. If it stops sooner it was
      // noise, and nothing happens.
      case 'input_audio_buffer.speech_started':
        if (bargeIn) clearTimeout(bargeIn);
        bargeIn = setTimeout(() => {
          bargeIn = null;
          onSpeechStarted();
        }, BARGE_IN_MS);
        break;

      // The model decided the caller has finished. From here to the first
      // sound of the reply is the wait the caller feels; the silence window
      // above has already been spent by the time this arrives.
      case 'input_audio_buffer.speech_stopped':
        if (bargeIn) {
          clearTimeout(bargeIn);
          bargeIn = null;
        }
        waiting = { since: Date.now(), what: 'reply' };
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) onTranscript(event.transcript.trim());
        break;

      case 'response.created':
        responseActive = true;
        break;

      case 'response.done': {
        responseActive = false;
        const outputs = event.response?.output || [];
        for (const item of outputs) {
          if (item.type !== 'function_call') continue;
          let args = {};
          try {
            args = JSON.parse(item.arguments || '{}');
          } catch {
            args = {};
          }
          onToolCall({ id: item.call_id, name: item.name, args });
        }
        break;
      }

      case 'error':
        onError(new Error(event.error?.message || 'The realtime session reported an error.'));
        break;

      default:
        break;
    }
  });

  socket.on('error', (err) => onError(err));
  socket.on('close', () => {
    open = false;
    if (bargeIn) clearTimeout(bargeIn);
    onClose();
  });

  return {
    /** μ-law bytes from the phone, base64, straight through. */
    sendAudio(base64) {
      send({ type: 'input_audio_buffer.append', audio: base64 });
    },

    /**
     * Hands a tool result back and lets the model speak it.
     *
     * Separate from `deliver` below because a tool result is an answer the
     * model asked for, where a late arrival is news it did not.
     */
    completeToolCall(callId, output) {
      send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: String(output) },
      });
      send({ type: 'response.create' });
      waiting = { since: Date.now(), what: 'tool result' };
    },

    /**
     * Says something the caller did not ask for right now.
     *
     * This is how a slow answer gets back into a live call: the team's reply
     * lands as a system-authored turn and the model reads it out in its own
     * voice, in the language of the call, rather than the call ending and the
     * answer arriving by message an hour later.
     */
    deliver(text) {
      send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }],
        },
      });
      send({ type: 'response.create' });
    },

    /**
     * Stop talking. The caller has started and is no longer listening.
     * A no-op when nothing is being said: see responseActive.
     */
    interrupt() {
      if (!responseActive) return;
      responseActive = false;
      send({ type: 'response.cancel' });
    },

    close() {
      try {
        socket.close();
      } catch {
        // Already gone. Closing a closed call is not an error worth raising.
      }
    },
  };
}
