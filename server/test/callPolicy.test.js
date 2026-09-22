// A phone number is the most exposed surface this app has. The WhatsApp
// webhook at least requires Meta to forward a message from an account; a
// published number can be dialled by a wrong number, an autodialer, or anyone
// who reads it off a screenshot. And a call bills by the minute for as long as
// it stays open, so getting this wrong does not cost an unwanted conversation
// — it costs an unwanted conversation that runs until somebody notices.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedCaller,
  refuseCall,
  callAllowedNumbers,
  callMinutesRemaining,
  recordCallSeconds,
  describeCalling,
  __resetCallBudgetForTests,
} from '../realtime/callPolicy.js';

const KEYS = ['VOICE_CALLS', 'CALL_ALLOWED_NUMBERS', 'WHATSAPP_ALLOWED_NUMBERS', 'CALL_MAX_MINUTES_PER_DAY', 'CALL_MAX_SECONDS'];
const saved = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  __resetCallBudgetForTests();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetCallBudgetForTests();
});

test('calls are off until explicitly switched on', () => {
  process.env.CALL_ALLOWED_NUMBERS = '66812345678';
  assert.equal(isAllowedCaller('+66812345678'), false, 'an allowlisted number still gets nothing');
  assert.match(refuseCall('+66812345678'), /switched off/);
});

test('no allowlist means nobody, not everybody', () => {
  // The failure that matters. An empty list read as "no restriction" turns a
  // private line into a public one.
  process.env.VOICE_CALLS = 'true';
  assert.deepEqual(callAllowedNumbers(), []);
  assert.equal(isAllowedCaller('+66812345678'), false);
  assert.match(refuseCall('+66812345678'), /not on the call allowlist/);
});

test('a withheld caller ID is refused rather than treated as empty', () => {
  process.env.VOICE_CALLS = 'true';
  process.env.CALL_ALLOWED_NUMBERS = '66812345678';
  for (const withheld of ['', null, undefined, 'anonymous', '+']) {
    assert.equal(isAllowedCaller(withheld), false, `${JSON.stringify(withheld)} must not get through`);
  }
});

test('numbers compare by digits, so formatting cannot lock the founder out', () => {
  process.env.VOICE_CALLS = 'true';
  process.env.CALL_ALLOWED_NUMBERS = '+66 81 234 5678';
  for (const form of ['66812345678', '+66812345678', '(668) 123-45678'.replace(/\D/g, '')]) {
    assert.equal(isAllowedCaller(form), true, `${form} is the same number`);
  }
});

test('the call allowlist falls back to the WhatsApp one rather than to nothing', () => {
  // Two lists to keep in sync is a second list to forget, and forgetting this
  // one means the founder cannot call their own company.
  process.env.VOICE_CALLS = 'true';
  process.env.WHATSAPP_ALLOWED_NUMBERS = '66812345678';
  assert.deepEqual(callAllowedNumbers(), ['66812345678']);
  assert.equal(isAllowedCaller('+66812345678'), true);
});

test('an explicit call allowlist overrides the WhatsApp one', () => {
  process.env.VOICE_CALLS = 'true';
  process.env.WHATSAPP_ALLOWED_NUMBERS = '66812345678';
  process.env.CALL_ALLOWED_NUMBERS = '447700900123';
  assert.equal(isAllowedCaller('+447700900123'), true);
  assert.equal(isAllowedCaller('+66812345678'), false, 'the override replaces, it does not add');
});

test('the daily budget runs out and says so', () => {
  process.env.VOICE_CALLS = 'true';
  process.env.CALL_ALLOWED_NUMBERS = '66812345678';
  process.env.CALL_MAX_MINUTES_PER_DAY = '10';

  assert.equal(refuseCall('+66812345678'), null, 'allowed to start with');
  recordCallSeconds(9 * 60);
  assert.equal(refuseCall('+66812345678'), null, 'still inside the budget');
  assert.ok(callMinutesRemaining() > 0);

  recordCallSeconds(2 * 60);
  assert.equal(callMinutesRemaining(), 0, 'never negative');
  assert.match(refuseCall('+66812345678'), /daily call budget of 10 minutes is spent/);
});

test('the refusal names the fix rather than dropping the line', () => {
  // A dead line is indistinguishable from a broken number, and the founder
  // would reasonably conclude the latter and stop calling.
  const off = refuseCall('+66812345678');
  assert.match(off, /VOICE_CALLS/, 'names the variable to set');
});

test('describeCalling tells the founder which of the three states they are in', () => {
  assert.match(describeCalling(), /off/i);

  process.env.VOICE_CALLS = 'true';
  assert.match(describeCalling(), /nobody gets through/, 'on but unreachable is its own state');

  process.env.CALL_ALLOWED_NUMBERS = '66812345678';
  assert.match(describeCalling(), /1 number/);
  assert.match(describeCalling(), /minutes left today/);
});

// The call summary. A call leaves no record the founder can search, and half
// of what gets said on one is a decision — speech is also the medium where
// "I thought we agreed" does the most damage, because neither side can scroll
// back.
test('the call summary separates what the founder said from what the team answered', async () => {
  const { formatCallSummaryEmail } = await import('../email.js');
  const { subject, text } = formatCallSummaryEmail({
    from: '+66812345678',
    seconds: 185,
    transcript: [
      { who: 'founder', text: 'What is CircadianAPI priced at?' },
      { who: 'asked the team', text: 'Confirm the price on record for CircadianAPI.' },
      { who: 'team', text: 'USD 29.00 per month.' },
    ],
  });

  assert.match(subject, /3 min/, 'rounded to something a human reads');
  assert.match(text, /You: What is CircadianAPI priced at\?/, "the founder's own words, labelled as theirs");
  assert.match(text, /The team: USD 29\.00 per month\./);
  assert.match(text, /1 question was put to the team/, 'singular reads correctly');
});

test('a call where nothing was asked of the team says so by omission, not by a lie', async () => {
  const { formatCallSummaryEmail } = await import('../email.js');
  const { text } = formatCallSummaryEmail({
    from: '+1',
    seconds: 30,
    transcript: [{ who: 'founder', text: 'Morning.' }],
  });
  assert.doesNotMatch(text, /questions? was put to the team/);
  assert.match(text, /1-minute call/, 'a short call is not rounded to zero minutes');
});

// --- A public support line -----------------------------------------------------------------

test('in support mode anyone gets through, because a help line with an allowlist helps nobody', (t) => {
  process.env.VOICE_CALLS = 'true';
  process.env.CALL_MODE = 'support';
  t.after(() => delete process.env.CALL_MODE);
  assert.equal(refuseCall('+15551234567'), null, 'an unknown caller is answered');
  assert.equal(refuseCall(''), null, 'even a withheld number');
});

test('support mode keeps the daily budget, which is what stops a public number being a public bill', (t) => {
  process.env.VOICE_CALLS = 'true';
  process.env.CALL_MODE = 'support';
  process.env.CALL_MAX_MINUTES_PER_DAY = '5';
  t.after(() => delete process.env.CALL_MODE);
  recordCallSeconds(6 * 60);
  assert.match(refuseCall('+15551234567'), /daily call budget of 5 minutes is spent/);
});

test('support mode still needs calls switched on', (t) => {
  process.env.CALL_MODE = 'support';
  t.after(() => delete process.env.CALL_MODE);
  assert.match(refuseCall('+1'), /switched off/);
});

test('the founder line is the default, so a misspelt CALL_MODE cannot open the founder to the public', (t) => {
  process.env.VOICE_CALLS = 'true';
  process.env.CALL_MODE = 'suport';
  process.env.CALL_ALLOWED_NUMBERS = '66812345678';
  t.after(() => delete process.env.CALL_MODE);
  assert.match(refuseCall('+15551234567'), /not on the call allowlist/);
});

test('describeCalling says which line the number is', (t) => {
  process.env.VOICE_CALLS = 'true';
  process.env.CALL_MODE = 'support';
  t.after(() => delete process.env.CALL_MODE);
  assert.match(describeCalling(), /public support desk — any caller gets through/);
});
