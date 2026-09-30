// The consultant starts corrections on its own, so the bounds are the test.
// Pinned: the tool set is an allowlist with no way to merge, deploy, send, revert
// or change a price; candidates come from our own rubric labels (nothing from a
// competitor's page reaches them); a correction is not retried for a week and is
// given up on after three tries; the guards (kill switch, spend cap, the
// founder's OFF, the environment) stop it; outcomes are recorded from the record
// of what happened, not only from what the session says; and the founder can see
// and switch it from WhatsApp.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let af;
let ventures;
let store;
let commands;
let halt;
const ENV = ['CONSULTANT_AUTOFIX_DISABLED', 'CONSULTANT_AUTOFIX_PER_DAY', 'CONSULTANT_AUTOFIX_BUDGET_USD', 'DAILY_SPEND_CAP_USD'];
const saved = {};
let a;
let b;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-autofix-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of ENV) saved[k] = process.env[k];
  af = await import('../consultant/autofix.js');
  ventures = await import('../finance/ventures.js');
  store = await import('../store.js');
  commands = await import('../channels/founderCommands.js');
  halt = await import('../killSwitch.js');
  a = ventures.createVenture({ title: 'Alpha API', oneLiner: 'x', proposedBy: 'venture_partner' });
  ventures.linkRepo(a.id, { owner: 'me', name: 'alpha', allowedPaths: ['src/'] });
  b = ventures.createVenture({ title: 'Beta App', oneLiner: 'y', proposedBy: 'venture_partner' });
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  store.writeJson('consultant-fixes.json', { enabled: true, lastRunDate: null, runs: [], attempts: {} });
  halt.resumeRealActions();
});

const NOW = new Date('2026-10-10T03:00:00Z');
const card = (over = {}) => ({
  ventures: [
    { id: a.id, title: 'Alpha API', reached: 3, next: { key: 'used', label: 'People are using it', evidence: 'E4' } },
    { id: b.id, title: 'Beta App', reached: 0, next: { key: 'price', label: 'A price is set', evidence: 'E9' } },
  ],
  ...over,
});
const okItem = (got) => ({ got });
const bench = () => ({
  ventures: [{
    id: a.id,
    own: { probe: { ok: true }, scores: { quality: { items: [{ label: 'Public documentation', got: false }, { label: 'Forces https (HSTS)', got: false }, { label: 'A machine-readable API description (OpenAPI)', got: false }] }, innovation: { items: [{ label: 'Publishes llms.txt, so AI agents can read the site', got: false }, { label: 'Offers or documents an MCP server for AI agents', got: false }] } } },
    competitors: [{ probe: { ok: true }, scores: { quality: { score: 9, items: [{ label: 'Public documentation', got: true }, { label: 'Forces https (HSTS)', got: true }, { label: 'A machine-readable API description (OpenAPI)', got: true }] }, innovation: { score: 6, items: [{ label: 'Publishes llms.txt, so AI agents can read the site', got: true }, { label: 'Offers or documents an MCP server for AI agents', got: true }] } } }],
  }],
});

test('the correction session is given an allowlist with no way to merge, deploy, send, revert or reprice', () => {
  const names = Object.keys(af.autofixHandlers());
  assert.deepEqual(names.sort(), [...af.AUTOFIX_TOOLS].sort(), 'every allowlisted tool is wired');
  for (const forbidden of ['deploy_code', 'deploy_changes', 'revert_commit', 'send_customer_email', 'create_payment_link', 'submit_daily_plan', 'log_revenue', 'log_expense', 'link_venture_repo', 'kill_venture', 'run_checks']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not be available`);
  }
  assert.ok(names.includes('open_pull_request') && names.includes('draft_customer_email'));
});

test('candidates come from our rubric labels, the ladder and the repo checklist, with a decision where no repo is linked', () => {
  const engineering = { repos: [{ owner: 'me', name: 'alpha', checklist: [{ key: 'agentDocs', label: 'CLAUDE.md', present: false }, { key: 'tests', label: 'tests', present: false }, { key: 'ci', label: 'ci', present: true }] }] };
  const c = af.buildCandidates({ scorecard: card(), benchmark: bench(), engineering });
  const keys = c.map((x) => x.key);

  assert.equal(c[0].key, `ladder:${a.id}:used`, 'the venture closest to the goal comes first, at its next rung');
  for (const k of ['docs', 'headers', 'openapi', 'llms', 'mcp']) assert.ok(keys.includes(`bench:${a.id}:${k}`), k);
  // Alpha's repo link allows only src/, so a root CLAUDE.md would be refused: it becomes one request to widen the scope.
  assert.ok(!keys.includes(`repo:${a.id}:agentDocs`), 'a pull request the scope would refuse is not started');
  const widen = c.find((x) => x.key === `decision:${a.id}:paths:CLAUDE.md`);
  assert.equal(widen.kind, 'decision');
  assert.match(widen.instruction, new RegExp(`LINK ${a.id} me/alpha src/ CLAUDE\\.md`));
  assert.ok(keys.includes(`repo:${a.id}:tests`));
  assert.ok(!keys.includes(`repo:${a.id}:ci`), 'what is present is not a gap');
  assert.equal(c.find((x) => x.key === `bench:${a.id}:mcp`).kind, 'task', 'an MCP server is scoped, not built blind');
  assert.equal(c.find((x) => x.key === `ladder:${b.id}:price`).kind, 'decision', 'a price is the founder\'s');
  assert.ok(c.every((x) => !/https?:\/\//.test(x.instruction)), 'no URL from the outside reaches an instruction');

  // A venture with no linked repo cannot receive a pull request: it becomes a request to link one.
  const noRepo = af.buildCandidates({ scorecard: { ventures: [{ id: b.id, title: 'Beta App', reached: 1, next: { key: 'product', label: 'x', evidence: 'E1' } }] }, benchmark: null, engineering: null });
  assert.deepEqual(noRepo.map((x) => x.kind), ['task']);
  const viaBench = af.buildCandidates({ scorecard: { ventures: [{ id: b.id, title: 'Beta App', reached: 1, next: null }] }, benchmark: { ventures: [{ id: b.id, own: bench().ventures[0].own, competitors: bench().ventures[0].competitors }] }, engineering: null });
  assert.equal(viaBench.filter((x) => x.kind === 'decision' && /link-repo/.test(x.key)).length, 1, 'one request to link a repo, not one per gap');
});

test('a correction is not retried within a week, is given up on after three tries, and the day has a limit', () => {
  const c = af.buildCandidates({ scorecard: card(), benchmark: bench(), engineering: null });
  const first = af.selectCandidates(c, { now: NOW, attempts: {}, limit: 3 });
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((x) => x.id), ['F1', 'F2', 'F3']);

  const attempts = Object.fromEntries(first.map((x) => [x.key, { count: 1, last: NOW.toISOString() }]));
  const tomorrow = af.selectCandidates(c, { now: new Date(NOW.getTime() + 86_400_000), attempts, limit: 3 });
  assert.ok(tomorrow.every((x) => !first.some((f) => f.key === x.key)), 'not tried again the next day');
  const nextWeek = af.selectCandidates(c, { now: new Date(NOW.getTime() + 8 * 86_400_000), attempts, limit: 3 });
  assert.ok(nextWeek.some((x) => x.key === first[0].key), 'tried again after a week');

  const gaveUp = { [first[0].key]: { count: 3, last: '2026-01-01T00:00:00Z' } };
  assert.ok(!af.selectCandidates(c, { now: NOW, attempts: gaveUp, limit: 20 }).some((x) => x.key === first[0].key), 'given up on after three tries');
});

test('a run gives the session the constraints and only the allowlisted tools, and records outcomes from what actually happened', async () => {
  const selected = af.selectCandidates(af.buildCandidates({ scorecard: card(), benchmark: bench(), engineering: null }), { now: NOW, attempts: {}, limit: 2 });
  let seen;
  const run = async (args) => {
    seen = args;
    // The session opens one pull request, for real, through the same recorder the handler uses.
    ventures.recordPullRequest(a.id, { number: 7, url: 'https://github.com/me/alpha/pull/7', title: 'Report usage', branch: 'agents/x', paths: ['src/x.py'], triggeredBy: 'daily_cycle', agentId: 'cto' });
    return { text: `Done.\nF1: done — https://github.com/me/alpha/pull/7\nF2: asked — a decision to set the price is in the inbox`, usage: { costUsd: 0.42 } };
  };
  const out = await af.runAutofix({ selected, now: NOW, run });

  assert.equal(out.ran, true);
  assert.equal(seen.agentId, 'ceo');
  assert.deepEqual(Object.keys(seen.actionHandlers).sort(), [...af.AUTOFIX_TOOLS].sort());
  assert.equal(seen.budgetUsd, 1);
  assert.match(seen.messages[0].content, /You may not, and cannot: commit to a main branch, deploy, revert, send an email/);
  assert.match(seen.messages[0].content, /never merge/);
  assert.match(seen.messages[0].content, /F1\. \[/);

  assert.deepEqual(out.outcomes.map((o) => [o.id, o.status]), [['F1', 'done'], ['F2', 'asked']]);
  assert.deepEqual(out.prs, [{ venture: 'Alpha API', url: 'https://github.com/me/alpha/pull/7', title: 'Report usage' }], 'the pull request comes from the record, not from the session\'s words');
  assert.equal(out.usd, 0.42);

  const state = store.readJson('consultant-fixes.json', null);
  assert.equal(state.lastRunDate, '2026-10-10');
  assert.equal(state.attempts[selected[0].key].count, 1);
  assert.equal((await af.runAutofix({ selected, now: NOW, run })).reason, 'corrections already ran today');
  assert.equal((await af.runAutofix({ selected, now: NOW, run, force: true })).ran, true);
  assert.equal(af.lastFixRun().date, '2026-10-10');
});

test('a session that fails or says nothing is recorded as blocked or unknown, never as done', async () => {
  const selected = af.selectCandidates(af.buildCandidates({ scorecard: card(), benchmark: null, engineering: null }), { now: NOW, attempts: {}, limit: 2 });
  const failed = await af.runAutofix({ selected, now: NOW, run: async () => { throw new Error('the API is down'); }, force: true });
  assert.ok(failed.outcomes.every((o) => o.status === 'blocked' && /the API is down/.test(o.note)));
  const silent = await af.runAutofix({ selected, now: NOW, run: async () => ({ text: 'I did some things.' }), force: true });
  assert.ok(silent.outcomes.every((o) => o.status === 'unknown'));
});

test('the founder\'s OFF, the environment, the kill switch, the spend cap and an empty day all stop it', async () => {
  const selected = af.selectCandidates(af.buildCandidates({ scorecard: card(), benchmark: null, engineering: null }), { now: NOW, attempts: {}, limit: 2 });
  const never = async () => { throw new Error('must not run'); };

  af.setAutofix(false);
  assert.match((await af.runAutofix({ selected, now: NOW, run: never })).reason, /automatic corrections are off/);
  af.setAutofix(true);

  process.env.CONSULTANT_AUTOFIX_DISABLED = 'true';
  assert.match((await af.runAutofix({ selected, now: NOW, run: never })).reason, /CONSULTANT_AUTOFIX_DISABLED/);
  delete process.env.CONSULTANT_AUTOFIX_DISABLED;

  process.env.CONSULTANT_AUTOFIX_PER_DAY = '0';
  assert.equal(af.autofixOn(), false);
  delete process.env.CONSULTANT_AUTOFIX_PER_DAY;

  halt.haltRealActions('test');
  assert.match((await af.runAutofix({ selected, now: NOW, run: never })).reason, /real actions are halted/);
  halt.resumeRealActions();

  process.env.DAILY_SPEND_CAP_USD = '0.0001';
  (await import('../spend.js')).recordSpend(1);
  assert.match((await af.runAutofix({ selected, now: NOW, run: never })).reason, /spend cap/);
  delete process.env.DAILY_SPEND_CAP_USD;

  assert.match((await af.runAutofix({ selected: [], now: NOW, run: never })).reason, /nothing new to correct/);
});

test('AUTOFIX from WhatsApp shows the state, switches it, and is in the help', async () => {
  assert.equal(commands.parseFounderCommand('autofix').kind, 'autofix');
  assert.equal(commands.parseFounderCommand('AUTOFIX off').mode, 'off');
  assert.equal(commands.parseFounderCommand('autofix the login page'), null, 'a sentence is not a command');
  assert.match(commands.__helpForTests, /AUTOFIX \[ON\|OFF\|STATUS\]/);

  const off = await commands.runFounderCommand({ kind: 'autofix', mode: 'off' });
  assert.match(off, /switched OFF/);
  assert.match(off, /Automatic corrections are OFF/);
  assert.equal(af.autofixOn(), false);
  const on = await commands.runFounderCommand({ kind: 'autofix', mode: 'on' });
  assert.match(on, /switched ON/);
  const status = await commands.runFounderCommand({ kind: 'autofix' });
  assert.match(status, /Automatic corrections are ON: up to 3 a day, \$1 a day at most\./);
  assert.match(status, /It cannot merge, deploy, send, revert, change a price or spend money/);
});

test('the email section says what starts, what the last run did, and the limits', () => {
  const planned = [{ id: 'F1', kind: 'pr', title: 'Alpha API: Public documentation', why: 'a competitor has it' }];
  const last = { date: '2026-10-09', outcomes: [{ id: 'F1', status: 'done', title: 'x', note: 'https://github.com/me/alpha/pull/7' }, { id: 'F2', status: 'blocked', title: 'y', note: 'no repo is linked' }], prs: [{ venture: 'Alpha API', title: 'Report usage', url: 'https://github.com/me/alpha/pull/7' }], usd: 0.42 };
  const text = af.renderFixes({ planned, last, on: true });
  assert.match(text, /What the last run \(2026-10-09\) did:/);
  assert.match(text, /F1  DONE/);
  assert.match(text, /F2  BLOCKED/);
  assert.match(text, /Pull requests opened \(never merged; you or CI decide\)/);
  assert.match(text, /Starting now, after this email/);
  assert.match(text, /F1  \[pr\]  Alpha API: Public documentation/);
  assert.match(text, /pull requests only, never merged; no deploys, reverts, sent email, price changes or spending/);
  assert.match(af.renderFixes({ planned: [], last: null, on: false }), /Automatic corrections are OFF/);
  assert.match(af.renderFixes({ planned: [], last: null, on: true }), /Nothing new to correct today/);
});

test('closing lines are read from the whole reply, so a long reply does not lose them; bullets and bold are read too', () => {
  const selected = [{ id: 'F1', key: 'k1', title: 'One', kind: 'pr' }, { id: 'F2', key: 'k2', title: 'Two', kind: 'pr' }, { id: 'F3', key: 'k3', title: 'Three', kind: 'task' }];
  const long = `${'I looked at the repository and delegated the work to the CTO. '.repeat(60)}\n- **F1:** done — https://github.com/me/alpha/pull/9\n* F2: asked — filed a decision to widen the scope\nF3: blocked — no usage endpoint exists`;
  assert.ok(long.length > 1500, 'longer than the old cut');
  const out = af.parseOutcomes(long, selected);
  assert.deepEqual(out.map((o) => o.status), ['done', 'asked', 'blocked']);
  assert.equal(out[0].note, 'https://github.com/me/alpha/pull/9');
  assert.equal(af.parseOutcomes('nothing useful', selected)[0].status, 'unknown');
});

test('a run that reports nothing still shows what the activity log says it did, and the end of what it said', () => {
  const last = {
    date: '2026-10-10',
    outcomes: [{ id: 'F1', status: 'unknown', title: 'CircadianAPI: X', note: 'the session did not report on this one' }],
    prs: [],
    actions: { open_pull_request: { ok: 0, refused: 2 }, check_usage: { ok: 1, refused: 0 } },
    summary: 'I asked the CTO and it said the path is outside the allowed scope.',
    usd: 0.127,
  };
  const text = af.renderFixes({ planned: [], last, on: true });
  assert.match(text, /What the session did, from the activity log: open_pull_request 0 done, 2 refused; check_usage 1 done\./);
  assert.match(text, /It gave no closing line for some corrections\. The end of what it said:\n    \| I asked the CTO/);
  const none = af.renderFixes({ planned: [], last: { ...last, actions: {}, outcomes: [{ id: 'F1', status: 'done', title: 't', note: 'n' }] }, on: true });
  assert.match(none, /The activity log shows the session took no action with any tool\./);
});
