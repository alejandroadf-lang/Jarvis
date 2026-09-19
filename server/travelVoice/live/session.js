// A live call, from the first frame of audio to the last.
//
// What this owns: deciding when the caller has finished (turnTaking.js),
// hearing what they said, asking the advisor, speaking the answer, and
// stopping dead the moment they start talking over it. What it does not
// own is the wire — it is handed a transport and never learns whether the
// audio came from a browser, a SIP trunk or WhatsApp. That is the point:
// the research's conclusion was that endpointing, barge-in and teardown
// are the same work whichever transport wins, so they are written once,
// here, and tested with a transport made of arrays.
//
// It reuses the advisor whole. The same prompt, the same case memory, the
// same grounding check on invented fares, the same spelled-out locators,
// the same handoff to a person, the same spend cap and audit trail. A live
// call is a faster way to reach the advisor, not a second advisor, and the
// worst outcome of this file would be a parallel one with none of the
// guards on it.
//
// The one thing a call has that a voice note does not is a person waiting
// in silence, so:
//
//   BARGE-IN IS ABSOLUTE. When the caller speaks over the answer, the
//   audio stops on the next frame, the rest is thrown away, and what was
//   already said is recorded as said — because they heard it, and the
//   advisor must not repeat it as if it never happened.
//
//   FAILURE IS AUDIBLE. A call that goes quiet is broken; a call that says
//   "un momento" and then answers is slow. Every error path here says
//   something in the caller's language.

import { EventEmitter } from 'node:events';
import { createTurnDetector } from './turnTaking.js';
import { pcmToWav, pcmSeconds } from './wav.js';
import { transcribeWithLanguage, synthesizeSpeech, speakable, canHear, canSpeak } from '../speech.js';
import { runAdvisorTurn } from '../advisor.js';
import { resolveProvider } from '../providers/index.js';
import { loadSessions, saveSession, trimHistory } from '../../sessionStore.js';
import { caseFor, rememberTurn, contextPrompt } from '../context.js';
import { readBack } from '../spoken.js';
import { resolveLanguage, requestedLanguageSwitch, normalizeLanguage, languageFromNumber, localized, DEFAULT_LANGUAGE } from '../languages.js';
import { spokenDisclosure, consentMode } from '../consent.js';
import { isHandoffRequest } from '../escalation.js';

const SESSION_KIND = 'travel';

// What the caller hears while the advisor is working. A call cannot go
// silent for three seconds without sounding dead, and this is cheaper and
// faster than anything a model could say.
const THINKING = {
  es: 'Un momento.',
  fr: 'Un instant.',
  en: 'One moment.',
};

export const STATES = ['greeting', 'listening', 'thinking', 'speaking', 'ended'];

/**
 * One live call.
 *
 * The transport is anything with `send(message)` and `close()`, plus the
 * caller pushing frames in through `pushAudio()`. Messages sent out are
 * `{type:'audio'|'state'|'transcript'|'reply'|'error', ...}` — a shape a
 * WebSocket can carry as JSON and a media gateway can ignore in favour of
 * the raw buffers on the `audio` event.
 */
export class LiveSession extends EventEmitter {
  constructor({
    sessionId,
    anthropic,
    transport,
    number = null,
    language = null,
    providers = {},
    sampleRate = 16000,
    audioFormat = 'mp3',
    detector = null,
    onTurn = null,
    greet = true,
  } = {}) {
    super();
    this.sessionId = sessionId;
    this.anthropic = anthropic;
    this.transport = transport;
    this.providers = providers;
    this.sampleRate = sampleRate;
    this.audioFormat = audioFormat;
    this.onTurn = onTurn;
    this.greet = greet;
    this.number = number;
    // Nothing has been heard yet, and the greeting has to be in some
    // language. Their country code is the only evidence there is, and it
    // is the same evidence the message path uses for a first contact.
    this.language = normalizeLanguage(language) || languageFromNumber(number) || null;
    this.state = 'greeting';
    this.frames = [];
    this.turns = 0;
    this.costUsd = 0;
    this.startedAt = Date.now();
    this.endedReason = null;
    // Rises on every barge-in and every new utterance: anything produced
    // for an older generation is stale and must not reach the caller.
    this.generation = 0;
    this.detector = detector || createTurnDetector({ sampleRate });
    this.history = loadSessions(SESSION_KIND).get(sessionId) || [];
  }

  // --- talking to the transport ---------------------------------------------

  send(message) {
    try {
      this.transport?.send?.(message);
    } catch (err) {
      this.emit('error', err);
    }
    this.emit(message.type, message);
  }

  setState(state) {
    if (this.state === state || this.state === 'ended') return;
    this.state = state;
    this.detector.setSpeaking(state === 'speaking');
    this.send({ type: 'state', state });
  }

  // --- the call --------------------------------------------------------------

  /** Opens the call: the disclosure, then listening. */
  async start() {
    const language = this.language || DEFAULT_LANGUAGE;
    if (this.greet) {
      // The same obligation as a first message, and more pressing out loud:
      // the caller must be told before they start talking to a machine.
      const words = consentMode() === 'off'
        ? localized('liveGreeting', language)
        : `${localized('liveGreeting', language)} ${spokenDisclosure(language)}`;
      await this.say(words, { language, interruptible: true });
    }
    this.setState('listening');
    return this;
  }

  /**
   * One frame of PCM16 from the caller. Cheap on purpose: this runs every
   * twenty milliseconds for the whole call.
   */
  pushAudio(frame) {
    if (this.state === 'ended') return;
    for (const event of this.detector.push(frame)) {
      if (event.type === 'speech-start') {
        if (event.bargeIn) this.bargeIn();
        this.send({ type: 'listening', bargeIn: Boolean(event.bargeIn) });
      }
      if (event.type === 'false-start') this.frames = [];
      if (event.type === 'speech-end' || event.type === 'too-long') {
        const utterance = this.frames;
        this.frames = [];
        if (utterance.length) this.answer(utterance).catch((err) => this.fail(err));
      }
    }
    // Kept only while there is a turn being spoken into, so a quiet line
    // does not accumulate a call's worth of silence in memory.
    if (this.detector.state().inSpeech) this.frames.push(Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
  }

  /**
   * The caller started talking over the answer. Everything in flight for
   * the previous generation is now stale.
   */
  bargeIn() {
    if (this.state !== 'speaking') return;
    this.generation += 1;
    this.send({ type: 'interrupt' });
    this.setState('listening');
    this.emit('barge-in', { at: Date.now() - this.startedAt });
  }

  /** Hears one utterance, answers it, speaks the answer. */
  async answer(frames) {
    const generation = (this.generation += 1);
    const seconds = pcmSeconds(frames, { sampleRate: this.sampleRate });
    this.setState('thinking');

    let heard = null;
    let transcript = '';
    try {
      if (!canHear()) throw new Error('No speech-to-text provider is configured');
      const result = await transcribeWithLanguage(pcmToWav(frames, { sampleRate: this.sampleRate }), {
        filename: 'turn.wav',
        languageHint: this.language,
        provider: this.providers.stt,
      });
      transcript = result.text;
      heard = result.language;
      this.costUsd += result.costUsd;
    } catch (err) {
      return this.fail(err);
    }
    if (generation !== this.generation) return null; // they talked over it
    if (!transcript.trim()) {
      this.setState('listening');
      return null;
    }

    const switched = requestedLanguageSwitch(transcript);
    // A short utterance cannot change the language of a call that has one,
    // for the same reason a short voice note cannot (see index.js).
    const resolved = seconds < 2 && this.language && !switched
      ? { language: this.language, source: 'previous' }
      : resolveLanguage({ chosen: switched, heard, text: transcript, previous: this.language });
    this.language = resolved.language;
    this.send({ type: 'transcript', text: transcript, language: resolved.language, seconds });

    if (isHandoffRequest(transcript)) {
      this.emit('handoff', { reason: 'The caller asked for a person.', transcript, language: resolved.language });
    }

    let turn;
    try {
      turn = await runAdvisorTurn({
        anthropic: this.anthropic,
        provider: this.providers.llm,
        history: this.history,
        text: transcript,
        language: resolved.language,
        context: contextPrompt(caseFor(this.sessionId)),
      });
    } catch (err) {
      return this.fail(err, resolved.language);
    }
    if (generation !== this.generation) return null;

    this.costUsd += turn.usage.costUsd;
    this.history = trimHistory(turn.messages);
    saveSession(SESSION_KIND, this.sessionId, this.history);
    rememberTurn(this.sessionId, { text: transcript, reply: turn.reply, language: resolved.language });
    this.turns += 1;

    const heardBack = readBack(transcript, resolved.language);
    this.send({ type: 'reply', text: turn.reply, language: resolved.language, readBack: heardBack?.written || null });
    if (turn.handoff) this.emit('handoff', { reason: turn.handoff.reason, transcript, language: resolved.language });

    const spoken = heardBack ? `${heardBack.spoken} ${turn.reply}` : turn.reply;
    const said = await this.say(spoken, { language: resolved.language, generation, interruptible: true });

    if (this.onTurn) {
      try {
        await this.onTurn({
          transcript,
          reply: turn.reply,
          language: resolved.language,
          seconds,
          costUsd: this.costUsd,
          interrupted: said?.interrupted || false,
          readBack: heardBack?.codes || null,
          drift: turn.drift,
          grounding: turn.grounding,
          handoff: turn.handoff,
          model: turn.model,
          promptVersion: turn.promptVersion,
          providers: { stt: this.providers.stt || null, llm: turn.provider, tts: this.providers.tts || null },
        });
      } catch (err) {
        this.emit('error', err);
      }
    }
    return turn;
  }

  /**
   * Speaks. Returns once the audio has been handed over, or the moment a
   * barge-in makes the rest of it pointless.
   */
  async say(text, { language = DEFAULT_LANGUAGE, generation = this.generation, interruptible = true } = {}) {
    const words = String(text || '').trim();
    if (!words || this.state === 'ended') return null;
    if (!canSpeak()) {
      this.send({ type: 'reply', text: words, language, spoken: false });
      this.setState('listening');
      return { interrupted: false, spoken: false };
    }

    let speech;
    try {
      speech = await synthesizeSpeech(speakable(words, { language }), {
        language,
        format: this.audioFormat,
        provider: this.providers.tts,
      });
      this.costUsd += speech.costUsd;
    } catch (err) {
      this.emit('error', err);
      this.send({ type: 'error', detail: err.message, language });
      this.setState('listening');
      return { interrupted: false, spoken: false };
    }
    if (interruptible && generation !== this.generation) return { interrupted: true, spoken: false };

    this.setState('speaking');
    this.send({
      type: 'audio',
      format: this.audioFormat,
      mimeType: speech.mimeType,
      language,
      data: speech.buffer.toString('base64'),
    });
    this.emit('audio', { buffer: speech.buffer, mimeType: speech.mimeType, language });

    // The transport says when the audio has finished playing; without that
    // the call would go back to listening while the caller is still
    // hearing the answer, and every reply would barge in on itself.
    if (typeof this.transport?.waitForPlayback === 'function') {
      try {
        await this.transport.waitForPlayback();
      } catch {
        // A transport that cannot say is treated as one that did not.
      }
    }
    const interrupted = interruptible && generation !== this.generation;
    if (!interrupted) this.setState('listening');
    return { interrupted, spoken: true };
  }

  /** Says what went wrong, out loud, and keeps the call alive. */
  async fail(err, language = this.language || DEFAULT_LANGUAGE) {
    this.emit('error', err);
    const overCap = String(err?.message || '').startsWith('Daily spend cap reached');
    this.send({ type: 'error', detail: err.message, language });
    await this.say(localized(overCap ? 'answerFailed' : 'transcriptionFailed', language), { language, interruptible: false });
    this.setState('listening');
    return null;
  }

  /** Something to hear while a slow turn runs, when the transport wants it. */
  async fillSilence(language = this.language || DEFAULT_LANGUAGE) {
    if (this.state !== 'thinking') return null;
    return this.say(THINKING[language] || THINKING.en, { language, interruptible: false });
  }

  end(reason = 'ended') {
    if (this.state === 'ended') return this;
    this.endedReason = reason;
    this.generation += 1;
    this.state = 'ended';
    this.frames = [];
    this.send({ type: 'state', state: 'ended', reason });
    try {
      this.transport?.close?.();
    } catch {
      // A transport already gone needs no closing.
    }
    this.emit('end', { reason, turns: this.turns, costUsd: this.costUsd, ms: Date.now() - this.startedAt });
    return this;
  }

  summary() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      language: this.language,
      turns: this.turns,
      costUsd: this.costUsd,
      ms: Date.now() - this.startedAt,
      endedReason: this.endedReason,
    };
  }
}

/** Whether a live call could run at all with what is configured. */
export function liveCallsPossible() {
  return canHear() && canSpeak() && Boolean(resolveProvider('llm'));
}

export const __testing = { THINKING, SESSION_KIND };
