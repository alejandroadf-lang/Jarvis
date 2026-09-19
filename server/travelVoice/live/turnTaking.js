// Knowing when the caller has stopped talking.
//
// On a voice note this question does not exist: the note has an end, and
// the caller decided where it was. On a live call it is the whole problem,
// and it is the same problem whichever architecture answers it — a
// streaming cascade and a native speech-to-speech model both have to
// decide when to answer, and getting it wrong is the thing people mean
// when they say a voice bot feels broken. Too eager and it interrupts;
// too patient and it sits there.
//
// So this is deliberately its own file with no dependencies: energy over
// PCM frames, a floor that adapts to the room, and hysteresis on both
// edges. Three events come out:
//
//   speech-start   the caller began. While the advisor is speaking, this
//                  is a barge-in and the advisor must stop immediately.
//   speech-end     enough trailing silence that the turn is theirs to
//                  answer — the endpoint.
//   too-long       they have run past the ceiling; answer what there is.
//
// Two things this does NOT do, and both are somebody else's job on
// purpose. Acoustic echo cancellation: without it the advisor's own voice
// comes back through the caller's microphone and every reply barges in on
// itself. The browser does it properly (`echoCancellation: true` on
// getUserMedia) and a phone network does it in hardware, so the guard here
// is only a raised bar while speaking, not a substitute. And semantic
// endpointing — "is that a finished thought?" — needs the words, so it
// arrives from the transcriber through `noteTranscript()` rather than
// being guessed from the waveform.

const DEFAULTS = {
  sampleRate: 16000,
  // How much speech before it counts as speech, and how much silence
  // before the turn is over. The silence figure is the one that decides
  // how the thing feels: people leave gaps mid-sentence, and cutting in on
  // one is worse than waiting a beat too long.
  speechStartMs: 120,
  silenceMs: 700,
  // A caller thinking out loud mid-sentence leaves a longer gap than one
  // who has finished. When the transcriber says the words end in a full
  // stop, the wait can be shorter.
  finalisedSilenceMs: 380,
  minUtteranceMs: 300,
  maxUtteranceMs: 30000,
  // Barge-in is held to a higher bar than a first word: it costs an
  // interrupted answer if it is wrong, and without echo cancellation the
  // advisor's own voice is what it would be wrong about.
  bargeInMs: 260,
  bargeInFactor: 2.2,
  // Speech is this many times the noise floor, and never below the
  // absolute floor — which stops a silent line from calling its own hiss
  // speech once the adaptive floor has crept down to nothing.
  speechFactor: 3.0,
  absoluteFloor: 180,
  noiseAdaptUp: 0.002,
  noiseAdaptDown: 0.05,
};

/** Root mean square of a frame of signed 16-bit samples. */
export function rms(samples) {
  if (!samples?.length) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i++) total += samples[i] * samples[i];
  return Math.sqrt(total / samples.length);
}

/** PCM16 little-endian bytes as an Int16Array, without copying when aligned. */
export function toSamples(frame) {
  if (frame instanceof Int16Array) return frame;
  const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame || []);
  const usable = buf.length - (buf.length % 2);
  return new Int16Array(buf.buffer, buf.byteOffset, usable / 2);
}

/**
 * A turn detector. Push frames, read events.
 *
 * @param {object} [options] see DEFAULTS
 * @returns {{push: Function, noteTranscript: Function, setSpeaking: Function,
 *   reset: Function, state: Function, noiseFloor: Function}}
 */
export function createTurnDetector(options = {}) {
  const config = { ...DEFAULTS, ...options };
  let noiseFloor = config.absoluteFloor;
  let speaking = false; // is the ADVISOR speaking
  let inSpeech = false; // is the CALLER speaking
  let speechMs = 0;
  let silenceMs = 0;
  let utteranceMs = 0;
  let announced = false; // speech-start already emitted for this utterance
  let finalised = false; // the transcriber says the words look complete
  let totalMs = 0;

  function frameMs(samples) {
    return (samples.length / config.sampleRate) * 1000;
  }

  function threshold() {
    const base = Math.max(noiseFloor * config.speechFactor, config.absoluteFloor);
    // While the advisor speaks, only a clearly louder voice counts, because
    // some of what the microphone hears is the advisor.
    return speaking ? base * config.bargeInFactor : base;
  }

  return {
    /**
     * Feeds one frame. Returns the events it produced, in order — usually
     * none, which is the common case and must stay cheap.
     */
    push(frame) {
      const samples = toSamples(frame);
      if (!samples.length) return [];
      const ms = frameMs(samples);
      const level = rms(samples);
      const loud = level > threshold();
      const events = [];
      totalMs += ms;

      // The floor tracks the room: quick to rise when it is quiet, slow to
      // follow when it is loud, so a long sentence does not teach it that
      // speech is silence.
      const rate = loud ? config.noiseAdaptUp : config.noiseAdaptDown;
      noiseFloor += (level - noiseFloor) * rate;
      if (noiseFloor < 1) noiseFloor = 1;

      if (loud) {
        speechMs += ms;
        silenceMs = 0;
        if (inSpeech) utteranceMs += ms;
        const needed = speaking ? config.bargeInMs : config.speechStartMs;
        if (!announced && speechMs >= needed) {
          inSpeech = true;
          announced = true;
          utteranceMs = speechMs;
          events.push({ type: 'speech-start', bargeIn: speaking, at: totalMs, level });
        }
      } else {
        if (inSpeech) {
          utteranceMs += ms;
          silenceMs += ms;
          const wait = finalised ? config.finalisedSilenceMs : config.silenceMs;
          if (silenceMs >= wait) {
            const spoken = utteranceMs - silenceMs;
            const event = spoken >= config.minUtteranceMs
              ? { type: 'speech-end', at: totalMs, speechMs: spoken, finalised }
              : { type: 'false-start', at: totalMs, speechMs: spoken };
            events.push(event);
            inSpeech = false;
            announced = false;
            speechMs = 0;
            silenceMs = 0;
            utteranceMs = 0;
            finalised = false;
          }
        } else {
          // Scattered blips that never became speech decay away rather
          // than accumulating into a phantom start.
          speechMs = Math.max(0, speechMs - ms);
        }
      }

      if (inSpeech && utteranceMs >= config.maxUtteranceMs) {
        events.push({ type: 'too-long', at: totalMs, speechMs: utteranceMs });
        inSpeech = false;
        announced = false;
        speechMs = 0;
        silenceMs = 0;
        utteranceMs = 0;
        finalised = false;
      }

      return events;
    },

    /**
     * What the transcriber has heard so far. A finalised fragment that
     * ends like a finished sentence shortens the wait — the cheap half of
     * semantic endpointing, and the half that needs no extra model.
     */
    noteTranscript(text, { isFinal = false } = {}) {
      if (!isFinal) return;
      finalised = /[.!?。？！]\s*$/.test(String(text || '').trim());
    },

    /** Tell the detector whether the advisor is currently speaking. */
    setSpeaking(on) {
      speaking = Boolean(on);
    },

    reset() {
      inSpeech = false;
      announced = false;
      speechMs = 0;
      silenceMs = 0;
      utteranceMs = 0;
      finalised = false;
    },

    state() {
      return { inSpeech, speaking, speechMs, silenceMs, utteranceMs, finalised };
    },

    noiseFloor() {
      return noiseFloor;
    },
  };
}

export const __testing = { DEFAULTS };
