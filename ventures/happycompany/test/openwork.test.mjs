import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorkSnapshot, dueCrunch, OVERLOAD_FLOOR } from '../src/lib/openwork.mjs';

const issues = (spec) =>
  Object.entries(spec).flatMap(([who, n]) => Array.from({ length: n }, () => ({ assignee: who === 'nobody' ? null : who, overdue: false })));

test('a snapshot keeps team figures and no account id', () => {
  const list = [
    ...issues({ a: 3, b: 4, c: 3, d: 20, nobody: 2 }),
    { assignee: 'a', overdue: true, inProgress: true, high: true, due: '2026-09-01' },
    { assignee: null, overdue: true },
  ];
  const snap = openWorkSnapshot(list, (id) => `p-${id}`, '2026-09-28');
  assert.equal(snap.openTotal, 34);
  assert.equal(snap.unassigned, 3);
  assert.equal(snap.unassignedOverdue, 1);
  assert.equal(snap.people, 4);
  assert.equal(snap.medianOpen, 4);
  assert.ok(Math.abs(snap.overdueShare - 2 / 34) < 1e-9);
  assert.equal(snap.overloadedShare, 0.25); // d, with 20 against a median of 4
  assert.ok(Math.abs(snap.topShare - 20 / 31) < 1e-9);
  assert.equal(snap.wipMean, 0.3); // one in-progress item across four people
  assert.equal(snap.wipHighShare, 0);
  assert.ok(Math.abs(snap.highPriorityShare - 1 / 34) < 1e-9);
  assert.equal(snap.dueCrunch, null);
  assert.ok(!JSON.stringify(snap).includes('p-'));
});

test('the overload floor stops tiny teams from flagging two issues', () => {
  const snap = openWorkSnapshot(issues({ a: 1, b: 1, c: 2 }), (id) => id, '2026-09-28');
  assert.equal(snap.overloadedShare, 0);
  const big = openWorkSnapshot(issues({ a: 1, b: 1, c: OVERLOAD_FLOOR }), (id) => id, '2026-09-28');
  assert.ok(Math.abs(big.overloadedShare - 1 / 3) < 1e-9);
});

test('work in progress per person and the high-WIP share', () => {
  const list = [
    ...Array.from({ length: 6 }, () => ({ assignee: 'a', inProgress: true })),
    { assignee: 'b', inProgress: true },
    { assignee: 'b', inProgress: false },
    { assignee: 'c', inProgress: false },
  ];
  const snap = openWorkSnapshot(list, (id) => id, '2026-09-28');
  assert.equal(snap.wipMean, 2.3);
  assert.ok(Math.abs(snap.wipHighShare - 1 / 3) < 1e-9);
});

test('due-date crunch compares the busiest five-day window with a typical one', () => {
  const spread = ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05'];
  assert.equal(dueCrunch(spread, '2026-09-28'), null); // no window reaches five issues
  const crunch = [...Array(10).fill('2026-10-30'), '2026-10-08', '2026-10-15', '2026-11-12'];
  assert.equal(dueCrunch(crunch, '2026-09-28'), 3.1); // 10 against a mean of 3.25
  assert.equal(dueCrunch(['2026-01-01', null, '2027-01-01'], '2026-09-28'), null); // past and beyond the horizon ignored
});

test('an empty project gives nulls, not zeros', () => {
  const snap = openWorkSnapshot([], (id) => id, '2026-09-28');
  assert.equal(snap.overdueShare, null);
  assert.equal(snap.overloadedShare, null);
  assert.equal(snap.wipMean, null);
  assert.equal(snap.highPriorityShare, null);
  assert.equal(snap.people, 0);
});
