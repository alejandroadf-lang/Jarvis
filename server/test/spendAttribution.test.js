// Where the money goes, and a ceiling for one unattended run.
//
// The spend ledger knew what a day cost and nothing about why, so every cut was
// a guess. These pin the attribution (by part of the company and by agent) and
// the per-run budget that keeps one work session from eating the day's cap.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let spend;
let runner;
let commands;
const saved = process.env.DAILY_SPEND_CAP_USD;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-spend-attr-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  process.env.DAILY_SPEND_CAP_USD = '100';
  spend = await import('../spend.js');
  runner = await import('../agents/agentRunner.js');
  commands = await import('../channels/founderCommands.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (saved === undefined) delete process.env.DAILY_SPEND_CAP_USD;
  else process.env.DAILY_SPEND_CAP_USD = saved;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true });
});

test('spend is attributed to the part of the company and the agent that made it', async () => {
  spend.recordSpend(0.5); // nothing named: the founder talking to the company
  await spend.withSpendContext({ source: 'meeting' }, async () => {
    await spend.withSpendContext({ agentId: 'cto' }, async () => spend.recordSpend(2));
    spend.recordSpend(1, {});
  });
  spend.withSpendContext({ source: 'studio', agentId: 'market_researcher' }, () => spend.recordSpend(0.25));

  const { total, bySource, byAgent } = spend.spendBreakdown(7);
  assert.equal(total, 3.75);
  assert.deepEqual(bySource, [['meeting', 3], ['chat', 0.5], ['studio', 0.25]]);
  assert.deepEqual(byAgent, [['cto', 2], ['unknown', 1.5], ['market_researcher', 0.25]]);
  assert.equal(spend.getSpendToday(), 3.75, 'the day total is unchanged by attribution');
});

test('SPEND says where it went, in words a phone can read', async () => {
  const empty = await commands.runFounderCommand({ kind: 'spend' });
  assert.match(empty, /nothing attributed yet/);

  spend.withSpendContext({ source: 'meeting', agentId: 'ceo' }, () => spend.recordSpend(3));
  spend.withSpendContext({ source: 'pitch', agentId: 'ideation_lead' }, () => spend.recordSpend(1));
  const text = await commands.runFounderCommand({ kind: 'spend' });
  assert.match(text, /Last 7 days by part: meeting \$3\.00 \(75%\), pitch \$1\.00 \(25%\)\./);
  assert.match(text, /By agent: ceo \$3\.00 \(75%\), ideation_lead \$1\.00 \(25%\)\./);
});

test('a run stops widening once its budget is spent, and says so to what it never consulted', async () => {
  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'x', reports: ['a', 'b'], actions: [], toolDescription: 't', systemPrompt: 's', mission: 'm' },
    a: { id: 'a', title: 'A', department: 'x', reports: [], actions: [], toolDescription: 't', systemPrompt: 's', mission: 'm', reportsTo: 'boss' },
    b: { id: 'b', title: 'B', department: 'x', reports: [], actions: [], toolDescription: 't', systemPrompt: 's', mission: 'm', reportsTo: 'boss' },
  };
  // Each call costs about $0.03 on the default model (10k in, 1k out).
  const usage = { input_tokens: 10000, output_tokens: 1000 };
  const consult = (name) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${name}`, name, input: { task: 'go' } }], usage });
  const done = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage });
  const script = [consult('consult_a'), done('a says hi'), consult('consult_b'), done('boss closes out')];
  let i = 0;
  const calls = [];
  const client = { messages: { create: async (p) => { calls.push(p); return script[i++] || done('closing'); } } };

  const result = await runner.runAgent({ anthropic: client, agents, agentId: 'boss', messages: [{ role: 'user', content: 'go' }], budgetUsd: 0.0001 });
  // Round 0 always runs and spends the budget; round 1 must not consult anyone.
  assert.equal(result.ranOutOfTime, true);
  assert.ok(calls.length <= 3, `stopped early: ${calls.length} model calls`);
  assert.ok(!/b says/.test(result.text));
});
