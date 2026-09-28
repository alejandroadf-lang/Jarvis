import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorkSnapshot, OVERLOAD_FLOOR } from '../src/lib/openwork.mjs';

const issues = (spec) =>
  Object.entries(spec).flatMap(([who, n]) => Array.from({ length: n }, () => ({ assignee: who === 'nobody' ? null : who, overdue: false })));

test('a snapshot keeps team figures and no account id', () => {
  const list = [...issues({ a: 3, b: 4, c: 3, d: 20, nobody: 2 }), { assignee: 'a', overdue: true }];
  const snap = openWorkSnapshot(list, (id) => `p-${id}`, '2026-09-28');
  assert.equal(snap.openTotal, 33);
  assert.equal(snap.unassigned, 2);
  assert.equal(snap.people, 4);
  assert.equal(snap.medianOpen, 4);
  assert.ok(Math.abs(snap.overdueShare - 1 / 33) < 1e-9);
  assert.equal(snap.overloadedShare, 0.25); // d, with 20 against a median of 4
  assert.ok(Math.abs(snap.topShare - 20 / 31) < 1e-9);
  assert.ok(!JSON.stringify(snap).includes('p-'));
});

test('the overload floor stops tiny teams from flagging two issues', () => {
  const snap = openWorkSnapshot(issues({ a: 1, b: 1, c: 2 }), (id) => id, '2026-09-28');
  assert.equal(snap.overloadedShare, 0);
  const big = openWorkSnapshot(issues({ a: 1, b: 1, c: OVERLOAD_FLOOR }), (id) => id, '2026-09-28');
  assert.ok(Math.abs(big.overloadedShare - 1 / 3) < 1e-9);
});

test('an empty project gives nulls, not zeros', () => {
  const snap = openWorkSnapshot([], (id) => id, '2026-09-28');
  assert.equal(snap.overdueShare, null);
  assert.equal(snap.overloadedShare, null);
  assert.equal(snap.people, 0);
});
