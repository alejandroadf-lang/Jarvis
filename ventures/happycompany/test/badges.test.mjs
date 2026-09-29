import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earnedBadges, actionStreak, canFreeze } from '../src/lib/badges.mjs';

const w = (n, grade, extra = {}) => ({ week: `2026-W${String(n).padStart(2, '0')}`, grade, fragmentationStatus: 'watch', hoursStatus: 'watch', ...extra });

test('Recovered needs a D or E, then four weeks at C or better', () => {
  const almost = [w(30, 'D'), w(31, 'C'), w(32, 'B'), w(33, 'C')];
  assert.equal(earnedBadges(almost).some((b) => b.key === 'recovered'), false);
  const done = [...almost, w(34, 'C')];
  const badge = earnedBadges(done).find((b) => b.key === 'recovered');
  assert.equal(badge.week, '2026-W34');
  // Being an A all along earns nothing: badges reward change, not level.
  assert.deepEqual(earnedBadges([w(30, 'A'), w(31, 'A'), w(32, 'A'), w(33, 'A'), w(34, 'A')]), []);
});

test('Protected focus needs four good fragmentation weeks in a row', () => {
  const weeks = [30, 31, 32, 33].map((n) => w(n, 'B', { fragmentationStatus: 'good' }));
  assert.ok(earnedBadges(weeks).some((b) => b.key === 'focus'));
  weeks[2].fragmentationStatus = 'act';
  assert.equal(earnedBadges(weeks).some((b) => b.key === 'focus'), false);
});

test('an action streak counts weeks with something done; an open current week and freeze weeks do not break it', () => {
  const keys = ['2026-W30', '2026-W31', '2026-W32', '2026-W33', '2026-W34'];
  const acts = { '2026-W30': { done: 1 }, '2026-W31': { done: 2 }, '2026-W33': { done: 1 }, '2026-W34': { done: 0 } };
  assert.deepEqual(actionStreak(keys, acts), { length: 1, endWeek: '2026-W33' });
  assert.deepEqual(actionStreak(keys, acts, ['2026-W32']), { length: 3, endWeek: '2026-W33' });
  const badges = earnedBadges(keys.map((k) => ({ week: k, grade: 'B' })), acts, ['2026-W32']);
  assert.equal(badges.find((b) => b.key === 'streak').label, 'Action streak: 3 weeks');
});

test('a sustainable release is a sprint closed nearly complete in a healthy-hours week', () => {
  const weeks = [w(30, 'B', { sprintClosed: true, carryOverShare: 0.05, hoursStatus: 'good' }), w(32, 'B', { sprintClosed: true, carryOverShare: 0.3, hoursStatus: 'good' })];
  const badges = earnedBadges(weeks);
  assert.equal(badges.filter((b) => b.key === 'release').length, 1);
});

test('at most two freeze weeks a quarter, and not the same week twice', () => {
  const recent = Array.from({ length: 13 }, (_, i) => `2026-W${String(40 - i).padStart(2, '0')}`);
  assert.equal(canFreeze([], '2026-W40', recent), true);
  assert.equal(canFreeze(['2026-W35'], '2026-W40', recent), true);
  assert.equal(canFreeze(['2026-W35', '2026-W38'], '2026-W40', recent), false);
  assert.equal(canFreeze(['2026-W20', '2026-W22'], '2026-W40', recent), true); // outside the quarter
  assert.equal(canFreeze(['2026-W40'], '2026-W40', recent), false);
});
