import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeDaysByPerson, hasStreak, streakShare, updatePeopleRecord, noRestShare } from '../src/lib/recovery.mjs';
import { DEFAULT_SETTINGS } from '../src/lib/signals.mjs';

const days = (...list) => new Set(list);

test('seven days in a row is a streak; a normal week with a weekend is not', () => {
  assert.equal(hasStreak(days('2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'), '2026-09-27'), true);
  assert.equal(hasStreak(days('2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29'), '2026-09-29'), false);
});

test('twelve days with only single days off is a streak too', () => {
  const list = [];
  for (let d = 14; d <= 25; d++) if (d !== 19 && d !== 22) list.push(`2026-09-${d}`);
  assert.equal(hasStreak(days(...list), '2026-09-25'), true);
  // The same with a real weekend (two days off) in it is fine.
  const withWeekend = list.filter((d) => d !== '2026-09-20' && d !== '2026-09-19');
  assert.equal(hasStreak(days(...withWeekend), '2026-09-25'), false);
});

test('streak share counts only people active this week', () => {
  const byPerson = {
    grinder: days('2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'),
    normal: days('2026-09-28', '2026-09-29'),
    gone: days('2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07'),
  };
  const week = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  assert.equal(streakShare(byPerson, week, '2026-09-30'), 0.5);
  assert.equal(streakShare({}, week, '2026-09-30'), null);
});

test('the people record learns first seen, last seen and the last five-workday rest', () => {
  const rows = [];
  // Alice works every weekday of three weeks except the whole middle week.
  for (let d = 7; d <= 27; d++) {
    const day = `2026-09-${String(d).padStart(2, '0')}`;
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const people = {};
    if (weekday !== 0 && weekday !== 6 && !(d >= 14 && d <= 18)) people.alice = { n: 1, hours: [9], items: [], mentions: 0 };
    if (weekday !== 0 && weekday !== 6) people.bob = { n: 1, hours: [9], items: [], mentions: 0 };
    rows.push({ day, bucket: { v: 2, total: 1, afterHours: 0, late: 0, weekend: 0, kinds: {}, people } });
  }
  const record = updatePeopleRecord({}, rows, DEFAULT_SETTINGS, '2026-09-28');
  assert.deepEqual(record.alice, { firstSeen: '2026-09-07', lastSeen: '2026-09-25', lastRest: '2026-09-18' });
  assert.equal(record.bob.lastRest, null);

  // Someone not seen for 120 days is forgotten.
  const stale = updatePeopleRecord({ ...record, ghost: { firstSeen: '2026-01-01', lastSeen: '2026-03-01', lastRest: null } }, rows, DEFAULT_SETTINGS, '2026-09-28');
  assert.equal(stale.ghost, undefined);
  assert.ok(stale.alice);
});

test('no-rest share needs 90 days of history per person and counts a stale rest as none', () => {
  const record = {
    fresh: { firstSeen: '2026-09-01', lastSeen: '2026-09-28', lastRest: null }, // too new to judge
    rested: { firstSeen: '2026-01-01', lastSeen: '2026-09-28', lastRest: '2026-08-10' },
    never: { firstSeen: '2026-01-01', lastSeen: '2026-09-28', lastRest: null },
    longAgo: { firstSeen: '2026-01-01', lastSeen: '2026-09-28', lastRest: '2026-03-01' },
  };
  assert.ok(Math.abs(noRestShare(record, ['fresh', 'rested', 'never', 'longAgo'], '2026-09-28') - 2 / 3) < 1e-9);
  assert.equal(noRestShare(record, ['fresh'], '2026-09-28'), null);
  assert.equal(activeDaysByPerson([]).constructor, Object);
});
