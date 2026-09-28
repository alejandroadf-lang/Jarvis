import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let store;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-store-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  store = await import('../store.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a missing file is created from the fallback, as a copy', () => {
  const fallback = { items: [] };
  const first = store.readJson('fresh.json', fallback);
  first.items.push('changed by the caller');
  assert.deepEqual(store.readJson('fresh.json', fallback), { items: [] }, 'the fallback object itself is never handed out');
  assert.ok(fs.existsSync(path.join(tmpDir, 'fresh.json')));
});

test('writeJson leaves no temporary file behind and the file reads back whole', () => {
  store.writeJson('ledger.json', { transactions: [{ amount: 1 }] });
  assert.deepEqual(store.readJson('ledger.json', {}), { transactions: [{ amount: 1 }] });
  const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a write that fails midway keeps the previous file intact', () => {
  store.writeJson('ventures.json', { ventures: ['before'] });
  // JSON.stringify throws on a BigInt, after the previous file exists and
  // before anything is renamed over it: the failure mode a crash mid-write
  // has, without needing to crash.
  assert.throws(() => store.writeJson('ventures.json', { ventures: [1n] }), TypeError);
  assert.deepEqual(store.readJson('ventures.json', {}), { ventures: ['before'] });
  assert.deepEqual(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp')), []);
});

test('a corrupt file names itself and is not replaced', () => {
  const file = path.join(tmpDir, 'sessions.json');
  fs.writeFileSync(file, '{"jarvis": {"s1": [{"role": "user", "content": "hi"');
  assert.throws(() => store.readJson('sessions.json', {}), (err) => {
    assert.equal(err.code, 'STORE_CORRUPT');
    assert.equal(err.file, file);
    assert.match(err.message, /sessions\.json is not valid JSON/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf-8').startsWith('{"jarvis"'), true, 'the file is left for recovery');
});

test('updateJson reads, changes and writes in one step', () => {
  const out = store.updateJson('spend.json', { days: {} }, (data) => {
    data.days['2026-09-28'] = 1.5;
    return data;
  });
  assert.deepEqual(out, { days: { '2026-09-28': 1.5 } });
  assert.deepEqual(store.readJson('spend.json', {}), { days: { '2026-09-28': 1.5 } });
  // A change that mutates in place and returns nothing still saves.
  store.updateJson('spend.json', { days: {} }, (data) => { data.days['2026-09-29'] = 2; });
  assert.equal(store.readJson('spend.json', {}).days['2026-09-29'], 2);
});
