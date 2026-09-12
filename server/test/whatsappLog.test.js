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

// --- Telling someone how long to wait ---------------------------------------
// A real turn takes minutes, and from a phone that is indistinguishable from
// the thing being broken — which it has been more than once this week.

test('with no history it says so plainly rather than inventing a number', () => {
  assert.match(log.waitingMessage(), /minute or two/);
  assert.equal(log.typicalTurnMs(), null);
});

test('one sample is not enough to quote a figure', () => {
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 60_000 });
  assert.equal(log.typicalTurnMs(), null);
});

test('the estimate is measured from turns that actually completed', () => {
  for (const ms of [40_000, 60_000, 80_000]) {
    log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: ms });
  }

  assert.equal(log.typicalTurnMs(), 60_000);
  assert.match(log.waitingMessage(), /about 1 minute/);
});

test('a single disastrous turn does not move the number', () => {
  // The median, not the mean: one turn that hit a retry storm and took eight
  // minutes should not change what anyone is quoted.
  for (const ms of [30_000, 30_000, 30_000, 480_000]) {
    log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: ms });
  }

  assert.equal(log.typicalTurnMs(), 30_000);
});

test('failed turns are not counted — they say nothing about how long an answer takes', () => {
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 60_000 });
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 60_000 });
  log.recordInbound({ stage: log.STAGES.FAILED, from: '1', text: 'x', durationMs: 1 });

  assert.equal(log.typicalTurnMs(), 60_000);
});

test('sub-minute answers are quoted in seconds, rounded so as not to imply precision', () => {
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 22_000 });
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 26_000 });

  assert.match(log.waitingMessage(), /about 30 seconds/);
});

test('past a minute the estimate rounds up, never down', () => {
  // An answer arriving sooner than quoted is a pleasant surprise; one
  // arriving later feels like the thing has broken, which is the impression
  // this message exists to prevent.
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 70_000 });
  log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 80_000 });

  assert.match(log.waitingMessage(), /about 2 minutes/);
});

test('a failure records how long it ran before breaking', () => {
  // A config error that fails instantly and a turn that ran four minutes and
  // then broke are different problems; the message alone cannot tell them apart.
  log.recordInbound({ stage: log.STAGES.FAILED, from: '1', text: 'x', detail: 'credit balance too low', durationMs: 240_000 });

  const [entry] = log.recentInbound().events;
  assert.equal(entry.durationMs, 240_000);
});

test('only the most recent turns count, so the estimate tracks reality', () => {
  for (let i = 0; i < 12; i++) {
    log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 300_000 });
  }
  for (let i = 0; i < 10; i++) {
    log.recordInbound({ stage: log.STAGES.ANSWERED, from: '1', text: 'x', durationMs: 30_000 });
  }

  assert.equal(log.typicalTurnMs(), 30_000, 'yesterday\'s slowness must not haunt today');
});
