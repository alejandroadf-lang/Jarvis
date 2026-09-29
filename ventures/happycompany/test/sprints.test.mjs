import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintSummary, sprintMetrics, sprintMetricsForWeek } from '../src/lib/sprints.mjs';

const sprint = { id: 42, startDate: '2026-09-14T09:00:00.000Z', completeDate: '2026-09-28T09:00:00.000Z' };

test('a sprint summary counts committed, carried over and unplanned', () => {
  const issues = [
    { done: true, created: '2026-09-10T00:00:00Z', resolved: '2026-09-20T00:00:00Z' },
    { done: true, created: '2026-09-10T00:00:00Z', resolved: '2026-09-29T00:00:00Z' }, // finished after close: carried
    { done: false, created: '2026-09-10T00:00:00Z', resolved: null },
    { done: true, created: '2026-09-20T00:00:00Z', resolved: '2026-09-21T00:00:00Z' }, // created mid-sprint
    { done: false, created: '2026-09-25T00:00:00Z', resolved: null }, // mid-sprint and carried
  ];
  assert.deepEqual(sprintSummary(sprint, issues), { id: '42', completeDate: '2026-09-28', committed: 5, carried: 3, unplanned: 2 });
  assert.deepEqual(sprintSummary({ id: 1, completeDate: '2026-09-28T09:00:00.000Z' }, []), { id: '1', completeDate: '2026-09-28', committed: 0, carried: 0, unplanned: 0 });
});

test('sprint metrics are shares of everything committed, null when nothing was', () => {
  const m = sprintMetrics([
    { committed: 10, carried: 1, unplanned: 2 },
    { committed: 10, carried: 3, unplanned: 0 },
  ]);
  assert.deepEqual(m, { carryOverShare: 0.2, unplannedShare: 0.1, sprints: 2 });
  assert.deepEqual(sprintMetrics([]), { carryOverShare: null, unplannedShare: null, sprints: 0 });
});

test('a week uses its own sprints, else the most recent one in the fallback window, else nothing', () => {
  const summaries = [
    { id: '1', completeDate: '2026-09-14', committed: 10, carried: 5, unplanned: 0 },
    { id: '2', completeDate: '2026-09-28', committed: 10, carried: 1, unplanned: 1 },
  ];
  const week40 = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  const week41 = week40.map((d) => d.replace('2026-09-28', '2026-10-05').replace('2026-09-29', '2026-10-06').replace('2026-09-30', '2026-10-07').replace('2026-10-01', '2026-10-08').replace('2026-10-02', '2026-10-09').replace('2026-10-03', '2026-10-10').replace('2026-10-04', '2026-10-11'));
  assert.equal(sprintMetricsForWeek(summaries, week40, []).carryOverShare, 0.1);
  assert.equal(sprintMetricsForWeek(summaries, week41, [...week40]).carryOverShare, 0.1); // falls back to sprint 2
  assert.equal(sprintMetricsForWeek(summaries, week41, []).carryOverShare, null);
});
