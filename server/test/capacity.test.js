// CAPACITY: how much of what the founder grants is used, and what would use more.
//
// Four ceilings, each measured on its own: the roster, each venture's commit
// allowance (read with the deploy gate's own arithmetic), the daily model
// budget, and the daily cycle. The recommendations are rules over those
// numbers, and each must name the command that acts on it.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let log;
let cap;
let ventures;
let commands;
const savedCap = process.env.DAILY_SPEND_CAP_USD;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-capacity-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  process.env.DAILY_SPEND_CAP_USD = '10';
  log = await import('../activityLog.js');
  cap = await import('../capacity.js');
  ventures = await import('../finance/ventures.js');
  commands = await import('../channels/founderCommands.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedCap === undefined) delete process.env.DAILY_SPEND_CAP_USD;
  else process.env.DAILY_SPEND_CAP_USD = savedCap;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true });
});

test('refusals are kept as a gate category, never as the message', () => {
  assert.equal(log.classifyRefusal('Could not: the daily model spend cap is reached'), 'spend');
  assert.equal(log.classifyRefusal('The approved plan does not cover "deploy_code".'), 'plan');
  assert.equal(log.classifyRefusal('Weekly deployment cap reached (3 of 3).'), 'cap');
  assert.equal(log.classifyRefusal('Too soon after the last commit'), 'cooldown');
  assert.equal(log.classifyRefusal('"server/x.js" is outside the allowed scope (ventures/happycompany/)'), 'scope');
  assert.equal(log.classifyRefusal('No outreach scope set up for this venture yet'), 'outreach');
  assert.equal(log.classifyRefusal('Could not link a repo: this server has no GITHUB_TOKEN configured.'), 'config');
  const e = log.recordActivity({ agentId: 'pilot_manager', kind: 'action', tool: 'send_customer_email', ok: false, refusal: 'bob@acme.com is not in the outreach allowlist' });
  assert.equal(e.gate, 'outreach');
  assert.ok(!JSON.stringify(log.listActivity()).includes('bob@acme.com'), 'the message, and the address in it, are not stored');
});

test('the report measures each ceiling on its own', () => {
  const v = ventures.createVenture({ title: 'Happy Company' });
  ventures.linkRepo(v.id, { owner: 'o', name: 'r', allowedPaths: ['x/'] });
  ventures.setDeploymentEnabled(v.id, true);
  ventures.setDeploymentCaps(v.id, { maxPerDay: 1, maxPerWeek: 4 });
  ventures.recordDeployment(v.id, { path: 'x/a.js', message: 'm', commitSha: 'abc' });
  log.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool: 'open_pull_request', ok: true });
  log.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool: 'open_pull_request', ok: false, refusal: 'The approved plan does not cover it' });
  log.recordActivity({ agentId: 'cto', kind: 'consulted' });

  const r = cap.capacityReport({ days: 7 });
  assert.deepEqual([r.roster.active, r.roster.working], [2, 1]);
  assert.equal(r.actions.successPct, 50);
  assert.deepEqual(r.actions.gates, { plan: 1 });
  assert.deepEqual(r.ventures.map((x) => [x.title, x.used, x.allowed, x.pct]), [['Happy Company', 1, 4, 25]]);
  assert.equal(r.budget.cap, 10);
  assert.equal(r.cycles.ran, 0);

  const text = cap.describeCapacity(r);
  assert.match(text, /• Agents in use: 2 of \d+ active/);
  assert.match(text, /• Commit allowance used this week: Happy Company 1\/4 \(25%\)/);
  assert.match(text, /• Model budget used: 0% \(average \$0\.00 a day of \$10\.00\)/);
  assert.match(text, /To use more of it:\n1\. The daily meeting ran on 0 of 7 days/);
  assert.match(text, /waited on the daily plan\. Send PLAN and APPROVE earlier/);
  assert.match(text, /Happy Company used 1 of 4 commits this week and has nothing queued/);
  assert.match(text, /agents were never asked\. Ask the Agent Operations Engineer/);
});

test('every recommendation names a command or a setting the founder can act on', () => {
  const r = {
    days: 7,
    roster: { total: 32, active: 3, working: 1, activePct: 9, workingPct: 3, idle: Array.from({ length: 29 }, (_, i) => `a${i}`) },
    actions: { done: 10, refused: 12, successPct: 45, gates: { plan: 5, cap: 4, spend: 3 } },
    concentration: { agentId: 'forge_engineer', share: 90 },
    ventures: [
      { id: 'v_a', title: 'A', enabled: true, used: 20, allowed: 20, pct: 100, openTasks: 3 },
      { id: 'v_b', title: 'B', enabled: false, used: 0, allowed: 20, pct: 0, openTasks: 0 },
    ],
    budget: { cap: 5, avgPerDay: 4.9, pct: 98 },
    cycles: { ran: 7, days: 7 },
    tasks: { done: 2, failed: 1, open: 3 },
  };
  const recs = cap.recommendations(r);
  assert.ok(recs.length <= 6);
  for (const rec of recs) assert.match(rec, /\b(PLAN|APPROVE|CAPS|DEPLOY ON|MODE ECO|DAILY_SPEND_CAP_USD|BUILD|READY|RESUME|LINK|OUTREACH|INTEGRATIONS|AGENT|REPORT|Agent Operations Engineer|manager|objective)\b/, rec);
  assert.match(recs[0], /waited on the daily plan/, 'the biggest gate first');
  assert.ok(recs.some((x) => /A used its whole allowance \(20 of 20/.test(x)));
  assert.ok(recs.some((x) => /B has a repo but deployments are off.*DEPLOY ON v_b/.test(x)));
  assert.ok(recs.some((x) => /98% used on average\. MODE ECO/.test(x)));
});

test('when everything is used and nothing is stuck, it says so rather than inventing advice', () => {
  const r = {
    days: 7,
    roster: { total: 4, active: 4, working: 3, activePct: 100, workingPct: 75, idle: [] },
    actions: { done: 20, refused: 0, successPct: 100, gates: {} },
    concentration: { agentId: 'x', share: 40 },
    ventures: [{ id: 'v', title: 'V', enabled: true, used: 10, allowed: 20, pct: 50, openTasks: 2 }],
    budget: { cap: 5, avgPerDay: 3, pct: 60 },
    cycles: { ran: 7, days: 7 },
    tasks: { done: 9, failed: 0, open: 2 },
  };
  assert.deepEqual(cap.recommendations(r), []);
  assert.match(cap.describeCapacity(r), /Nothing to change: capacity is being used and nothing is stuck\./);
});

test('CAPACITY and KPI from WhatsApp; AGENTS carries the same block', async () => {
  assert.deepEqual(commands.parseFounderCommand('CAPACITY'), { kind: 'capacity', days: 7 });
  assert.deepEqual(commands.parseFounderCommand('kpis 14'), { kind: 'capacity', days: 14 });
  assert.equal(commands.parseFounderCommand('capacity is fine this week'), null);
  const reply = await commands.runFounderCommand({ kind: 'capacity', days: 7 });
  assert.match(reply, /^KPIs, last 7 days:/);
  assert.doesNotMatch(reply, /Did real work/, 'CAPACITY is the KPIs alone');
  assert.match(await commands.runFounderCommand({ kind: 'agents', days: 7 }), /KPIs, last 7 days:/);
  assert.match(commands.__helpForTests, /CAPACITY \[days\]/);
});
