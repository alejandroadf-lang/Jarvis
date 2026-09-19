// The advisor end to end: a voice note in, a voice note out, in the caller's
// language, with the words as a second message. And the things around it —
// who may talk to it, how often, the founder's TRAVEL ON switch, and the
// venture record — which are what make it a product rather than a demo.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeOpus } from './travelVoiceOgg.test.js';

let tmpDir;
let tv;
let whatsapp;
let ventures;
let consent;
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
  'TRAVEL_VOICE_SHORT_CLIP_SECONDS',
  'TRAVEL_VOICE_CONSENT',
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-voice-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  tv = await import('../travelVoice/index.js');
  whatsapp = await import('../channels/whatsapp.js');
  ventures = await import('../finance/ventures.js');
  consent = await import('../travelVoice/consent.js');
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
  consent.__resetConsentForTests();
  // The tests of the advisor itself run with the notice off; the consent
  // flow has its own tests below, which turn it back on.
  process.env.TRAVEL_VOICE_CONSENT = 'off';
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

test('a clip under two seconds cannot switch the language of a conversation', async () => {
  // A Spanish conversation is under way.
  const first = stubOutside({ transcript: '¿Cómo valoro el PNR?', heard: 'spanish' });
  await tv.handleTravelVoiceMessage(
    { id: 'wamid.s1', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic: stubAnthropic('Con FXP.'), phoneNumberId: '222' }
  );
  assert.equal(sends(first).length, 2);

  // Then "oui, merci": one second, and Whisper reports French with no duration
  // of its own — the Ogg pages give it.
  const outside = stubOutside({ transcript: 'oui merci', heard: 'french' });
  const inner = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u === 'https://lookaside/blob') return { ok: true, arrayBuffer: async () => fakeOpus(1.1).buffer.slice(fakeOpus(1.1).byteOffset, fakeOpus(1.1).byteOffset + fakeOpus(1.1).length) };
    if (u.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'oui merci', language: 'french' }) };
    return inner(url, init);
  };
  const anthropic = stubAnthropic('De nada.');
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.s2', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );

  assert.equal(outcome.language, 'es', 'the conversation stays Spanish');
  assert.match(anthropic.calls[0].system.map((b) => b.text).join(), /Reply entirely in Spanish/);
  const [logged] = tv.recentTravelVoiceTurns();
  assert.equal(logged.shortClip, true);
  assert.ok(Math.abs(logged.durationSeconds - 1.1) < 0.01);
  assert.equal(logged.languageSource, 'previous');
});

test('a locator heard in a voice note is read back, spelled aloud and written as heard', async () => {
  const outside = stubOutside({ transcript: 'No me valora el localizador X7K2PQ', heard: 'spanish' });
  const anthropic = stubAnthropic('Pruebe FXP y revise el TST con TQT.');

  await tv.handleTravelVoiceMessage(
    { id: 'wamid.rb', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );

  // The audio: the read-back in the Spanish spelling alphabet, then the
  // answer with its entries spelled letter by letter.
  const spoken = JSON.parse(outside.find((c) => c.url.includes('/audio/speech')).init.body).input;
  assert.match(spoken, /^He entendido: Localizador X de Xiquena, 7, K de Kilo, 2, P de París, Q de Querido\./);
  assert.match(spoken, /F-X-P/);
  assert.match(spoken, /T-Q-T/);

  // The text: the code exactly as heard, then the answer exactly as written.
  const [, text] = sends(outside);
  assert.equal(text.text.body, 'He entendido — Localizador: X7K2PQ\n\nPruebe FXP y revise el TST con TQT.');

  const [logged] = tv.recentTravelVoiceTurns();
  assert.deepEqual(logged.readBack, ['X7K2PQ']);
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

// --- first contact: the notice and the tap ------------------------------------------

function interactiveSends(calls) {
  return sends(calls).filter((m) => m.type === 'interactive');
}

test('first contact is disclosed, spoken and written with two buttons, and voice waits for the tap', async () => {
  process.env.TRAVEL_VOICE_CONSENT = 'required';
  const outside = stubOutside({ transcript: '¿Cómo emito?', heard: 'spanish' });
  const anthropic = stubAnthropic('Con TTP.');

  // A voice note from a stranger: the notice goes out, the note is not touched.
  const first = await tv.handleTravelVoiceMessage(
    { id: 'wamid.c1', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.deepEqual(first, { stage: 'consent_required' });
  assert.equal(anthropic.calls.length, 0, 'nothing was asked of the model');
  assert.ok(!outside.some((c) => c.url.includes('lookaside')), 'the audio was not downloaded');
  assert.ok(!outside.some((c) => c.url.includes('/audio/transcriptions')), 'and not transcribed');

  // What went out: the spoken disclosure, then the interactive notice.
  const spoken = JSON.parse(outside.find((c) => c.url.includes('/audio/speech')).init.body).input;
  assert.match(spoken, /asistente automático de inteligencia artificial, no una persona/);
  const [notice] = interactiveSends(outside);
  assert.equal(notice.interactive.type, 'button');
  assert.match(notice.interactive.body.text, /^Aviso: estás hablando con un asistente automático/);
  assert.match(notice.interactive.body.text, /AGENTE/);
  assert.deepEqual(notice.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [['consent_yes', 'Acepto'], ['consent_no', 'No acepto']]);
  for (const b of notice.interactive.action.buttons) assert.ok(b.reply.title.length <= 20);

  const state = consent.consentState('34600111222');
  assert.equal(state.disclosureVersion, consent.DISCLOSURE_VERSION);
  assert.equal(state.consent, null);
  assert.equal(state.disclosureSpoken, true);

  // A second voice note before the tap: reminded, not disclosed again.
  const again = stubOutside({ transcript: 'x', heard: 'spanish' });
  await tv.handleTravelVoiceMessage(
    { id: 'wamid.c2', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(interactiveSends(again).length, 0);
  assert.match(sends(again)[0].text.body, /necesito tu aceptación/);

  // Text is still answered while voice waits.
  const typed = stubOutside();
  const text = await tv.handleTravelVoiceMessage(
    { id: 'wamid.c3', from: '34600111222', type: 'text', text: '¿Qué hace FXP?', mediaId: null, phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(text.stage, 'answered');
  assert.equal(interactiveSends(typed).length, 0, 'the notice is not repeated');

  // The tap.
  const tap = stubOutside();
  const consented = await tv.handleTravelVoiceMessage(
    { id: 'wamid.tap', from: '34600111222', type: 'interactive', text: '', mediaId: null, phoneNumberId: '222', buttonReply: { id: 'consent_yes', title: 'Acepto' } },
    { anthropic, phoneNumberId: '222' }
  );
  assert.deepEqual(consented, { stage: 'consent', granted: true });
  assert.match(sends(tap)[0].text.body, /Ya puedes enviarme notas de voz/);
  const after = consent.consentState('34600111222');
  assert.equal(after.consent, 'granted');
  assert.equal(after.consentMessageId, 'wamid.tap');
  assert.equal(after.consentButton, 'consent_yes');

  // Now the voice note is heard and answered.
  const heard = stubOutside({ transcript: '¿Cómo emito?', heard: 'spanish' });
  const answered = await tv.handleTravelVoiceMessage(
    { id: 'wamid.c4', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(answered.stage, 'answered');
  assert.ok(heard.some((c) => c.url.includes('/audio/transcriptions')));

  const stages = tv.recentTravelVoiceTurns().map((t) => t.stage);
  assert.deepEqual(stages.slice().reverse(), ['disclosed', 'consent_required', 'consent_required', 'answered', 'consent', 'answered']);
});

test('a decline keeps text working and voice closed; BORRAR forgets the caller', async () => {
  process.env.TRAVEL_VOICE_CONSENT = 'required';
  const anthropic = stubAnthropic('Sí.');
  stubOutside();
  await tv.handleTravelVoiceMessage(
    { id: 'wamid.d1', from: '34600111222', type: 'interactive', text: '', mediaId: null, phoneNumberId: '222', buttonReply: { id: 'consent_no', title: 'No acepto' } },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(consent.consentState('34600111222').consent, 'declined');
  assert.equal(consent.voiceAllowed('34600111222'), false);

  const forget = stubOutside();
  const gone = await tv.handleTravelVoiceMessage(
    { id: 'wamid.d2', from: '34600111222', type: 'text', text: 'BORRAR', mediaId: null, phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(gone.stage, 'forgotten');
  assert.equal(consent.consentState('34600111222'), null);
  assert.match(sends(forget)[0].text.body, /He borrado/);
  assert.equal(anthropic.calls.length, 0);
});

test('notice mode discloses once and never gates; off mode does neither', async () => {
  process.env.TRAVEL_VOICE_CONSENT = 'notice';
  const outside = stubOutside({ transcript: 'Bonjour, comment émettre ?', heard: 'french' });
  const anthropic = stubAnthropic('Avec TTP.');
  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'wamid.n1', from: '33600000000', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(outcome.stage, 'answered');
  const [notice] = interactiveSends(outside);
  assert.match(notice.interactive.body.text, /^Information : vous parlez à un assistant automatique/);
  assert.deepEqual(notice.interactive.action.buttons.map((b) => b.reply.title), ["J'accepte", 'Je refuse']);

  process.env.TRAVEL_VOICE_CONSENT = 'off';
  const quiet = stubOutside({ transcript: 'hello', heard: 'english' });
  await tv.handleTravelVoiceMessage(
    { id: 'wamid.n2', from: '447700900123', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(interactiveSends(quiet).length, 0);
  assert.equal(consent.consentState('447700900123'), null);
});

test('the status and the founder commands report the consent mode', async () => {
  process.env.TRAVEL_VOICE_CONSENT = 'required';
  assert.deepEqual(tv.travelVoiceStatus().consent, { mode: 'required', disclosed: 0, granted: 0 });
  const reply = await tv.runTravelVoiceCommand({ kind: 'consents' }, { from: '111' });
  assert.match(reply, /Consent is required\. Nobody has been shown/);
  consent.recordDisclosure('34600111222', { language: 'es' });
  consent.recordConsent('34600111222', { granted: true, messageId: 'wamid.x' });
  const listed = await tv.runTravelVoiceCommand({ kind: 'consents' }, { from: '111' });
  assert.match(listed, /…1222 granted/);
  assert.ok(!listed.includes('34600111222'), 'numbers are masked');
});

