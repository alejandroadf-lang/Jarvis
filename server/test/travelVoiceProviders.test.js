// The ears, brains and voices behind the advisor, and how one gets picked.
// Pinned: each provider's request shape (the auth header, the field names,
// the format that WhatsApp will play), that the language each reports comes
// back as one of the advisor's three codes, and that a choice is honoured
// exactly — the one the caller named, else the deployment default, else the
// first with a key — and never silently swapped.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let stt;
let tts;
let llm;
let registry;
let originalFetch;
const saved = {};
const KEYS = [
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_TTS_MODEL',
  'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_OUTPUT_FORMAT',
  'DEEPGRAM_API_KEY',
  'DEEPGRAM_TTS_VOICE_FR',
  'IONOS_API_KEY',
  'IONOS_MODEL',
  'IONOS_BASE_URL',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'TRAVEL_VOICE_STT_PROVIDER',
  'TRAVEL_VOICE_LLM_PROVIDER',
  'TRAVEL_VOICE_TTS_PROVIDER',
];

before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  stt = await import('../travelVoice/providers/stt.js');
  tts = await import('../travelVoice/providers/tts.js');
  llm = await import('../travelVoice/providers/llm.js');
  registry = await import('../travelVoice/providers/index.js');
});

after(() => {
  global.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  global.fetch = originalFetch;
});

function capture(reply) {
  const seen = [];
  global.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return typeof reply === 'function' ? reply(String(url), init) : reply;
  };
  return seen;
}

// --- ears -------------------------------------------------------------------

test('ElevenLabs Scribe: multipart with the model, xi-api-key, and a three-letter language code understood', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-key';
  const seen = capture({ ok: true, json: async () => ({ text: ' Necesito ayuda ', language_code: 'spa', language_probability: 0.98, words: [{ text: 'ayuda', end: 2.5 }] }) });

  const result = await stt.elevenLabsEars.transcribe(Buffer.from('opus'), { filename: 'voice.ogg' });

  assert.equal(seen[0].url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(seen[0].init.headers['xi-api-key'], 'el-key');
  assert.ok(seen[0].init.body instanceof FormData);
  assert.equal(seen[0].init.body.get('model_id'), 'scribe_v2');
  assert.equal(seen[0].init.body.get('diarize'), 'false');
  assert.equal(seen[0].init.body.get('language_code'), null, 'no hint, so Scribe detects');
  assert.equal(result.text, 'Necesito ayuda');
  assert.equal(result.language, 'es');
  assert.equal(result.durationSeconds, 2.5, 'the last word’s end time stands in for a duration');
  assert.ok(result.costUsd > 0);
});

test('ElevenLabs Scribe: a chosen language is passed and wins', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-key';
  const seen = capture({ ok: true, json: async () => ({ text: 'ok', language_code: 'en' }) });
  const result = await stt.elevenLabsEars.transcribe(Buffer.from('x'), { languageHint: 'fr' });
  assert.equal(seen[0].init.body.get('language_code'), 'fr');
  assert.equal(result.language, 'fr');
});

test('Deepgram Nova: raw bytes with a Token header, detect_language unless a language was chosen', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  const seen = capture({
    ok: true,
    json: async () => ({ metadata: { duration: 4.2 }, results: { channels: [{ detected_language: 'fr', alternatives: [{ transcript: 'Bonjour à tous' }] }] } }),
  });

  const result = await stt.deepgramEars.transcribe(Buffer.from('opus'), { filename: 'voice.webm' });

  const url = new URL(seen[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.deepgram.com/v1/listen');
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('detect_language'), 'true');
  assert.equal(url.searchParams.get('language'), null);
  assert.equal(seen[0].init.headers.Authorization, 'Token dg-key');
  assert.equal(seen[0].init.headers['Content-Type'], 'audio/webm');
  assert.ok(Buffer.isBuffer(seen[0].init.body), 'the audio goes as the body, not multipart');
  assert.equal(result.text, 'Bonjour à tous');
  assert.equal(result.language, 'fr');
  assert.equal(result.durationSeconds, 4.2);

  seen.length = 0;
  await stt.deepgramEars.transcribe(Buffer.from('x'), { languageHint: 'es' });
  const url2 = new URL(seen[0].url);
  assert.equal(url2.searchParams.get('language'), 'es');
  assert.equal(url2.searchParams.get('detect_language'), null, 'told, not asked');
});

test('every ear names itself in a failure', async () => {
  process.env.ELEVENLABS_API_KEY = 'x';
  process.env.DEEPGRAM_API_KEY = 'x';
  capture({ ok: false, status: 422, text: async () => 'bad audio' });
  await assert.rejects(() => stt.elevenLabsEars.transcribe(Buffer.from('x')), /ElevenLabs transcription failed \(422\)/);
  await assert.rejects(() => stt.deepgramEars.transcribe(Buffer.from('x')), /Deepgram transcription failed \(422\)/);
});

// --- voices -----------------------------------------------------------------

test('ElevenLabs voice: the multilingual model, Opus at 48 kHz, xi-api-key, no language field it would reject', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-key';
  const seen = capture({ ok: true, arrayBuffer: async () => new TextEncoder().encode('OggS').buffer });

  const result = await tts.elevenLabsVoice.synthesize('Utilice FXP.', { language: 'es', format: 'opus' });

  const url = new URL(seen[0].url);
  assert.equal(url.pathname, '/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb');
  assert.equal(url.searchParams.get('output_format'), 'opus_48000_64');
  assert.equal(seen[0].init.headers['xi-api-key'], 'el-key');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model_id, 'eleven_multilingual_v2');
  assert.equal(body.text, 'Utilice FXP.');
  assert.equal(body.language_code, undefined);
  assert.equal(result.mimeType, 'audio/ogg');
  assert.equal(result.filename, 'reply.ogg');
  assert.ok(result.costUsd > 0);
});

test('ElevenLabs voice: the Flash model gets the language code, a custom voice id, and MP3 on request', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-key';
  process.env.ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
  process.env.ELEVENLABS_VOICE_ID = 'voice-abc';
  const seen = capture({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });

  const result = await tts.elevenLabsVoice.synthesize('Bonjour', { language: 'fr', format: 'mp3' });

  const url = new URL(seen[0].url);
  assert.equal(url.pathname, '/v1/text-to-speech/voice-abc');
  assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
  assert.equal(JSON.parse(seen[0].init.body).language_code, 'fr');
  assert.equal(result.mimeType, 'audio/mpeg');
});

test('Deepgram Aura: a per-language voice, Opus in an Ogg container, and no French until a voice is named', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  const seen = capture({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });

  await tts.deepgramVoice.synthesize('Hola', { language: 'es' });
  let url = new URL(seen[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.deepgram.com/v1/speak');
  assert.equal(url.searchParams.get('model'), 'aura-2-celeste-es');
  assert.equal(url.searchParams.get('encoding'), 'opus');
  assert.equal(url.searchParams.get('container'), 'ogg');
  assert.equal(seen[0].init.headers.Authorization, 'Token dg-key');
  assert.deepEqual(JSON.parse(seen[0].init.body), { text: 'Hola' });

  assert.deepEqual(tts.deepgramVoice.languages, ['es', 'en'], 'French is not offered until a voice is set');
  await assert.rejects(() => tts.deepgramVoice.synthesize('Bonjour', { language: 'fr' }), /DEEPGRAM_TTS_VOICE_FR/);

  process.env.DEEPGRAM_TTS_VOICE_FR = 'aura-2-some-fr';
  assert.deepEqual(tts.deepgramVoice.languages, ['es', 'fr', 'en']);
  seen.length = 0;
  await tts.deepgramVoice.synthesize('Bonjour', { language: 'fr', format: 'mp3' });
  url = new URL(seen[0].url);
  assert.equal(url.searchParams.get('model'), 'aura-2-some-fr');
  assert.equal(url.searchParams.get('encoding'), 'mp3');
});

// --- brains -----------------------------------------------------------------

test('a system prompt of blocks is flattened to text for the OpenAI-compatible brains', () => {
  const flat = llm.__testing.flattenSystem([{ type: 'text', text: 'One', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Two' }]);
  assert.equal(flat, 'One\n\nTwo');
  assert.equal(llm.__testing.flattenSystem('plain'), 'plain');
});

test('IONOS: the request goes to the EU hub with a bearer token and the default Llama, overridable', async () => {
  process.env.IONOS_API_KEY = 'io';
  const seen = capture({ ok: true, json: async () => ({ choices: [{ message: { content: 'Hola.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) });

  const response = await llm.ionosBrain.create({ system: [{ type: 'text', text: 'Sys' }], messages: [{ role: 'user', content: 'Hola' }], max_tokens: 100 });

  assert.equal(seen[0].url, 'https://openai.inference.de-txl.ionos.com/v1/chat/completions');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer io');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'meta-llama/Llama-3.3-70B-Instruct');
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.messages, [{ role: 'system', content: 'Sys' }, { role: 'user', content: 'Hola' }]);
  assert.equal(response.content[0].text, 'Hola.');
  assert.equal(response.usage.input_tokens, 5);

  process.env.IONOS_MODEL = 'mistralai/Mistral-Small-24B-Instruct';
  process.env.IONOS_BASE_URL = 'https://example.ionos.test/v1/';
  seen.length = 0;
  await llm.ionosBrain.create({ system: 'S', messages: [{ role: 'user', content: 'x' }], max_tokens: 10 });
  assert.equal(seen[0].url, 'https://example.ionos.test/v1/chat/completions');
  assert.equal(JSON.parse(seen[0].init.body).model, 'mistralai/Mistral-Small-24B-Instruct');
});

test('the Anthropic brain passes the request through untouched, cache markers included', async () => {
  process.env.ANTHROPIC_API_KEY = 'an';
  let seen;
  const anthropic = { messages: { create: async (req) => { seen = req; return { content: [] }; } } };
  const system = [{ type: 'text', text: 'brief', cache_control: { type: 'ephemeral' } }];
  await llm.anthropicBrain.create({ system, messages: [], max_tokens: 5, tools: [{ name: 't' }] }, { anthropic });
  assert.equal(seen.system, system);
  assert.equal(seen.model, 'claude-sonnet-5');
  assert.deepEqual(seen.tools, [{ name: 't' }]);
});

// --- picking ----------------------------------------------------------------

test('with nothing configured a slot resolves to nothing', () => {
  assert.equal(registry.resolveProvider('stt'), null);
  assert.equal(registry.resolveProvider('llm'), null);
  assert.equal(registry.resolveProvider('tts'), null);
  assert.equal(registry.hasProvider('tts'), false);
});

test('the first configured provider in slot order is the default', () => {
  process.env.DEEPGRAM_API_KEY = 'dg';
  assert.equal(registry.resolveProvider('stt').id, 'deepgram');
  process.env.OPENAI_API_KEY = 'oa';
  assert.equal(registry.resolveProvider('stt').id, 'openai', 'the one that was here first comes first');
  process.env.IONOS_API_KEY = 'io';
  assert.equal(registry.resolveProvider('llm').id, 'ionos');
  process.env.ANTHROPIC_API_KEY = 'an';
  assert.equal(registry.resolveProvider('llm').id, 'anthropic');
});

test('the deployment default wins over slot order, and falls through when it has no key', () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  process.env.TRAVEL_VOICE_TTS_PROVIDER = 'elevenlabs';
  assert.equal(registry.resolveProvider('tts').id, 'elevenlabs');

  process.env.TRAVEL_VOICE_STT_PROVIDER = 'deepgram'; // no DEEPGRAM_API_KEY
  assert.equal(registry.resolveProvider('stt').id, 'openai', 'a default without a key is not a stop');
});

test('a provider the caller names is honoured exactly, or refused', () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.DEEPGRAM_API_KEY = 'dg';
  process.env.TRAVEL_VOICE_STT_PROVIDER = 'openai';
  assert.equal(registry.resolveProvider('stt', 'deepgram').id, 'deepgram', 'the request beats the default');
  assert.equal(registry.resolveProvider('stt', 'DEEPGRAM ').id, 'deepgram', 'case and spacing forgiven');
  assert.throws(() => registry.resolveProvider('stt', 'elevenlabs'), /ElevenLabs Scribe is not configured/);
  assert.throws(() => registry.resolveProvider('stt', 'nope'), /Unknown stt provider "nope". Options: openai, elevenlabs, deepgram/);
  assert.throws(() => registry.resolveProvider('ears'), /Unknown provider slot/);
});

test('the registry describes every option so the tab can show what a choice would need', () => {
  process.env.ANTHROPIC_API_KEY = 'an';
  process.env.ELEVENLABS_API_KEY = 'el';
  const described = registry.describeProviders();

  assert.deepEqual(Object.keys(described), ['stt', 'llm', 'tts']);
  assert.equal(described.stt.active, 'elevenlabs');
  assert.equal(described.llm.active, 'anthropic');
  assert.equal(described.tts.active, 'elevenlabs');
  assert.deepEqual(described.llm.options.map((o) => o.id), ['anthropic', 'ionos', 'openai', 'gemini', 'deepseek', 'openrouter']);

  const openai = described.stt.options.find((o) => o.id === 'openai');
  assert.equal(openai.configured, false);
  assert.equal(openai.model, 'whisper-1');
  const eleven = described.tts.options.find((o) => o.id === 'elevenlabs');
  assert.equal(eleven.configured, true);
  assert.equal(eleven.voice, 'JBFqnCBsd6RMkjVDRZzb');
  assert.deepEqual(eleven.languages, ['es', 'fr', 'en']);
  const ionos = described.llm.options.find((o) => o.id === 'ionos');
  assert.equal(ionos.model, 'meta-llama/Llama-3.3-70B-Instruct');
  assert.equal(ionos.voice, undefined, 'a brain has no voice');
});
