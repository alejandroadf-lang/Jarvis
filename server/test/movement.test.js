// Whether the morning sync runs wide or narrow.
//
// The wide sync reaches 22 agents and costs a minimum of 27 Anthropic calls,
// and it used to run identically on a day with three commits and a day with
// nothing at all. That is the company's largest recurring cost, and on a dead
// day it buys 22 agents being asked for "one real, specific data point" about a
// company that did nothing.
//
// The risk in fixing it runs the other way, which is what most of these tests
// are about: a detector that misses a real event reports "nothing moved" while
// something was broken, and a field name typo'd here would do that silently and
// forever. So every signal is asserted against a record written by the real
// function that writes it, never against a hand-built object that could agree
// with a wrong field name.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let movement;
let ventures;
let tasks;
let ledger;
let plan;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-movement-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  movement = await import('../movement.js');
  ventures = await import('../finance/ventures.js');
  tasks = await import('../tasks.js');
  ledger = await import('../finance/ledger.js');
  plan = await import('../dailyPlan.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from an empty company; these are the only files any of
  // the signals below read.
  for (const file of ['ventures.json', 'tasks.json', 'ledger.json', 'dailyPlans.json']) {
    fs.rmSync(path.join(tmpDir, file), { force: true });
  }
});

const HOUR_AGO = Date.now() - 60 * 60 * 1000;

function makeVenture() {
  return ventures.createVenture({
    title: 'CircadianAPI',
    oneLiner: 'Schedules',
    problem: 'Jet lag',
    targetCustomer: 'Travellers',
    businessModel: 'API',
    marketSize: 'Big',
    pathToMillions: 'Scale',
    milestones: ['Ship it'],
  });
}

test('a company where nothing happened is quiet, and the sync goes narrow', () => {
  makeVenture();
  // createVenture stamps createdAt now, so compare from after it.
  const scope = movement.planSyncScope({ since: Date.now() });
  assert.equal(scope.full, false);
  assert.match(scope.reason, /nothing has moved/);
  assert.deepEqual(scope.movement.lines, []);
});

// Each of the following is a real event the old detector would have to catch.
// Written through the real recording function in every case, because the bug
// worth fearing here is a field name that never matches — `runs` stamps
// `startedAt` and ledger entries stamp `createdAt`, and guessing either wrong
// makes the company silently quiet forever.
test('a commit counts as movement', () => {
  const v = makeVenture();
  ventures.linkRepo(v.id, { owner: 'a', name: 'b', allowedPaths: ['src/'] });
  ventures.recordDeployment(v.id, { path: 'src/main.py', message: 'x', commitSha: 'abc', rationale: 'y' });

  const scope = movement.planSyncScope({ since: HOUR_AGO });
  assert.equal(scope.full, true);
  assert.match(scope.movement.lines.join('\n'), /1 commit/);
});

test('a customer email counts as movement', () => {
  const v = makeVenture();
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['a@b.com'] });
  ventures.recordOutreach(v.id, { to: 'a@b.com', subject: 's', body: 'b' });

  assert.match(movement.describeMovement({ since: HOUR_AGO }).lines.join('\n'), /1 customer email/);
});

// Nobody did anything and it is still the most important thing in the morning:
// the product went down between syncs.
test('a failing service probe counts as movement even though nobody acted', () => {
  const v = makeVenture();
  ventures.setServiceUrl(v.id, 'https://api.example.com');
  ventures.recordProbe(v.id, { path: '/health', status: 500, ok: false, ms: 12 });

  const scope = movement.planSyncScope({ since: HOUR_AGO });
  assert.equal(scope.full, true);
  assert.match(scope.movement.lines.join('\n'), /answered badly/);
});

test('a passing probe alone is not movement', () => {
  const v = makeVenture();
  ventures.setServiceUrl(v.id, 'https://api.example.com');
  ventures.recordProbe(v.id, { path: '/health', status: 200, ok: true, ms: 12 });

  assert.deepEqual(movement.describeMovement({ since: Date.now() }).lines, []);
});

test('a failing CI run counts as movement — and the timestamp field is startedAt', () => {
  const v = makeVenture();
  ventures.recordRun(v.id, { workflow: 'ci.yml', runId: 1, conclusion: 'failure' });

  assert.match(movement.describeMovement({ since: HOUR_AGO }).lines.join('\n'), /failing CI run/);
});

test('finished and queued tasks count as movement', () => {
  const queued = tasks.enqueueTask({ ventureId: 'v_1', title: 'Write the engine', queuedBy: 'cto' });
  tasks.startTask(queued.id);
  tasks.completeTask(queued.id, 'done');

  const lines = movement.describeMovement({ since: HOUR_AGO }).lines.join('\n');
  assert.match(lines, /1 task completed/);
  assert.match(lines, /1 new task queued/);
});

test('a ledger entry counts as movement — and its timestamp field is createdAt', () => {
  ledger.addTransaction({ type: 'revenue', amount: 50, description: 'first dollar' });

  assert.match(movement.describeMovement({ since: HOUR_AGO }).lines.join('\n'), /1 ledger entry/);
});

// Not movement, but the one state where a narrow sync would report "nothing
// happened" while the reason nothing happened sits in the founder's inbox.
test('a plan waiting on the founder forces the full sync', () => {
  const v = makeVenture();
  plan.submitPlan({
    summary: 'Ship the engine',
    items: [{ ventureId: v.id, action: 'deploy_code', intent: 'ship it' }],
  });

  const scope = movement.planSyncScope({ since: Date.now() });
  assert.equal(scope.full, true);
  assert.match(scope.reason, /waiting on the founder/);
  // And it is honest about the distinction: the plan is a reason to look wide,
  // not an event that happened.
  assert.deepEqual(scope.movement.lines, []);
});

test('an approved plan forces the full sync, because the team is cleared to work', () => {
  const v = makeVenture();
  plan.submitPlan({ summary: 's', items: [{ ventureId: v.id, action: 'deploy_code', intent: 'i' }] });
  plan.approvePlan();

  const scope = movement.planSyncScope({ since: Date.now() });
  assert.equal(scope.full, true);
  assert.match(scope.reason, /cleared to work/);
});

// The guard against the obvious failure of this whole change: a company that
// goes permanently quiet because nothing trips a counter. "Nothing changed" is
// exactly the state a wider look is most likely to have something to say about.
test('a long quiet stretch still gets a full sync eventually', () => {
  // No venture: creating one stamps createdAt now, which is itself movement.
  const longAgo = Date.now() - (movement.FULL_SYNC_MAX_GAP_DAYS + 1) * 24 * 60 * 60 * 1000;

  const scope = movement.planSyncScope({ since: longAgo });
  assert.equal(scope.full, true);
  assert.match(scope.reason, /days since the last full sync/);
});

test('with no previous sync at all, the first one is full', () => {
  const scope = movement.planSyncScope({ since: undefined });
  assert.equal(scope.full, true);
  assert.match(scope.reason, /no previous sync/);
});

// Events before the window are not this morning's news.
test('movement is measured from the given moment, not from all of history', () => {
  const v = makeVenture();
  ventures.recordRun(v.id, { workflow: 'ci.yml', runId: 1, conclusion: 'failure' });

  // A moment after the run: the run is history, not movement.
  assert.deepEqual(movement.describeMovement({ since: Date.now() + 1000 }).lines, []);
  assert.ok(movement.describeMovement({ since: HOUR_AGO }).lines.length > 0);
});
