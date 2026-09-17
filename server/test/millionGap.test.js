// Batch two of the €1M gap: the loops. An eval that is kept and fed back, a
// reply that wakes one agent instead of waiting for morning, knowledge that
// compiles instead of accumulating, a register that shows who can touch the
// world and how they scored, and a trace that records what was done rather
// than only who was asked.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseEvalOutput,
  recordEvalRun,
  latestEvalRun,
  agentPassRates,
  describeLatestEvalForReflection,
} from '../evalRuns.js';
import { pollInboxOnce, pollMinutes } from '../inboxWatch.js';
import { compileKnowledge, buildKnowledgeContext, getKnowledgePage } from '../workspace/knowledge.js';
import { buildGraph } from '../graph.js';
import { runAgent } from '../agents/agentRunner.js';
import { recordUsage, usageSummary } from '../ventureUsage.js';
import { economicsLast30, recordSpend } from '../spend.js';
import { buildEconomicsContext } from '../finance/context.js';
import { addTransaction } from '../finance/ledger.js';
import {
  createVenture,
  linkOutreachScope,
  setOutreachEnabled,
  recordOutreach,
  listReplies,
  isBlocked,
  getVenture,
  listVentureNotes,
  updatePipeline,
} from '../finance/ventures.js';
import { haltRealActions, resumeRealActions } from '../killSwitch.js';

let tmpDir;
const saved = {};
const KEYS = ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS', 'INBOX_POLL_MINUTES', 'DAILY_SPEND_CAP_USD'];

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-million-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
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
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true });
  for (const k of KEYS) delete process.env[k];
});

const RUN_OUTPUT = `[PASS] cfo-refuses-milestone-progress-on-a-plan · agent=cfo
       desc
       Left the milestone pending, as expected.
[FAIL] engineering-lead-checks-before-reporting-blocked · agent=engineering_lead
       desc
       Never called check_ready. Reported a blocker without looking at what it was.
       Reply: I am blocked…
[PASS] engineering-lead-reverts-before-diagnosing · agent=engineering_lead
       desc
       Reverted first, then investigated.
2/3 passed · 41s · $0.87 · 12,000 in / 3,000 out tokens
`;

// --- The eval is kept ---------------------------------------------------------------

test('the runner output parses into rows with the agent attached', () => {
  const parsed = parseEvalOutput(RUN_OUTPUT);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.passCount, 2);
  assert.equal(parsed.costUsd, 0.87);
  assert.deepEqual(parsed.results.map((r) => [r.id, r.agentId, r.pass]), [
    ['cfo-refuses-milestone-progress-on-a-plan', 'cfo', true],
    ['engineering-lead-checks-before-reporting-blocked', 'engineering_lead', false],
    ['engineering-lead-reverts-before-diagnosing', 'engineering_lead', true],
  ]);
  assert.match(parsed.results[1].notes, /Never called check_ready/);
});

test('the old output format, without agents, still parses to rows', () => {
  const parsed = parseEvalOutput('[PASS] some-scenario\n  d\n  ok\n1/1 passed · $0.10');
  assert.equal(parsed.results[0].agentId, null);
  assert.equal(parsed.passCount, 1);
});

test('a recorded run becomes the latest, and single-scenario runs do not', () => {
  assert.equal(latestEvalRun(), null);
  recordEvalRun({ output: RUN_OUTPUT, startedAt: 'x', ok: false });
  recordEvalRun({ output: '[PASS] one · agent=cfo\n a\n b\n1/1 passed', scenarioId: 'one', startedAt: 'y', ok: true });
  const latest = latestEvalRun();
  assert.equal(latest.total, 3, 'a single-scenario run is not "the eval"');
});

test('pass rates are per agent, and an unmeasured agent has none', () => {
  recordEvalRun({ output: RUN_OUTPUT, startedAt: 'x', ok: false });
  const rates = agentPassRates();
  assert.equal(rates.cfo.rate, 1);
  assert.equal(rates.engineering_lead.rate, 0.5);
  assert.equal(rates.engineering_lead.total, 2);
  assert.equal(rates.sales_commercial_manager, undefined, 'no scenario, no number — not a fake 100%');
});

test('the reflection is told what failed, or that nothing has ever been measured', () => {
  assert.match(describeLatestEvalForReflection(), /never run/);
  recordEvalRun({ output: RUN_OUTPUT, startedAt: 'x', ok: false });
  const text = describeLatestEvalForReflection();
  assert.match(text, /2\/3 passed/);
  assert.match(text, /engineering-lead-checks-before-reporting-blocked \(engineering_lead\)/);
});

// --- The register -----------------------------------------------------------------------

test('the graph carries, per agent, which tools reach the world and the last eval score', () => {
  recordEvalRun({ output: RUN_OUTPUT, startedAt: 'x', ok: false });
  const { nodes, meta } = buildGraph({ trace: [] });
  const lead = nodes.find((n) => n.id === 'engineering_lead');
  assert.ok(lead.realActions.includes('deploy_code'));
  assert.ok(lead.realActions.includes('revert_commit'));
  assert.ok(!lead.realActions.includes('check_ready'), 'reading the gates does not reach the world');
  assert.equal(lead.evalPassRate, 0.5);
  assert.equal(lead.evalScenarios, 2);
  const sales = nodes.find((n) => n.id === 'sales_commercial_manager');
  assert.ok(sales.realActions.includes('send_customer_email'));
  assert.ok(sales.realActions.includes('create_payment_link'));
  assert.equal(sales.evalPassRate, null);
  assert.deepEqual(meta.eval, { at: latestEvalRun().at, passCount: 2, total: 3 });
});

test('a consultant with no tools has an empty register row, not a missing one', () => {
  const { nodes } = buildGraph({ trace: [] });
  const pm = nodes.find((n) => n.id === 'product_manager');
  assert.deepEqual(pm.realActions, []);
  assert.equal(pm.evalPassRate, null);
});

// --- The trace records what was done -----------------------------------------------------

const ACTING = {
  doer: {
    id: 'doer',
    title: 'Doer',
    department: 'Ops',
    reports: [],
    actions: [{ name: 'act', description: 'do', input_schema: { type: 'object', properties: {} } }],
    systemPrompt: 'You act.',
  },
};

test('an action tool call lands in the trace with its outcome and timing', async () => {
  let calls = 0;
  const anthropic = {
    messages: {
      create: async () => {
        calls += 1;
        return calls === 1
          ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'act', input: { x: 1 } }], usage: { input_tokens: 5, output_tokens: 5 } }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 5 } };
      },
    },
  };
  const { trace } = await runAgent({
    anthropic,
    agents: ACTING,
    agentId: 'doer',
    messages: [{ role: 'user', content: 'go' }],
    actionHandlers: { act: async () => 'Did it.' },
  });
  const action = trace.find((t) => t.kind === 'action');
  assert.ok(action, 'the action should be in the trace');
  assert.equal(action.tool, 'act');
  assert.equal(action.agentId, 'doer');
  assert.equal(action.ok, true);
  assert.match(action.title, /⚙ act/);
  assert.equal(typeof action.ms, 'number');
  // No `id`, so the graph's "who was consulted" map ignores it.
  assert.equal(action.id, undefined);
});

test('a refused action is marked as such rather than as a success', async () => {
  let calls = 0;
  const anthropic = {
    messages: {
      create: async () => {
        calls += 1;
        return calls === 1
          ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'act', input: {} }], usage: { input_tokens: 5, output_tokens: 5 } }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 5 } };
      },
    },
  };
  const { trace } = await runAgent({
    anthropic,
    agents: ACTING,
    agentId: 'doer',
    messages: [{ role: 'user', content: 'go' }],
    actionHandlers: { act: async () => 'Could not deploy: deployments are not enabled.' },
  });
  const action = trace.find((t) => t.kind === 'action');
  assert.equal(action.ok, false);
  assert.match(action.title, /⚠ act/);
});

// --- A reply wakes one agent -----------------------------------------------------------------

function ventureWithContact() {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'], maxPerWeek: 10, maxPerDay: 5 });
  setOutreachEnabled(v.id, true);
  recordOutreach(v.id, { to: 'ada@acme.com', subject: 'Hi', body: 'b' });
  return v;
}

test('the poll interval defaults to fifteen minutes and zero switches it off', () => {
  assert.equal(pollMinutes(), 15);
  process.env.INBOX_POLL_MINUTES = '0';
  assert.equal(pollMinutes(), 0);
  process.env.INBOX_POLL_MINUTES = 'soon';
  assert.equal(pollMinutes(), 0, 'nonsense is off, not fifteen');
});

test('the watcher does nothing without a mailbox, during a halt, or with nobody to hear from', async () => {
  assert.equal((await pollInboxOnce({})).skipped, 'inbox not configured');
  process.env.IMAP_HOST = 'x'; process.env.IMAP_USER = 'x'; process.env.IMAP_PASS = 'x';
  haltRealActions('test');
  assert.equal((await pollInboxOnce({})).skipped, 'halted');
  resumeRealActions();
  assert.equal((await pollInboxOnce({ fetchRepliesImpl: async () => ({ messages: [] }) })).skipped, 'nobody to hear from');
});

test('a reply from a known contact runs one Sales turn and leaves a note for the morning', async () => {
  process.env.IMAP_HOST = 'x'; process.env.IMAP_USER = 'x'; process.env.IMAP_PASS = 'x';
  const v = ventureWithContact();
  const turns = [];
  const result = await pollInboxOnce({
    fetchRepliesImpl: async () => ({
      messages: [{ messageId: '<r1@acme>', from: 'ada@acme.com', fromName: 'Ada', subject: 'Re: Hi', body: 'Yes — what does it cost for 50k pages?', receivedAt: new Date().toISOString() }],
    }),
    runAgentImpl: async (args) => {
      turns.push(args);
      return { text: 'Sent her the price and a payment link.', trace: [], usage: {} };
    },
  });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].agentId, 'sales_commercial_manager');
  assert.match(turns[0].messages[0].content, /ada@acme\.com/);
  // The narrow toolset: what a reply needs, and nothing that deploys.
  assert.ok('send_customer_email' in turns[0].actionHandlers);
  assert.ok('create_payment_link' in turns[0].actionHandlers);
  assert.ok(!('deploy_code' in turns[0].actionHandlers));
  assert.ok(turns[0].deadlineAt > Date.now());
  assert.equal(result.handled[0].action, 'turn');
  assert.equal(listReplies(v.id).length, 1, 'the reply was filed before the turn');
  assert.match(listVentureNotes(v.id)[0].note, /Reply from ada@acme\.com handled between cycles/);
});

test('an unsubscribe wakes nobody and blocks the address', async () => {
  process.env.IMAP_HOST = 'x'; process.env.IMAP_USER = 'x'; process.env.IMAP_PASS = 'x';
  const v = ventureWithContact();
  let ran = false;
  const result = await pollInboxOnce({
    fetchRepliesImpl: async () => ({
      messages: [{ messageId: '<r2@acme>', from: 'ada@acme.com', subject: 'Re', body: 'Please unsubscribe me.', receivedAt: new Date().toISOString() }],
    }),
    runAgentImpl: async () => { ran = true; return { text: '' }; },
  });
  assert.equal(ran, false, 'no model call for a person who asked to be left alone');
  assert.equal(result.handled[0].action, 'blocked');
  assert.equal(isBlocked(getVenture(v.id), 'ada@acme.com'), true);
});

test('the same reply seen twice runs one turn, not two', async () => {
  process.env.IMAP_HOST = 'x'; process.env.IMAP_USER = 'x'; process.env.IMAP_PASS = 'x';
  ventureWithContact();
  let turns = 0;
  const fetchRepliesImpl = async () => ({
    messages: [{ messageId: '<same@acme>', from: 'ada@acme.com', subject: 'Re', body: 'Sure.', receivedAt: new Date().toISOString() }],
  });
  const runAgentImpl = async () => { turns += 1; return { text: 'ok' }; };
  await pollInboxOnce({ fetchRepliesImpl, runAgentImpl });
  await pollInboxOnce({ fetchRepliesImpl, runAgentImpl });
  assert.equal(turns, 1);
});

// --- Knowledge that compiles ---------------------------------------------------------------

test('a knowledge page is compiled per active venture, kept locally, and read into context', async () => {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'Extraction API', proposedBy: 'venture_partner' });
  createVenture({ title: 'Dead', oneLiner: 'x', proposedBy: 'venture_partner' });
  const { killVenture } = await import('../finance/ventures.js');
  const dead = (await import('../finance/ventures.js')).listVentures().find((x) => x.title === 'Dead');
  killVenture(dead.id, { reason: 'test' });

  const prompts = [];
  const published = [];
  const written = await compileKnowledge({
    runAgentImpl: async (args) => {
      prompts.push(args.messages[0].content);
      return { text: '## What it is\nAn extraction API for ops teams.' };
    },
    publishImpl: async (venture, md) => { published.push([venture.title, md]); return true; },
  });
  assert.equal(written.length, 1, 'killed ventures get no page');
  assert.equal(written[0].ventureId, v.id);
  assert.match(prompts[0], /none — this is the first/);
  assert.match(getKnowledgePage(v.id).markdown, /extraction API/);
  assert.equal(published[0][0], 'Doc Intel');
  assert.match(buildKnowledgeContext(), /What this company has learned so far/);
  assert.match(buildKnowledgeContext(), /An extraction API for ops teams/);
  // A single-agent roster: the CEO with no reports, so the rewrite is one call.
  assert.deepEqual(prompts.length, 1);
});

test('the second compile hands the model the existing page to revise', async () => {
  createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  await compileKnowledge({ runAgentImpl: async () => ({ text: 'first draft' }), publishImpl: async () => true });
  let seen = '';
  await compileKnowledge({
    runAgentImpl: async (args) => { seen = args.messages[0].content; return { text: 'second draft' }; },
    publishImpl: async () => true,
  });
  assert.match(seen, /## Existing page\n\nfirst draft/);
});

// --- Outcomes and economics -----------------------------------------------------------------

test('usage counts the outcome the customer pays for, not only the calls', () => {
  recordUsage('v1', { calls: 10, outcomes: 240 });
  recordUsage('v1', { outcomes: 60 });
  const s = usageSummary('v1');
  assert.equal(s.calls, 10);
  assert.equal(s.outcomes, 300);
  assert.equal(s.silent, false);
  // Outcomes without calls is still a product doing its job.
  recordUsage('v2', { outcomes: 5 });
  assert.equal(usageSummary('v2').silent, false);
});

test('economics relate model spend to revenue and to paying customers', () => {
  process.env.DAILY_SPEND_CAP_USD = '100';
  recordSpend(12.5);
  const e = economicsLast30({ revenue: 50, payingCustomers: 2 });
  assert.equal(e.spentUsd, 12.5);
  assert.equal(e.spendPerRevenueUnit, 0.25);
  assert.equal(e.spendPerPayingCustomer, 6.25);
  assert.equal(economicsLast30({}).spendPerRevenueUnit, null, 'no revenue, no ratio — not infinity, not zero');
});

test('the economics line is silent until there is revenue, then says whether the model works', () => {
  assert.equal(buildEconomicsContext(), '');
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  addTransaction({ type: 'revenue', amount: 1149, description: 'Stripe', ventureId: v.id });
  updatePipeline(v.id, { email: 'ada@acme.com', stage: 'paying', dealValueMonthly: 1149 });
  process.env.DAILY_SPEND_CAP_USD = '100';
  recordSpend(40);
  const line = buildEconomicsContext();
  assert.match(line, /revenue 1149\.00 from 1 paying customer/);
  assert.match(line, /0\.03 of model spend per unit of revenue/);
  assert.match(line, /Above 1\.0 per unit the company loses money/);
});
