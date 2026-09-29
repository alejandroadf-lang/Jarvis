// The founder's AGENTS command, and the log under it.
//
// The profit-share ledger drops every action that earns no credit, so a
// performance view read from it would have called the Forge Engineer idle on
// a day it opened three pull requests. These tests pin the replacement: the
// runner records every consultation and every action, done or refused, and
// the reply sorts agents into real work, refused, advice only, and idle.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let log;
let runAgent;
let commands;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-activity-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  log = await import('../activityLog.js');
  ({ runAgent } = await import('../agents/agentRunner.js'));
  commands = await import('../channels/founderCommands.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => fs.rmSync(path.join(tmpDir, 'activityLog.json'), { force: true }));

const NOW = new Date('2026-09-29T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3);

test('entries older than the keep window are dropped on the next write', () => {
  log.recordActivity({ agentId: 'cto', kind: 'consulted' }, new Date('2026-08-01T00:00:00Z'));
  log.recordActivity({ agentId: 'cto', kind: 'consulted' }, NOW);
  assert.equal(log.listActivity().length, 1);
  assert.equal(log.recordActivity({ kind: 'consulted' }), null, 'no agent, nothing recorded');
});

test('agents are sorted into real work, refused, advice only and idle', () => {
  log.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool: 'open_pull_request', ok: true, ventureId: 'v_1' }, hoursAgo(2));
  log.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool: 'open_pull_request', ok: true, ventureId: 'v_1' }, hoursAgo(3));
  log.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool: 'open_pull_request', ok: false, ventureId: 'v_1' }, hoursAgo(4));
  log.recordActivity({ agentId: 'pilot_manager', kind: 'action', tool: 'draft_customer_email', ok: false }, hoursAgo(5));
  log.recordActivity({ agentId: 'privacy_officer', kind: 'consulted' }, hoursAgo(6));
  log.recordActivity({ agentId: 'ceo', kind: 'led' }, hoursAgo(1));
  log.recordActivity({ agentId: 'cto', kind: 'consulted' }, new Date(NOW.getTime() - 10 * 86400e3)); // outside 7 days

  const perf = log.agentPerformance({ days: 7, now: NOW });
  const forge = perf.agents.find((a) => a.agentId === 'forge_engineer');
  assert.deepEqual([forge.done, forge.refused, forge.ventures], [2, 1, ['v_1']]);
  assert.ok(perf.idle.includes('cto'), 'a consult 10 days ago does not count in a 7-day window');
  assert.ok(perf.idle.includes('health_researcher'));

  const text = log.describePerformance({ days: 7, now: NOW });
  assert.match(text, /Did real work \(1\):\n• Atlassian Forge Engineer \(forge_engineer\): open_pull_request 2 \(\+1 refused\) · 2h ago/);
  assert.match(text, /Tried, but every action was refused:\n• Pilot & Partnerships Manager \(pilot_manager\): draft_customer_email 0 \(\+1 refused\)/);
  assert.match(text, /Advised only \(2\): (ceo 1, privacy_officer 1|privacy_officer 1, ceo 1)/);
  assert.match(text, /2 actions were refused by a gate\. READY <ventureId>/);
  assert.match(log.describePerformance({ days: 30, now: NOW }), /cto/);
});

test('an empty window says the team has not run, rather than listing thirty idle agents', () => {
  assert.match(log.describePerformance({ days: 7, now: NOW }), /0 of \d+ did anything\.\n\nNothing recorded\. The team has not run/);
});

test('one agent in detail, with venture names; an unknown id suggests close ones', () => {
  log.recordActivity({ agentId: 'forge_engineer', kind: 'consulted' }, hoursAgo(3));
  log.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool: 'run_checks', ok: true, ventureId: 'v_1' }, hoursAgo(2));
  const text = log.describeAgent('forge_engineer', { days: 7, now: NOW, ventureTitle: (id) => (id === 'v_1' ? 'Happy Company' : id) });
  assert.match(text, /Consulted 1 time\./);
  assert.match(text, /Actions: 1 done, 0 refused \(run_checks 1\)\./);
  assert.match(text, /Ventures: Happy Company\./);
  assert.match(text, /• 2h ago ✓ run_checks · Happy Company\n• 3h ago consulted/);
  assert.match(log.describeAgent('forge', { now: NOW }), /No agent called "forge"\. Did you mean: forge_engineer\?/);
  assert.match(log.describeAgent('health_researcher', { now: NOW }), /Nothing\. Not consulted, no action tried\./);
});

// The part that makes it true: the runner writes the log, not the agent.
test('a real turn records the lead, the consultation, and each action done or refused', async () => {
  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'T', reportsTo: null, reports: ['helper'], systemPrompt: 'x', actions: [{ name: 'do_it', description: 'd', input_schema: { type: 'object', properties: {} } }] },
    helper: { id: 'helper', title: 'Helper', department: 'T', reportsTo: 'boss', reports: [], toolDescription: 'h', systemPrompt: 'y' },
  };
  const responses = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'consult_helper', input: { task: 'look' } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'helper says hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'do_it', input: { ventureId: 'v_9' } }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'do_it', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  let i = 0;
  const anthropic = { messages: { create: async () => responses[i++] } };
  let calls = 0;
  const actionHandlers = { do_it: async () => (calls++ === 0 ? 'Done.' : 'Could not: the plan does not cover it.') };
  await runAgent({ anthropic, agents, agentId: 'boss', messages: [{ role: 'user', content: 'go' }], actionHandlers });

  const entries = log.listActivity().map((e) => [e.agentId, e.kind, e.tool, e.ok, e.ventureId]);
  assert.deepEqual(entries, [
    ['boss', 'led', null, true, null],
    ['helper', 'consulted', null, true, null],
    ['boss', 'action', 'do_it', true, 'v_9'],
    ['boss', 'action', 'do_it', false, null],
  ]);
});

test('AGENTS and AGENT from WhatsApp: parsed strictly, window capped at what is kept', async () => {
  assert.deepEqual(commands.parseFounderCommand('AGENTS'), { kind: 'agents', days: 7 });
  assert.deepEqual(commands.parseFounderCommand('performance 14'), { kind: 'agents', days: 14 });
  assert.deepEqual(commands.parseFounderCommand('Agent Forge_Engineer'), { kind: 'agent', agentId: 'forge_engineer', days: 7 });
  assert.equal(commands.parseFounderCommand('agents keep asking for more budget'), null);

  log.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool: 'open_pull_request', ok: true });
  const reply = await commands.runFounderCommand({ kind: 'agents', days: 90 });
  assert.match(reply, /forge_engineer/);
  assert.match(reply, /Queued work: \d+ done, \d+ failed, \d+ open\. Model spend today: \$/);
  assert.match(reply, /kept 30 days, so this covers 30/);
  assert.match(await commands.runFounderCommand({ kind: 'agent', agentId: 'forge_engineer', days: 7 }), /Actions: 1 done/);
  assert.match(commands.__helpForTests, /AGENTS \[days\]/);
});
