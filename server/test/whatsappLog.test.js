// The log exists to answer "did my message arrive, and how far did it get?"
// without reading deploy logs — so what's worth testing is that each stage is
// distinguishable afterwards, and that instrumentation can never be the thing
// that breaks the webhook.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let log;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-whatsapplog-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  log = await import('../channels/whatsappLog.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  log.__resetLogForTests();
});

test('an empty log is the "Meta never called" diagnosis, not an error', () => {
  const { events, receipts } = log.recentInbound();
  assert.deepEqual(events, []);
  assert.equal(receipts.count, 0);
  assert.equal(receipts.lastAt, null);
});

test('each stage comes back distinguishable, with a readable summary', () => {
  for (const stage of Object.values(log.STAGES)) {
    log.recordInbound({ stage, from: '447700900123', text: 'status?' });
  }

  const { events } = log.recentInbound();
  assert.equal(events.length, Object.keys(log.STAGES).length);
  for (const event of events) {
    // The summary is what the founder reads, so it must not fall back to the
    // raw stage key for any stage that actually gets recorded.
    assert.notEqual(event.summary, event.stage, `stage ${event.stage} has no summary`);
    assert.match(event.summary, /[a-z]/);
  }
});

test('newest first — a debugging session cares about the last message, not the first', () => {
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'oldest' });
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '2', text: 'newest' });

  const { events } = log.recentInbound();
  assert.equal(events[0].preview, 'newest');
  assert.equal(events[1].preview, 'oldest');
});

test('a rejected signature is recorded without a sender, since the body is untrusted', () => {
  log.recordInbound({ stage: log.STAGES.BAD_SIGNATURE });

  const { events } = log.recentInbound();
  assert.equal(events[0].from, null);
  assert.equal(events[0].preview, null);
  assert.match(events[0].summary, /WHATSAPP_APP_SECRET/);
});

test('receipts are counted, not listed, so they cannot flush real messages out', () => {
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'the real one' });
  for (let i = 0; i < 200; i++) log.recordReceipt();

  const { events, receipts } = log.recentInbound();
  assert.equal(events.length, 1);
  assert.equal(events[0].preview, 'the real one');
  assert.equal(receipts.count, 200);
  assert.ok(receipts.lastAt, 'a receipt timestamp proves Meta is calling the webhook');
});

test('the log is capped, keeping the most recent messages', () => {
  for (let i = 0; i < 80; i++) {
    log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: `msg-${i}` });
  }

  const { events } = log.recentInbound();
  assert.ok(events.length <= 50, `kept ${events.length} events`);
  assert.equal(events[0].preview, 'msg-79');
});

test('message text is truncated — this is a diagnostic, not a second transcript', () => {
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x'.repeat(500) });

  const { events } = log.recentInbound();
  assert.ok(events[0].preview.length < 200);
});

test('a failure to write is swallowed, so instrumentation never breaks the webhook', () => {
  const saved = process.env.JARVIS_DATA_DIR;
  // Point the store at a path that cannot be created, which is the realistic
  // production failure: a volume that did not mount.
  process.env.JARVIS_DATA_DIR = '/proc/version/definitely-not-a-directory';
  try {
    assert.doesNotThrow(() => log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'hi' }));
    assert.doesNotThrow(() => log.recordReceipt());
  } finally {
    process.env.JARVIS_DATA_DIR = saved;
  }
});
