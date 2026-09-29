import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, emptyBucket, isAfterHours, isLate, isRestDay, recordActivity, recordMention, bursts, periodMetrics, upgradeBucket,
  MAX_ITEMS_PER_PERSON_DAY,
} from '../src/lib/signals.mjs';

test('quiet hours wrap midnight by default and can be a plain window; late night is its own window', () => {
  assert.equal(isAfterHours(23), true);
  assert.equal(isAfterHours(3), true);
  assert.equal(isAfterHours(7), false);
  assert.equal(isAfterHours(19), false);
  const plain = { ...DEFAULT_SETTINGS, quietStart: 0, quietEnd: 6 };
  assert.equal(isAfterHours(5, plain), true);
  assert.equal(isAfterHours(23, plain), false);
  assert.equal(isLate(21), false);
  assert.equal(isLate(22), true);
  assert.equal(isLate(4), true);
  assert.equal(isLate(5), false);
});

test('rest days are the weekend plus the team’s holidays', () => {
  assert.equal(isRestDay(6, '2026-10-03'), true);
  assert.equal(isRestDay(5, '2026-10-02'), false);
  assert.equal(isRestDay(5, '2026-10-02', { ...DEFAULT_SETTINGS, weekendDays: [5, 6] }), true);
  assert.equal(isRestDay(4, '2026-12-25', { ...DEFAULT_SETTINGS, holidays: ['2026-12-25'] }), true);
});

test('a bucket counts actions, after-hours, late, rest days and per-person hours, items and mentions, and nothing else', () => {
  const b = emptyBucket();
  recordActivity(b, { actor: 'p1', hour: 22, weekday: 2, day: '2026-09-29', kind: 'updated', item: 'i1' });
  recordActivity(b, { actor: 'p1', hour: 10, weekday: 6, day: '2026-10-03', kind: 'comment', item: 'i2' });
  recordActivity(b, { actor: 'p1', hour: 10, weekday: 6, day: '2026-10-03', kind: 'comment', item: 'i2' });
  recordActivity(b, { actor: 'p2', hour: 10, weekday: 2, day: '2026-09-29', kind: 'updated' });
  recordMention(b, { mentioned: 'p3' });
  assert.deepEqual(b, {
    v: 2,
    total: 4,
    afterHours: 1,
    late: 1,
    weekend: 2,
    kinds: { updated: 2, comment: 2 },
    people: {
      p1: { n: 3, hours: [22, 10], items: ['i1', 'i2'], mentions: 0 },
      p2: { n: 1, hours: [10], items: [], mentions: 0 },
      p3: { n: 0, hours: [], items: [], mentions: 1 },
    },
  });
  assert.throws(() => recordActivity(emptyBucket(), { actor: '', hour: 1, weekday: 1, day: '2026-01-01' }), /actor/);
  assert.throws(() => recordMention(emptyBucket(), {}), /mentioned/);
});

test('items per person-day are capped', () => {
  const b = emptyBucket();
  for (let i = 0; i < MAX_ITEMS_PER_PERSON_DAY + 50; i++) recordActivity(b, { actor: 'p', hour: 9, weekday: 1, day: '2026-09-28', item: `i${i}` });
  assert.equal(b.people.p.items.length, MAX_ITEMS_PER_PERSON_DAY);
  assert.equal(b.people.p.n, MAX_ITEMS_PER_PERSON_DAY + 50);
});

test('bursts are runs of consecutive active hours', () => {
  assert.equal(bursts([]), 0);
  assert.equal(bursts([9, 10, 11]), 1);
  assert.equal(bursts([9, 10, 14, 15, 20]), 3);
  assert.equal(bursts([7, 9, 11, 13, 15, 17, 21]), 7);
});

test('period metrics: shares, concentration, long days, fragmentation, mentions, reopen rate', () => {
  const day1 = emptyBucket();
  recordActivity(day1, { actor: 'p1', hour: 8, weekday: 1, day: '2026-09-28', item: 'a' });
  recordActivity(day1, { actor: 'p1', hour: 13, weekday: 1, day: '2026-09-28', item: 'b' });
  recordActivity(day1, { actor: 'p1', hour: 20, weekday: 1, day: '2026-09-28', item: 'c', kind: 'resolved' }); // 12-hour span, 3 bursts
  recordActivity(day1, { actor: 'p2', hour: 10, weekday: 1, day: '2026-09-28', item: 'a', kind: 'reopened' });
  recordMention(day1, { mentioned: 'p2' });
  recordMention(day1, { mentioned: 'p2' });
  recordMention(day1, { mentioned: 'p1' });
  const day2 = emptyBucket();
  recordActivity(day2, { actor: 'p2', hour: 9, weekday: 0, day: '2026-10-04', item: 'a' });
  const m = periodMetrics([day1, null, day2]);
  assert.equal(m.total, 5);
  assert.equal(m.contributors, 2);
  assert.equal(m.personDays, 3);
  assert.ok(Math.abs(m.afterHoursShare - 1 / 5) < 1e-9);
  assert.equal(m.lateShare, 0);
  assert.ok(Math.abs(m.weekendShare - 1 / 5) < 1e-9);
  assert.ok(Math.abs(m.topShare - 3 / 5) < 1e-9);
  assert.ok(Math.abs(m.longSpanShare - 1 / 3) < 1e-9);
  assert.equal(m.burstyShare, 0); // three bursts is under the threshold of four
  assert.equal(m.itemsMedian, 1);
  assert.equal(m.mentionsPerPersonDay, 1);
  assert.ok(Math.abs(m.mentionTopShare - 2 / 3) < 1e-9);
  assert.equal(m.reopenRate, 0.5);
  assert.deepEqual(m.kinds, { activity: 3, resolved: 1, reopened: 1 });
  assert.equal(Object.keys(m).some((k) => k === 'people' || k === 'byActor'), false);
});

test('no activity gives null shares, not zero; old buckets are read', () => {
  const m = periodMetrics([emptyBucket()]);
  assert.equal(m.total, 0);
  assert.equal(m.afterHoursShare, null);
  assert.equal(m.topShare, null);
  assert.equal(m.itemsMedian, null);
  const old = upgradeBucket({ total: 2, afterHours: 1, weekend: 0, byActor: { x: 2 }, kinds: {} });
  assert.equal(old.v, 2);
  assert.equal(periodMetrics([old]).contributors, 1);
  assert.equal(periodMetrics([old]).afterHoursShare, 0.5);
});
