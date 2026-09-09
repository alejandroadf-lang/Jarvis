import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let weeklyReflections;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-weeklyreflections-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  weeklyReflections = await import('../weeklyReflections.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeReflection(weekEnding, overrides = {}) {
  return {
    weekEnding,
    generatedAt: `${weekEnding}T01:30:00.000Z`,
    reportsConsidered: 7,
    reflection: 'a week happened',
    trace: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0.001,
    durationMs: 5000,
    ...overrides,
  };
}

test('weekKey returns the most recent Sunday (UTC) on or before the given date', () => {
  // 2026-03-08 is a Sunday.
  assert.equal(weeklyReflections.weekKey(new Date('2026-03-08T00:00:00Z')), '2026-03-08');
  assert.equal(weeklyReflections.weekKey(new Date('2026-03-08T23:59:59Z')), '2026-03-08');
  assert.equal(weeklyReflections.weekKey(new Date('2026-03-11T12:00:00Z')), '2026-03-08'); // Wednesday -> preceding Sunday
  assert.equal(weeklyReflections.weekKey(new Date('2026-03-14T23:59:59Z')), '2026-03-08'); // Saturday -> same week's Sunday
  assert.equal(weeklyReflections.weekKey(new Date('2026-03-15T00:00:00Z')), '2026-03-15'); // next Sunday
});

test('listWeeklyReflections starts empty, getLatestWeeklyReflection is null, hasReflectionForThisWeek is false', () => {
  assert.deepEqual(weeklyReflections.listWeeklyReflections(), []);
  assert.equal(weeklyReflections.getLatestWeeklyReflection(), null);
  assert.equal(weeklyReflections.hasReflectionForThisWeek(), false);
});

test('saveWeeklyReflection persists and getWeeklyReflection retrieves it by weekEnding', () => {
  const saved = weeklyReflections.saveWeeklyReflection(makeReflection('2026-01-04'));
  assert.deepEqual(weeklyReflections.getWeeklyReflection('2026-01-04'), saved);
  assert.equal(weeklyReflections.getWeeklyReflection('2026-01-11'), null);
});

test('saving a reflection for this week makes hasReflectionForThisWeek true', () => {
  weeklyReflections.saveWeeklyReflection(makeReflection(weeklyReflections.weekKey()));
  assert.equal(weeklyReflections.hasReflectionForThisWeek(), true);
});

test('listWeeklyReflections sorts newest first and getLatestWeeklyReflection matches the top of that list', () => {
  weeklyReflections.saveWeeklyReflection(makeReflection('2026-01-18'));
  weeklyReflections.saveWeeklyReflection(makeReflection('2026-01-11'));

  const list = weeklyReflections.listWeeklyReflections();
  const weeks = list.map((r) => r.weekEnding);
  assert.deepEqual([...weeks].sort().reverse(), weeks);
  assert.deepEqual(weeklyReflections.getLatestWeeklyReflection(), list[0]);
});

test('saveWeeklyReflection for an existing week overwrites rather than duplicating', () => {
  weeklyReflections.saveWeeklyReflection(makeReflection('2026-01-04', { reflection: 'first run' }));
  const before = weeklyReflections.listWeeklyReflections().length;

  weeklyReflections.saveWeeklyReflection(makeReflection('2026-01-04', { reflection: 'second run' }));

  assert.equal(weeklyReflections.listWeeklyReflections().length, before);
  assert.equal(weeklyReflections.getWeeklyReflection('2026-01-04').reflection, 'second run');
});
