import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indicatorScore, indicatorValues, scorecard, gradeOf, statusOf, trend, BANDS, INDICATOR_KEYS, DIMENSIONS } from '../src/lib/score.mjs';

test('an indicator is 100 at or below good, 0 at or above poor, linear between', () => {
  const { good, poor } = BANDS.afterHoursShare;
  assert.equal(indicatorScore('afterHoursShare', good), 100);
  assert.equal(indicatorScore('afterHoursShare', poor), 0);
  assert.equal(indicatorScore('afterHoursShare', (good + poor) / 2), 50);
  assert.equal(indicatorScore('afterHoursShare', 0), 100);
  assert.equal(indicatorScore('afterHoursShare', null), null);
  assert.equal(indicatorScore('overloadedShare', 0), 100);
  assert.equal(indicatorScore('wipMean', 3.5), 50);
});

test('every indicator belongs to a dimension and has text', () => {
  for (const key of INDICATOR_KEYS) assert.ok(DIMENSIONS[BANDS[key].dimension], key);
  const card = scorecard(
    { total: 300, contributors: 6, personDays: 30, afterHoursShare: 0.3, lateShare: 0.2, weekendShare: 0.2, topShare: 0.6, longSpanShare: 0.5, burstyShare: 0.5, itemsMedian: 12, mentionsPerPersonDay: 9, mentionTopShare: 0.6, reopenRate: 0.2, streakShare: 0.5, noRestShare: 0.8 },
    { overloadedShare: 0.4, overdueShare: 0.4, wipMean: 6, dueCrunch: 5, highPriorityShare: 0.7 },
  );
  for (const d of Object.values(card.dimensions)) for (const i of d.indicators) assert.ok(i.text.length > 10, i.key);
  assert.equal(card.score, 0);
  assert.equal(card.grade, 'E');
  assert.equal(card.actions.length, 3);
  assert.ok(card.actions.every((a) => a.action.length > 10));
});

test('concentration is the excess over an even share', () => {
  const v = indicatorValues({ topShare: 0.5, contributors: 5 }, null);
  assert.ok(Math.abs(v.concentration - 0.3) < 1e-9);
  assert.equal(indicatorValues({ topShare: 0.2, contributors: 5 }, null).concentration, 0);
  assert.equal(indicatorValues(null, null).concentration, null);
});

test('grades and statuses at their boundaries', () => {
  assert.equal(gradeOf(85), 'A');
  assert.equal(gradeOf(84), 'B');
  assert.equal(gradeOf(70), 'B');
  assert.equal(gradeOf(55), 'C');
  assert.equal(gradeOf(40), 'D');
  assert.equal(gradeOf(39), 'E');
  assert.equal(gradeOf(null), null);
  assert.equal(statusOf(70), 'good');
  assert.equal(statusOf(45), 'watch');
  assert.equal(statusOf(44), 'act');
  assert.equal(statusOf(null), 'unknown');
});

test('a healthy team is an A with no actions; a strained one gets its three worst indicators as actions', () => {
  const healthy = scorecard(
    { total: 300, contributors: 6, afterHoursShare: 0.03, lateShare: 0, weekendShare: 0.01, topShare: 0.2, longSpanShare: 0.05, burstyShare: 0.05, itemsMedian: 3, mentionsPerPersonDay: 1, mentionTopShare: 0.2, reopenRate: 0.02, streakShare: 0, noRestShare: 0.1 },
    { overloadedShare: 0, overdueShare: 0.05, wipMean: 1.5, dueCrunch: 1.5, highPriorityShare: 0.1 },
  );
  assert.equal(healthy.grade, 'A');
  assert.deepEqual(healthy.actions, []);

  const strained = scorecard(
    { total: 300, contributors: 6, afterHoursShare: 0.3, lateShare: 0.12, weekendShare: 0.02, topShare: 0.2 },
    { overloadedShare: 0.05, overdueShare: 0.1 },
  );
  assert.equal(strained.dimensions.hours.status, 'act');
  // Two indicators are bad; the healthy ones never become "actions".
  assert.deepEqual(
    strained.actions.map((a) => a.key),
    ['afterHoursShare', 'lateShare'],
  );
  assert.match(strained.dimensions.hours.indicators[0].text, /30% of activity happened outside working hours/);
});

test('missing data is left out rather than counted, and a switched-off signal too', () => {
  const partial = scorecard({ total: 50, contributors: 5, afterHoursShare: 0.02, weekendShare: 0.0, topShare: 0.2 }, null);
  assert.equal(partial.dimensions.workload.indicators.find((i) => i.key === 'overdueShare').score, null);
  assert.equal(partial.dimensions.workload.score, 100); // concentration alone, fine
  assert.equal(partial.dimensions.rework.score, null);
  assert.equal(partial.score, 100);
  const nothing = scorecard(null, null);
  assert.equal(nothing.score, null);
  assert.equal(nothing.grade, null);
  assert.equal(nothing.status, 'unknown');

  const off = scorecard({ total: 50, contributors: 5, afterHoursShare: 0.5, weekendShare: 0.0, topShare: 0.2 }, null, { afterHoursShare: false });
  assert.equal(off.dimensions.hours.indicators.some((i) => i.key === 'afterHoursShare'), false);
  assert.equal(off.dimensions.hours.score, 100);
});

test('a trend needs earlier weeks and ignores noise', () => {
  assert.deepEqual(trend(80, []), { delta: null, direction: 'flat' });
  assert.deepEqual(trend(80, [70, 72]), { delta: 9, direction: 'up' });
  assert.deepEqual(trend(60, [70, 72]), { delta: -11, direction: 'down' });
  assert.deepEqual(trend(73, [70, 72]), { delta: 2, direction: 'flat' });
});
