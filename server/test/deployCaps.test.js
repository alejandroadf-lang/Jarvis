// Why the team spent five turns failing to commit one file.
//
// The founder ran LINK, which passed no caps, so the venture got the defaults:
// one commit a day, three a week. The team shipped three files — the whole
// week's allowance in an afternoon — and every attempt at a fourth came back
// "Weekly deployment cap reached (3/week)", a sentence that named a number and
// no way past it. An agent reading that five times has no reason to believe
// the sixth will differ, and this one eventually narrated a deploy it had not
// performed.
//
// Two defects, one of them in the multi-file authorizer added the same week.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createVenture,
  linkRepo,
  setDeploymentEnabled,
  setDeploymentCaps,
  authorizeDeployment,
  authorizeDeploymentOfPaths,
  recordDeployment,
  getVenture,
  rateLimitState,
} from '../finance/ventures.js';

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-caps-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
});
after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
});

// What LINK actually does: owner, name, branch, paths, and no caps at all.
function linkedLikeFounder(caps = {}) {
  const v = createVenture({ title: 'Shift Planner', oneLiner: 'x', proposedBy: 'venture_partner' });
  linkRepo(v.id, { owner: 'acme', name: 'shift', branch: 'main', allowedPaths: ['src/', '.github/workflows/'], ...caps });
  setDeploymentEnabled(v.id, true);
  return v;
}

// Commits land at distinct times and under distinct shas, like real ones.
function commit(ventureId, paths, sha, minutesAgo = 0) {
  for (const p of paths) {
    recordDeployment(ventureId, { path: p, message: 'm', commitSha: sha, commitUrl: `u/${sha}`, triggeredBy: 'interactive' });
  }
  if (minutesAgo) {
    const file = path.join(tmpDir, 'ventures.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const when = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
    for (const v of data.ventures) {
      for (const d of v.deployments || []) if (d.commitSha === sha) d.deployedAt = when;
    }
    fs.writeFileSync(file, JSON.stringify(data));
  }
}

test('LINK no longer hands a venture under construction a three-file week', () => {
  const repo = getVenture(linkedLikeFounder().id).repo;
  assert.equal(repo.maxPerWeek, 20);
  assert.equal(repo.maxPerDay, 4);
});

test('three files across three commits no longer exhausts the week', () => {
  // The exact shape of the blocker: shift_logic, its tests, then app.py.
  const v = linkedLikeFounder();
  commit(v.id, ['src/shift_logic.py'], 'aaa', 180);
  commit(v.id, ['src/test_shift_logic.py'], 'bbb', 120);
  commit(v.id, ['src/app.py'], 'ccc', 60);
  assert.doesNotThrow(() => authorizeDeployment(v.id, { path: 'src/auth.py' }));
});

test('one commit is one unit, however many files it touched', () => {
  // The log keeps a row per path, because "what changed" wants every path. The
  // cap asks how often the team acted. Counting rows made a well-structured
  // seven-file commit seven times more expensive than the seven sloppy
  // single-file commits it replaced.
  const v = linkedLikeFounder({ maxPerWeek: 5, maxPerDay: 5 });
  commit(v.id, ['src/a.py', 'src/b.py', 'src/c.py', 'src/d.py', 'src/e.py', 'src/f.py', 'src/g.py'], 'one', 60);
  assert.equal((getVenture(v.id).deployments || []).length, 7, 'every path is still in the log');
  const state = rateLimitState({ entries: getVenture(v.id).deployments, timestampKey: 'deployedAt', scope: getVenture(v.id).repo });
  assert.equal(state.inWeek, 1, 'but the cap counts one commit');
  assert.doesNotThrow(() => authorizeDeployment(v.id, { path: 'src/h.py' }));
});

test('a changeset larger than the headroom is refused, not admitted and overshot', () => {
  // The defect: every per-path call read the same pre-commit state, saw room
  // for one, and passed — so four of headroom admitted a six-file commit and
  // recorded seven against a cap of five.
  const v = linkedLikeFounder({ maxPerWeek: 3, maxPerDay: 3 });
  commit(v.id, ['src/one.py'], 'aaa', 90);
  commit(v.id, ['src/two.py'], 'bbb', 60);
  commit(v.id, ['src/three.py'], 'ccc', 30);
  assert.throws(
    () => authorizeDeploymentOfPaths(v.id, ['src/a.py', 'src/b.py', 'src/c.py']),
    /Weekly deployment cap reached \(3 of 3 this week\)/,
  );
});

test('the multi-path authorizer still checks every path against the allowlist', () => {
  // Restructuring it to check the cap once must not have loosened the rest:
  // six files cannot ride in on the seventh's approval.
  const v = linkedLikeFounder({ maxPerWeek: 20, maxPerDay: 10 });
  assert.throws(
    () => authorizeDeploymentOfPaths(v.id, ['src/ok.py', 'infra/prod.tf']),
    /outside the allowed scope/,
  );
  assert.throws(() => authorizeDeploymentOfPaths(v.id, []), /at least one file change/);
});

test('the multi-path authorizer still refuses a venture that is not set up', () => {
  const v = createVenture({ title: 'Bare', oneLiner: 'x', proposedBy: 'venture_partner' });
  assert.throws(() => authorizeDeploymentOfPaths(v.id, ['src/a.py']), /No repo linked/);
  linkRepo(v.id, { owner: 'a', name: 'b', branch: 'main', allowedPaths: ['src/'] });
  assert.throws(() => authorizeDeploymentOfPaths(v.id, ['src/a.py']), /not enabled/);
});

test('a cap refusal names the way out instead of only the number', () => {
  // Every other gate says what to ask the founder for. These two said a number
  // had been reached and stopped, and an agent that hits a wall with no door
  // reads it as a fault in itself.
  const v = linkedLikeFounder({ maxPerWeek: 2, maxPerDay: 2 });
  commit(v.id, ['src/a.py'], 'aaa', 90);
  commit(v.id, ['src/b.py'], 'bbb', 60);
  try {
    authorizeDeployment(v.id, { path: 'src/c.py' });
    assert.fail('expected the weekly cap to refuse');
  } catch (err) {
    assert.match(err.message, /CAPS <ventureId> <per day> <per week>/);
    assert.match(err.message, /Re-attempting will not change it/);
  }
});

test('CAPS moves the wall in one message', () => {
  const v = linkedLikeFounder({ maxPerWeek: 2, maxPerDay: 2 });
  commit(v.id, ['src/a.py'], 'aaa', 90);
  commit(v.id, ['src/b.py'], 'bbb', 60);
  assert.throws(() => authorizeDeployment(v.id, { path: 'src/c.py' }), /Weekly deployment cap/);
  setDeploymentCaps(v.id, { maxPerDay: 6, maxPerWeek: 30 });
  assert.doesNotThrow(() => authorizeDeployment(v.id, { path: 'src/c.py' }));
});

test('outreach entries, which carry no commit sha, still count one apiece', () => {
  // countableTimes groups on commitSha. Sends have none, and collapsing them
  // would silently uncap outreach.
  const sends = [
    { sentAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    { sentAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    { sentAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
  ];
  const state = rateLimitState({ entries: sends, timestampKey: 'sentAt', scope: { maxPerWeek: 10, maxPerDay: 5 } });
  assert.equal(state.inWeek, 3);
  assert.equal(state.inDay, 3);
});
