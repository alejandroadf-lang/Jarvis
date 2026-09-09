import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTargetUTC, TARGET_UTC_HOUR } from '../scheduler.js';

test('target hour is 01:00 UTC (08:00 Asia/Bangkok, UTC+7, no DST)', () => {
  assert.equal(TARGET_UTC_HOUR, 1);
});

test('before today\'s slot: next target is later today', () => {
  const from = new Date('2026-03-05T00:30:00Z');
  assert.equal(nextTargetUTC(from).toISOString(), '2026-03-05T01:00:00.000Z');
});

test('exactly at the slot: next target rolls to tomorrow (this run belongs to now, not the next one)', () => {
  const from = new Date('2026-03-05T01:00:00Z');
  assert.equal(nextTargetUTC(from).toISOString(), '2026-03-06T01:00:00.000Z');
});

test('after today\'s slot: next target is tomorrow', () => {
  const from = new Date('2026-03-05T14:00:00Z');
  assert.equal(nextTargetUTC(from).toISOString(), '2026-03-06T01:00:00.000Z');
});

test('rolls correctly across a month boundary', () => {
  const from = new Date('2026-03-31T05:00:00Z');
  assert.equal(nextTargetUTC(from).toISOString(), '2026-04-01T01:00:00.000Z');
});

test('rolls correctly across a year boundary', () => {
  const from = new Date('2026-12-31T05:00:00Z');
  assert.equal(nextTargetUTC(from).toISOString(), '2027-01-01T01:00:00.000Z');
});
