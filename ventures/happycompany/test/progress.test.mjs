import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToNextGrade, scoreWith, nextGrade } from '../src/lib/progress.mjs';
import { scorecard, publicValue } from '../src/lib/score.mjs';

const strained = () =>
  scorecard(
    { total: 300, contributors: 6, afterHoursShare: 0.3, lateShare: 0.12, weekendShare: 0.02, topShare: 0.2, longSpanShare: 0.05 },
    { overloadedShare: 0, overdueShare: 0.05 },
  );

test('the next grade and its floor', () => {
  assert.equal(nextGrade('E'), 'D');
  assert.equal(nextGrade('B'), 'A');
  assert.equal(nextGrade('A'), null);
});

test('replacing one indicator recomputes the score the way the scorecard does', () => {
  const card = strained();
  assert.equal(scoreWith(card, 'nonexistent', 100), card.score);
  const lifted = scoreWith(card, 'afterHoursShare', 100);
  assert.ok(lifted > card.score);
});

test('the levers are sorted by lift, and say whether one alone reaches the next grade', () => {
  const card = strained();
  const path = pathToNextGrade(card);
  assert.equal(path.grade, card.grade);
  assert.equal(path.target, nextGrade(card.grade));
  assert.ok(path.levers.length >= 2);
  assert.ok(path.levers[0].liftsTo >= path.levers[1].liftsTo);
  assert.deepEqual(path.levers.slice(0, 2).map((l) => l.key).sort(), ['afterHoursShare', 'lateShare']);
  for (const l of path.levers) assert.equal(l.reaches, l.liftsTo >= { A: 85, B: 70, C: 55, D: 40 }[path.target]);
});

test('an A has nowhere to go, and no card means no path', () => {
  const a = scorecard({ total: 300, contributors: 6, afterHoursShare: 0.01, weekendShare: 0, topShare: 0.2 }, null);
  assert.equal(a.grade, 'A');
  assert.deepEqual(pathToNextGrade(a).levers, []);
  assert.equal(pathToNextGrade(null), null);
});

test('values reach the browser rounded: shares to 5%, the rest to one decimal', () => {
  assert.equal(publicValue('afterHoursShare', 0.2239), 0.2);
  assert.equal(publicValue('afterHoursShare', 0.2251), 0.25);
  assert.equal(publicValue('concentration', 0.137), 0.15);
  assert.equal(publicValue('wipMean', 2.346), 2.3);
  assert.equal(publicValue('reopenRate', null), null);
});
