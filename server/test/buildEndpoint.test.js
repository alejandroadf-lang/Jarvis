// The company gained a task queue, commit and check-run logs, and a venture
// notebook — and none of it rendered anywhere. The founder could see which
// ventures existed but not what anyone was doing with them. GitHub answers
// "what code is there"; it says nothing about what is queued, what failed
// and why, or what the team has learned.
//
// One endpoint rather than four, because this is read on a phone: four round
// trips is four chances to show a half-built screen.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;
let tasks;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-build-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  ventures = await import('../finance/ventures.js');
  tasks = await import('../tasks.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of ['ventures.json', 'tasks.json']) {
    fs.rmSync(path.join(tmpDir, f), { force: true });
  }
});

// The endpoint's body, exercised directly. Standing up Express here would
// test Express; what matters is that everything the screen needs is present
// and in the order a person reads it.
function buildPayload(id) {
  const venture = ventures.getVenture(id);
  return {
    venture: { id: venture.id, title: venture.title, status: venture.status, repo: venture.repo || null },
    tasks: tasks.listTasks({ ventureId: venture.id }),
    deployments: [...(venture.deployments || [])].reverse().slice(0, 20),
    runs: [...(venture.runs || [])].reverse().slice(0, 10),
    notes: [...(venture.notes || [])].reverse().slice(0, 20),
  };
}

function shipping() {
  const v = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship v1'] });
  ventures.linkRepo(v.id, { owner: 'acme', name: 'circadian-api', allowedPaths: ['src/'] });
  return v;
}

test('one call carries everything the screen needs', () => {
  const v = shipping();
  tasks.enqueueTasks(v.id, ['engine', 'tests']);
  ventures.recordDeployment(v.id, { path: 'src/engine.py', message: 'x', commitSha: 'abc', commitUrl: 'u' });
  ventures.recordRun(v.id, { workflow: 'ci.yml', runId: '1', status: 'completed', conclusion: 'success' });
  ventures.recordVentureNote(v.id, { note: 'zoneinfo, not pytz', agentId: 'engineering_lead' });

  const payload = buildPayload(v.id);
  assert.equal(payload.tasks.length, 2);
  assert.equal(payload.deployments.length, 1);
  assert.equal(payload.runs.length, 1);
  assert.equal(payload.notes.length, 1);
  assert.equal(payload.venture.repo.name, 'circadian-api');
});

test('the newest commit is first — a build log is read from the recent end', () => {
  const v = shipping();
  ventures.recordDeployment(v.id, { path: 'src/first.py', message: 'a', commitSha: '1' });
  ventures.recordDeployment(v.id, { path: 'src/second.py', message: 'b', commitSha: '2' });

  assert.equal(buildPayload(v.id).deployments[0].path, 'src/second.py');
});

test('a failed task carries its reason, which is the line that decides what to do', () => {
  const v = shipping();
  const [t] = tasks.enqueueTasks(v.id, ['engine']);
  tasks.startTask(t.id);
  tasks.failTask(t.id, 'ran out of output tokens before writing the file');

  const shown = buildPayload(v.id).tasks[0];
  assert.match(shown.error, /output tokens/);
  assert.equal(shown.attempts, 1);
});

test('tasks stay in build order, not completion order', () => {
  // The screen is a plan, not a feed. Finishing the second thing first must
  // not reorder the list under the reader.
  const v = shipping();
  tasks.enqueueTasks(v.id, ['engine', 'tests', 'auth']);
  const list = tasks.listTasks({ ventureId: v.id });
  tasks.startTask(list[1].id);
  tasks.completeTask(list[1].id, 'done');

  assert.deepEqual(buildPayload(v.id).tasks.map((t) => t.title), ['engine', 'tests', 'auth']);
});

test('a venture with nothing yet still returns a whole shape', () => {
  // Every list empty is the normal first state. A screen that has to guard
  // against undefined renders half of itself and looks broken.
  const v = ventures.createVenture({ title: 'Fresh', milestones: [] });
  const payload = buildPayload(v.id);
  assert.deepEqual(payload.tasks, []);
  assert.deepEqual(payload.deployments, []);
  assert.deepEqual(payload.runs, []);
  assert.deepEqual(payload.notes, []);
  assert.equal(payload.venture.repo, null, 'and says plainly there is no repo');
});
