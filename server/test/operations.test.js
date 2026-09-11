// The Agent Operations Engineer only earns its place if it can see how the
// company actually ran. These cover the context that makes that true — and
// that it stays scoped to that one role.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let operations;
let dailyReports;
let context;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-operations-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  operations = await import('../agents/operations.js');
  dailyReports = await import('../dailyReports.js');
  context = await import('../finance/context.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'dailyReports.json'), { force: true });
});

function saveReport(date, leadershipTrace, extra = {}) {
  dailyReports.saveDailyReport({
    date,
    generatedAt: new Date().toISOString(),
    leadership: { reply: 'x', trace: leadershipTrace },
    studio: { reply: 'y', trace: [] },
    proposedVentureIds: [],
    business: { revenue: 0, expenses: 0, net: 0 },
    usage: { inputTokens: 1000, outputTokens: 500 },
    costUsd: 0.08,
    durationMs: 47000,
    ...extra,
  });
}

test('with no cycles run it says so rather than inventing performance', () => {
  const text = operations.buildOperationsContext();
  assert.match(text, /No daily cycles have run yet/);
  assert.match(text, /rather than speculating/);
});

test('it counts how often each agent was actually consulted', () => {
  saveReport('2026-09-09', [{ id: 'cto' }, { id: 'engineering_lead' }]);
  saveReport('2026-09-10', [{ id: 'cto' }]);

  const text = operations.buildOperationsContext();
  assert.match(text, /- cto: 2/);
  assert.match(text, /- engineering_lead: 1/);
});

// The most actionable signal, and the one nobody was looking at: a role
// nobody asks dilutes the profit share and adds a tool every manager weighs.
test('it names the agents nobody consulted, and invites cutting them', () => {
  saveReport('2026-09-10', [{ id: 'cto' }]);

  const text = operations.buildOperationsContext();
  assert.match(text, /Never consulted once in this window:/);
  assert.match(text, /hr_manager/);
  assert.doesNotMatch(text.split('Never consulted')[1], /\bcto\b/);
  assert.match(text, /willing to recommend removing a role outright/);
});

test('it reports what a cycle actually costs', () => {
  saveReport('2026-09-10', [{ id: 'cto' }]);
  const text = operations.buildOperationsContext();
  assert.match(text, /Average cycle: \$0\.08 and 47\.0s/);
});

test('a report saved before cost tracking does not break the summary', () => {
  saveReport('2026-09-10', [{ id: 'cto' }], { costUsd: undefined, durationMs: undefined });
  const text = operations.buildOperationsContext();
  assert.match(text, /- cto: 1/);
  assert.doesNotMatch(text, /NaN|undefined/);
});

// Operating data is a wall of numbers. It belongs in one prompt, not 24 —
// and an agent reasoning about the org chart while doing its actual job is
// the distraction this company least needs.
test('only the operations engineer gets the operating data', () => {
  saveReport('2026-09-10', [{ id: 'cto' }]);

  assert.match(context.buildPerAgentContext('agent_operations_engineer'), /Never consulted once/);
  for (const other of ['marketing_manager', 'ceo', 'data_analyst', 'automation_architect']) {
    assert.doesNotMatch(
      context.buildPerAgentContext(other),
      /Never consulted once/,
      `${other} should not receive the operating data`
    );
  }
});

test('every agent still gets its own earnings line', () => {
  for (const id of ['agent_operations_engineer', 'marketing_manager']) {
    assert.match(context.buildPerAgentContext(id), /Your stake:/);
  }
});
