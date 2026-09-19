// Ears and voice for the travel advisor: speech in, speech out.
//
// The providers themselves live in providers/stt.js and providers/tts.js —
// OpenAI, ElevenLabs and Deepgram each — and providers/index.js decides
// which one a turn uses. This module is the façade the rest of the advisor
// talks to, and the place where two things every provider shares happen:
// the spend cap is checked before the call and charged after it, and the
// reply is scrubbed of the markdown a spoken answer must not contain.

import { assertUnderDailyCap, recordSpend } from '../spend.js';
import { resolveProvider, hasProvider } from './providers/index.js';
import { trimToSentence, spokenMaxWords } from './replyCheck.js';

/** Whether the advisor can both hear and speak with what is configured. */
export function isSpeechConfigured() {
  return hasProvider('stt') && hasProvider('tts');
}

export function canHear() {
  return hasProvider('stt');
}

export function canSpeak() {
  return hasProvider('tts');
}

/**
 * Transcribes audio and says which language it was in.
 *
 * @param {Buffer|Uint8Array} audio
 * @param {object} [opts]
 * @param {string} [opts.filename] format hint; the extension picks the decoder
 * @param {string} [opts.languageHint] a supported code, when the caller has
 *   already chosen. Passed through to the model, which stops it decoding a
 *   Spanish note as Portuguese on a bad line.
 * @param {string} [opts.provider] a provider id to use for this call
 * @returns {Promise<{ text: string, language: string|null, durationSeconds: number|null, costUsd: number, provider: string, ms: number }>}
 */
export async function transcribeWithLanguage(audio, { filename = 'voice.ogg', languageHint = null, provider = null } = {}) {
  const ears = resolveProvider('stt', provider);
  if (!ears) throw new Error('No speech-to-text provider is configured — set OPENAI_API_KEY, ELEVENLABS_API_KEY or DEEPGRAM_API_KEY');
  assertUnderDailyCap();

  const startedAt = Date.now();
  const result = await ears.transcribe(audio, { filename, languageHint });
  recordSpend(result.costUsd);
  return { ...result, provider: ears.id, ms: Date.now() - startedAt };
}

/**
 * Turns a reply into speech.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.language] which of the three, for voice and delivery
 * @param {'opus'|'mp3'} [opts.format]
 * @param {string} [opts.provider] a provider id to use for this call
 * @returns {Promise<{ buffer: Buffer, mimeType: string, filename: string, costUsd: number, provider: string, ms: number }>}
 */
export async function synthesizeSpeech(text, { language = 'en', format = 'opus', provider = null } = {}) {
  const voice = resolveProvider('tts', provider);
  if (!voice) throw new Error('No text-to-speech provider is configured — set OPENAI_API_KEY, ELEVENLABS_API_KEY or DEEPGRAM_API_KEY');
  const input = String(text || '').trim();
  if (!input) throw new Error('Nothing to say');
  assertUnderDailyCap();

  const startedAt = Date.now();
  const result = await voice.synthesize(input, { language, format });
  recordSpend(result.costUsd);
  return { ...result, provider: voice.id, ms: Date.now() - startedAt };
}

/**
 * What the advisor says out loud is not always what it writes.
 *
 * Two differences. A spoken answer drops markdown, because a fare table read
 * aloud is unbearable — the advisor is asked for a spoken-friendly answer in
 * the first place (see advisor.js) and this strips what slips through. And a
 * spoken answer has a length nobody will sit through, so an overlong one is
 * cut at a sentence boundary rather than mid-word at whatever ceiling the
 * provider happens to impose.
 *
 * The cut only ever applies to the audio. The text message that goes out
 * alongside it carries the whole answer, so nothing the advisor said is lost
 * — it moves from the ear to the eye.
 *
 * @param {string} text
 * @param {{maxWords?: number}} [opts] maxWords of Infinity speaks it all,
 *   which is what the founder's own outreach message gets: their words, their
 *   call.
 */
export function speakable(text, { maxWords = spokenMaxWords() } = {}) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Number.isFinite(maxWords) ? trimToSentence(cleaned, maxWords) : cleaned;
}

// Kept for the Integrations panel and status, which name the active voice.
export { openaiVoice as __openaiVoice } from './providers/tts.js';
export function ttsModel() {
  const voice = resolveProvider('tts');
  return voice ? voice.model() : null;
}
export function ttsVoice() {
  const voice = resolveProvider('tts');
  return voice && typeof voice.voice === 'function' ? voice.voice() : null;
}
