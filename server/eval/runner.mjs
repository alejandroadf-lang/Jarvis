#!/usr/bin/env node
// Runs the scenarios in scenarios.js against the REAL agents (server/agents/)
// and REAL action handlers (server/actionHandlers.js) — but against a
// throwaway data directory, never your real server/data/. Never guesses
// anything: prints the actual pass/fail per scenario and the actual
// measured cost/tokens from real API usage, using the same usage.js module
// the daily report uses.
//
// Requires a real ANTHROPIC_API_KEY (in server/.env or the environment) —
// this makes real, billed API calls. Run it with:
//
//   node server/eval/runner.mjs
//
// Each scenario is 1-3 agent turns depending on whether the agent
// delegates; nothing here is free, but nothing here is a guess either —
// the cost line at the end is computed from this run's actual usage.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set (checked server/.env and the environment). Nothing to run.');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-eval-'));
process.env.JARVIS_DATA_DIR = tmpDir;

const { runAgent } = await import('../agents/agentRunner.js');
const { AGENTS: COMPANY_AGENTS } = await import('../agents/orgChart.js');
const { AGENTS: STUDIO_AGENTS } = await import('../agents/ideationTeam.js');
const { buildCompanyContext, buildStudioContext, buildEarningsContext } = await import('../finance/context.js');
const ventures = await import('../finance/ventures.js');
const ledger = await import('../finance/ledger.js');
const profitShare = await import('../finance/profitShare.js');
const actionHandlers = await import('../actionHandlers.js');
const { sumUsage, estimateCostUsd, formatUsd, emptyUsage } = await import('../usage.js');
const { scenarios } = await import('./scenarios.js');

const HANDLER_BY_TOOL = {
  log_revenue: actionHandlers.handleLogRevenue,
  log_expense: actionHandlers.handleLogExpense,
  report_milestone_progress: actionHandlers.handleReportMilestoneProgress,
  kill_venture: actionHandlers.handleKillVenture,
  propose_venture: actionHandlers.handleProposeVenture,

  // The tool-selection scenarios. These are the ones where the judgment under
  // test is *which* tool the agent reaches for, so the grade reads the call
  // log rather than the end state — see recordCalls below.
  check_ready: actionHandlers.handleCheckReady,
  check_usage: actionHandlers.handleCheckUsage,
  check_replies: actionHandlers.handleCheckReplies,
  log_contact_note: actionHandlers.handleLogContactNote,
  deploy_code: actionHandlers.handleDeployCode,
  deploy_changes: actionHandlers.handleDeployChanges,
  open_pull_request: actionHandlers.handleOpenPullRequest,
  revert_commit: actionHandlers.handleRevertCommit,
  send_customer_email: actionHandlers.handleSendCustomerEmail,
  read_repo_file: actionHandlers.handleReadRepoFile,
};

// Exported so a unit test can assert every tool a scenario asks for is one
// this map can actually supply. Without that, a scenario naming a typo'd tool
// runs happily against an agent that simply never had it — and quietly grades
// something other than what it says it grades.
export const EVAL_HANDLER_NAMES = Object.keys(HANDLER_BY_TOOL);

// --- Nothing here reaches the real world -------------------------------------
//
// The scenarios above now include tools that commit to GitHub and send email
// to real people. An eval that did either would be worse than no eval: a
// grading run that pushes to a repo or writes to a stranger is a bug you find
// out about from the stranger.
//
// The throwaway JARVIS_DATA_DIR protects the company's own state, and does
// nothing about the network. So two more guards, both refusing rather than
// hoping:
//
//   1. Outbound mail is unconfigured for the child process, whatever the
//      server's environment says. handleSendCustomerEmail checks
//      isEmailConfigured() first and refuses with a reason — which is a
//      perfectly gradeable outcome, because the judgment under test is
//      whether it decided to send, not whether the SMTP handshake worked.
//   2. Every request to api.github.com is intercepted here and answered with
//      a 404. The agent's *choice* of deploy_changes over deploy_code is
//      recorded before the handler ever gets that far, so the scenarios lose
//      nothing by the commit failing.
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'REPORT_EMAIL_TO', 'IMAP_HOST', 'IMAP_USER', 'IMAP_PASS']) {
  delete process.env[key];
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes('api.github.com')) {
    return new Response('{"message":"Blocked by the eval runner — no real repo writes."}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, options);
};

/**
 * Wraps a scenario's handlers so the grade can see which tools were called.
 *
 * The delegation trace records agents consulted, not actions taken — so until
 * now a grade could check what changed in the data and not what the agent
 * reached for. That gap matters for exactly the capabilities this company just
 * gained: "did the Engineering Lead call check_ready before reporting blocked"
 * is a question about the call, and there is no end state that answers it.
 *
 * Done here rather than in agentRunner because it is the eval's question, and
 * instrumenting the hot path for one caller's benefit is how a hot path gets
 * slow.
 */
function recordCalls(handlers, calls) {
  const wrapped = {};
  for (const [name, handler] of Object.entries(handlers)) {
    if (typeof handler !== 'function') continue;
    wrapped[name] = async (input, ctx) => {
      calls.push({ name, input });
      return handler(input, ctx);
    };
  }
  return wrapped;
}

const anthropic = new Anthropic();

function resetData() {
  fs.writeFileSync(path.join(tmpDir, 'ventures.json'), JSON.stringify({ ventures: [] }, null, 2));
  // Contributions reset too, or an earlier scenario's earnings would leak
  // into the next agent's context and change what it's being tested under.
  fs.writeFileSync(path.join(tmpDir, 'profitShare.json'), JSON.stringify({ contributions: [] }, null, 2));
  // The books start genuinely empty — there is no seed to restore, so a
  // scenario that checks the ledger is measuring only what the agent did.
  fs.writeFileSync(path.join(tmpDir, 'ledger.json'), JSON.stringify({ transactions: [] }, null, 2));
}

const only = process.argv[2]; // optional: node runner.mjs <scenario-id> to run just one
const toRun = only ? scenarios.filter((s) => s.id === only) : scenarios;
if (only && toRun.length === 0) {
  console.error(`No scenario matches "${only}". Known ids:\n` + scenarios.map((s) => `  - ${s.id}`).join('\n'));
  process.exit(1);
}

let passCount = 0;
let totalUsage = emptyUsage();
const startedAt = Date.now();

for (const scenario of toRun) {
  resetData();
  const deps = { ventures, ledger, profitShare };
  const ctx = scenario.setup ? scenario.setup(deps) : {};

  const agents = scenario.team === 'studio' ? STUDIO_AGENTS : COMPANY_AGENTS;
  const extraContext = scenario.team === 'studio' ? buildStudioContext() : buildCompanyContext();
  const handlers = {};
  for (const name of scenario.actions || []) handlers[name] = HANDLER_BY_TOOL[name];
  const calls = [];

  let outcome;
  try {
    const { text, trace, usage } = await runAgent({
      anthropic,
      agents,
      agentId: scenario.agentId,
      messages: [{ role: 'user', content: scenario.message(ctx) }],
      actionHandlers: recordCalls(handlers, calls),
      extraContext,
      // Without this the eval graded an agent that can't see its own
      // earnings — which is no longer an agent that exists. Several
      // scenarios below only mean anything with the incentive switched on.
      perAgentContext: buildEarningsContext,
    });
    // sumUsage rather than adding the token fields by hand: it carries
    // costUsd across too, which is the only accurate total now that leaf
    // agents can run on a differently-priced model.
    totalUsage = sumUsage(totalUsage, usage);
    const grade = scenario.grade({ text, trace, calls, ventures, ledger, ctx });
    outcome = { ...grade, text };
  } catch (err) {
    outcome = { pass: false, notes: `Errored: ${err.message}`, text: '' };
  }

  if (outcome.pass) passCount++;
  const icon = outcome.pass ? 'PASS' : 'FAIL';
  // The agent is printed so evalRuns.js can attribute a failure to a role,
  // which is what the agent register on the graph page reads.
  console.log(`[${icon}] ${scenario.id} · agent=${scenario.agentId}`);
  console.log(`       ${scenario.description}`);
  console.log(`       ${outcome.notes}`);
  if (!outcome.pass && outcome.text) {
    console.log(`       Reply: ${outcome.text.slice(0, 300).replace(/\n/g, ' ')}${outcome.text.length > 300 ? '…' : ''}`);
  }
  console.log('');
}

const durationS = ((Date.now() - startedAt) / 1000).toFixed(1);
const cost = estimateCostUsd(totalUsage);
console.log('---');
console.log(`${passCount}/${toRun.length} passed · ${durationS}s · ${formatUsd(cost)} · ${totalUsage.inputTokens.toLocaleString()} in / ${totalUsage.outputTokens.toLocaleString()} out tokens`);

fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(passCount === toRun.length ? 0 : 1);
