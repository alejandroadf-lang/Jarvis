// The supervisor's veto: the price floor and the CEO review.
//
// Two properties matter more than the happy path and are tested first: the
// floor cannot be talked around, and the review can never take the company
// down. A reviewer that throws on a bad day would turn every outbound message
// into an outage — which is a worse failure than the one it prevents.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let review;
let ventures;
let originalFetch;
const saved = {};

function stash(...keys) {
  for (const key of keys) saved[key] = process.env[key];
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-review-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  stash('CEO_REVIEW', 'OPENROUTER_API_KEY', 'DAILY_SPEND_CAP_USD');
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.DAILY_SPEND_CAP_USD = '100';
  originalFetch = global.fetch;
  review = await import('../review.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.CEO_REVIEW;
  global.fetch = originalFetch;
});

function priced({ floorMonthly = 149, perUnit = 0, unit = '' } = {}) {
  return {
    id: 'v_test',
    title: 'CircadianAPI',
    pricing: { currency: 'EUR', floorMonthly, perUnit, unit },
  };
}

// --- The floor ---------------------------------------------------------------

test('a link at the price on record passes', () => {
  assert.equal(review.priceFloorRefusal(priced(), { amount: 149 }), null);
});

test('a link above the price on record passes', () => {
  assert.equal(review.priceFloorRefusal(priced(), { amount: 500 }), null);
});

test('a link below the price on record is refused', () => {
  const refusal = review.priceFloorRefusal(priced(), { amount: 59 });
  assert.ok(refusal, 'expected a refusal');
  assert.match(refusal, /149/, 'the refusal names the real price');
});

// The recurring failure in this codebase is a refusal that names a rule and no
// way past it. A price floor is exactly the kind of thing an agent will retry
// against forever unless the message says whose decision it is.
test('the refusal names the founder command that moves the floor', () => {
  const refusal = review.priceFloorRefusal(priced(), { amount: 59 });
  assert.match(refusal, /DISCOUNT\s+v_test/);
});

test('per-unit pricing counts the expected volume', () => {
  const venture = priced({ floorMonthly: 100, perUnit: 0.02, unit: 'page' });
  // 100 + 0.02 * 5000 = 200.
  assert.equal(review.priceFloorRefusal(venture, { amount: 200, expectedUnits: 5000 }), null);
  assert.ok(review.priceFloorRefusal(venture, { amount: 150, expectedUnits: 5000 }));
});

test('a venture with no price has no floor to be below', () => {
  assert.equal(review.priceFloorRefusal({ id: 'v_x', title: 'X' }, { amount: 1 }), null);
});

test('a free venture has no floor either', () => {
  const free = priced({ floorMonthly: 0 });
  assert.equal(review.priceFloorRefusal(free, { amount: 0 }), null);
});

test('a founder-approved floor lets a discount through', () => {
  const venture = { ...priced(), discount: { approvedFloor: 99 } };
  assert.equal(review.priceFloorRefusal(venture, { amount: 99 }), null);
  assert.equal(review.priceFloorRefusal(venture, { amount: 120 }), null);
});

test('an approved floor is still a floor', () => {
  const venture = { ...priced(), discount: { approvedFloor: 99 } };
  const refusal = review.priceFloorRefusal(venture, { amount: 40 });
  assert.ok(refusal);
  assert.match(refusal, /below even that/, 'says the approved discount was also undercut');
});

// --- The CEO review ------------------------------------------------------------

function respondWith(text) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: text } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  });
}

test('the review does not run unless the founder turned it on', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be reached');
  };
  const result = await review.reviewOutbound({
    anthropic: {},
    venture: priced(),
    action: 'send_customer_email',
    summary: 'anything',
  });
  assert.equal(result.approved, true);
  assert.equal(result.reviewed, false);
  assert.equal(called, false, 'no model call when CEO_REVIEW is off');
});

test('VETO blocks, and the reason survives', async () => {
  process.env.CEO_REVIEW = 'true';
  respondWith('VETO — it offers 60% off, which nobody approved.');
  const result = await review.reviewOutbound({
    anthropic: {},
    venture: priced(),
    action: 'send_customer_email',
    summary: 'Have 60% off',
  });
  assert.equal(result.approved, false);
  assert.equal(result.reviewed, true);
  assert.match(result.reason, /60% off/);
  assert.doesNotMatch(result.reason, /^VETO/, 'the verdict word is stripped from the reason');
});

test('APPROVE passes', async () => {
  process.env.CEO_REVIEW = 'true';
  respondWith('APPROVE — quotes the price on record.');
  const result = await review.reviewOutbound({
    anthropic: {},
    venture: priced(),
    action: 'send_customer_email',
    summary: 'EUR 149/month',
  });
  assert.equal(result.approved, true);
  assert.equal(result.reviewed, true);
});

// Anything that is not a clear veto passes. A reviewer that blocks on an
// answer it did not understand is a reviewer that blocks good work.
test('an answer that is neither word passes', async () => {
  process.env.CEO_REVIEW = 'true';
  respondWith('I think this is probably fine?');
  const result = await review.reviewOutbound({
    anthropic: {},
    venture: priced(),
    action: 'send_customer_email',
    summary: 'hello',
  });
  assert.equal(result.approved, true);
});

test('the word has to start the answer to count as a veto', async () => {
  process.env.CEO_REVIEW = 'true';
  respondWith('APPROVE — there is nothing here to VETO.');
  const result = await review.reviewOutbound({
    anthropic: {},
    venture: priced(),
    action: 'send_customer_email',
    summary: 'hello',
  });
  assert.equal(result.approved, true, 'the word inside the sentence is not a verdict');
});

// The property that matters most: an unreachable supervisor must not stop the
// company sending anything, ever.
test('a failing review approves rather than throwing', async () => {
  process.env.CEO_REVIEW = 'true';
  global.fetch = async () => {
    throw new Error('network down');
  };
  const result = await review.reviewOutbound({
    anthropic: {},
    venture: priced(),
    action: 'send_customer_email',
    summary: 'hello',
  });
  assert.equal(result.approved, true);
  assert.equal(result.reviewed, false, 'and it says it did not actually review');
});

test('a review with no client approves', async () => {
  process.env.CEO_REVIEW = 'true';
  const result = await review.reviewOutbound({
    anthropic: null,
    venture: priced(),
    action: 'send_customer_email',
    summary: 'hello',
  });
  assert.equal(result.approved, true);
  assert.equal(result.reviewed, false);
});

test('isCeoReviewEnabled is off unless set to exactly true', () => {
  delete process.env.CEO_REVIEW;
  assert.equal(review.isCeoReviewEnabled(), false);
  process.env.CEO_REVIEW = '1';
  assert.equal(review.isCeoReviewEnabled(), false);
  process.env.CEO_REVIEW = 'true';
  assert.equal(review.isCeoReviewEnabled(), true);
});

// The objectives are the only thing the CEO is asked to judge against, so a
// review that never sees them is judging against nothing.
test('the prompt carries the venture objectives', async () => {
  process.env.CEO_REVIEW = 'true';
  const venture = ventures.createVenture({
    title: 'ReviewCo',
    problem: 'p',
    solution: 's',
    targetCustomer: 't',
    proposedBy: 'ceo',
  });
  ventures.setObjective(venture.id, { key: 'revenue', target: 'EUR 2000 MRR', by: '2026-12-31' });

  let sentBody = null;
  global.fetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: 'APPROVE — fine.' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };

  await review.reviewOutbound({
    anthropic: {},
    venture: ventures.getVenture(venture.id),
    action: 'send_customer_email',
    summary: 'hello',
  });

  const text = JSON.stringify(sentBody);
  assert.match(text, /EUR 2000 MRR/);
});
