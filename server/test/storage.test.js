// The company's whole memory lives in a data directory, and on a container
// host that directory is wiped on every redeploy unless a volume is mounted.
// Nothing said so, so it was discovered by noticing a record had vanished —
// days after it started happening.
//
// "Is this directory persistent" can't be answered by looking at it. "Has
// anything here survived a restart" can, and that's the question that
// matters.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let storage;
let savedDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-storage-test-'));
  savedDir = process.env.JARVIS_DATA_DIR;
  process.env.JARVIS_DATA_DIR = tmpDir;
  storage = await import('../storage.js');
});

after(() => {
  if (savedDir === undefined) delete process.env.JARVIS_DATA_DIR;
  else process.env.JARVIS_DATA_DIR = savedDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.JARVIS_DATA_DIR = tmpDir;
  fs.rmSync(path.join(tmpDir, 'storage.json'), { force: true });
});

test('one boot is ambiguous, and says exactly what would settle it', () => {
  storage.recordBoot();

  const status = storage.getStorageStatus();

  // A first-ever start looks identical to a directory that was just emptied.
  // Guessing either way would be wrong half the time.
  assert.equal(status.persistent, null);
  assert.equal(status.boots, 1);
  assert.match(status.detail, /Redeploy and check again/);
});

test('a second boot in the same directory proves it persisted', () => {
  storage.recordBoot();
  storage.recordBoot();

  const status = storage.getStorageStatus();

  assert.equal(status.persistent, true);
  assert.equal(status.boots, 2);
  assert.match(status.detail, /survived 1 restart\b/);
});

test('restarts are counted, and read as English', () => {
  for (let i = 0; i < 4; i++) storage.recordBoot();

  assert.match(storage.getStorageStatus().detail, /survived 3 restarts/);
});

test('a wiped directory falls back to first boot — which is the signal', () => {
  storage.recordBoot();
  storage.recordBoot();
  assert.equal(storage.getStorageStatus().persistent, true);

  // What a redeploy without a mounted volume actually does.
  fs.rmSync(path.join(tmpDir, 'storage.json'), { force: true });
  storage.recordBoot();

  const status = storage.getStorageStatus();
  assert.equal(status.boots, 1);
  assert.equal(status.persistent, null, 'back to "unknown", which after a redeploy means "not persisting"');
});

test('no JARVIS_DATA_DIR is reported as not persistent, with the fix named', () => {
  delete process.env.JARVIS_DATA_DIR;

  const status = storage.getStorageStatus();

  assert.equal(status.persistent, false);
  assert.equal(status.dirConfigured, false);
  assert.match(status.detail, /Mount a volume/);
});

test('the first-seen date is kept across boots, so the window is knowable', () => {
  storage.recordBoot();
  const first = storage.getStorageStatus().firstSeenAt;
  storage.recordBoot();

  assert.equal(storage.getStorageStatus().firstSeenAt, first);
});

test('recording a boot never throws, whatever the disk is doing', () => {
  const saved = process.env.JARVIS_DATA_DIR;
  // A volume that failed to mount is the realistic version of this.
  process.env.JARVIS_DATA_DIR = '/proc/version/not-a-directory';
  try {
    assert.doesNotThrow(() => storage.recordBoot());
    // A diagnostic that takes the server down is worse than the problem it
    // reports, so the status must degrade rather than throw too.
    assert.equal(storage.getStorageStatus().persistent, false);
  } finally {
    process.env.JARVIS_DATA_DIR = saved;
  }
});

test('warnIfEphemeral shouts only when state is actually at risk', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    storage.recordBoot();
    storage.recordBoot();
    storage.warnIfEphemeral();
    assert.equal(warnings.length, 0, 'a persistent directory must not nag on every boot');

    delete process.env.JARVIS_DATA_DIR;
    storage.warnIfEphemeral();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not persistent/);
  } finally {
    console.warn = original;
  }
});
