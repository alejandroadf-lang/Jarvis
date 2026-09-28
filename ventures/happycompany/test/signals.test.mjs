import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, emptyBucket, isAfterHours, isWeekend, recordActivity, mergeBuckets, periodMetrics } from '../src/lib/signals.mjs';

test('quiet hours wrap midnight by default and can be a plain window', () => {
  assert.equal(isAfterHours(23), true);
  assert.equal(isAfterHours(3), true);
  assert.equal(isAfterHours(7), false);
  assert.equal(isAfterHours(19), false);
  const plain = { ...DEFAULT_SETTINGS, quietStart: 0, quietEnd: 6 };
  assert.equal(isAfterHours(5, plain), true);
  assert.equal(isAfterHours(23, plain), false);
});

test('the weekend is a setting', () => {
  assert.equal(isWeekend(6), true);
  assert.equal(isWeekend(5), false);
  assert.equal(isWeekend(5, { ...DEFAULT_SETTINGS, weekendDays: [5, 6] }), true);
});

test('a bucket counts actions, after-hours, weekend and per-person, and nothing else', () => {
  const b = emptyBucket();
  recordActivity(b, { actor: 'p1', hour: 22, weekday: 2, kind: 'updated' });
  recordActivity(b, { actor: 'p1', hour: 10, weekday: 6, kind: 'comment' });
  recordActivity(b, { actor: 'p2', hour: 10, weekday: 2, kind: 'updated' });
  assert.deepEqual(b, {
    total: 3,
    afterHours: 1,
    weekend: 1,
    byActor: { p1: 2, p2: 1 },
    kinds: { updated: 2, comment: 1 },
  });
  assert.throws(() => recordActivity(emptyBucket(), { actor: '', hour: 1, weekday: 1 }), /actor/);
});

test('merging buckets sums every counter; metrics are shares of the total', () => {
  const a = recordActivity(emptyBucket(), { actor: 'p1', hour: 22, weekday: 1 });
  const b = recordActivity(emptyBucket(), { actor: 'p2', hour: 9, weekday: 0 });
  const c = recordActivity(emptyBucket(), { actor: 'p1', hour: 9, weekday: 1 });
  const merged = mergeBuckets([a, null, b, c]);
  assert.equal(merged.total, 3);
  const m = periodMetrics(merged);
  assert.equal(m.contributors, 2);
  assert.ok(Math.abs(m.afterHoursShare - 1 / 3) < 1e-9);
  assert.ok(Math.abs(m.weekendShare - 1 / 3) < 1e-9);
  assert.ok(Math.abs(m.topShare - 2 / 3) < 1e-9);
  assert.ok(Math.abs(m.hhi - (4 / 9 + 1 / 9)) < 1e-9);
});

test('no activity gives null shares, not zero', () => {
  const m = periodMetrics(emptyBucket());
  assert.equal(m.total, 0);
  assert.equal(m.afterHoursShare, null);
  assert.equal(m.topShare, null);
});
