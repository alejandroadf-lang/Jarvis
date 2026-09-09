import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostUsd, sumUsage, formatUsd } from '../usage.js';

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

test('sumUsage adds token counts across multiple usage objects', () => {
  const total = sumUsage({ inputTokens: 100, outputTokens: 50 }, { inputTokens: 200, outputTokens: 25 });
  assert.deepEqual(total, { inputTokens: 300, outputTokens: 75 });
});

test('sumUsage treats missing/undefined usage as zero', () => {
  const total = sumUsage({ inputTokens: 10, outputTokens: 5 }, undefined, null);
  assert.deepEqual(total, { inputTokens: 10, outputTokens: 5 });
});

test('formatUsd uses 2 decimals normally, more precision under a cent', () => {
  assert.equal(formatUsd(0.62), '$0.62');
  assert.equal(formatUsd(12), '$12.00');
  assert.equal(formatUsd(0.0034), '$0.0034');
  assert.equal(formatUsd(0), '$0.00');
});
