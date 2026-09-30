// The briefing runs at 08:00 Bangkok on its own clock, not as the tail of the
// daily meeting. Pinned: it is scheduled for the next 01:00 UTC; a server that
// starts after today's slot with nothing sent catches up shortly after boot and
// one that already sent does not; it does not need the daily meeting (which can
// be switched off to save tokens); a failing run never stops tomorrow's; and two
// overlapping calls send one briefing.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let sched;
let digest;
let store;
const ENV = ['SMTP_HOST', 'REPORT_EMAIL_TO', 'CONSULTANT_DIGEST_DISABLED', 'DAILY_MEETING_DISABLED'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-consultant-sched-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of ENV) saved[k] = process.env[k];
  sched = await import('../consultant/schedule.js');
  digest = await import('../consultant/digest.js');
  store = await import('../store.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  store.writeJson('consultant.json', { lastDate: null, history: [] });
});

const ENVOK = { ANTHROPIC_API_KEY: 'sk-ant-x' };
const fakeTimers = () => {
  const set = [];
  return { set, api: { set: (fn, ms) => { set.push({ fn, ms }); return set.length; }, clear: () => {} } };
};

test('before the slot it waits for 01:00 UTC, which is 08:00 in Bangkok', () => {
  const t = fakeTimers();
  const now = new Date('2026-10-10T00:30:00Z');
  sched.startConsultantScheduler({ run: async () => ({}), timers: t.api, now: () => now, env: ENVOK });
  assert.equal(t.set.length, 1);
  assert.equal(t.set[0].ms, 30 * 60_000);
});

test('started after the slot with nothing sent today, it catches up shortly after boot; after a send it waits for tomorrow', () => {
  let t = fakeTimers();
  const afternoon = new Date('2026-10-10T07:00:00Z');
  sched.startConsultantScheduler({ run: async () => ({}), timers: t.api, now: () => afternoon, env: ENVOK });
  assert.equal(t.set[0].ms, sched.STARTUP_DELAY_MS);

  store.writeJson('consultant.json', { lastDate: '2026-10-10', history: [{ date: '2026-10-10' }] });
  t = fakeTimers();
  sched.startConsultantScheduler({ run: async () => ({}), timers: t.api, now: () => afternoon, env: ENVOK });
  assert.equal(t.set[0].ms, new Date('2026-10-11T01:00:00Z') - afternoon, 'already sent today, so it waits for tomorrow 08:00 Bangkok');
});

test('a run happens, and a failing one never stops tomorrow', async () => {
  const t = fakeTimers();
  let calls = 0;
  const now = new Date('2026-10-10T07:00:00Z');
  sched.startConsultantScheduler({ anthropic: 'A', run: async (o) => { calls += 1; assert.equal(o.anthropic, 'A'); throw new Error('provider down'); }, timers: t.api, now: () => now, env: ENVOK });
  await t.set[0].fn();
  assert.equal(calls, 1);
  assert.equal(t.set.length, 2, 'tomorrow is scheduled even after a failure');
  assert.equal(t.set[1].ms, new Date('2026-10-11T01:00:00Z') - now);
});

test('it does not depend on the daily meeting being enabled, and stays off without a key, a destination or when switched off', () => {
  process.env.DAILY_MEETING_DISABLED = 'true';
  const t = fakeTimers();
  const now = new Date('2026-10-10T00:30:00Z');
  const stop = sched.startConsultantScheduler({ run: async () => ({}), timers: t.api, now: () => now, env: ENVOK });
  assert.equal(typeof stop, 'function', 'the meeting being off does not stop the briefing');

  assert.equal(sched.startConsultantScheduler({ timers: t.api, now: () => now, env: {} }), null, 'no model key');
  assert.equal(sched.startConsultantScheduler({ timers: t.api, now: () => now, env: { ...ENVOK, CONSULTANT_DIGEST_DISABLED: 'true' } }), null);
  delete process.env.SMTP_HOST;
  assert.equal(sched.startConsultantScheduler({ timers: t.api, now: () => now, env: ENVOK }), null, 'nowhere to deliver it');
});

test('two overlapping calls build and send one briefing', async () => {
  let sends = 0;
  const member = { name: 'Claude', tier: 'frontier', create: async () => ({ content: [{ type: 'text', text: '## Verdict\nOk [E1]' }], usage: { input_tokens: 10, output_tokens: 10 } }) };
  const opts = { now: new Date('2026-10-10T01:00:00Z'), members: [member], refresh: async () => {}, modelScan: async () => {}, send: async () => { sends += 1; }, publish: async () => true };
  const [a, b] = await Promise.all([digest.runConsultantDigest(opts), digest.runConsultantDigest(opts)]);
  assert.equal(a, b, 'the second caller gets the first one\'s result');
  assert.equal(sends, 1);
  assert.equal((await digest.runConsultantDigest(opts)).sent, false, 'and the once-a-day rule still holds afterwards');
});
