// Keeping a demo's voice notes as benchmark audio: only when switched on,
// named the way the bench reads, and swept like everything else.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let capture;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-capture-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  capture = await import('../travelVoice/qa/capture.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => capture.__resetCaptureForTests());

test('nothing is kept unless it was switched on', () => {
  assert.equal(capture.capturing(), false);
  assert.equal(capture.captureVoiceNote({ audio: Buffer.from('OggS'), transcript: 'hola' }), null);
  assert.deepEqual(capture.capturedFixtures(), []);

  capture.setCapturing(true);
  assert.equal(capture.capturing(), true);
  const id = capture.captureVoiceNote({ audio: Buffer.from('OggS-audio'), filename: 'voice.ogg', transcript: 'no me valora el localizador X7K2PQ', language: 'es' });
  assert.match(id, /^es-\d{14}-[a-z0-9]{4}$/);
  assert.equal(capture.captureState().count, 1);

  capture.setCapturing(false);
  assert.equal(capture.captureVoiceNote({ audio: Buffer.from('x'), transcript: 'more' }), null, 'and stops when switched off');
});

test('a fixture is audio beside its transcript, in the layout the bench reads', async () => {
  const { loadFixtures } = await import('../travelVoice/bench/stt.js');
  capture.setCapturing(true);
  capture.captureVoiceNote({ audio: Buffer.from('OggS-1'), filename: 'voice.ogg', transcript: 'no me valora el localizador X7K2PQ', language: 'es' });
  capture.captureVoiceNote({ audio: Buffer.from('OggS-2'), filename: 'voice.ogg', transcript: 'remboursement du dossier ABCDEF', language: 'fr' });

  const fixtures = capture.capturedFixtures();
  assert.equal(fixtures.length, 2);
  assert.deepEqual(fixtures.map((f) => f.language).sort(), ['es', 'fr']);
  assert.match(fixtures.find((f) => f.language === 'es').reference, /X7K2PQ/);

  // The bench reads the same folder without being told anything about capture.
  const read = loadFixtures(capture.captureDir());
  assert.equal(read.length, 2);
  assert.deepEqual(read.map((f) => f.language).sort(), ['es', 'fr']);
});

test('an empty transcript is not a fixture, and the sweep forgets old voices', () => {
  capture.setCapturing(true);
  assert.equal(capture.captureVoiceNote({ audio: Buffer.from('x'), transcript: '   ', language: 'es' }), null);
  assert.equal(capture.captureVoiceNote({ audio: Buffer.alloc(0), transcript: 'hola', language: 'es' }), null);
  capture.captureVoiceNote({ audio: Buffer.from('OggS'), transcript: 'hola', language: 'es' });
  assert.equal(capture.capturedFixtures().length, 1);

  assert.equal(capture.sweepFixtures(Date.now() - 60000), 0, 'a fresh one stays');
  assert.equal(capture.sweepFixtures(Date.now() + 60000), 1, 'an old one goes');
  assert.deepEqual(capture.capturedFixtures(), []);
  assert.equal(fs.readdirSync(capture.captureDir()).length, 0, 'the transcript goes with the audio');
});
