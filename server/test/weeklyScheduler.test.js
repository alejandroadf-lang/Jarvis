import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWeeklyTargetUTC, TARGET_DAY_OF_WEEK, TARGET_UTC_HOUR, TARGET_UTC_MINUTE } from '../weeklyScheduler.js';

test('target is Sunday 01:30 UTC (30 minutes after the daily cycle\'s own slot)', () => {
  assert.equal(TARGET_DAY_OF_WEEK, 0);
  assert.equal(TARGET_UTC_HOUR, 1);
  assert.equal(TARGET_UTC_MINUTE, 30);
});

// 2026-03-08 is a Sunday; 2026-03-04 is the preceding Wednesday.
test('mid-week: next target is the upcoming Sunday', () => {
  const from = new Date('2026-03-04T05:00:00Z');
  assert.equal(nextWeeklyTargetUTC(from).toISOString(), '2026-03-08T01:30:00.000Z');
});

test('Sunday before the slot: next target is later today', () => {
  const from = new Date('2026-03-08T00:30:00Z');
  assert.equal(nextWeeklyTargetUTC(from).toISOString(), '2026-03-08T01:30:00.000Z');
});

test('Sunday exactly at the slot: next target rolls to next Sunday', () => {
  const from = new Date('2026-03-08T01:30:00Z');
  assert.equal(nextWeeklyTargetUTC(from).toISOString(), '2026-03-15T01:30:00.000Z');
});

test('Sunday after the slot: next target rolls to next Sunday', () => {
  const from = new Date('2026-03-08T14:00:00Z');
  assert.equal(nextWeeklyTargetUTC(from).toISOString(), '2026-03-15T01:30:00.000Z');
});

test('rolls correctly across a month boundary', () => {
  // 2026-03-29 is a Sunday; the next one is 2026-04-05.
  const from = new Date('2026-03-29T14:00:00Z');
  assert.equal(nextWeeklyTargetUTC(from).toISOString(), '2026-04-05T01:30:00.000Z');
});
