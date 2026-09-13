import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateCostUsd,
  sumUsage,
  formatUsd,
  priceUsage,
  emptyUsage,
  billedInputTokens,
  cacheHitRate,
  CACHE_WRITE_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
} from '../usage.js';
import { MODELS, CHEAP_TIER, DEFAULT_TIER } from '../agents/models.js';

test('estimateCostUsd applies per-token pricing for input and output separately', () => {
  // 1M input tokens at $2.00/MTok + 1M output tokens at $10.00/MTok
  const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 12);
});

test('estimateCostUsd scales linearly for partial millions', () => {
  const cost = estimateCostUsd({ inputTokens: 500_000, outputTokens: 100_000 });
  // 0.5 * $2.00 + 0.1 * $10.00 = $1.00 + $1.00
  assert.equal(cost, 2);
});

test('sumUsage adds token counts and cost across multiple usage objects', () => {
  const total = sumUsage(
    { inputTokens: 100, outputTokens: 50, costUsd: 1 },
    { inputTokens: 200, outputTokens: 25, costUsd: 0.5 }
  );
  assert.deepEqual(total, { inputTokens: 300, outputTokens: 75, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 1.5 });
});

test('sumUsage treats missing/undefined usage as zero', () => {
  const total = sumUsage({ inputTokens: 10, outputTokens: 5, costUsd: 0.25 }, undefined, null);
  assert.deepEqual(total, { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0.25 });
});

// Reports saved before mixed-model routing carry tokens but no costUsd.
// Dropping them from the total would quietly understate a week's spend, so
// they're priced at the default model's rate instead.
test('sumUsage prices a usage object that predates cost tracking', () => {
  const total = sumUsage({ inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(total.costUsd, 2);
});

test('estimateCostUsd prefers a real accumulated cost over re-pricing tokens', () => {
  // Tokens that would price at $12 on the default model, but actually cost
  // $0.53 because they were spent on the cheaper one.
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: 0.53 };
  assert.equal(estimateCostUsd(usage), 0.53);
});

test('priceUsage charges the cheap tier far less than the default for identical tokens', () => {
  const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const frontier = priceUsage(tokens, MODELS[DEFAULT_TIER]);
  const specialist = priceUsage(tokens, MODELS[CHEAP_TIER]);
  assert.equal(frontier, 12);
  assert.ok(specialist < frontier / 10, `expected a big saving, got ${specialist} vs ${frontier}`);
});

test('emptyUsage starts every counter at zero', () => {
  assert.deepEqual(emptyUsage(), { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0 });
});

test('formatUsd uses 2 decimals normally, more precision under a cent', () => {
  assert.equal(formatUsd(0.62), '$0.62');
  assert.equal(formatUsd(12), '$12.00');
  assert.equal(formatUsd(0.0034), '$0.0034');
  assert.equal(formatUsd(0), '$0.00');
});

// --- What prompt caching bills, and what the meter used to miss ---
//
// `input_tokens` from the Anthropic API is the *uncached* input only. With
// caching on, the tool schemas, the shared company context and each agent's
// system prompt all arrive in `cache_creation_input_tokens` or
// `cache_read_input_tokens` instead — on a CEO call, roughly 4,400 of 4,600
// input tokens. Pricing only `input_tokens` meant the daily spend cap metered a
// small fraction of the bill and could never fire, which is how an Anthropic
// balance emptied while SPEND reported room to spare.

test('a cache write costs more than sending the same tokens uncached', () => {
  const spec = MODELS[DEFAULT_TIER];
  const uncached = priceUsage({ inputTokens: 10_000 }, spec);
  const written = priceUsage({ cacheWriteTokens: 10_000 }, spec);
  assert.ok(written > uncached, 'a write is a surcharge, not a saving');
  assert.equal(written / uncached, CACHE_WRITE_MULTIPLIER);
});

test('a cache read costs a fraction of the same tokens uncached', () => {
  const spec = MODELS[DEFAULT_TIER];
  const uncached = priceUsage({ inputTokens: 10_000 }, spec);
  const read = priceUsage({ cacheReadTokens: 10_000 }, spec);
  assert.equal(read / uncached, CACHE_READ_MULTIPLIER);
});

// The bug, stated as a number. This is the gap the cap was blind to.
test('a realistic agent call costs well over what the old meter reported', () => {
  const spec = MODELS[DEFAULT_TIER];
  const blind = priceUsage({ inputTokens: 200, outputTokens: 800 }, spec);
  const real = priceUsage({ inputTokens: 200, outputTokens: 800, cacheWriteTokens: 4_380 }, spec);
  assert.ok(real > blind * 2, `expected more than double, got ${real} vs ${blind}`);
});

// Caching only pays when the prefix is read back. An orchestrator loops several
// rounds with identical tools and system and genuinely hits; a leaf makes one
// call and pays the write for nothing. cacheHitRate is how that gets measured
// rather than assumed.
test('cacheHitRate separates a cache that is paying for itself from one that is not', () => {
  assert.equal(cacheHitRate({ cacheWriteTokens: 4_000, cacheReadTokens: 0 }), 0);
  assert.equal(cacheHitRate({ cacheWriteTokens: 0, cacheReadTokens: 4_000 }), 1);
  assert.equal(cacheHitRate({ cacheWriteTokens: 1_000, cacheReadTokens: 3_000 }), 0.75);
  // Null rather than 0 when nothing was cached: "no cache" and "a cache that
  // never hit" are different findings, and one of them is a bug.
  assert.equal(cacheHitRate({ inputTokens: 500 }), null);
});

test('billedInputTokens counts every input token, not just the uncached ones', () => {
  assert.equal(billedInputTokens({ inputTokens: 200, cacheWriteTokens: 4_000, cacheReadTokens: 100 }), 4_300);
  assert.equal(billedInputTokens({ inputTokens: 200 }), 200);
  assert.equal(billedInputTokens(undefined), 0);
});

// Everything saved before caching was metered has neither field. Those must
// price exactly as they always did, or a week of history shifts under the
// founder for no reason.
test('a usage object with no cache fields prices exactly as before', () => {
  const spec = MODELS[DEFAULT_TIER];
  assert.equal(priceUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, spec), 12);
});
