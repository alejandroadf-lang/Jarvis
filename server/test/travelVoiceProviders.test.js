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
  'ASSEMBLYAI_API_KEY',
  'ASSEMBLYAI_POLL_MS',
  'DEEPGRAM_KEYTERMS',
  'ELEVENLABS_ZERO_RETENTION',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_TTS_MODEL',
  'ELEVENLABS_VOICE_ID',
  'ELEVENLABS_OUTPUT_FORMAT',
  'DEEPGRAM_API_KEY',
  'DEEPGRAM_TTS_VOICE_FR',
  'DEEPGRAM_TTS_VOICE_ES',
  'DEEPGRAM_TTS_VOICE_EN',
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
  'TRAVEL_VOICE_MODEL',
  'TRAVEL_VOICE_EFFORT',
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
  tts.__resetDeepgramVoicesForTests();
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

test('Deepgram Aura: French works once the catalogue is asked, without pinning a guess', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  tts.__resetDeepgramVoicesForTests();

  // Before asking, French has no voice: it was never pinned, because a
  // guessed id would 404 the first time a French caller spoke.
  assert.equal(tts.deepgramVoiceName('fr'), '');
  assert.deepEqual(tts.deepgramVoice.languages, ['es', 'en']);

  const seen = capture((url) => {
    if (String(url).includes('/v1/models')) {
      return { ok: true, json: async () => ({
        tts: [
          { canonical_name: 'aura-2-thalia-en', languages: ['en'] },
          { canonical_name: 'aura-2-celeste-es', languages: ['es'] },
          { canonical_name: 'aura-2-pandora-fr', languages: ['fr'] },
        ],
      }) };
    }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) };
  });

  await tts.deepgramVoice.synthesize('Bonjour', { language: 'fr' });

  assert.ok(seen[0].url.includes('/v1/models'), 'it asks before it refuses');
  assert.equal(new URL(seen[1].url).searchParams.get('model'), 'aura-2-pandora-fr');
  assert.equal(tts.deepgramVoiceName('fr'), 'aura-2-pandora-fr');
  assert.deepEqual(tts.deepgramVoice.languages, ['es', 'fr', 'en'], 'all three now');

  seen.length = 0;
  await tts.deepgramVoice.synthesize('Encore', { language: 'fr' });
  assert.ok(!seen.some((c) => c.url.includes('/v1/models')), 'and asks only once');
});

test('an explicit French voice beats whatever the catalogue offers', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  process.env.DEEPGRAM_TTS_VOICE_FR = 'aura-2-mine-fr';
  tts.__resetDeepgramVoicesForTests();
  const seen = capture({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });

  await tts.deepgramVoice.synthesize('Bonjour', { language: 'fr' });
  assert.equal(new URL(seen[0].url).searchParams.get('model'), 'aura-2-mine-fr');
  assert.ok(!seen.some((c) => c.url.includes('/v1/models')), 'no need to ask when it was told');
});

test('a catalogue with no French leaves a refusal that names the fix', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  tts.__resetDeepgramVoicesForTests();
  capture((url) => String(url).includes('/v1/models')
    ? { ok: true, json: async () => ({ tts: [{ canonical_name: 'aura-2-thalia-en', languages: ['en'] }] }) }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(2) });

  await assert.rejects(
    () => tts.deepgramVoice.synthesize('Bonjour', { language: 'fr' }),
    /no fr voice[\s\S]*DEEPGRAM_TTS_VOICE_FR/
  );
});

test('a catalogue that cannot be reached falls back to the pinned names rather than breaking', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  tts.__resetDeepgramVoicesForTests();
  const seen = capture((url) => String(url).includes('/v1/models')
    ? { ok: false, status: 500, text: async () => 'down' }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(2) });

  // Spanish still speaks, because its name was pinned all along.
  await tts.deepgramVoice.synthesize('Hola', { language: 'es' });
  assert.equal(new URL(seen[seen.length - 1].url).searchParams.get('model'), 'aura-2-celeste-es');
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

  tts.__resetDeepgramVoicesForTests();
  assert.deepEqual(tts.deepgramVoice.languages, ['es', 'en'], 'French is not offered until a voice is set or found');

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
  assert.equal(seen.model, 'claude-opus-5');
  assert.deepEqual(seen.tools, [{ name: 't' }]);
});

test('the advisor gets its own model default, priced at that model rather than the company tier', () => {
  // The company's other agents stay on their own default; only the advisor
  // moves, and the cap must meter it at the price it actually costs.
  assert.equal(llm.anthropicBrain.model(), 'claude-opus-5');
  assert.deepEqual(llm.anthropicBrain.priceSpec(), {
    provider: 'anthropic',
    model: 'claude-opus-5',
    inputPricePerMTok: 5.0,
    outputPricePerMTok: 25.0,
  });

  process.env.TRAVEL_VOICE_MODEL = 'claude-sonnet-5';
  assert.equal(llm.anthropicBrain.priceSpec().inputPricePerMTok, 2.0, 'a cheaper model is metered cheaper');

  process.env.TRAVEL_VOICE_MODEL = 'claude-something-unreleased';
  assert.equal(llm.anthropicBrain.priceSpec().inputPricePerMTok, 10.0, 'an unknown model is priced at the top rate, so the cap fires early rather than late');
});

test('the advisor thinks at low effort by default, and effort is tunable or removable', async () => {
  process.env.ANTHROPIC_API_KEY = 'an';
  const seen = [];
  const anthropic = { messages: { create: async (req) => { seen.push(req); return { content: [] }; } } };
  const request = { system: 'S', messages: [], max_tokens: 2000 };

  await llm.anthropicBrain.create(request, { anthropic });
  assert.deepEqual(seen[0].output_config, { effort: 'low' }, 'a caller is holding a phone');
  assert.equal(seen[0].thinking, undefined, 'thinking is left at the model default rather than disabled');

  process.env.TRAVEL_VOICE_EFFORT = 'medium';
  await llm.anthropicBrain.create(request, { anthropic });
  assert.deepEqual(seen[1].output_config, { effort: 'medium' });

  process.env.TRAVEL_VOICE_EFFORT = '';
  await llm.anthropicBrain.create(request, { anthropic });
  assert.equal(seen[2].output_config, undefined, 'an older model that predates the parameter gets nothing');
});

test('effort never reaches a brain that would not understand it', async () => {
  process.env.IONOS_API_KEY = 'io';
  const seen = capture({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }) });
  await llm.ionosBrain.create({ system: 'S', messages: [{ role: 'user', content: 'x' }], max_tokens: 10 });
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.output_config, undefined);
  assert.equal(body.effort, undefined);
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

  assert.deepEqual(Object.keys(described), ['residency', 'stt', 'llm', 'tts']);
  assert.equal(described.residency, 'any');
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

// --- AssemblyAI, keyterms, and what is never asked for ----------------------------

test('AssemblyAI Universal: upload, create, poll until complete, and the language heard', async () => {
  process.env.ASSEMBLYAI_API_KEY = 'aai-key';
  process.env.ASSEMBLYAI_POLL_MS = '1';
  let polls = 0;
  const seen = capture((url, init) => {
    if (url.endsWith('/v2/upload')) return { ok: true, json: async () => ({ upload_url: 'https://cdn.assemblyai.com/upload/abc' }) };
    if (url.endsWith('/v2/transcript')) return { ok: true, json: async () => ({ id: 'tr_1', status: 'queued' }) };
    if (url.endsWith('/v2/transcript/tr_1')) {
      polls += 1;
      return polls < 3
        ? { ok: true, json: async () => ({ id: 'tr_1', status: 'processing' }) }
        : { ok: true, json: async () => ({ id: 'tr_1', status: 'completed', text: ' El cliente quiere un refund ', language_code: 'es', audio_duration: 4.8 }) };
    }
    throw new Error(`unexpected ${url}`);
  });

  const result = await stt.assemblyAiEars.transcribe(Buffer.from('opus'), { filename: 'voice.ogg' });

  assert.equal(seen[0].url, 'https://api.assemblyai.com/v2/upload');
  assert.equal(seen[0].init.headers.authorization, 'aai-key');
  assert.equal(seen[0].init.headers['Content-Type'], 'audio/ogg');
  const created = JSON.parse(seen[1].init.body);
  assert.deepEqual(created, { audio_url: 'https://cdn.assemblyai.com/upload/abc', speech_model: 'universal', language_detection: true });
  assert.equal(polls, 3);
  assert.equal(result.text, 'El cliente quiere un refund');
  assert.equal(result.language, 'es');
  assert.equal(result.durationSeconds, 4.8);
  assert.ok(result.costUsd > 0);
  delete process.env.ASSEMBLYAI_POLL_MS;
});

test('AssemblyAI: a chosen language is sent instead of detection, and an error status is an error', async () => {
  process.env.ASSEMBLYAI_API_KEY = 'aai-key';
  const seen = capture((url) => {
    if (url.endsWith('/v2/upload')) return { ok: true, json: async () => ({ upload_url: 'u' }) };
    if (url.endsWith('/v2/transcript')) return { ok: true, json: async () => ({ id: 'tr_2' }) };
    return { ok: true, json: async () => ({ status: 'error', error: 'audio too short' }) };
  });
  await assert.rejects(() => stt.assemblyAiEars.transcribe(Buffer.from('x'), { languageHint: 'fr' }), /AssemblyAI transcription failed: audio too short/);
  const created = JSON.parse(seen[1].init.body);
  assert.equal(created.language_code, 'fr');
  assert.equal(created.language_detection, undefined);
});

test('Deepgram: keyterms are sent only when configured, one parameter each', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg-key';
  const reply = { ok: true, json: async () => ({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript: 'FXP' }] }] } }) };
  let seen = capture(reply);
  await stt.deepgramEars.transcribe(Buffer.from('x'));
  assert.deepEqual(new URL(seen[0].url).searchParams.getAll('keyterm'), []);

  process.env.DEEPGRAM_KEYTERMS = 'FXP, TTP, Amadeus, MAD,CDG';
  try {
    seen = capture(reply);
    await stt.deepgramEars.transcribe(Buffer.from('x'));
    assert.deepEqual(new URL(seen[0].url).searchParams.getAll('keyterm'), ['FXP', 'TTP', 'Amadeus', 'MAD', 'CDG']);
  } finally {
    delete process.env.DEEPGRAM_KEYTERMS;
  }
});

test('no ear asks for speaker identification, diarisation or sentiment', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  process.env.DEEPGRAM_API_KEY = 'dg';
  process.env.ASSEMBLYAI_API_KEY = 'aai';
  process.env.ASSEMBLYAI_POLL_MS = '1';
  const forbidden = /diarize=true|diarization|speaker_labels|sentiment|entity_detection|identify|speaker_id|emotion/i;
  const seen = capture((url, init) => {
    if (url.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'x', language: 'english', duration: 1 }) };
    if (url.includes('elevenlabs')) return { ok: true, json: async () => ({ text: 'x', language_code: 'en' }) };
    if (url.includes('deepgram')) return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'x' }] }] } }) };
    if (url.endsWith('/v2/upload')) return { ok: true, json: async () => ({ upload_url: 'u' }) };
    if (url.endsWith('/v2/transcript')) return { ok: true, json: async () => ({ id: 't' }) };
    return { ok: true, json: async () => ({ status: 'completed', text: 'x', language_code: 'en' }) };
  });
  for (const ear of stt.EARS) await ear.transcribe(Buffer.from('x'));
  for (const call of seen) {
    const body = call.init.body instanceof FormData ? [...call.init.body.entries()].map(([k, v]) => `${k}=${typeof v === 'string' ? v : ''}`).join('&') : typeof call.init.body === 'string' ? call.init.body : '';
    assert.ok(!forbidden.test(call.url), `${call.url} asks for something about the person`);
    assert.ok(!forbidden.test(body), `${call.url} body asks for something about the person: ${body}`);
  }
  assert.deepEqual(stt.EARS.map((e) => e.id), ['openai', 'elevenlabs', 'deepgram', 'assemblyai']);
  delete process.env.ASSEMBLYAI_POLL_MS;
});

// --- what the voice keeps, which tier it speaks with, and what it never does ----------

test('ElevenLabs is asked not to log by default, and can be told to when a plan rejects the flag', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-key';
  let seen = capture({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
  await tts.elevenLabsVoice.synthesize('Hola', { language: 'es' });
  assert.equal(new URL(seen[0].url).searchParams.get('enable_logging'), 'false');

  process.env.ELEVENLABS_ZERO_RETENTION = 'false';
  try {
    seen = capture({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
    await tts.elevenLabsVoice.synthesize('Hola', { language: 'es' });
    assert.equal(new URL(seen[0].url).searchParams.get('enable_logging'), null);
  } finally {
    delete process.env.ELEVENLABS_ZERO_RETENTION;
  }
});

test('the tier dial switches ElevenLabs between the quality and the fast model', async () => {
  process.env.ELEVENLABS_API_KEY = 'el-key';
  const settings = await import('../travelVoice/settings.js');
  settings.__resetSettingsForTests();
  assert.equal(tts.elevenLabsVoice.model(), 'eleven_multilingual_v2');
  settings.setOverride('tier', 'fast');
  assert.equal(tts.elevenLabsVoice.model(), 'eleven_flash_v2_5');
  const seen = capture({ ok: true, arrayBuffer: async () => new ArrayBuffer(2) });
  await tts.elevenLabsVoice.synthesize('Bonjour', { language: 'fr' });
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model_id, 'eleven_flash_v2_5');
  assert.equal(body.language_code, 'fr', 'the fast model takes the language');
  settings.setOverride('tier', 'quality');
  assert.equal(tts.elevenLabsVoice.model(), 'eleven_multilingual_v2');
  settings.__resetSettingsForTests();
});

test('no voice provider clones a voice', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../travelVoice/providers/tts.js', import.meta.url), 'utf8');
  for (const forbidden of ['/voices/add', 'voice_clone', 'instant_voice', 'clone', 'voices/pvc', 'similarity_boost']) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()) || /cloning is not covered|no cloning here/.test(source), `tts.js mentions ${forbidden}`);
  }
  assert.ok(!source.includes('/v1/voices/add'), 'no ElevenLabs cloning endpoint');
});
