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
  onError = () => {},
  onClose = () => {},
}) {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set, so the company cannot take calls.');

  const socket = new WebSocket(`${realtimeUrl()}?model=${encodeURIComponent(realtimeModel())}`, {
    headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
  });

  let open = false;
  const queued = [];

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
        modalities: ['audio', 'text'],
        instructions,
        voice: realtimeVoice(),
        // Twilio's native format, both directions. No transcoding.
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // Whisper on the inbound leg as well, purely so the call can be logged
        // and so a question handed to the team is the founder's own words
        // rather than the voice model's paraphrase of them.
        input_audio_transcription: { model: 'whisper-1' },
        // The model decides when the caller has stopped talking. Server-side
        // detection rather than push-to-talk, because this is meant to feel
        // like a call and a call has no button.
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
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
      case 'response.audio.delta':
        if (event.delta) onAudio(event.delta);
        break;

      // The caller started talking over the model. The bridge needs this
      // immediately to stop playing audio the caller is no longer listening
      // to — a model that talks through an interruption is the single most
      // unnatural thing a voice agent does.
      case 'input_audio_buffer.speech_started':
        onSpeechStarted();
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) onTranscript(event.transcript.trim());
        break;

      case 'response.done': {
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

    /** Stop talking. The caller has started and is no longer listening. */
    interrupt() {
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
