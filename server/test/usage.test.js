import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostUsd, sumUsage, formatUsd, priceUsage, emptyUsage } from '../usage.js';
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
  assert.deepEqual(total, { inputTokens: 300, outputTokens: 75, costUsd: 1.5 });
});

test('sumUsage treats missing/undefined usage as zero', () => {
  const total = sumUsage({ inputTokens: 10, outputTokens: 5, costUsd: 0.25 }, undefined, null);
  assert.deepEqual(total, { inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
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
  assert.deepEqual(emptyUsage(), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
});

test('formatUsd uses 2 decimals normally, more precision under a cent', () => {
  assert.equal(formatUsd(0.62), '$0.62');
  assert.equal(formatUsd(12), '$12.00');
  assert.equal(formatUsd(0.0034), '$0.0034');
  assert.equal(formatUsd(0), '$0.00');
});
