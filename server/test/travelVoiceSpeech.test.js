// Ears and voice. The two things worth pinning: transcription asks for the
// language only from a model that can report it, and speech comes back as
// Ogg Opus so WhatsApp plays it as a voice note. Both meter the spend cap.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeOpus } from './travelVoiceOgg.test.js';
import { oggOpusComments } from '../travelVoice/ogg.js';

let tmpDir;
let speech;
let spend;
let originalFetch;
const saved = {};
const KEYS = ['OPENAI_API_KEY', 'OPENAI_TRANSCRIBE_MODEL', 'TRAVEL_VOICE_TTS_MODEL', 'TRAVEL_VOICE_TTS_VOICE', 'DAILY_SPEND_CAP_USD'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-speech-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  speech = await import('../travelVoice/speech.js');
  spend = await import('../spend.js');
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
  process.env.OPENAI_API_KEY = 'oa-key';
  global.fetch = originalFetch;
});

test('whisper is asked for verbose_json and its language is reported as a code', async () => {
  let seen;
  global.fetch = async (url, init) => {
    seen = { url: String(url), body: init.body };
    return { ok: true, json: async () => ({ text: ' Necesito el precio ', language: 'spanish', duration: 6.2 }) };
  };

  const before = spend.getSpendToday();
  const result = await speech.transcribeWithLanguage(Buffer.from('audio'), { filename: 'voice.ogg' });

  assert.match(seen.url, /audio\/transcriptions/);
  assert.equal(seen.body.get('response_format'), 'verbose_json');
  assert.equal(seen.body.get('model'), 'whisper-1');
  assert.equal(result.text, 'Necesito el precio');
  assert.equal(result.language, 'es');
  assert.equal(result.durationSeconds, 6.2);
  assert.ok(spend.getSpendToday() > before, 'transcription is metered against the daily cap');
});

test('a model that cannot report the language is asked for plain json and reports none', async () => {
  process.env.OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
  let seen;
  global.fetch = async (_url, init) => {
    seen = init.body;
    return { ok: true, json: async () => ({ text: 'Bonjour' }) };
  };

  const result = await speech.transcribeWithLanguage(Buffer.from('audio'));
  assert.equal(seen.get('response_format'), 'json');
  assert.equal(result.language, null, 'left for the word heuristic to decide');
  assert.equal(result.durationSeconds, null);
});

test('a language hint is passed to the transcriber and wins', async () => {
  let seen;
  global.fetch = async (_url, init) => {
    seen = init.body;
    return { ok: true, json: async () => ({ text: 'ok', language: 'english', duration: 1 }) };
  };
  const result = await speech.transcribeWithLanguage(Buffer.from('x'), { languageHint: 'fr' });
  assert.equal(seen.get('language'), 'fr');
  assert.equal(result.language, 'fr');
});

test('a transcription failure carries its status', async () => {
  global.fetch = async () => ({ ok: false, status: 413, text: async () => 'too large' });
  await assert.rejects(() => speech.transcribeWithLanguage(Buffer.from('x')), (err) => err.status === 413 && /OpenAI transcription failed \(413\)/.test(err.message));
});

test('speech comes back as Ogg Opus with delivery instructions in the caller’s language', async () => {
  let seen;
  global.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('OggS...').buffer };
  };

  const before = spend.getSpendToday();
  const result = await speech.synthesizeSpeech('Utilice FXP para valorar el PNR.', { language: 'es' });

  assert.match(seen.url, /audio\/speech/);
  assert.equal(seen.body.response_format, 'opus');
  assert.equal(seen.body.model, 'gpt-4o-mini-tts');
  assert.match(seen.body.instructions, /español/);
  assert.equal(result.mimeType, 'audio/ogg');
  assert.equal(result.filename, 'reply.ogg');
  assert.equal(Buffer.from(result.buffer).toString(), 'OggS...');
  assert.ok(spend.getSpendToday() > before, 'synthesis is metered against the daily cap');
});

test('tts-1 gets no instructions field, which it would reject', async () => {
  process.env.TRAVEL_VOICE_TTS_MODEL = 'tts-1';
  let seen;
  global.fetch = async (_url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) };
  };
  await speech.synthesizeSpeech('Hello', { language: 'en' });
  assert.equal(seen.instructions, undefined);
});

test('with no audio provider at all the façade says which keys would give it one', async () => {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(() => speech.transcribeWithLanguage(Buffer.from('x')), /No speech-to-text provider is configured/);
  await assert.rejects(() => speech.synthesizeSpeech('Hello'), /No text-to-speech provider is configured/);
  assert.equal(speech.isSpeechConfigured(), false);
});

test('nothing is synthesised over the daily cap', async () => {
  process.env.DAILY_SPEND_CAP_USD = '0.0000001';
  spend.recordSpend(1);
  global.fetch = async () => {
    throw new Error('should not be called');
  };
  await assert.rejects(() => speech.synthesizeSpeech('Hello'), /Daily spend cap reached/);
});

test('speakable strips the markdown a spoken reply must not contain', () => {
  const text = '**Use FXP.**\n\n- first\n- second\n\n| a | b |\n\n```\nRT ABC123\n```\nSee [this](http://x).';
  const spoken = speech.speakable(text);
  assert.ok(!/[*|`#]/.test(spoken), spoken);
  assert.ok(!spoken.includes('http'), 'link targets are not read out');
  assert.match(spoken, /Use FXP\./);
  assert.match(spoken, /See this\./);
});

test('every synthesised voice note says inside the file that a machine made it', async () => {
  const opus = fakeOpus(2);
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => opus.buffer.slice(opus.byteOffset, opus.byteOffset + opus.length) });
  const result = await speech.synthesizeSpeech('Hola', { language: 'es' });
  assert.equal(result.marked, true);
  const comments = oggOpusComments(result.buffer);
  assert.ok(comments.includes('AI_GENERATED=true'));
  assert.ok(comments.includes('LANGUAGE=es'));
  assert.ok(comments.some((c) => c.startsWith('GENERATOR=openai/')));
  assert.ok(comments.some((c) => /Article 50/.test(c)));

  // The MP3 fallback has nowhere to write it and passes through untouched.
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('ID3mp3').buffer });
  const mp3 = await speech.synthesizeSpeech('Hola', { language: 'es', format: 'mp3' });
  assert.equal(mp3.marked, false);

  process.env.TRAVEL_VOICE_MARK_AUDIO = 'false';
  try {
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => opus.buffer.slice(opus.byteOffset, opus.byteOffset + opus.length) });
    const off = await speech.synthesizeSpeech('Hola', { language: 'es' });
    assert.equal(off.marked, false);
  } finally {
    delete process.env.TRAVEL_VOICE_MARK_AUDIO;
  }
});

