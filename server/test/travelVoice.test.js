// The advisor end to end: a voice note in, a voice note out, in the caller's
// language, with the words as a second message. And the things around it —
// who may talk to it, how often, the founder's TRAVEL ON switch, and the
// venture record — which are what make it a product rather than a demo.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let tv;
let whatsapp;
let ventures;
let originalFetch;
const saved = {};
const KEYS = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'TRAVEL_VOICE_PHONE_NUMBER_ID',
  'TRAVEL_VOICE_ALLOWED_NUMBERS',
  'TRAVEL_VOICE_MAX_TURNS_PER_HOUR',
  'TRAVEL_VOICE_TEXT_TOO',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AMADEUS_CLIENT_ID',
  'AMADEUS_CLIENT_SECRET',
  'ELEVENLABS_API_KEY',
  'DEEPGRAM_API_KEY',
  'IONOS_API_KEY',
  'TRAVEL_VOICE_STT_PROVIDER',
  'TRAVEL_VOICE_LLM_PROVIDER',
  'TRAVEL_VOICE_TTS_PROVIDER',
  'TRAVEL_VOICE_MODEL',
  'TRAVEL_VOICE_EFFORT',
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-voice-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  tv = await import('../travelVoice/index.js');
  whatsapp = await import('../channels/whatsapp.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  global.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.WHATSAPP_TOKEN = 'wa-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '111';
  process.env.TRAVEL_VOICE_PHONE_NUMBER_ID = '222';
  process.env.OPENAI_API_KEY = 'oa-key';
  process.env.ANTHROPIC_API_KEY = 'an-key';
  tv.__resetTravelVoiceForTests();
  whatsapp.__resetDedupForTests();
  global.fetch = originalFetch;
});

function stubAnthropic(reply, calls = []) {
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push({ ...request, messages: [...request.messages] });
        const text = typeof reply === 'function' ? reply(request) : reply;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 50, output_tokens: 20 } };
      },
    },
  };
}

// A fetch stub covering every outside call a WhatsApp voice turn makes:
// media lookup and download, transcription, synthesis, media upload, and
// the two sends. Records each so the test can read the order back.
function stubOutside({ transcript = 'hola', heard = 'spanish' } = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (/graph\.facebook\.com\/v[\d.]+\/media-1$/.test(u)) return { ok: true, json: async () => ({ url: 'https://lookaside/blob', mime_type: 'audio/ogg' }) };
    if (u === 'https://lookaside/blob') return { ok: true, arrayBuffer: async () => new TextEncoder().encode('opus-bytes').buffer };
    if (u.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: transcript, language: heard, duration: 3 }) };
    if (u.includes('/audio/speech')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('OggS-reply').buffer };
    if (/\/media$/.test(u)) return { ok: true, json: async () => ({ id: 'uploaded-1' }) };
    if (/\/messages$/.test(u)) return { ok: true, json: async () => ({ messages: [{ id: 'sent' }] }) };
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}

function sends(calls) {
  return calls.filter((c) => /\/messages$/.test(c.url)).map((c) => JSON.parse(c.init.body));
}

test('the advisor’s number is its own, and any caller may write to it unless narrowed', () => {
  assert.equal(tv.isTravelVoiceNumber('222'), true);
  assert.equal(tv.isTravelVoiceNumber('111'), false);
  assert.equal(tv.isTravelVoiceNumber(null), false);
  delete process.env.TRAVEL_VOICE_PHONE_NUMBER_ID;
  assert.equal(tv.isTravelVoiceNumber('222'), false, 'no number configured, nothing is the advisor’s');

  assert.equal(tv.isTravelVoiceCallerAllowed('34600111222'), true, 'open by default');
  process.env.TRAVEL_VOICE_ALLOWED_NUMBERS = '+34 600 111 222';
  assert.equal(tv.isTravelVoiceCallerAllowed('34600111222'), true);
  assert.equal(tv.isTravelVoiceCallerAllowed('33600000000'), false);
});

test('capabilities are reported as separate facts', () => {
  assert.deepEqual(tv.travelVoiceCapabilities(), { text: true, voice: true, hear: true, speak: true, liveFares: false, whatsapp: true, liveCalls: false });
  delete process.env.OPENAI_API_KEY;
  assert.equal(tv.travelVoiceCapabilities().voice, false);
  assert.equal(tv.isTravelVoiceConfigured(), true, 'text still works without voice');
  process.env.DEEPGRAM_API_KEY = 'dg';
  assert.equal(tv.travelVoiceCapabilities().voice, true, 'any configured ears and voice will do');
  delete process.env.DEEPGRAM_API_KEY;
});

test('a caller gets a sliding hour of turns, then a polite no', () => {
  process.env.TRAVEL_VOICE_MAX_TURNS_PER_HOUR = '3';
  const t0 = 1_000_000_000_000;
  assert.equal(tv.admitTurn('a', t0), true);
  assert.equal(tv.admitTurn('a', t0 + 1), true);
  assert.equal(tv.admitTurn('a', t0 + 2), true);
  assert.equal(tv.admitTurn('a', t0 + 3), false);
  assert.equal(tv.admitTurn('b', t0 + 3), true, 'per caller');
  assert.equal(tv.admitTurn('a', t0 + 61 * 60 * 1000), true, 'the window slides');
});

test('TRAVEL ON and OFF are parsed and persisted per number', () => {
  assert.equal(tv.parseAdvisorModeCommand('travel on'), 'on');
  assert.equal(tv.parseAdvisorModeCommand('TRAVEL OFF'), 'off');
  assert.equal(tv.parseAdvisorModeCommand('travel to Paris'), null);
  assert.equal(tv.parseAdvisorModeCommand('I want to travel on Monday'), null);

  assert.equal(tv.isAdvisorMode('+44 7700 900123'), false);
  tv.setAdvisorMode('+44 7700 900123', true);
  assert.equal(tv.isAdvisorMode('447700900123'), true, 'formatting is ignored');
  tv.setAdvisorMode('447700900123', false);
  assert.equal(tv.isAdvisorMode('447700900123'), false);
});

test('numbers are masked before they reach the log', () => {
  assert.equal(tv.maskNumber('+34 600 111 222'), '…1222');
  assert.equal(tv.maskNumber(''), null);
});

test('a text turn answers in the detected language and remembers the session', async () => {
  const anthropic = stubAnthropic((request) => `Réponse ${request.messages.length}`);
  const first = await tv.runTravelVoiceTurn({ anthropic, sessionId: 'web-1', text: "Bonjour, comment je valorise le PNR avec le tarif le moins cher ?" });
  assert.equal(first.language, 'fr');
  assert.equal(first.languageSource, 'guessed');
  assert.equal(first.reply, 'Réponse 1');
  assert.equal(first.audio, null, 'no audio unless asked');

  const second = await tv.runTravelVoiceTurn({ anthropic, sessionId: 'web-1', text: 'ok' });
  assert.equal(second.language, 'fr', 'a short follow-up stays in the conversation’s language');
  assert.equal(second.languageSource, 'previous');
  assert.equal(anthropic.calls[1].messages.length, 3, 'history carried');

  tv.resetTravelVoiceSession('web-1');
  const third = await tv.runTravelVoiceTurn({ anthropic, sessionId: 'web-1', text: 'ok' });
  assert.equal(third.language, 'en', 'reset forgets the language too');
  assert.equal(anthropic.calls[2].messages.length, 1);
});

test('asking to switch language switches this turn', async () => {
  const anthropic = stubAnthropic('Sure.');
  await tv.runTravelVoiceTurn({ anthropic, sessionId: 'web-2', text: 'Hola, necesito ayuda con una reserva de un vuelo' });
  const r = await tv.runTravelVoiceTurn({ anthropic, sessionId: 'web-2', text: 'can you continue in english please' });
  assert.equal(r.language, 'en');
  assert.equal(r.languageSource, 'switched');
});

test('a WhatsApp voice note is answered with a voice note in the same language, then the words', async () => {
  const outside = stubOutside({ transcript: '¿Cómo emito el billete?', heard: 'spanish' });
  const anthropic = stubAnthropic('Con TTP. Primero valore el PNR con FXP.');

  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.1', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );

  assert.deepEqual(outcome, { stage: 'answered', spoke: true, language: 'es' });
  assert.match(anthropic.calls[0].system.map((b) => b.text).join(), /Reply entirely in Spanish/);

  // The order: download, transcribe, think, speak, upload, send audio, send text.
  const order = outside.map((c) => c.url.replace(/^https:\/\//, '').replace(/graph\.facebook\.com\/v[\d.]+\//, ''));
  assert.deepEqual(order, ['media-1', 'lookaside/blob', 'api.openai.com/v1/audio/transcriptions', 'api.openai.com/v1/audio/speech', '222/media', '222/messages', '222/messages']);

  const upload = outside.find((c) => /\/media$/.test(c.url));
  assert.equal(upload.init.body.get('type'), 'audio/ogg');
  assert.equal(upload.init.body.get('messaging_product'), 'whatsapp');

  const [audio, text] = sends(outside);
  assert.deepEqual(audio, { messaging_product: 'whatsapp', to: '34600111222', type: 'audio', audio: { id: 'uploaded-1' } });
  assert.equal(text.type, 'text');
  assert.equal(text.text.body, 'Con TTP. Primero valore el PNR con FXP.');

  const [logged] = tv.recentTravelVoiceTurns();
  assert.equal(logged.stage, 'answered');
  assert.equal(logged.from, '…1222');
  assert.equal(logged.voice, true);
  assert.equal(logged.spoke, true);
  assert.equal(logged.language, 'es');
  assert.ok(logged.costUsd > 0);
  assert.deepEqual(logged.providers, { stt: 'openai', llm: 'anthropic', tts: 'openai' });
  assert.ok(Number.isFinite(logged.timings.sttMs) && Number.isFinite(logged.timings.llmMs) && Number.isFinite(logged.timings.ttsMs));
});

test('a turn can name its ears, brain and voice, and reports which answered', async () => {
  process.env.ELEVENLABS_API_KEY = 'el';
  process.env.DEEPGRAM_API_KEY = 'dg';
  const hit = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    hit.push(u);
    if (u.includes('api.elevenlabs.io/v1/speech-to-text')) return { ok: true, json: async () => ({ text: 'Bonjour', language_code: 'fra', words: [{ end: 1.2 }] }) };
    if (u.includes('api.deepgram.com/v1/speak')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    throw new Error(`unexpected fetch ${u}`);
  };
  process.env.DEEPGRAM_TTS_VOICE_FR = 'aura-2-test-fr';
  try {
    const anthropic = stubAnthropic('Oui.');
    const r = await tv.runTravelVoiceTurn({
      anthropic,
      sessionId: 'web-p',
      audio: Buffer.from('opus'),
      wantAudio: true,
      providers: { stt: 'elevenlabs', llm: 'anthropic', tts: 'deepgram' },
    });
    assert.equal(r.transcript, 'Bonjour');
    assert.equal(r.language, 'fr', 'Scribe’s three-letter code is understood');
    assert.deepEqual(r.providers, { stt: 'elevenlabs', llm: 'anthropic', tts: 'deepgram' });
    assert.equal(r.model, 'claude-opus-5');
    assert.ok(r.audio, 'spoken by Deepgram');
    assert.equal(hit.filter((u) => u.includes('openai.com')).length, 0, 'OpenAI was not used for anything');
  } finally {
    delete process.env.DEEPGRAM_TTS_VOICE_FR;
  }
});

test('the deployment default picks the provider for WhatsApp callers', async () => {
  process.env.DEEPGRAM_API_KEY = 'dg';
  process.env.TRAVEL_VOICE_STT_PROVIDER = 'deepgram';
  const hit = [];
  const inner = (() => {
    const calls = stubOutside({ transcript: 'ignored' });
    return calls;
  })();
  const outer = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    hit.push(u);
    if (u.includes('api.deepgram.com/v1/listen')) {
      return { ok: true, json: async () => ({ metadata: { duration: 2 }, results: { channels: [{ detected_language: 'es', alternatives: [{ transcript: 'Hola' }] }] } }) };
    }
    return outer(url, init);
  };
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.p', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic: stubAnthropic('Sí.'), phoneNumberId: '222' }
  );
  assert.equal(outcome.stage, 'answered');
  assert.ok(hit.some((u) => u.includes('api.deepgram.com/v1/listen')), 'Deepgram heard it');
  assert.ok(!hit.some((u) => u.includes('audio/transcriptions')), 'OpenAI did not');
  assert.equal(tv.recentTravelVoiceTurns()[0].providers.stt, 'deepgram');
  assert.equal(tv.recentTravelVoiceTurns()[0].providers.tts, 'openai', 'the voice default is unchanged');
  void inner;
});

test('a WhatsApp text is answered with text only', async () => {
  const outside = stubOutside();
  const anthropic = stubAnthropic('Use RT with the locator.');
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.2', from: '447700900123', type: 'text', text: 'How do I retrieve a booking by its locator?', mediaId: null, phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(outcome.stage, 'answered');
  assert.equal(outcome.spoke, false);
  assert.equal(outside.some((c) => c.url.includes('/audio/')), false, 'no transcription, no synthesis');
  const [text] = sends(outside);
  assert.equal(text.text.body, 'Use RT with the locator.');
});

test('a voice note with the text reply turned off sends only the voice note', async () => {
  process.env.TRAVEL_VOICE_TEXT_TOO = 'false';
  const outside = stubOutside();
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.3', from: '34600111222', type: 'voice', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic: stubAnthropic('Sí.'), phoneNumberId: '222' }
  );
  assert.equal(outcome.spoke, true);
  assert.equal(sends(outside).length, 1);
  assert.equal(sends(outside)[0].type, 'audio');
});

test('when the voice reply cannot be sent, the words still go', async () => {
  const outside = stubOutside();
  const inner = global.fetch;
  global.fetch = async (url, init) => {
    if (/\/media$/.test(String(url))) return { ok: false, status: 500, text: async () => 'upload broke' };
    return inner(url, init);
  };
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.4', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic: stubAnthropic('Respuesta.'), phoneNumberId: '222' }
  );
  assert.equal(outcome.stage, 'answered');
  assert.equal(outcome.spoke, false);
  const only = sends(outside);
  assert.equal(only.length, 1);
  assert.equal(only[0].text.body, 'Respuesta.');
});

test('over the rate limit the caller is told in their own language', async () => {
  process.env.TRAVEL_VOICE_MAX_TURNS_PER_HOUR = '1';
  const outside = stubOutside();
  const anthropic = stubAnthropic('Oui.');
  const msg = (id) => ({ id, from: '33600000000', type: 'text', text: 'Bonjour, je voudrais un tarif pour un vol', mediaId: null, phoneNumberId: '222' });

  await tv.handleTravelVoiceMessage(msg('a'), { anthropic, phoneNumberId: '222' });
  const outcome = await tv.handleTravelVoiceMessage(msg('b'), { anthropic, phoneNumberId: '222' });

  assert.equal(outcome.stage, 'rate_limited');
  assert.equal(anthropic.calls.length, 1, 'the model was not asked a second time');
  const last = sends(outside).pop();
  assert.match(last.text.body, /beaucoup de demandes/);
});

test('a voice note without OpenAI configured is declined in the caller’s language', async () => {
  delete process.env.OPENAI_API_KEY;
  const outside = stubOutside();
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.5', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic: stubAnthropic('x'), phoneNumberId: '222' }
  );
  assert.equal(outcome.stage, 'unsupported_type');
  assert.match(sends(outside)[0].text.body, /voice notes|notas de voz/);
});

test('a silent voice note gets asked again rather than answered', async () => {
  const outside = stubOutside({ transcript: '', heard: 'french' });
  const anthropic = stubAnthropic('x');
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.6', from: '33600000000', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(outcome.stage, 'empty');
  assert.equal(anthropic.calls.length, 0);
  assert.match(sends(outside)[0].text.body, /répéter/);
});

test('a failed answer is apologised for in the caller’s language, and logged with the reason', async () => {
  const outside = stubOutside();
  const anthropic = { messages: { create: async () => { throw new Error('model unavailable'); } } };
  await tv.handleTravelVoiceMessage(
    { id: 'p', from: '34600111222', type: 'text', text: 'Hola, quiero saber la tarifa de un vuelo', mediaId: null, phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.match(sends(outside)[0].text.body, /No he podido responder/);
  assert.equal(tv.recentTravelVoiceTurns()[0].stage, 'failed');
  assert.equal(tv.recentTravelVoiceTurns()[0].detail, 'model unavailable');
});

test('reaching out sends the intro, a permission request and the message as a voice note', async () => {
  const outside = stubOutside();
  const outcome = await tv.startTravelVoiceOutreach('+33 6 00 00 00 00', {
    phoneNumberId: '222',
    language: 'fr',
    message: 'Bonjour, je vous rappelle au sujet de votre PNR.',
  });
  assert.deepEqual(outcome, { permissionRequested: true, spoke: true, called: false, callId: null });
  const all = sends(outside);
  assert.equal(all[0].type, 'text');
  assert.match(all[0].text.body, /conseiller voyage/);
  assert.equal(all[1].type, 'interactive');
  assert.equal(all[1].interactive.type, 'call_permission_request');
  assert.equal(all[2].type, 'audio');
  assert.equal(tv.recentTravelVoiceTurns()[0].stage, 'outreach');
});

test('reaching out respects the allowlist', async () => {
  process.env.TRAVEL_VOICE_ALLOWED_NUMBERS = '34600111222';
  await assert.rejects(() => tv.startTravelVoiceOutreach('33600000000', { phoneNumberId: '222' }), /outside TRAVEL_VOICE_ALLOWED_NUMBERS/);
});

test('the venture is registered once, on the portfolio, with milestones', () => {
  const first = tv.ensureTravelVoiceVenture();
  assert.equal(first.created, true);
  assert.equal(first.venture.title, tv.VENTURE_TITLE);
  assert.equal(first.venture.status, 'active');
  assert.equal(first.venture.milestones.length, 4);
  assert.match(first.venture.agentNativeEdge, /three languages/);

  const again = tv.ensureTravelVoiceVenture();
  assert.equal(again.created, false);
  assert.equal(again.venture.id, first.venture.id);
  assert.equal(ventures.listVentures().filter((v) => v.title === tv.VENTURE_TITLE).length, 1);

  const status = tv.travelVoiceStatus();
  assert.equal(status.venture.id, first.venture.id);
  assert.deepEqual(status.languages, ['es', 'fr', 'en']);
  assert.equal(status.whatsapp.open, true);
});
