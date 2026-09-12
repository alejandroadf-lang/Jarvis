// run_checks existed and nothing required it, so "the tests pass" was a claim
// an agent could make about code nobody had run. Worse, a red run stopped
// nothing — the team could keep committing on top of a broken build, and
// every commit made the eventual diagnosis harder.
//
// The gate is not "check before every commit": the code has to land before CI
// can run it. It is "don't go far without looking".

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;
const saved = {};
const KEYS = ['MAX_DEPLOYS_WITHOUT_CHECKS', 'MAX_DEPLOYS_AFTER_RED', 'DAILY_PLAN_REQUIRED', 'AUTONOMOUS_DEPLOY_REPOS'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-checks-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.DAILY_PLAN_REQUIRED = 'false';
  delete process.env.AUTONOMOUS_DEPLOY_REPOS;
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
});

// recordRun stamps "now", which is newer than any backdated commit — so the
// count of commits-since-the-run came out at zero. The run has to be older
// than the commits it is being measured against.
function runAt(id, conclusion, minutesAgo) {
  ventures.recordRun(id, { workflow: 'ci.yml', runId: '1', status: 'completed', conclusion });
  const file = path.join(tmpDir, 'ventures.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const venture = data.ventures.find((v) => v.id === id);
  const last = venture.runs[venture.runs.length - 1];
  last.startedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function shipping() {
  const v = ventures.createVenture({ title: 'CircadianAPI', milestones: ['v1'] });
  ventures.linkRepo(v.id, { owner: 'acme', name: 'circadian-api', allowedPaths: ['src/'], maxPerDay: 50, maxPerWeek: 50 });
  ventures.setDeploymentEnabled(v.id, true);
  return v;
}

// Written straight into the store rather than through recordDeployment,
// because a real run is spaced out by the 60s per-venture cooldown and a test
// that waited five minutes to make its point would never be run.
// `minutesAgo` backdates them so the cooldown is not what is being measured.
function commit(id, n = 1, minutesAgo = 10) {
  const file = path.join(tmpDir, 'ventures.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const venture = data.ventures.find((v) => v.id === id);
  venture.deployments = venture.deployments || [];
  for (let i = 0; i < n; i += 1) {
    venture.deployments.push({
      path: `src/f${i}.py`,
      message: 'x',
      commitSha: 'abc',
      deployedAt: new Date(Date.now() - minutesAgo * 60_000 + i * 1000).toISOString(),
    });
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

test('the first commits are not blocked — the gate is a leash, not a gate', () => {
  const v = shipping();
  commit(v.id, 4);
  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'src/e.py' }));
});

test('five commits with nobody looking, and the sixth is refused', () => {
  const v = shipping();
  commit(v.id, 5);
  assert.throws(
    () => ventures.authorizeDeployment(v.id, { path: 'src/f.py' }),
    /run_checks before committing more/
  );
});

test('running the checks clears it, whatever the result', () => {
  // Even a red result counts as looking. The point is closing the loop, not
  // passing — an agent that knows its build is broken is ahead of one that
  // doesn't.
  const v = shipping();
  commit(v.id, 5, 20);
  ventures.recordRun(v.id, { workflow: 'ci.yml', runId: '1', status: 'completed', conclusion: 'success' });
  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'src/f.py' }));
});

test('after a red run the leash is shorter', () => {
  // Commits piled on a known-broken build are the ones most likely to be
  // wrong, so there is less room before someone has to look again.
  const v = shipping();
  runAt(v.id, 'failure', 30);
  commit(v.id, 2, 5);
  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'src/a.py' }), 'two fixes are allowed');

  commit(v.id, 1, 4);
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'src/b.py' }), /last check run on this venture failed/);
});

test('the refusal after a red run names the failure, not a generic limit', () => {
  const v = shipping();
  runAt(v.id, 'timed_out', 30);
  commit(v.id, 3, 5);
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'src/b.py' }), /timed_out/);
});

test('the gate is configurable, because five is a guess', () => {
  const v = shipping();
  process.env.MAX_DEPLOYS_WITHOUT_CHECKS = '2';
  try {
    commit(v.id, 2);
    assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'src/c.py' }), /run_checks/);
  } finally {
    delete process.env.MAX_DEPLOYS_WITHOUT_CHECKS;
  }
});

test('scope problems still win — the gate is checked last', () => {
  // A path outside the allowlist is a configuration answer; "you don't know
  // if your code works" is only interesting once the basics are right.
  const v = shipping();
  commit(v.id, 9);
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'secrets/prod.env' }), /outside the allowed scope/);
});
