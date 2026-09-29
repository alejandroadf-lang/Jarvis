import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enablerScore, enablerCard, ENABLER_KEYS } from '../src/lib/enablers.mjs';
import { changelogTags } from '../src/lib/events.mjs';
import { emptyBucket, recordActivity, periodMetrics, soloShare } from '../src/lib/signals.mjs';
import { openWorkSnapshot } from '../src/lib/openwork.mjs';

test('enabler scores: lower is better, except self-assigned work', () => {
  assert.equal(enablerScore('blockedShare', 0.05), 100);
  assert.equal(enablerScore('blockedShare', 0.3), 0);
  assert.equal(enablerScore('selfAssignedShare', 0.7), 100);
  assert.equal(enablerScore('selfAssignedShare', 0.2), 0);
  assert.equal(enablerScore('selfAssignedShare', 0.4), 50);
  assert.equal(enablerScore('soloShare', null), null);
});

test('the enabler card has its own score and suggests actions only where needed', () => {
  const c = enablerCard({ reprioritisationRate: 3, selfAssignedShare: 0.8, soloShare: 0.5 }, { blockedShare: 0.2 });
  assert.equal(c.indicators.length, ENABLER_KEYS.length);
  assert.equal(c.indicators.find((i) => i.key === 'selfAssignedShare').action, '');
  assert.ok(c.indicators.find((i) => i.key === 'reprioritisationRate').action.length > 10);
  assert.equal(enablerCard({}, null, { soloShare: false }).indicators.some((i) => i.key === 'soloShare'), false);
});

test('changelog tags for priority churn and self-assignment', () => {
  const ev = (items, actor = 'me') => ({ atlassianId: actor, changelog: { items } });
  assert.deepEqual(changelogTags(ev([{ field: 'priority', from: '3', to: '1' }])), ['reprioritised']);
  assert.deepEqual(changelogTags(ev([{ field: 'priority', from: null, to: '1' }])), []);
  assert.deepEqual(changelogTags(ev([{ field: 'assignee', from: null, to: 'me' }])), ['selfAssigned']);
  assert.deepEqual(changelogTags(ev([{ field: 'assignee', from: 'me', to: 'you' }])), ['assignedByOther']);
});

test('metrics: reprioritisation per person, self-assigned share, solo work', () => {
  const b = emptyBucket();
  const add = (actor, item, tags = []) => recordActivity(b, { actor, hour: 10, weekday: 2, day: '2026-09-29', item, tags });
  add('a', 'i1', ['reprioritised', 'selfAssigned']);
  add('b', 'i1', ['selfAssigned']);
  add('a', 'i2', ['assignedByOther']);
  add('a', 'i3');
  add('b', 'i4');
  add('b', 'i5', ['reprioritised']);
  const m = periodMetrics([b]);
  assert.equal(m.reprioritisationRate, 1); // 2 changes, 2 people
  assert.ok(Math.abs(m.selfAssignedShare - 2 / 3) < 1e-9);
  assert.equal(m.soloShare, 0.8); // i2..i5 solo, i1 shared
  assert.equal(soloShare([emptyBucket()]), null);
});

test('blocked share from the flagged count', () => {
  const issues = [{ assignee: 'a', inProgress: true }, { assignee: 'a', inProgress: true }, { assignee: 'b', inProgress: false }, { assignee: 'b', inProgress: true }];
  assert.ok(Math.abs(openWorkSnapshot(issues, (x) => x, '2026-09-29', { flaggedInProgress: 1 }).blockedShare - 1 / 3) < 1e-9);
  assert.equal(openWorkSnapshot(issues, (x) => x, '2026-09-29').blockedShare, null);
});
