// A live call end to end, with a transport made of arrays: the advisor
// reused whole, barge-in that actually stops the audio, and every failure
// audible rather than silent.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let live;
let context;
let wav;
const saved = {};
const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DAILY_SPEND_CAP_USD', 'TRAVEL_VOICE_CONSENT', 'TRAVEL_VOICE_GROUNDING_RETRY', 'TRAVEL_VOICE_LANGUAGE_RETRY'];
let originalFetch;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-live-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  live = await import('../travelVoice/live/session.js');
  context = await import('../travelVoice/context.js');
  wav = await import('../travelVoice/live/wav.js');
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
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ANTHROPIC_API_KEY = 'an';
  process.env.DAILY_SPEND_CAP_USD = '100';
  process.env.TRAVEL_VOICE_CONSENT = 'off';
  process.env.TRAVEL_VOICE_GROUNDING_RETRY = 'false';
  process.env.TRAVEL_VOICE_LANGUAGE_RETRY = 'false';
  context.__resetContextForTests();
  global.fetch = originalFetch;
});

const RATE = 16000;
const FRAME = 320;

function frame(level) {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) samples[i] = i % 2 ? level : -level;
  return Buffer.from(samples.buffer);
}

// Playback is a latch rather than a one-shot callback: the session only
// calls waitForPlayback() after the synthesis resolves, so a test that
// releases beforehand must still be honoured or the call hangs for ever.
function fakeTransport({ hold = false } = {}) {
  const sent = [];
  let finished = !hold;
  let waiting = [];
  return {
    sent,
    send: (m) => sent.push(m),
    close: () => sent.push({ type: 'closed' }),
    waitForPlayback: () => (finished ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve))),
    finishPlayback: () => {
      finished = true;
      const pending = waiting;
      waiting = [];
      pending.forEach((resolve) => resolve());
    },
    of: (type) => sent.filter((m) => m.type === type),
  };
}

// Lets every chain started by pushAudio() run to where it next waits.
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

// Whisper, synthesis and a brain, all faked at fetch level like everywhere else.
function stubVendors({ transcript = 'hola', heard = 'spanish' } = {}) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: transcript, language: heard, duration: 2 }) };
    if (u.includes('/audio/speech')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('MP3-BYTES').buffer };
    throw new Error(`unexpected ${u}`);
  };
  return calls;
}

function stubBrain(reply = 'Valore con FXP.') {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push({ ...request, messages: [...request.messages] });
        const text = typeof reply === 'function' ? reply(request, calls.length) : reply;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 30 } };
      },
    },
  };
}

// Speak, then go quiet, so the detector calls the turn.
async function speakAndStop(session, { level = 4000, speechMs = 600, silenceMs = 900 } = {}) {
  for (let i = 0; i < speechMs / 20; i++) session.pushAudio(frame(level));
  for (let i = 0; i < silenceMs / 20; i++) session.pushAudio(frame(4));
}

test('raw call audio becomes a file the transcribers accept, and reads back', () => {
  const pcm = [frame(1000), frame(-1000)];
  const file = wav.pcmToWav(pcm, { sampleRate: RATE });
  assert.equal(file.toString('latin1', 0, 4), 'RIFF');
  assert.equal(file.toString('latin1', 8, 12), 'WAVE');
  assert.equal(file.readUInt32LE(24), RATE);
  assert.equal(file.readUInt16LE(22), 1, 'mono');
  assert.equal(file.length, 44 + FRAME * 2 * 2);
  assert.equal(file.readUInt32LE(4), file.length - 8);

  const back = wav.wavToPcm(file);
  assert.equal(back.sampleRate, RATE);
  assert.equal(back.pcm.length, FRAME * 2 * 2);
  assert.ok(Math.abs(wav.pcmSeconds(pcm, { sampleRate: RATE }) - 0.04) < 1e-9);
  assert.equal(wav.wavToPcm(Buffer.from('not a wav')), null);
});

test('a call greets, hears a turn, answers it, and speaks it', async () => {
  const transport = fakeTransport();
  const outside = stubVendors({ transcript: '¿Cómo emito el billete?', heard: 'spanish' });
  const anthropic = stubBrain('Con TTP, después de valorar con FXP.');
  const turns = [];
  const session = new live.LiveSession({ sessionId: 'live-1', number: '+34 600 111 222', anthropic, transport, onTurn: (t) => turns.push(t) });

  await session.start();
  assert.equal(session.state, 'listening');
  // Nothing has been heard yet, so the Spanish number decides the greeting.
  assert.match(JSON.parse(outside.find((c) => c.url.includes('/audio/speech')).init.body).input, /Hola, soy tu asesor de viajes/, 'it said what it is first, in their language');

  await speakAndStop(session);
  await settle();

  const heard = transport.of('transcript')[0];
  assert.equal(heard.text, '¿Cómo emito el billete?');
  assert.equal(heard.language, 'es');
  const answered = transport.of('reply')[0];
  assert.equal(answered.text, 'Con TTP, después de valorar con FXP.');
  assert.equal(transport.of('audio').length, 2, 'the greeting and the answer');
  assert.equal(transport.of('audio')[1].format, 'mp3');
  assert.ok(Buffer.from(transport.of('audio')[1].data, 'base64').length > 0);

  // The advisor, whole: the prompt, the language, the case.
  assert.match(anthropic.calls[0].system.map((b) => b.text).join(), /Reply entirely in Spanish/);
  assert.deepEqual(context.caseFor('live-1').entries, ['TTP', 'FXP'], 'the case is kept as on any other channel');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].interrupted, false);
  assert.ok(turns[0].costUsd > 0);
  assert.equal(turns[0].providers.llm, 'anthropic');

  const states = transport.of('state').map((m) => m.state);
  assert.deepEqual(states, ['speaking', 'listening', 'thinking', 'speaking', 'listening']);
});

test('the caller talking over the answer stops it dead', async () => {
  const transport = fakeTransport({ hold: true });
  stubVendors({ transcript: 'Una pregunta', heard: 'spanish' });
  const session = new live.LiveSession({ sessionId: 'live-2', anthropic: stubBrain('Una respuesta larga.'), transport, greet: false });
  await session.start();

  const barges = [];
  session.on('barge-in', (e) => barges.push(e));
  await speakAndStop(session);
  await settle();
  assert.equal(session.state, 'speaking', 'the answer is playing');

  // They cut in. Loud, because barge-in is held to a higher bar.
  for (let i = 0; i < 20; i++) session.pushAudio(frame(12000));
  assert.equal(barges.length, 1);
  assert.equal(session.state, 'listening');
  assert.equal(transport.of('interrupt').length, 1);

  transport.finishPlayback();
  await settle();
  // What they heard counts as said: the reply is in history, not replayed.
  assert.equal(transport.of('reply').length, 1);
});

test('an answer overtaken by a new question is thrown away rather than spoken late', async () => {
  const transport = fakeTransport();
  let resolveBrain;
  const anthropic = {
    calls: [],
    messages: {
      create: async (request) => {
        anthropic.calls.push(request);
        if (anthropic.calls.length === 1) {
          await new Promise((r) => { resolveBrain = r; });
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'La primera respuesta.' }], usage: { input_tokens: 10, output_tokens: 5 } };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'La segunda respuesta.' }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  stubVendors({ transcript: 'Primera', heard: 'spanish' });
  const session = new live.LiveSession({ sessionId: 'live-3', anthropic, transport, greet: false });
  await session.start();

  await speakAndStop(session);
  await settle();
  assert.equal(session.state, 'thinking');

  // They ask again before the first answer arrives.
  await speakAndStop(session);
  await settle();
  resolveBrain();
  await settle();

  const replies = transport.of('reply').map((m) => m.text);
  assert.ok(!replies.includes('La primera respuesta.'), 'the overtaken answer never reached them');
});

test('a failure is said out loud, in their language, and the call goes on', async () => {
  const transport = fakeTransport();
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/audio/transcriptions')) throw new Error('Whisper is down');
    if (u.includes('/audio/speech')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('MP3').buffer };
    throw new Error(`unexpected ${u}`);
  };
  const session = new live.LiveSession({ sessionId: 'live-4', anthropic: stubBrain(), transport, language: 'fr', greet: false });
  await session.start();
  session.on('error', () => {});

  await speakAndStop(session);
  await settle();

  assert.equal(transport.of('error').length, 1);
  assert.match(transport.of('error')[0].detail, /Whisper is down/);
  assert.equal(session.state, 'listening', 'the call is still up');
  assert.ok(transport.of('audio').length >= 1, 'and they heard why');
});

test('a locator on a call is read back spelled out, as it is on a voice note', async () => {
  const transport = fakeTransport();
  const outside = stubVendors({ transcript: 'No me valora el localizador X7K2PQ', heard: 'spanish' });
  const session = new live.LiveSession({ sessionId: 'live-5', anthropic: stubBrain('Pruebe FXP.'), transport, greet: false });
  await session.start();
  await speakAndStop(session);
  await settle();

  const spoken = JSON.parse(outside.filter((c) => c.url.includes('/audio/speech')).at(-1).init.body).input;
  assert.match(spoken, /^He entendido: Localizador X de Xiquena, 7, K de Kilo/);
  assert.match(spoken, /F-X-P/, 'and the entry is spelled for the voice');
  assert.match(transport.of('reply')[0].readBack, /Localizador: X7K2PQ/);
});

test('asking for a person on a call raises a handoff without ending it', async () => {
  const transport = fakeTransport();
  stubVendors({ transcript: 'quiero hablar con una persona', heard: 'spanish' });
  const session = new live.LiveSession({ sessionId: 'live-6', anthropic: stubBrain('Le paso con alguien.'), transport, greet: false });
  const handoffs = [];
  session.on('handoff', (h) => handoffs.push(h));
  await session.start();
  await speakAndStop(session);
  await settle();

  assert.equal(handoffs.length, 1);
  assert.match(handoffs[0].reason, /asked for a person/);
  assert.equal(session.state, 'listening');
});

test('ending a call closes the transport once and reports the call', async () => {
  const transport = fakeTransport();
  stubVendors();
  const session = new live.LiveSession({ sessionId: 'live-7', anthropic: stubBrain(), transport, greet: false });
  await session.start();
  const ends = [];
  session.on('end', (e) => ends.push(e));

  session.end('hung-up');
  assert.equal(session.state, 'ended');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'hung-up');
  assert.equal(transport.of('closed').length, 1);

  session.end('again');
  assert.equal(ends.length, 1, 'ending twice is not two calls');
  session.pushAudio(frame(9000));
  assert.deepEqual(session.summary().state, 'ended');
});


test('a call with no number and nothing heard yet greets in English, and switches once they speak', async () => {
  const transport = fakeTransport();
  stubVendors({ transcript: 'Bonjour, une question sur FXP', heard: 'french' });
  const session = new live.LiveSession({ sessionId: 'live-8', anthropic: stubBrain('Bien sûr.'), transport });
  await session.start();
  assert.equal(session.language, null, 'nothing to go on');
  await speakAndStop(session);
  await settle();
  assert.equal(session.language, 'fr');
  assert.equal(transport.of('reply')[0].language, 'fr');
});
