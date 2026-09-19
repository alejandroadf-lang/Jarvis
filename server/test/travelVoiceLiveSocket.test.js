// A live call over a real WebSocket: frames up, audio down, playback
// acknowledged, and a dropped socket that does not leave a call hanging.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';

let tmpDir;
let attachLiveCalls;
let originalFetch;
const saved = {};
const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DAILY_SPEND_CAP_USD', 'TRAVEL_VOICE_CONSENT', 'TRAVEL_VOICE_ALLOWED_NUMBERS', 'TRAVEL_VOICE_GROUNDING_RETRY', 'TRAVEL_VOICE_LANGUAGE_RETRY'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-socket-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  ({ attachLiveCalls } = await import('../travelVoice/live/websocket.js'));
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
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: '¿Cómo emito el billete?', language: 'spanish', duration: 2 }) };
    if (u.includes('/audio/speech')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('MP3').buffer };
    throw new Error(`unexpected ${u}`);
  };
});

const FRAME = 320;
function frame(level) {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) samples[i] = i % 2 ? level : -level;
  return Buffer.from(samples.buffer);
}

const anthropic = {
  messages: {
    create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Con TTP.' }], usage: { input_tokens: 10, output_tokens: 5 } }),
  },
};

async function withServer(run, { query = '' } = {}) {
  const server = http.createServer();
  const calls = attachLiveCalls(server, { anthropic });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const socket = new WebSocket(`ws://127.0.0.1:${port}${calls.path}?sessionId=t1${query}`);
  const seen = [];
  socket.on('message', (data) => seen.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    return await run({ socket, seen, calls, server });
  } finally {
    try { socket.close(); } catch { /* already gone */ }
    calls.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5)); };
const of = (seen, type) => seen.filter((m) => m.type === type);

test('a browser can hold a whole turn over the socket', async () => {
  await withServer(async ({ socket, seen, calls }) => {
    await settle();
    // The greeting goes out and waits to be played.
    assert.equal(of(seen, 'audio').length, 1, 'it greeted');
    assert.equal(of(seen, 'state').at(-1).state, 'speaking', 'and is waiting for the browser to finish playing it');
    socket.send(JSON.stringify({ type: 'played' }));
    await settle();
    assert.equal(of(seen, 'state').at(-1).state, 'listening');

    for (let i = 0; i < 30; i++) socket.send(frame(4000));
    for (let i = 0; i < 45; i++) socket.send(frame(4));
    await settle(14);

    assert.equal(of(seen, 'transcript')[0].text, '¿Cómo emito el billete?');
    assert.equal(of(seen, 'reply')[0].text, 'Con TTP.');
    assert.equal(of(seen, 'audio').length, 2);
    assert.equal(Buffer.from(of(seen, 'audio')[1].data, 'base64').toString(), 'MP3');
    assert.deepEqual(calls.live().map((s) => s.turns), [1]);

    socket.send(JSON.stringify({ type: 'bye' }));
    await settle();
    assert.equal(of(seen, 'state').at(-1).reason, 'hung-up');
  });
});

test('a socket that drops mid-answer ends the call rather than leaving it waiting', async () => {
  await withServer(async ({ socket, calls }) => {
    await settle();
    socket.terminate();
    await settle();
    assert.deepEqual(calls.live().map((s) => s.state), [], 'the call is gone, not stuck speaking');
  });
});

test('a number the deployment shut out is refused at the door', async () => {
  process.env.TRAVEL_VOICE_ALLOWED_NUMBERS = '+34 600 111 222';
  await withServer(async ({ seen, calls }) => {
    await settle();
    assert.equal(of(seen, 'error').length, 1);
    assert.match(of(seen, 'error')[0].detail, /outside TRAVEL_VOICE_ALLOWED_NUMBERS/);
    assert.deepEqual(calls.live(), [], 'no call was started');
  }, { query: '&number=%2B33600000000' });
});

test('an unreadable frame is ignored rather than dropping the call', async () => {
  await withServer(async ({ socket, seen, calls }) => {
    await settle();
    socket.send('{not json at all');
    await settle();
    assert.equal(calls.live().length, 1, 'still up');
    assert.ok(of(seen, 'audio').length >= 1);
  });
});
