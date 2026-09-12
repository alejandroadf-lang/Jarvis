// Voice notes are the natural way to brief a team while walking, and until
// now they got an apology. What's worth pinning down is the two-call media
// download (the second URL still needs the token, which is easy to miss and
// fails as a confusing 401) and that a silent or failed note still answers.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractMessage, downloadMedia } from '../channels/whatsapp.js';
import { transcribeAudio } from '../agents/openai.js';

let originalFetch;
let savedToken;
let savedKey;

before(() => {
  originalFetch = global.fetch;
  savedToken = process.env.WHATSAPP_TOKEN;
  savedKey = process.env.OPENAI_API_KEY;
});

after(() => {
  global.fetch = originalFetch;
  if (savedToken === undefined) delete process.env.WHATSAPP_TOKEN; else process.env.WHATSAPP_TOKEN = savedToken;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
});

beforeEach(() => {
  global.fetch = originalFetch;
  process.env.WHATSAPP_TOKEN = 'wa-token';
  process.env.OPENAI_API_KEY = 'oa-key';
});

function webhook(message) {
  return { entry: [{ changes: [{ field: 'messages', value: { messages: [message] } }] }] };
}

test('a voice note carries a media id to fetch, not bytes', () => {
  const message = extractMessage(webhook({
    id: 'wamid.1', from: '66854882740', type: 'audio', audio: { id: 'media-123', mime_type: 'audio/ogg' },
  }));

  assert.equal(message.type, 'audio');
  assert.equal(message.mediaId, 'media-123');
  assert.equal(message.text, '');
});

test('a note recorded in-app and one attached as a file both resolve', () => {
  const recorded = extractMessage(webhook({ id: 'w1', from: '1', type: 'voice', voice: { id: 'v-1' } }));
  const attached = extractMessage(webhook({ id: 'w2', from: '1', type: 'audio', audio: { id: 'a-1' } }));

  assert.equal(recorded.mediaId, 'v-1');
  assert.equal(attached.mediaId, 'a-1');
});

test('a text message carries no media id', () => {
  const message = extractMessage(webhook({ id: 'w3', from: '1', type: 'text', text: { body: 'hello' } }));
  assert.equal(message.mediaId, null);
  assert.equal(message.text, 'hello');
});

test('downloading sends the token on both calls, including the download URL', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    if (String(url).includes('media-123')) {
      return { ok: true, json: async () => ({ url: 'https://lookaside.example/blob', mime_type: 'audio/ogg' }) };
    }
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('fake-audio').buffer };
  };

  const { buffer, filename } = await downloadMedia('media-123');

  assert.equal(calls.length, 2, 'resolve the id, then fetch the blob');
  // The one that catches people out: the blob URL looks public and is not.
  assert.equal(calls[1].auth, 'Bearer wa-token', 'the download URL needs the token too');
  assert.equal(filename, 'voice.ogg', 'the extension is how the decoder gets picked');
  assert.equal(Buffer.from(buffer).toString(), 'fake-audio');
});

test('an mp4 note keeps its own extension', async () => {
  global.fetch = async (url) => (String(url).includes('m-1')
    ? { ok: true, json: async () => ({ url: 'https://x/blob', mime_type: 'audio/mp4' }) }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) });

  const { filename } = await downloadMedia('m-1');
  assert.equal(filename, 'voice.mp4');
});

test('a failed media lookup explains itself rather than throwing a bare status', async () => {
  global.fetch = async () => ({ ok: false, status: 404, text: async () => 'media not found' });

  await assert.rejects(() => downloadMedia('gone'), /resolve the voice note \(404\)/);
});

test('transcription posts multipart with the model, and returns the words', async () => {
  let seen;
  global.fetch = async (url, init) => {
    seen = { url: String(url), body: init.body, auth: init.headers.Authorization };
    return { ok: true, json: async () => ({ text: '  get me the top ten ideas  ' }) };
  };

  const text = await transcribeAudio(Buffer.from('audio'), 'voice.ogg');

  assert.equal(text, 'get me the top ten ideas', 'trimmed, since it goes straight to the team');
  assert.match(seen.url, /audio\/transcriptions/);
  assert.equal(seen.auth, 'Bearer oa-key');
  assert.ok(seen.body instanceof FormData, 'must be multipart — a JSON body is rejected');
  assert.ok(seen.body.get('model'), 'the model is named in the form');
});

test('a transcription failure carries its status so the reply can name the reason', async () => {
  global.fetch = async () => ({ ok: false, status: 413, text: async () => 'file too large' });

  await assert.rejects(
    () => transcribeAudio(Buffer.from('x'), 'voice.ogg'),
    (err) => err.status === 413 && /Transcription failed \(413\)/.test(err.message)
  );
});
