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
 * What the advisor says out loud is not always what it writes. A spoken
 * answer drops markdown, and a fare table read aloud is unbearable, so the
 * advisor is asked for a spoken-friendly answer in the first place (see
 * advisor.js) — this only strips what slips through.
 */
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#>`]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
