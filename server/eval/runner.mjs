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
const { buildCompanyContext, buildStudioContext } = await import('../finance/context.js');
const ventures = await import('../finance/ventures.js');
const ledger = await import('../finance/ledger.js');
const actionHandlers = await import('../actionHandlers.js');
const { sumUsage, estimateCostUsd, formatUsd, emptyUsage } = await import('../usage.js');
const { scenarios } = await import('./scenarios.js');

const HANDLER_BY_TOOL = {
  log_revenue: actionHandlers.handleLogRevenue,
  log_expense: actionHandlers.handleLogExpense,
  report_milestone_progress: actionHandlers.handleReportMilestoneProgress,
  kill_venture: actionHandlers.handleKillVenture,
  propose_venture: actionHandlers.handleProposeVenture,
};

const anthropic = new Anthropic();

function resetData() {
  fs.writeFileSync(path.join(tmpDir, 'ventures.json'), JSON.stringify({ ventures: [] }, null, 2));
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
  const deps = { ventures, ledger };
  const ctx = scenario.setup ? scenario.setup(deps) : {};

  const agents = scenario.team === 'studio' ? STUDIO_AGENTS : COMPANY_AGENTS;
  const extraContext = scenario.team === 'studio' ? buildStudioContext() : buildCompanyContext();
  const handlers = {};
  for (const name of scenario.actions || []) handlers[name] = HANDLER_BY_TOOL[name];

  let outcome;
  try {
    const { text, trace, usage } = await runAgent({
      anthropic,
      agents,
      agentId: scenario.agentId,
      messages: [{ role: 'user', content: scenario.message(ctx) }],
      actionHandlers: handlers,
      extraContext,
    });
    // sumUsage rather than adding the token fields by hand: it carries
    // costUsd across too, which is the only accurate total now that leaf
    // agents can run on a differently-priced model.
    totalUsage = sumUsage(totalUsage, usage);
    const grade = scenario.grade({ text, trace, ventures, ledger, ctx });
    outcome = { ...grade, text };
  } catch (err) {
    outcome = { pass: false, notes: `Errored: ${err.message}`, text: '' };
  }

  if (outcome.pass) passCount++;
  const icon = outcome.pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${scenario.id}`);
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
