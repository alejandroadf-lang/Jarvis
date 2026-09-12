// The failure this file exists for: the Engineering Lead decided on seven
// files, ran out of output tokens before writing any, and the turn ended.
// Zero files landed — and nothing recorded that seven units of work had ever
// been identified. Nobody would retry them.
//
// So these tests are mostly about survival: what happens to work when the
// thing attempting it stops.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let tasks;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tasks-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  tasks = await import('../tasks.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'tasks.json'), { force: true });
});

const SEVEN = ['engine', 'tests', 'auth', 'rate limiting', 'API_CONTRACT.md', 'Dockerfile', 'CI'];

test('work written down survives the turn that wrote it', () => {
  // The whole point. A separate import would be a separate process in
  // production; here re-reading from disk is the same proof.
  tasks.enqueueTasks('v_1', SEVEN, 'engineering_lead');
  assert.equal(tasks.openCount('v_1'), 7);
  assert.equal(tasks.nextTask('v_1').title, 'engine', 'and in the order it was given');
});

test('a run that dies mid-way costs one task, not the plan', () => {
  tasks.enqueueTasks('v_1', SEVEN);
  const first = tasks.nextTask('v_1');
  tasks.startTask(first.id);
  tasks.completeTask(first.id, 'https://github.com/x/y/commit/abc');

  const second = tasks.nextTask('v_1');
  tasks.startTask(second.id);
  // ...and the turn dies here. Nothing calls complete or fail.

  assert.equal(tasks.openCount('v_1'), 6, 'six remain, and the finished one stays finished');
  assert.equal(tasks.listTasks({ ventureId: 'v_1', status: 'done' }).length, 1);
  const stalled = tasks.stalledTasks(-1);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].title, 'tests', 'the abandoned claim is visible rather than silent');
});

test('a failure is kept and the task goes back in the queue', () => {
  const [t] = tasks.enqueueTasks('v_1', ['engine']);
  tasks.startTask(t.id);
  tasks.failTask(t.id, 'ran out of output tokens before writing the file');

  const again = tasks.nextTask('v_1');
  assert.equal(again.id, t.id);
  assert.equal(again.status, 'queued');
  assert.match(again.error, /output tokens/, 'the next attempt starts knowing what went wrong');
  assert.equal(again.attempts, 1);
});

test('a task that keeps failing stops being retried', () => {
  // Retrying identically forever spends real money to learn the same thing.
  const [t] = tasks.enqueueTasks('v_1', ['engine']);
  for (let i = 0; i < 3; i += 1) {
    tasks.startTask(t.id);
    tasks.failTask(t.id, 'same error again');
  }
  assert.equal(tasks.getTask(t.id).status, 'failed');
  assert.equal(tasks.nextTask('v_1'), null, 'and it stops blocking the queue');
});

test('two turns cannot claim the same task', () => {
  const [t] = tasks.enqueueTasks('v_1', ['engine']);
  tasks.startTask(t.id);
  assert.throws(() => tasks.startTask(t.id), /already running/);
});

test('tasks are scoped per venture', () => {
  tasks.enqueueTasks('v_1', ['engine']);
  tasks.enqueueTasks('v_2', ['landing page']);
  assert.equal(tasks.nextTask('v_1').title, 'engine');
  assert.equal(tasks.nextTask('v_2').title, 'landing page');
  assert.equal(tasks.openCount('v_1'), 1);
});

test('a task needs a venture and a title', () => {
  assert.throws(() => tasks.enqueueTask({ title: 'orphan work' }), /ventureId/);
  assert.throws(() => tasks.enqueueTask({ ventureId: 'v_1', title: '  ' }), /title/);
});

test('the agent context stays silent when nothing is outstanding', () => {
  // Appended to every prompt: a line saying "no tasks" on every turn is what
  // makes the turns with real work in them harder to see.
  assert.equal(tasks.describeTasksForAgents(), '');

  tasks.enqueueTasks('v_1', ['engine']);
  const text = tasks.describeTasksForAgents();
  assert.match(text, /engine/);
  assert.match(text, /start_task/, 'and says how to pick it up');
});

test('the context carries the last failure into the next attempt', () => {
  const [t] = tasks.enqueueTasks('v_1', ['engine']);
  tasks.startTask(t.id);
  tasks.failTask(t.id, 'the shift direction was inverted for westward travel');
  assert.match(tasks.describeTasksForAgents('v_1'), /shift direction was inverted/);
});

test('trimming never drops queued work', () => {
  // The cap protects the file size. Dropping an open task to stay under it
  // would lose exactly the thing this store exists to keep.
  for (let i = 0; i < 320; i += 1) {
    const [t] = tasks.enqueueTasks('v_old', [`done-${i}`]);
    tasks.startTask(t.id);
    tasks.completeTask(t.id, 'ok');
  }
  tasks.enqueueTasks('v_live', ['the one that matters']);
  assert.equal(tasks.nextTask('v_live')?.title, 'the one that matters');
});
