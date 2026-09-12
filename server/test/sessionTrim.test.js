// The CEO stopped remembering what the founder had just agreed. Two causes
// were stacked: the data directory was being wiped on every deploy (fixed
// separately), and the history cap was 20 messages — user and assistant
// combined, so ten exchanges. Fine for a web chat opened to ask one thing,
// badly wrong for WhatsApp, where a real conversation passes ten exchanges
// before lunch.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let store;
const KEYS = ['SESSION_MAX_MESSAGES', 'SESSION_MAX_CHARS'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-trim-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  store = await import('../sessionStore.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

function conversation(pairs, text = 'a short message') {
  const history = [];
  for (let i = 0; i < pairs; i++) {
    history.push({ role: 'user', content: `${text} ${i}` });
    history.push({ role: 'assistant', content: `reply ${i}` });
  }
  return history;
}

test('a long chat conversation survives — this is the bug that was reported', () => {
  // Forty exchanges is an ordinary morning on WhatsApp. Under the old cap,
  // the first thirty were already gone.
  const kept = store.trimHistory(conversation(40));

  assert.ok(kept.length > 20, `kept only ${kept.length} messages`);
  assert.match(kept[0].content, /a short message/);
});

test('the most recent messages are the ones kept', () => {
  const kept = store.trimHistory(conversation(200));

  assert.equal(kept.at(-1).content, 'reply 199');
  assert.equal(kept.at(-2).content, 'a short message 199');
});

test('a few enormous messages cannot dominate the window', () => {
  // A message count alone misses this: ten pasted documents would be carried
  // in full on every subsequent turn.
  const huge = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: 'x'.repeat(20000) + i }));

  const kept = store.trimHistory(huge);

  const total = kept.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= 80000, `kept ${total} characters`);
  assert.ok(kept.length < 20, 'the character budget must bite before the message count');
});

test('the last message is always kept, however large', () => {
  // A turn with no history at all still beats one that drops what was just
  // said.
  const kept = store.trimHistory([{ role: 'user', content: 'y'.repeat(500000) }]);

  assert.equal(kept.length, 1);
});

test('content blocks are measured, not treated as free', () => {
  const blocks = Array.from({ length: 50 }, () => ({
    role: 'assistant',
    content: [{ type: 'text', text: 'z'.repeat(5000) }],
  }));

  const kept = store.trimHistory(blocks);

  assert.ok(kept.length < 50, 'array content must count towards the budget');
});

test('both limits are tunable without a redeploy', () => {
  process.env.SESSION_MAX_MESSAGES = '4';
  const kept = store.trimHistory(conversation(10));
  assert.equal(kept.length, 4);
});

test('a short conversation is returned untouched', () => {
  const history = conversation(3);
  assert.deepEqual(store.trimHistory(history), history);
});

test('an empty history is not an error', () => {
  assert.deepEqual(store.trimHistory([]), []);
  assert.deepEqual(store.trimHistory(undefined), []);
});
