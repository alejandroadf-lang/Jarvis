import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localParts, isoWeek, mondayOf, daysOfWeek, previousWeeks, addDays, isValidZone, parseInstant } from '../src/lib/time.mjs';

test('the same instant is late evening in Bangkok and afternoon in Berlin', () => {
  const at = '2026-09-28T16:10:00Z';
  assert.deepEqual(localParts(at, 'Asia/Bangkok'), { hour: 23, weekday: 1, day: '2026-09-28' });
  assert.deepEqual(localParts(at, 'Europe/Berlin'), { hour: 18, weekday: 1, day: '2026-09-28' });
  // Past midnight in Sydney: a different calendar day.
  assert.deepEqual(localParts(at, 'Australia/Sydney'), { hour: 2, weekday: 2, day: '2026-09-29' });
});

test('midnight is hour 0, never 24', () => {
  assert.equal(localParts('2026-09-28T17:00:00Z', 'Asia/Bangkok').hour, 0);
});

test('ISO weeks: year boundaries and Sundays', () => {
  assert.equal(isoWeek('2026-09-28'), '2026-W40'); // a Monday
  assert.equal(isoWeek('2026-10-04'), '2026-W40'); // the Sunday of the same week
  assert.equal(isoWeek('2026-01-01'), '2026-W01'); // a Thursday
  assert.equal(isoWeek('2027-01-01'), '2026-W53'); // a Friday: still 2026's last week
  assert.equal(isoWeek('2027-01-04'), '2027-W01');
  assert.equal(mondayOf('2026-W40'), '2026-09-28');
  assert.equal(mondayOf('2026-W53'), '2026-12-28');
  assert.equal(daysOfWeek('2026-W40').at(-1), '2026-10-04');
  assert.deepEqual(previousWeeks('2026-W02', 3), ['2026-W01', '2025-W52', '2025-W51']);
});

test('day arithmetic crosses months', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('time zones are validated, and Jira offsets without a colon parse', () => {
  assert.equal(isValidZone('Asia/Bangkok'), true);
  assert.equal(isValidZone('Mars/Olympus'), false);
  assert.equal(isValidZone(''), false);
  assert.equal(parseInstant('2026-09-28T23:10:00.000+0700').toISOString(), '2026-09-28T16:10:00.000Z');
  assert.equal(parseInstant('2026-09-28T23:10:00.000+07:00').toISOString(), '2026-09-28T16:10:00.000Z');
  assert.equal(parseInstant('yesterday-ish'), null);
  assert.equal(parseInstant(undefined), null);
});
