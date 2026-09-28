import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indicatorScore, indicatorValues, scorecard, gradeOf, statusOf, trend, BANDS } from '../src/lib/score.mjs';

test('an indicator is 100 at or below good, 0 at or above poor, linear between', () => {
  const { good, poor } = BANDS.afterHoursShare;
  assert.equal(indicatorScore('afterHoursShare', good), 100);
  assert.equal(indicatorScore('afterHoursShare', poor), 0);
  assert.equal(indicatorScore('afterHoursShare', (good + poor) / 2), 50);
  assert.equal(indicatorScore('afterHoursShare', 0), 100);
  assert.equal(indicatorScore('afterHoursShare', null), null);
  assert.equal(indicatorScore('overloadedShare', 0), 100);
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

test('a healthy team is an A and a team working nights and weekends is not', () => {
  const healthy = scorecard(
    { total: 300, contributors: 6, afterHoursShare: 0.03, weekendShare: 0.01, topShare: 0.2 },
    { overloadedShare: 0, overdueShare: 0.05 },
  );
  assert.equal(healthy.grade, 'A');
  assert.equal(healthy.dimensions.hours.status, 'good');

  const strained = scorecard(
    { total: 300, contributors: 6, afterHoursShare: 0.3, weekendShare: 0.2, topShare: 0.6 },
    { overloadedShare: 0.4, overdueShare: 0.4 },
  );
  assert.equal(strained.score, 0);
  assert.equal(strained.grade, 'E');
  assert.equal(strained.dimensions.workload.status, 'act');
  assert.match(strained.dimensions.hours.indicators[0].text, /30% of activity happened outside working hours/);
});

test('missing data is left out rather than counted', () => {
  const partial = scorecard({ total: 50, contributors: 5, afterHoursShare: 0.02, weekendShare: 0.0, topShare: 0.2 }, null);
  assert.equal(partial.dimensions.workload.indicators.find((i) => i.key === 'overdueShare').score, null);
  assert.equal(partial.dimensions.workload.score, 100); // concentration alone, fine
  assert.equal(partial.score, 100);
  const nothing = scorecard(null, null);
  assert.equal(nothing.score, null);
  assert.equal(nothing.grade, null);
  assert.equal(nothing.status, 'unknown');
});

test('a trend needs earlier weeks and ignores noise', () => {
  assert.deepEqual(trend(80, []), { delta: null, direction: 'flat' });
  assert.deepEqual(trend(80, [70, 72]), { delta: 9, direction: 'up' });
  assert.deepEqual(trend(60, [70, 72]), { delta: -11, direction: 'down' });
  assert.deepEqual(trend(73, [70, 72]), { delta: 2, direction: 'flat' });
});
