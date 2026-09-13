// The share is only defensible if the numbers behind it are. These cover the
// split maths, the loss case, and — most importantly — the properties that
// stop an agent that knows its own balance from being able to inflate it.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let profitShare;
let ledger;
let context;
let savedPct;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-profitshare-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  savedPct = process.env.AGENT_PROFIT_SHARE_PCT;
  profitShare = await import('../finance/profitShare.js');
  ledger = await import('../finance/ledger.js');
  context = await import('../finance/context.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedPct === undefined) delete process.env.AGENT_PROFIT_SHARE_PCT;
  else process.env.AGENT_PROFIT_SHARE_PCT = savedPct;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each case starts from an empty company.
  for (const f of ['profitShare.json', 'ledger.json']) {
    fs.rmSync(path.join(tmpDir, f), { force: true });
  }
  delete process.env.AGENT_PROFIT_SHARE_PCT;
});

test('an empty company owes nothing and nobody has earned anything', () => {
  const share = profitShare.getProfitShare();
  assert.equal(share.poolUsd, 0);
  assert.deepEqual(share.agents, []);
});

test('the pool is a percentage of net profit, not of revenue', () => {
  ledger.addTransaction({ type: 'revenue', amount: 1000, description: 'a sale' });
  ledger.addTransaction({ type: 'expense', amount: 400, description: 'hosting' });
  profitShare.recordContribution({ agentId: 'ceo', kind: 'propose_venture' });

  // Net is 600, not 1000. At the 10% default that's a $60 pool.
  const share = profitShare.getProfitShare();
  assert.equal(share.net, 600);
  assert.equal(share.poolUsd, 60);
});

test('a loss owes nobody anything, and does not go negative', () => {
  ledger.addTransaction({ type: 'revenue', amount: 100, description: 'a sale' });
  ledger.addTransaction({ type: 'expense', amount: 250, description: 'a domain and ads' });
  profitShare.recordContribution({ agentId: 'ceo', kind: 'deploy_code' });

  const share = profitShare.getProfitShare();
  assert.equal(share.net, -150);
  assert.equal(share.poolUsd, 0);
  // Weight is still tracked, so the moment the company is profitable it
  // distributes — without ever paying a share of a loss.
  assert.equal(share.agents[0].earnedUsd, 0);
  assert.ok(share.agents[0].weight > 0);
});

test('the pool splits by weighted contribution, and sums to the whole pool', () => {
  ledger.addTransaction({ type: 'revenue', amount: 1000, description: 'a sale' });
  // deploy_code is weight 5, log_contact_note weight 1.
  profitShare.recordContribution({ agentId: 'engineering_lead', kind: 'deploy_code' });
  profitShare.recordContribution({ agentId: 'sales_commercial_manager', kind: 'log_contact_note' });

  const share = profitShare.getProfitShare();
  const eng = share.agents.find((a) => a.agentId === 'engineering_lead');
  const sales = share.agents.find((a) => a.agentId === 'sales_commercial_manager');

  assert.equal(share.poolUsd, 100);
  assert.ok(Math.abs(eng.earnedUsd - (100 * 5) / 6) < 0.001);
  assert.ok(Math.abs(sales.earnedUsd - (100 * 1) / 6) < 0.001);
  const total = share.agents.reduce((sum, a) => sum + a.earnedUsd, 0);
  assert.ok(Math.abs(total - share.poolUsd) < 0.001, 'the distributed shares must add up to the pool');
});

test('an agent that did nothing earns nothing', () => {
  ledger.addTransaction({ type: 'revenue', amount: 1000, description: 'a sale' });
  profitShare.recordContribution({ agentId: 'ceo', kind: 'deploy_code' });

  const idle = profitShare.getAgentEarnings('hr_manager');
  assert.equal(idle.earnedUsd, 0);
  assert.equal(idle.events, 0);
});

// The guardrails. Each of these is a way an agent that knows its balance
// might try to move it.
test('credit cannot be recorded for a made-up kind of work', () => {
  assert.equal(profitShare.recordContribution({ agentId: 'ceo', kind: 'was_generally_helpful' }), null);
  assert.equal(profitShare.listContributions().length, 0);
});

test('credit cannot be recorded without an agent to attribute it to', () => {
  assert.equal(profitShare.recordContribution({ agentId: null, kind: 'deploy_code' }), null);
  assert.equal(profitShare.listContributions().length, 0);
});

test('logging an expense still earns credit, even though it shrinks the pool', () => {
  // Otherwise an agent paid on net is quietly incentivised to leave costs
  // unrecorded, which corrupts the founder's books to inflate a payout.
  assert.ok(profitShare.CONTRIBUTION_KINDS.log_expense);
  assert.ok(profitShare.CONTRIBUTION_KINDS.log_expense.weight > 0);
});

test('booking revenue is weighted no higher than the cheapest real work', () => {
  // log_revenue moves the number the share is computed from, so it must
  // never be the most profitable action an agent can take.
  //
  // Measured against the other *actions* only. revenue_earned sits at 0 in
  // this table because its weight is not in the table at all — it comes from
  // the amount earned (see distributeRevenue). Including it would compare an
  // action's price against an outcome's placeholder, which is why this used
  // to read as a straight minimum and no longer can.
  const kinds = profitShare.CONTRIBUTION_KINDS;
  const { log_revenue: revenue, deploy_code: deploy } = kinds;
  const actionWeights = Object.entries(kinds)
    .filter(([name]) => name !== 'revenue_earned')
    .map(([, k]) => k.weight);

  assert.ok(revenue.weight < deploy.weight, 'booking revenue must not out-earn shipping code');
  assert.equal(revenue.weight, Math.min(...actionWeights));
});

test('causing revenue out-earns every action, which is the whole point', () => {
  // The distortion this replaced: shipping a file paid 5, booking money paid
  // 1. The company's incentives argued against the thing it exists to do.
  const kinds = profitShare.CONTRIBUTION_KINDS;
  const dearestAction = Math.max(
    ...Object.entries(kinds)
      .filter(([name]) => name !== 'revenue_earned')
      .map(([, k]) => k.weight)
  );
  // $100 at the default rate is one shipped file; $10,000 is five hundred.
  assert.ok(10000 * 0.05 > dearestAction * 50, 'one real customer beats fifty commits');
});

test('the share percentage is configurable within the cap', () => {
  process.env.AGENT_PROFIT_SHARE_PCT = '15';
  assert.equal(profitShare.sharePct(), 15);
  process.env.AGENT_PROFIT_SHARE_PCT = '0';
  assert.equal(profitShare.sharePct(), 0, 'the share can be switched off entirely');
});

// The ceiling is on the whole pool, not on any one agent's slice: at most
// this much of net profit ever leaves the company.
test('no configuration can share more than the cap', () => {
  for (const over of ['20.1', '25', '50', '100', '1000']) {
    process.env.AGENT_PROFIT_SHARE_PCT = over;
    assert.equal(profitShare.sharePct(), profitShare.MAX_SHARE_PCT, `"${over}" should clamp to the cap`);
  }
  assert.equal(profitShare.MAX_SHARE_PCT, 20);
});

// Clamping is for numbers that are merely too big. Something that isn't a
// usable percentage at all is a config mistake, and silently reading it as
// the maximum would be the worst possible guess.
test('garbage and negatives fall back to the default rather than the cap', () => {
  for (const bad of ['-5', 'lots', '']) {
    process.env.AGENT_PROFIT_SHARE_PCT = bad;
    assert.equal(profitShare.sharePct(), 10, `"${bad}" should fall back to the default`);
  }
});

test('the cap holds all the way through to what is actually distributed', () => {
  process.env.AGENT_PROFIT_SHARE_PCT = '90';
  ledger.addTransaction({ type: 'revenue', amount: 1000, description: 'a sale' });
  profitShare.recordContribution({ agentId: 'ceo', kind: 'deploy_code' });

  const share = profitShare.getProfitShare();
  assert.equal(share.sharePct, 20);
  // 20% of $1000, not 90% — the company keeps at least four fifths of it.
  assert.equal(share.poolUsd, 200);
  assert.equal(share.agents[0].earnedUsd, 200);
});

test("an agent's own context states its position and the rules that bound it", () => {
  ledger.addTransaction({ type: 'revenue', amount: 1000, description: 'a sale' });
  profitShare.recordContribution({ agentId: 'engineering_lead', kind: 'deploy_code' });

  const text = context.buildEarningsContext('engineering_lead');
  assert.match(text, /You have earned \$100\.00/);
  assert.match(text, /Credit is recorded for you, not claimed by you/);
  assert.match(text, /consequence, not a target/);
  // It must say plainly that inflating revenue doesn't work, since that's
  // the specific thing this design is exposed to.
  assert.match(text, /Logging revenue\s+that hasn't landed doesn't grow the pool/);
});

test('an agent with nothing recorded is told so plainly rather than shown a blank', () => {
  const text = context.buildEarningsContext('hr_manager');
  assert.match(text, /no recorded contributions yet/);
});

test('there is no earnings context without an agent id', () => {
  assert.equal(context.buildEarningsContext(null), '');
});

// The load-bearing guardrail, and the one most likely to be broken by a
// later edit: the autonomous daily cycle must never be able to write the
// ledger the share is computed from. If someone wires log_revenue into
// dailyMeeting.js, an unattended run could grow the pool every agent is paid
// on with nobody watching. This asserts the wiring directly rather than
// trusting the file's comments.
test('no autonomous cycle can write the ledger the share is computed from', async () => {
  const dailyMeetingSource = fs.readFileSync(new URL('../dailyMeeting.js', import.meta.url), 'utf-8');
  const weeklySource = fs.readFileSync(new URL('../weeklyReflection.js', import.meta.url), 'utf-8');

  for (const [name, source] of [['dailyMeeting', dailyMeetingSource], ['weeklyReflection', weeklySource]]) {
    // The handler map is what actually decides; a mention in a comment is fine.
    const handlerLines = source
      .split('\n')
      .filter((line) => /^\s*(log_revenue|log_expense)\s*:/.test(line));
    assert.equal(
      handlerLines.length,
      0,
      `${name}.js wires up ${handlerLines.join(', ').trim()} — an unattended run could then move the profit-share pool`
    );
  }
});

test('the weekly reflection remains entirely read-only', async () => {
  const source = fs.readFileSync(new URL('../weeklyReflection.js', import.meta.url), 'utf-8');
  assert.match(source, /actionHandlers:\s*\{\s*\}/, 'the weekly reflection must pass an empty handler map');
});

// Being consulted is how most of this company's agents do their work. Credit
// only came from action tools, so 18 of the 24 agents — the entire ideation
// bench included — were told they had a stake in a pool they could never
// touch. These pin the fix.
test('a consulted specialist earns credit for answering', async () => {
  const { runAgent } = await import('../agents/agentRunner.js');

  const AGENTS = {
    boss: {
      id: 'boss',
      title: 'Boss',
      department: 'Test',
      reportsTo: null,
      reports: ['specialist'],
      systemPrompt: 'You are the boss.',
      toolDescription: 'Consult the boss.',
    },
    specialist: {
      id: 'specialist',
      title: 'Specialist',
      department: 'Test',
      reportsTo: 'boss',
      reports: [],
      systemPrompt: 'You are a specialist.',
      toolDescription: 'Consult the specialist.',
    },
  };

  const responses = [
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'consult_specialist', input: { task: 'what do you think?' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'A considered opinion.' }], usage: { input_tokens: 10, output_tokens: 5 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the answer.' }], usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  let i = 0;
  const anthropic = { messages: { create: async () => responses[i++] } };

  await runAgent({ anthropic, agents: AGENTS, agentId: 'boss', messages: [{ role: 'user', content: 'go' }] });

  const earned = profitShare.listContributions('specialist');
  assert.equal(earned.length, 1, 'the consulted specialist should have earned credit');
  assert.equal(earned[0].kind, 'consulted');
  assert.match(earned[0].detail, /consulted by boss/);
  // The manager earns nothing for delegating — otherwise the cheapest way to
  // get paid would be to ask someone else to do the work.
  assert.equal(profitShare.listContributions('boss').length, 0);
});

test('being consulted is weighted below every action that produces something', () => {
  const { consulted, deploy_code: deploy, propose_venture: propose } = profitShare.CONTRIBUTION_KINDS;
  assert.ok(consulted.weight < deploy.weight);
  assert.ok(consulted.weight < propose.weight);
});

// Compaction exists because recordContribution does a synchronous full-file
// read *and* rewrite on every consultation, so the cost of one write grew
// with the entire history — 1.5ms at 1k events, 6.8ms at 5k, unusable by
// 20k, all of it blocking the event loop. These pin the fix and, more
// importantly, that it doesn't quietly change what anyone has earned.
test('the log stays bounded however many contributions are recorded', () => {
  for (let i = 0; i < 1200; i++) {
    profitShare.recordContribution({ agentId: 'market_researcher', kind: 'consulted' });
  }
  const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'profitShare.json'), 'utf-8'));
  assert.ok(stored.contributions.length <= 500, `expected the event log to be capped, got ${stored.contributions.length}`);
  // The overflow was folded, not dropped.
  assert.equal(stored.totals.market_researcher.events, 1200 - stored.contributions.length);
});

test('compaction preserves every share exactly', () => {
  ledger.addTransaction({ type: 'revenue', amount: 1000, description: 'a sale' });

  // Well past the cap, in a fixed 3:1 weight ratio — deploy_code is weight 5,
  // consulted is weight 1, so 200 deploys against 1000 consults is 1000 vs
  // 1000 weight: an even split that compaction must not disturb.
  for (let i = 0; i < 200; i++) profitShare.recordContribution({ agentId: 'engineering_lead', kind: 'deploy_code' });
  for (let i = 0; i < 1000; i++) profitShare.recordContribution({ agentId: 'market_researcher', kind: 'consulted' });

  const share = profitShare.getProfitShare();
  const eng = share.agents.find((a) => a.agentId === 'engineering_lead');
  const res = share.agents.find((a) => a.agentId === 'market_researcher');

  assert.equal(eng.weight, 1000);
  assert.equal(res.weight, 1000);
  assert.equal(eng.events, 200);
  assert.equal(res.events, 1000);
  assert.ok(Math.abs(eng.earnedUsd - res.earnedUsd) < 0.001, 'equal weight must still earn equally after compaction');
  const total = share.agents.reduce((sum, a) => sum + a.earnedUsd, 0);
  assert.ok(Math.abs(total - share.poolUsd) < 0.001, 'the shares must still add up to the pool');
});

// A file written before compaction existed has no totals key.
test('a pre-compaction file still loads and pays out', () => {
  fs.writeFileSync(
    path.join(tmpDir, 'profitShare.json'),
    JSON.stringify({ contributions: [{ id: 'c_old', agentId: 'ceo', kind: 'deploy_code', weight: 5, at: '2026-01-01T00:00:00.000Z' }] })
  );
  ledger.addTransaction({ type: 'revenue', amount: 1000, description: 'a sale' });

  const share = profitShare.getProfitShare();
  assert.equal(share.totalWeight, 5);
  assert.equal(share.agents[0].agentId, 'ceo');
  assert.equal(share.agents[0].earnedUsd, 100);
});
