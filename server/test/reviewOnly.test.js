// Pull requests only, and READY telling the founder what actually opens a gate.
//
// Two bugs this pins. READY filed every gate without a WhatsApp command under
// "these need the Railway settings", so an unapproved daily plan, which is one
// message away, read as a server variable. And a venture blocked only by the
// plan was reported as stuck, when the team could still open pull requests,
// which need no plan.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let v;
let r;
let plan;
let commands;
let handlers;
const saved = { token: process.env.GITHUB_TOKEN, plan: process.env.DAILY_PLAN_REQUIRED };

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-review-only-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  v = await import('../finance/ventures.js');
  r = await import('../readiness.js');
  plan = await import('../dailyPlan.js');
  commands = await import('../channels/founderCommands.js');
  handlers = await import('../actionHandlers.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const [key, value] of [['GITHUB_TOKEN', saved.token], ['DAILY_PLAN_REQUIRED', saved.plan]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true });
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.DAILY_PLAN_REQUIRED = 'true';
});

function linked() {
  const venture = v.createVenture({ title: 'Happy Company', oneLiner: 'x', proposedBy: 'founder' });
  v.linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['ventures/hc/'], maxPerWeek: 5 });
  v.setDeploymentEnabled(venture.id, true);
  return venture;
}

const ready = (ventureId) => commands.runFounderCommand({ kind: 'ready', ventureId });

test('an unapproved plan is a message, not a Railway setting', async () => {
  const venture = linked();
  const text = await ready(venture.id);
  assert.match(text, /Approved daily plan: No plan is approved/);
  assert.match(text, /Ask the team, in one message, for a plan covering this; then APPROVE it/);
  assert.doesNotMatch(text, /Railway/, 'nothing here is a server variable');
  // And the work is not stuck: proposing needs no plan.
  assert.match(text, /The team can still open pull requests: proposing needs no plan/);
});

test('a plan waiting on the founder points at PLAN, which the parser accepts', async () => {
  // Also pins a bug: the gate read `.pending` off the plan getPlan returns,
  // which is always undefined, so a waiting plan was reported as none.
  const venture = linked();
  plan.submitPlan({ items: [{ ventureId: venture.id, action: 'deploy_code', intent: 'ship' }], summary: 's', submittedBy: 'cto' });
  const text = await ready(venture.id);
  assert.match(text, /Send any of these to fix it:\n {2}PLAN\n/);
  assert.match(text, /PLAN shows it; APPROVE opens this/);
  assert.ok(plan.parsePlanCommand('PLAN'), 'PLAN is a command the founder can actually send');
});

test('real server variables still go under Railway', async () => {
  delete process.env.GITHUB_TOKEN;
  const venture = linked();
  const text = await ready(venture.id);
  assert.match(text, /need the Railway settings:\n {2}· GitHub configured — The founder sets GITHUB_TOKEN/);
});

test('pull requests only: direct commits and reverts refuse and name the way forward; proposing still works', () => {
  const venture = linked();
  plan.submitPlan({ items: [{ ventureId: venture.id, action: 'deploy_code', intent: 'ship' }], summary: 's', submittedBy: 'cto' });
  plan.approvePlan();
  assert.doesNotThrow(() => v.authorizeDeployment(venture.id, { path: 'ventures/hc/a.js' }));

  v.setReviewOnly(venture.id, true);
  assert.throws(() => v.authorizeDeployment(venture.id, { path: 'ventures/hc/a.js' }), /pull requests only: propose this with open_pull_request.*REVIEW OFF/);
  assert.throws(() => v.authorizeDeploymentOfPaths(venture.id, ['ventures/hc/a.js']), /pull requests only/);
  assert.throws(() => v.authorizeRevert(venture.id, { paths: ['ventures/hc/a.js'] }), /pull requests only/);
  assert.doesNotThrow(() => v.authorizePullRequest(venture.id, { paths: ['ventures/hc/a.js'] }));

  // Re-linking to widen the paths keeps the review: a wider scope must not
  // quietly drop it.
  v.linkRepo(venture.id, { owner: 'acme', name: 'app', allowedPaths: ['ventures/hc/', 'docs/'] });
  assert.equal(v.getVenture(venture.id).repo.reviewOnly, true);
  v.setDeploymentEnabled(venture.id, true); // linkRepo resets writes to off by design

  v.setReviewOnly(venture.id, false);
  assert.doesNotThrow(() => v.authorizeDeployment(venture.id, { path: 'ventures/hc/a.js' }));
});

test('the readiness report agrees with the gate, for agents and for the founder', async () => {
  const venture = linked();
  v.setReviewOnly(venture.id, true);

  // An agent asking about a direct commit is told it is shut and why.
  const deploy = r.deployReadiness(venture.id);
  const shut = deploy.gates.find((g) => g.name === 'Direct commits allowed');
  assert.equal(shut.open, false);
  assert.match(handlers.handleCheckReady({ ventureId: venture.id, action: 'deploy_code' }), /\[--\] Direct commits allowed/);
  assert.match(handlers.handleCheckReady({ ventureId: venture.id, action: 'revert_commit' }), /\[--\] Direct commits allowed/);
  // Proposing is judged without the plan and without the review gate: no plan
  // is approved here, and it is still ready, as authorizePullRequest agrees.
  assert.match(handlers.handleCheckReady({ ventureId: venture.id, action: 'open_pull_request' }), /^Ready to open_pull_request/);
  assert.equal(r.pullRequestReadiness(venture.id).ready, true);

  // The founder's READY judges a review-only venture on proposing, which is
  // all it may do, instead of calling it blocked by their own choice.
  const text = await ready(venture.id);
  assert.match(text, /Nothing is blocking the venture from shipping/);
  assert.match(text, /Pull requests only: every change waits for you to merge it/);
  assert.doesNotMatch(text, /REVIEW OFF/, 'READY never nudges the founder to drop the review');
});

test('REVIEW ON / OFF from WhatsApp, listed in HELP and VENTURES', async () => {
  const venture = linked();
  assert.deepEqual(commands.parseFounderCommand(`REVIEW ON ${venture.id}`), { kind: 'review_on', ventureId: venture.id });
  assert.deepEqual(commands.parseFounderCommand(`review off ${venture.id}`), { kind: 'review_off', ventureId: venture.id });
  assert.equal(commands.parseFounderCommand('review on the plan please'), null, 'prose is not a command');

  const on = await commands.runFounderCommand({ kind: 'review_on', ventureId: venture.id });
  assert.match(on, /now takes pull requests only.*needs no daily plan.*until you merge it on GitHub/s);
  assert.match(await commands.runFounderCommand({ kind: 'ventures' }), /deploy ON, pull requests only/);
  assert.match(await commands.runFounderCommand({ kind: 'review_off', ventureId: venture.id }), /may commit directly again/);
  assert.match(commands.__helpForTests, /REVIEW ON <ventureId>/);

  // Writes off: the reply says no pull request can open yet, and how to fix it.
  v.setDeploymentEnabled(venture.id, false);
  assert.match(await commands.runFounderCommand({ kind: 'review_on', ventureId: venture.id }), /Repo writes are still off.*DEPLOY ON/);
});
