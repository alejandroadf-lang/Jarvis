import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let spend;
let savedCap;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-spend-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  savedCap = process.env.DAILY_SPEND_CAP_USD;
  spend = await import('../spend.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedCap === undefined) delete process.env.DAILY_SPEND_CAP_USD;
  else process.env.DAILY_SPEND_CAP_USD = savedCap;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.DAILY_SPEND_CAP_USD;
  fs.rmSync(path.join(tmpDir, 'spend.json'), { force: true });
});

test('starts at zero and uses the default cap when none is configured', () => {
  assert.equal(spend.getSpendToday(), 0);
  assert.equal(spend.dailyCapUsd(), 5);
});

test('DAILY_SPEND_CAP_USD overrides the default when it is a positive number', () => {
  process.env.DAILY_SPEND_CAP_USD = '12.5';
  assert.equal(spend.dailyCapUsd(), 12.5);
});

test('a nonsense cap falls back to the default rather than disabling the ceiling', () => {
  process.env.DAILY_SPEND_CAP_USD = 'not-a-number';
  assert.equal(spend.dailyCapUsd(), 5);

  process.env.DAILY_SPEND_CAP_USD = '0';
  assert.equal(spend.dailyCapUsd(), 5);

  process.env.DAILY_SPEND_CAP_USD = '-3';
  assert.equal(spend.dailyCapUsd(), 5);
});

test('recordSpend accumulates across calls', () => {
  spend.recordSpend(0.25);
  spend.recordSpend(0.5);
  assert.equal(Math.round(spend.getSpendToday() * 100) / 100, 0.75);
});

test('recordSpend ignores zero, negative, and non-finite amounts', () => {
  spend.recordSpend(0);
  spend.recordSpend(-1);
  spend.recordSpend(Number.NaN);
  assert.equal(spend.getSpendToday(), 0);
});

test('assertUnderDailyCap passes below the cap and throws at or above it', () => {
  process.env.DAILY_SPEND_CAP_USD = '1';

  spend.recordSpend(0.99);
  assert.doesNotThrow(() => spend.assertUnderDailyCap());

  spend.recordSpend(0.01);
  assert.throws(() => spend.assertUnderDailyCap(), /Daily spend cap reached/);
});

test('the cap error names both figures so the message is actionable on its own', () => {
  process.env.DAILY_SPEND_CAP_USD = '2';
  spend.recordSpend(2);

  assert.throws(() => spend.assertUnderDailyCap(), /\$2\.00 of \$2\.00/);
});

test('getSpendSummary reports the day, the totals, and whether the cap is spent', () => {
  process.env.DAILY_SPEND_CAP_USD = '10';
  spend.recordSpend(4);

  const summary = spend.getSpendSummary();
  assert.equal(summary.spentUsd, 4);
  assert.equal(summary.capUsd, 10);
  assert.equal(summary.overCap, false);
  assert.match(summary.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('spend older than the retention window is pruned rather than accumulating forever', () => {
  const stale = '2020-01-01';
  fs.writeFileSync(path.join(tmpDir, 'spend.json'), JSON.stringify({ days: { [stale]: 42 } }));

  spend.recordSpend(0.1);

  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'spend.json'), 'utf-8'));
  assert.equal(onDisk.days[stale], undefined);
  assert.equal(Object.keys(onDisk.days).length, 1);
});

// --- Cache accounting: the figure that says whether caching is working ---
//
// The cap was blind to cached tokens for most of this company's life, which is
// how an Anthropic balance emptied while SPEND reported room to spare. Metering
// them is the fix; reporting the hit rate is what stops the next version of the
// same mistake, because "caching saves money" is only true when the prefix is
// actually read back.
test('recordSpend accumulates cached token counts alongside the dollars', async () => {
  const spend = await import('../spend.js');
  spend.recordSpend(0.01, { cacheWriteTokens: 4000, cacheReadTokens: 0 });
  spend.recordSpend(0.01, { cacheWriteTokens: 0, cacheReadTokens: 12000 });

  const summary = spend.getCacheSummary();
  assert.equal(summary.writeTokens, 4000);
  assert.equal(summary.readTokens, 12000);
  assert.equal(summary.hitRate, 0.75);
});

test('no cached tokens reads as null, not as a cache that never hit', async () => {
  // Different findings: one means caching is off for these calls, the other
  // means it is on and costing 25% for nothing. Collapsing them would hide the
  // bug this whole change exists to surface.
  const spend = await import('../spend.js');
  spend.recordSpend(0.02, {});
  const summary = spend.getCacheSummary();
  assert.ok(summary === null || summary.writeTokens + summary.readTokens > 0);
});
