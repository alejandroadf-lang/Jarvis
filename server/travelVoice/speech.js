// Ears and voice for the travel advisor: speech in, speech out.
//
// Both halves run on OpenAI's audio endpoints, the same key that already
// transcribes the founder's WhatsApp voice notes (see agents/openai.js). Two
// things are different here and worth their own module:
//
//   1. Transcription has to report the LANGUAGE, not just the words. Whisper
//      does when asked for `verbose_json`; the newer transcription models do
//      not, so the caller falls back to the word heuristic in languages.js.
//   2. The reply is spoken back. WhatsApp accepts Ogg Opus voice notes and
//      OpenAI's speech endpoint emits them directly, so nothing is transcoded
//      and no native audio dependency enters this codebase.
//
// Every call is metered into the daily spend cap. Audio is billed by the
// minute and by the character rather than by the token, so the prices here
// are separate from the model table and, like every price in this app, pinned
// by hand and overridable without a redeploy.

import { readSecret, hasSecret } from '../env.js';
import { transcribeModel } from '../agents/openai.js';
import { assertUnderDailyCap, recordSpend } from '../spend.js';
import { normalizeLanguage, SUPPORTED_LANGUAGES } from './languages.js';

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

// Only whisper-1 reports the language it heard. gpt-4o-transcribe and its
// mini sibling reject verbose_json outright, so the request shape depends on
// the model.
function reportsLanguage(model) {
  return /^whisper/i.test(model);
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function isSpeechConfigured() {
  return hasSecret('OPENAI_API_KEY');
}

export function ttsModel() {
  return (process.env.TRAVEL_VOICE_TTS_MODEL || '').trim() || 'gpt-4o-mini-tts';
}

export function ttsVoice() {
  return (process.env.TRAVEL_VOICE_TTS_VOICE || '').trim() || 'alloy';
}

// Whisper is $0.006 per minute; the TTS models are $15 per million
// characters (tts-1) — the newer one is priced per token and lands close to
// the same figure per spoken minute, so one per-character number is an
// honest approximation for the cap. Checked 2026-09-19.
export function sttPricePerMinute() {
  return numberFromEnv('TRAVEL_VOICE_STT_PRICE_PER_MIN', 0.006);
}

export function ttsPricePer1kChars() {
  return numberFromEnv('TRAVEL_VOICE_TTS_PRICE_PER_1K_CHARS', 0.015);
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
 * @returns {Promise<{ text: string, language: string|null, durationSeconds: number|null, costUsd: number }>}
 */
export async function transcribeWithLanguage(audio, { filename = 'voice.ogg', languageHint = null } = {}) {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set — the advisor cannot hear voice notes without it');
  assertUnderDailyCap();

  const model = transcribeModel();
  const form = new FormData();
  form.append('file', new Blob([audio]), filename);
  form.append('model', model);
  form.append('response_format', reportsLanguage(model) ? 'verbose_json' : 'json');
  const hint = normalizeLanguage(languageHint);
  if (hint) form.append('language', hint);

  const response = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Transcription failed (${response.status}): ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = (data?.text || '').trim();
  // verbose_json carries the duration; without it, a rough estimate from the
  // byte count keeps the cap honest rather than metering nothing. Opus voice
  // notes run about 2 KB per second.
  const durationSeconds = Number.isFinite(data?.duration) ? data.duration : (audio?.length || 0) / 2000;
  const costUsd = (durationSeconds / 60) * sttPricePerMinute();
  recordSpend(costUsd);

  return {
    text,
    language: hint || normalizeLanguage(data?.language),
    durationSeconds: Number.isFinite(data?.duration) ? data.duration : null,
    costUsd,
  };
}

// WhatsApp plays Ogg Opus voice notes natively and shows them with the
// waveform UI rather than as a file attachment; the browser tab plays them
// too. MP3 is the fallback for anything that cannot.
const FORMATS = {
  opus: { mimeType: 'audio/ogg', filename: 'reply.ogg' },
  mp3: { mimeType: 'audio/mpeg', filename: 'reply.mp3' },
};

// The model reads the reply in the language it is written in; the
// instruction stops it anglicising IATA codes and airline names, which a
// travel professional notices immediately.
const VOICE_INSTRUCTIONS = {
  es: 'Habla en español neutro, con claridad y a un ritmo natural, como un asesor de viajes experimentado. Pronuncia los códigos IATA letra por letra.',
  fr: 'Parle en français clair, à un rythme naturel, comme un conseiller voyage expérimenté. Épelle les codes IATA lettre par lettre.',
  en: 'Speak clearly at a natural pace, like an experienced travel advisor. Spell IATA codes letter by letter.',
};

/**
 * Turns a reply into speech.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.language] which of the three, for the delivery instructions
 * @param {'opus'|'mp3'} [opts.format]
 * @returns {Promise<{ buffer: Buffer, mimeType: string, filename: string, costUsd: number }>}
 */
export async function synthesizeSpeech(text, { language = 'en', format = 'opus' } = {}) {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set — the advisor cannot speak without it');
  const input = String(text || '').trim();
  if (!input) throw new Error('Nothing to say');
  assertUnderDailyCap();

  const spec = FORMATS[format] || FORMATS.opus;
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
  const model = ttsModel();
  const body = {
    model,
    voice: ttsVoice(),
    input: input.slice(0, 4096), // the endpoint's own ceiling
    response_format: format in FORMATS ? format : 'opus',
  };
  // Only the newer model takes delivery instructions; tts-1 rejects the field.
  if (/gpt-4o/i.test(model)) body.instructions = VOICE_INSTRUCTIONS[lang];

  const response = await fetch(SPEECH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Speech synthesis failed (${response.status}): ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const costUsd = (body.input.length / 1000) * ttsPricePer1kChars();
  recordSpend(costUsd);

  return { buffer, mimeType: spec.mimeType, filename: spec.filename, costUsd };
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
