// Voice: every text-to-speech provider the advisor can speak through.
//
// The contract mirrors the ears':
//
//   synthesize(text, { language, format }) ->
//     { buffer, mimeType, filename, costUsd }
//
// `format` is 'opus' or 'mp3'. Opus in an Ogg container is what WhatsApp
// plays as a voice note with a waveform; MP3 arrives as a file attachment and
// is the fallback for a provider or tier that cannot produce Opus.
//
// Why more than one: the voice IS the product on a voice channel. OpenAI's
// voices are clear and cheap; ElevenLabs is what people mean when they say a
// synthetic voice sounds human, and its multilingual model keeps one voice
// across all three languages; Deepgram's Aura is built for phone latency and
// carries a native Spanish and French voice each. Which one a Spanish agency
// owner trusts with their clients is not something to decide from a
// datasheet.

import { readSecret, hasSecret } from '../../env.js';
import { SUPPORTED_LANGUAGES } from '../languages.js';
import { override as settingOverride } from '../settings.js';

const FORMATS = {
  opus: { mimeType: 'audio/ogg', filename: 'reply.ogg' },
  mp3: { mimeType: 'audio/mpeg', filename: 'reply.mp3' },
};

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function lang(language) {
  return SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
}

async function failure(label, response) {
  const detail = await response.text().catch(() => '');
  const err = new Error(`${label} speech synthesis failed (${response.status}): ${detail.slice(0, 200)}`);
  err.status = response.status;
  return err;
}

// --- OpenAI -------------------------------------------------------------------

const OPENAI_URL = 'https://api.openai.com/v1/audio/speech';

// The model reads the reply in the language it is written in; the
// instruction stops it anglicising IATA codes and airline names, which a
// travel professional notices immediately.
const OPENAI_INSTRUCTIONS = {
  es: 'Habla en español neutro, con claridad y a un ritmo natural, como un asesor de viajes experimentado. Pronuncia los códigos IATA letra por letra.',
  fr: 'Parle en français clair, à un rythme naturel, comme un conseiller voyage expérimenté. Épelle les codes IATA lettre par lettre.',
  en: 'Speak clearly at a natural pace, like an experienced travel advisor. Spell IATA codes letter by letter.',
};

export const openaiVoice = {
  id: 'openai',
  label: 'OpenAI',
  configured: () => hasSecret('OPENAI_API_KEY'),
  model: () => (process.env.TRAVEL_VOICE_TTS_MODEL || '').trim() || 'gpt-4o-mini-tts',
  voice: () => settingOverride('voice', 'openai') || (process.env.TRAVEL_VOICE_TTS_VOICE || '').trim() || 'alloy',
  languages: ['es', 'fr', 'en'],
  // tts-1 is $15 per million characters; the newer model is priced per token
  // and lands close to the same figure per spoken minute. Checked 2026-09-19.
  pricePer1kChars: () => numberFromEnv('TRAVEL_VOICE_TTS_PRICE_PER_1K_CHARS', 0.015),
  async synthesize(text, { language = 'en', format = 'opus' } = {}) {
    const apiKey = readSecret('OPENAI_API_KEY');
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    const spec = FORMATS[format] || FORMATS.opus;
    const model = this.model();
    const body = {
      model,
      voice: this.voice(),
      input: text.slice(0, 4096), // the endpoint's own ceiling
      response_format: format in FORMATS ? format : 'opus',
    };
    // Only the newer model takes delivery instructions; tts-1 rejects the field.
    if (/gpt-4o/i.test(model)) body.instructions = OPENAI_INSTRUCTIONS[lang(language)];

    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure('OpenAI', response);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: spec.mimeType,
      filename: spec.filename,
      costUsd: (body.input.length / 1000) * this.pricePer1kChars(),
    };
  },
};

// --- ElevenLabs ---------------------------------------------------------------

const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

// output_format is codec_samplerate_bitrate. Opus at 48 kHz / 64 kbps is
// what a voice note needs; the MP3 fallback is the one every tier can make.
function elevenLabsFormat(format) {
  if (format === 'mp3') return (process.env.ELEVENLABS_MP3_FORMAT || '').trim() || 'mp3_44100_128';
  return (process.env.ELEVENLABS_OUTPUT_FORMAT || '').trim() || 'opus_48000_64';
}

export const elevenLabsVoice = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  configured: () => hasSecret('ELEVENLABS_API_KEY'),
  model: () => (process.env.ELEVENLABS_TTS_MODEL || '').trim() || 'eleven_multilingual_v2',
  // "George", a stock multilingual voice, so a fresh key works without a
  // trip to the voice library. Any voice id from the account replaces it.
  voice: () => settingOverride('voice', 'elevenlabs') || (process.env.ELEVENLABS_VOICE_ID || '').trim() || 'JBFqnCBsd6RMkjVDRZzb',
  languages: ['es', 'fr', 'en'],
  // Per thousand characters at the Creator/Pro API rates, checked 2026-09-19.
  // The Flash model bills at half that; adjust the variable if switching.
  pricePer1kChars: () => numberFromEnv('ELEVENLABS_TTS_PRICE_PER_1K_CHARS', 0.24),
  async synthesize(text, { language = 'en', format = 'opus' } = {}) {
    const apiKey = readSecret('ELEVENLABS_API_KEY');
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
    const spec = FORMATS[format] || FORMATS.opus;
    const model = this.model();
    const input = text.slice(0, 5000);
    const body = { text: input, model_id: model };
    // Only the Flash and Turbo v2.5 models accept a language code; the
    // multilingual model detects it and rejects the field on some accounts.
    if (/flash|turbo/i.test(model)) body.language_code = lang(language);

    const params = new URLSearchParams({ output_format: elevenLabsFormat(format in FORMATS ? format : 'opus') });
    const response = await fetch(`${ELEVENLABS_URL}/${encodeURIComponent(this.voice())}?${params}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: spec.mimeType },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure('ElevenLabs', response);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: spec.mimeType,
      filename: spec.filename,
      costUsd: (input.length / 1000) * this.pricePer1kChars(),
    };
  },
};

// --- Deepgram Aura ------------------------------------------------------------

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/speak';

// Aura voices are per language, so there is one to name for each of the
// three. The English and Spanish defaults are stock Aura-2 voices; French
// arrived later and its voice ids are read from the variable so a wrong guess
// here cannot fail every French reply.
function deepgramVoiceFor(language) {
  const defaults = { en: 'aura-2-thalia-en', es: 'aura-2-celeste-es', fr: '' };
  const envName = { en: 'DEEPGRAM_TTS_VOICE_EN', es: 'DEEPGRAM_TTS_VOICE_ES', fr: 'DEEPGRAM_TTS_VOICE_FR' }[language];
  return (process.env[envName] || '').trim() || defaults[language];
}

export const deepgramVoice = {
  id: 'deepgram',
  label: 'Deepgram Aura',
  configured: () => hasSecret('DEEPGRAM_API_KEY'),
  model: () => 'aura-2',
  voice: () => SUPPORTED_LANGUAGES.map((l) => `${l}: ${deepgramVoiceFor(l) || 'unset'}`).join(', '),
  get languages() {
    return SUPPORTED_LANGUAGES.filter((l) => Boolean(deepgramVoiceFor(l)));
  },
  // Aura-2 pay-as-you-go, checked 2026-09-19.
  pricePer1kChars: () => numberFromEnv('DEEPGRAM_TTS_PRICE_PER_1K_CHARS', 0.03),
  async synthesize(text, { language = 'en', format = 'opus' } = {}) {
    const apiKey = readSecret('DEEPGRAM_API_KEY');
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set');
    const voice = deepgramVoiceFor(lang(language));
    if (!voice) {
      throw new Error(`Deepgram has no voice set for ${lang(language)} — set DEEPGRAM_TTS_VOICE_${lang(language).toUpperCase()} to an Aura voice id`);
    }
    const spec = FORMATS[format] || FORMATS.opus;
    const input = text.slice(0, 2000); // Aura's per-request ceiling
    const params = new URLSearchParams({ model: voice });
    if (format === 'mp3') params.set('encoding', 'mp3');
    else {
      params.set('encoding', 'opus');
      params.set('container', 'ogg');
    }

    const response = await fetch(`${DEEPGRAM_URL}?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input }),
    });
    if (!response.ok) throw await failure('Deepgram', response);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: spec.mimeType,
      filename: spec.filename,
      costUsd: (input.length / 1000) * this.pricePer1kChars(),
    };
  },
};

export const VOICES = [openaiVoice, elevenLabsVoice, deepgramVoice];
