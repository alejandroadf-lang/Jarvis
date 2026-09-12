// Repo linking used to be founder-only, which made every venture wait on a
// person for something the team could do in seconds. Removing the gate
// outright would have made the scope model decorative — an agent that grants
// itself a scope has no scope. So the gate moved instead: the founder names
// the repos once, and inside that set the team is autonomous.
//
// What's tested is the boundary, because that boundary is now the only thing
// standing between an agent and a commit.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;
let handlers;
let plans;
const KEYS = ['AUTONOMOUS_DEPLOY_REPOS', 'GITHUB_TOKEN', 'REAL_ACTIONS_DISABLED', 'DAILY_PLAN_REQUIRED'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-autodeploy-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  ventures = await import('../finance/ventures.js');
  handlers = await import('../actionHandlers.js');
  plans = await import('../dailyPlan.js');
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
  fs.writeFileSync(path.join(tmpDir, 'ventures.json'), JSON.stringify({ ventures: [] }));
  fs.writeFileSync(path.join(tmpDir, 'killSwitch.json'), JSON.stringify({ halted: false }));
  fs.writeFileSync(path.join(tmpDir, 'dailyPlans.json'), JSON.stringify({ plans: {} }));
  delete process.env.REAL_ACTIONS_DISABLED;
  process.env.GITHUB_TOKEN = 'gh-token';
  process.env.AUTONOMOUS_DEPLOY_REPOS = 'acme/doc-intel, acme/scraper';
});

function newVenture() {
  return ventures.createVenture({ title: 'Doc Intelligence', thesis: 'Cited answers.', milestones: ['v1'] });
}

// Self-service deployment implies the daily plan requirement, so a venture
// that expects to link needs today's plan approved first. That interaction is
// the design, not an inconvenience: autonomy is bounded by the plan.
function approvePlanFor(ventureId, target = 'acme/doc-intel') {
  plans.submitPlan({
    items: [{ ventureId, action: 'link_venture_repo', target, intent: 'Stand up the repo so the team can ship v1.' }],
  });
  plans.approvePlan();
}

const LINK = { owner: 'acme', name: 'doc-intel', allowedPaths: ['src/', '.github/workflows/'] };

test('a pre-approved repo links and deploys in one call', async () => {
  const v = newVenture();
  approvePlanFor(v.id);

  const reply = await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK }, 'interactive', { agentId: 'cto' });

  assert.match(reply, /Linked acme\/doc-intel/);
  const linked = ventures.getVenture(v.id);
  assert.equal(linked.repo.owner, 'acme');
  // Linking without enabling is a state nobody wants and the team would
  // immediately have to ask about.
  assert.equal(linked.repo.enabled, true);
});

test('a repo the founder never approved is refused', async () => {
  const v = newVenture();
  approvePlanFor(v.id, 'acme/payroll');

  const reply = await handlers.handleLinkVentureRepo({
    ventureId: v.id, owner: 'acme', name: 'payroll', allowedPaths: ['src/'],
  });

  assert.match(reply, /not one of the repos the founder pre-approved/);
  assert.equal(ventures.getVenture(v.id).repo, undefined);
});

test('with nothing pre-approved, autonomy is off and says why', async () => {
  // The default. Autonomy is turned on deliberately, never inherited.
  delete process.env.AUTONOMOUS_DEPLOY_REPOS;
  const v = newVenture();

  const reply = await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK });

  assert.match(reply, /Self-service deployment is off/);
  assert.match(reply, /AUTONOMOUS_DEPLOY_REPOS/);
});

test('the approved list is matched case-insensitively', async () => {
  const v = newVenture();
  approvePlanFor(v.id, 'ACME/Doc-Intel');

  const reply = await handlers.handleLinkVentureRepo({
    ventureId: v.id, owner: 'ACME', name: 'Doc-Intel', allowedPaths: ['src/'],
  });

  assert.match(reply, /Linked ACME\/Doc-Intel/, 'GitHub owners and repo names are case-insensitive');
});

test('the kill switch stops a link, like every other real action', async () => {
  process.env.REAL_ACTIONS_DISABLED = 'true';
  const v = newVenture();

  const reply = await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK });

  assert.match(reply, /Could not link a repo/);
  assert.equal(ventures.getVenture(v.id).repo, undefined);
});

test('linking with no writable paths is refused rather than quietly useless', async () => {
  // An empty allowlist permits nothing, so this would produce a venture that
  // looks ready and refuses every commit.
  const v = newVenture();
  approvePlanFor(v.id);

  const reply = await handlers.handleLinkVentureRepo({ ventureId: v.id, owner: 'acme', name: 'doc-intel', allowedPaths: [] });

  assert.match(reply, /allowedPaths is required/);
});

test('a killed venture cannot be linked', async () => {
  const v = newVenture();
  approvePlanFor(v.id);
  ventures.killVenture(v.id, 'not working');

  const reply = await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK });

  assert.match(reply, /the venture is killed/);
});

test('caps still apply to what the team grants itself', async () => {
  const v = newVenture();
  // Both items in one plan: an approved plan cannot be extended later, which
  // is also how a real day works — you plan the linking and the shipping
  // together, not the second one after the founder has already signed off.
  plans.submitPlan({
    items: [
      { ventureId: v.id, action: 'link_venture_repo', target: 'acme/doc-intel', intent: 'Stand up the repo.' },
      { ventureId: v.id, action: 'deploy_code', intent: 'Ship v1 into it.' },
    ],
  });
  plans.approvePlan();

  await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK, maxPerDay: 2, maxPerWeek: 5 });

  const repo = ventures.getVenture(v.id).repo;
  assert.equal(repo.maxPerDay, 2);
  assert.equal(repo.maxPerWeek, 5);

  // And a commit outside the paths the team chose is still refused, so the
  // allowlist binds the agents that set it. Planned first, so what this
  // proves is the path rule rather than the plan rule.
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'secrets/prod.env' }), /outside the allowed scope/);
});

test('list_approved_repos names them, so nobody guesses', async () => {
  const reply = await handlers.handleListApprovedRepos();
  assert.match(reply, /acme\/doc-intel/);
  assert.match(reply, /acme\/scraper/);
});

test('with autonomy off, listing says the founder does it', async () => {
  delete process.env.AUTONOMOUS_DEPLOY_REPOS;
  const reply = await handlers.handleListApprovedRepos();
  assert.match(reply, /founder links repos/);
});

test('the link is attributed to the agent that made it', async () => {
  const v = newVenture();
  approvePlanFor(v.id);
  const profitShare = await import('../finance/profitShare.js');

  await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK }, 'interactive', { agentId: 'cto' });

  const contributions = profitShare.listContributions();
  assert.ok(contributions.some((c) => c.agentId === 'cto'), 'the founder must be able to see who granted this');
});

test('self-service still needs an approved plan — autonomy is bounded, not unbounded', async () => {
  // The point of the whole arrangement. Pre-approving a repo hands over the
  // linking, not the deciding: the day's work is still agreed first.
  const v = newVenture();

  const reply = await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK });

  assert.match(reply, /No plan is approved/);
  assert.equal(ventures.getVenture(v.id).repo, undefined);
});

test('a plan approved for a different repo does not cover this one', async () => {
  const v = newVenture();
  approvePlanFor(v.id, 'acme/scraper');

  const reply = await handlers.handleLinkVentureRepo({ ventureId: v.id, ...LINK });

  assert.match(reply, /not in the approved plan/);
});
