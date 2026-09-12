// The founder wanted the team autonomous but still asking, daily, against a
// structured plan. That lands between two failure modes: approving every
// action makes the founder the bottleneck on a company meant to run itself,
// and approving nothing makes the scope model decorative.
//
// What's tested is the gate, since it is now the thing standing between an
// agent and a real commit or a real email.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let plan;
let ventures;
const KEYS = ['DAILY_PLAN_REQUIRED', 'AUTONOMOUS_DEPLOY_REPOS', 'REAL_ACTIONS_DISABLED'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  plan = await import('../dailyPlan.js');
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
  fs.writeFileSync(path.join(tmpDir, 'dailyPlans.json'), JSON.stringify({ plans: {} }));
  fs.writeFileSync(path.join(tmpDir, 'ventures.json'), JSON.stringify({ ventures: [] }));
  fs.writeFileSync(path.join(tmpDir, 'killSwitch.json'), JSON.stringify({ halted: false }));
  delete process.env.REAL_ACTIONS_DISABLED;
  delete process.env.AUTONOMOUS_DEPLOY_REPOS;
  process.env.DAILY_PLAN_REQUIRED = 'true';
});

const ITEM = { ventureId: 'v1', action: 'deploy_code', target: 'src/', intent: 'Ship the ingestion pipeline.' };

test('with no plan, nothing real runs — and the message says how to fix it', () => {
  assert.throws(
    () => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'src/index.ts' }),
    /No plan is approved/
  );
});

test('a submitted plan is not an approved plan', () => {
  plan.submitPlan({ items: [ITEM], submittedBy: 'ceo' });

  assert.throws(
    () => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'src/index.ts' }),
    /waiting on the founder/
  );
});

test('once approved, the planned work runs', () => {
  plan.submitPlan({ items: [ITEM], submittedBy: 'ceo' });
  plan.approvePlan({ note: 'go' });

  assert.doesNotThrow(() => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'src/index.ts' }));
});

test('work outside the plan is refused even when the plan is approved', () => {
  // The whole point. An approved plan is permission for what is in it, not a
  // general licence for the day.
  plan.submitPlan({ items: [ITEM], submittedBy: 'ceo' });
  plan.approvePlan();

  assert.throws(
    () => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'send_customer_email', target: 'a@b.com' }),
    /is not in the approved plan/
  );
});

test('a planned target binds — naming one and acting on another is not what was agreed', () => {
  plan.submitPlan({ items: [ITEM], submittedBy: 'ceo' });
  plan.approvePlan();

  assert.doesNotThrow(() => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'src/deep/file.ts' }));
  assert.throws(
    () => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'secrets/prod.env' }),
    /not in the approved plan/
  );
});

test('an item with no target covers any target for that action', () => {
  // "Email three prospects" is a reasonable thing to approve without naming
  // them in advance.
  plan.submitPlan({
    items: [{ ventureId: 'v1', action: 'send_customer_email', intent: 'Email three prospects from the list.' }],
  });
  plan.approvePlan();

  assert.doesNotThrow(() => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'send_customer_email', target: 'anyone@example.com' }));
});

test('the plan is per venture — approving one does not approve another', () => {
  plan.submitPlan({ items: [ITEM] });
  plan.approvePlan();

  assert.throws(() => plan.assertInApprovedPlan({ ventureId: 'v2', action: 'deploy_code', target: 'src/x.ts' }), /not in the approved plan/);
});

test('a rejected plan blocks, and carries the reason back', () => {
  plan.submitPlan({ items: [ITEM] });
  plan.rejectPlan({ reason: 'Ship the tests first.' });

  assert.throws(
    () => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'src/x.ts' }),
    /Ship the tests first/
  );
});

test('a rejected plan can be replaced immediately', () => {
  plan.submitPlan({ items: [ITEM] });
  plan.rejectPlan({ reason: 'no' });

  const revised = plan.submitPlan({ items: [{ ...ITEM, intent: 'Ship the tests first, then the pipeline.' }] });
  assert.equal(revised.status, 'pending');
});

test('a new plan can be proposed while one is approved, and changes nothing until approved', () => {
  // This used to throw, and that was the bug: an approval locked the calendar
  // day, so a team that finished its approved work could not propose the next
  // piece until midnight UTC. Proposing is now always allowed — and crucially
  // it grants nothing, so it cannot be used to widen a clearance the founder
  // already gave.
  plan.submitPlan({ items: [ITEM] });
  plan.approvePlan();

  plan.submitPlan({ items: [{ ventureId: 'v1', action: 'send_customer_email', intent: 'sneak this in' }] });

  assert.throws(
    () => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'send_customer_email', target: 'a@b.com' }),
    /waiting on the founder|not in the approved plan/,
    'submitting must not clear the new work'
  );
  assert.doesNotThrow(
    () => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'src/x.ts' }),
    'and must not revoke work already cleared'
  );
});

test('a plan needs real items, not an empty gesture', () => {
  assert.throws(() => plan.submitPlan({ items: [] }), /at least one item/);
  assert.throws(() => plan.submitPlan({ items: [{ ventureId: 'v1', action: 'deploy_code' }] }), /missing intent/);
});

test('with the requirement off, nothing is gated', () => {
  delete process.env.DAILY_PLAN_REQUIRED;
  assert.doesNotThrow(() => plan.assertInApprovedPlan({ ventureId: 'v1', action: 'deploy_code', target: 'x' }));
});

test('turning on self-service deployment turns on the plan requirement', () => {
  // Autonomy with nothing bounding it is the thing to avoid, so one implies
  // the other rather than having to be remembered separately.
  delete process.env.DAILY_PLAN_REQUIRED;
  process.env.AUTONOMOUS_DEPLOY_REPOS = 'acme/doc-intel';

  assert.equal(plan.isPlanRequired(), true);
});

test('DAILY_PLAN_REQUIRED=false wins over that implication', () => {
  process.env.DAILY_PLAN_REQUIRED = 'false';
  process.env.AUTONOMOUS_DEPLOY_REPOS = 'acme/doc-intel';

  assert.equal(plan.isPlanRequired(), false);
});

// --- Through the real guardrails -------------------------------------------

test('a real deploy is blocked by the plan before the path allowlist', () => {
  const v = ventures.createVenture({ title: 'Doc', thesis: 't', milestones: ['m'] });
  ventures.linkRepo(v.id, { owner: 'acme', name: 'doc', branch: 'main', allowedPaths: ['src/'] });
  ventures.setDeploymentEnabled(v.id, true);

  // Everything else is in order; only the plan is missing.
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'src/index.ts' }), /No plan is approved/);

  plan.submitPlan({ items: [{ ventureId: v.id, action: 'deploy_code', target: 'src/', intent: 'ship it' }] });
  plan.approvePlan();
  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'src/index.ts' }));
});

test('the agent-facing description states plainly what is cleared', () => {
  plan.submitPlan({ items: [ITEM] });
  assert.match(plan.describePlanForAgents(), /waiting on the founder/);

  plan.approvePlan();
  const approved = plan.describePlanForAgents();
  assert.match(approved, /approved plan/i);
  assert.match(approved, /and nothing else/);
  // Said on every render, because its absence is what let a stuck team
  // conclude on its own that the work had to wait for tomorrow.
  assert.match(approved, /any time/i);
  assert.doesNotMatch(approved, /tomorrow's plan/i);
});

// --- Deciding from a phone --------------------------------------------------
// A WhatsApp message from an allowlisted number is the founder, verified by
// Meta's signature and the allowlist — a stronger claim than the web app can
// make, since that has no authentication at all.

test('APPROVE from the phone clears the day', () => {
  plan.submitPlan({ items: [ITEM] });

  const command = plan.parsePlanCommand('approve');
  assert.equal(command.kind, 'approve');

  plan.approvePlan({ note: command.note });
  assert.equal(plan.getPlan().status, 'approved');
});

test('a reason travels with the decision', () => {
  plan.submitPlan({ items: [ITEM] });

  assert.equal(plan.parsePlanCommand('approve: ship it today').note, 'ship it today');
  assert.equal(plan.parsePlanCommand('reject - tests first').reason, 'tests first');
});

test('an ordinary message is never read as a decision', () => {
  plan.submitPlan({ items: [ITEM] });

  // The dangerous direction: inventing consent out of conversation.
  assert.equal(plan.parsePlanCommand('what did we approve last week?'), null);
  assert.equal(plan.parsePlanCommand('I would approve that if the tests passed'), null);
  assert.equal(plan.parsePlanCommand("how's the company doing?"), null);
});

test('approve does nothing when no plan is pending', () => {
  // On a day with nothing waiting, "approve" is far likelier to be part of a
  // sentence than a command, and acting on it would invent consent.
  assert.equal(plan.parsePlanCommand('approve'), null);

  plan.submitPlan({ items: [ITEM] });
  plan.approvePlan();
  assert.equal(plan.parsePlanCommand('approve'), null, 'an approved plan cannot be re-approved');
});

test('asking for the plan works any day, decided or not', () => {
  assert.equal(plan.parsePlanCommand('plan').kind, 'status');
  assert.equal(plan.parsePlanCommand("today's plan?").kind, 'status');
});

test('the WhatsApp format tells the founder exactly what replying does', () => {
  plan.submitPlan({ items: [ITEM], summary: 'Stand up the pipeline.' });

  const body = plan.formatPlanForWhatsApp(plan.getPlan());

  assert.match(body, /Stand up the pipeline/);
  assert.match(body, /deploy_code/);
  assert.match(body, /Reply APPROVE/);
  assert.match(body, /Nothing runs until you do/);
});

test('an item with no target is flagged as open-ended in the message', () => {
  // The founder should see which approvals are broader than they look.
  plan.submitPlan({ items: [{ ventureId: 'v1', action: 'send_customer_email', intent: 'Email three prospects.' }] });

  assert.match(plan.formatPlanForWhatsApp(plan.getPlan()), /any target/);
});

// --- The autonomous cycle ---------------------------------------------------
// A regression created by two changes made the same day. The 8am cycle can
// call deploy_code and send_customer_email; both became gated on an approved
// plan; and the cycle had no way to submit one. It was refused on every real
// action and could not even ask — fully autonomous in conversation, inert
// every morning. Nobody designed that.

test('the cycle is told to submit a plan when none exists', async () => {
  const { __planningInstructionForTests } = await import('../dailyMeeting.js');
  process.env.DAILY_PLAN_REQUIRED = 'true';

  const text = __planningInstructionForTests();

  assert.match(text, /submit_daily_plan/);
  assert.match(text, /will be refused/, 'and told not to try acting first');
});

test('the cycle is told to work inside a plan already approved', async () => {
  const { __planningInstructionForTests } = await import('../dailyMeeting.js');
  plan.submitPlan({ items: [ITEM] });
  plan.approvePlan();

  const text = __planningInstructionForTests();

  assert.match(text, /already approved/);
  // A plan is already approved, so the sync's job is to work inside it
  // rather than open with a fresh submission.
  assert.doesNotMatch(text, /call submit_daily_plan with everything/);
});

test('the cycle does not resubmit over a plan still waiting', async () => {
  const { __planningInstructionForTests } = await import('../dailyMeeting.js');
  plan.submitPlan({ items: [ITEM] });

  const text = __planningInstructionForTests();

  assert.match(text, /waiting on the founder/);
  assert.match(text, /Don't\n?\s*submit a second one/);
});

test('with plans not required the cycle is told nothing about them', async () => {
  const { __planningInstructionForTests } = await import('../dailyMeeting.js');
  delete process.env.DAILY_PLAN_REQUIRED;
  delete process.env.AUTONOMOUS_DEPLOY_REPOS;

  assert.equal(__planningInstructionForTests(), '', 'no requirement, no instruction');
});
