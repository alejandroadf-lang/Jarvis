// Work sessions: the team working between meetings without being asked.
//
// What this pins is the difference between a console and a company. The daily
// meeting used to be framed as a status meeting whose report ended in
// "Recommended Actions for the Founder", and nothing ran between meetings, so
// work only began when the founder sent a message. A session's only output is
// work, it goes to the venture the founder's split is furthest behind on, and
// it stops itself rather than spend the budget retrying a wall.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ws;
let ventures;
let activity;
let halt;
let dm;
let spend;
const saved = {
  perDay: process.env.WORK_SESSIONS_PER_DAY,
  cap: process.env.DAILY_SPEND_CAP_USD,
  realOff: process.env.REAL_ACTIONS_DISABLED,
};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-worksession-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  ws = await import('../workSession.js');
  ventures = await import('../finance/ventures.js');
  activity = await import('../activityLog.js');
  halt = await import('../killSwitch.js');
  dm = await import('../dailyMeeting.js');
  spend = await import('../spend.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const [key, value] of [['WORK_SESSIONS_PER_DAY', saved.perDay], ['DAILY_SPEND_CAP_USD', saved.cap], ['REAL_ACTIONS_DISABLED', saved.realOff]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true });
  delete process.env.WORK_SESSIONS_PER_DAY;
  process.env.DAILY_SPEND_CAP_USD = '50';
});

function venture(title, { writes = true } = {}) {
  const v = ventures.createVenture({ title, oneLiner: 'x', proposedBy: 'founder' });
  if (writes) {
    ventures.linkRepo(v.id, { owner: 'acme', name: title.toLowerCase().replace(/\W/g, ''), allowedPaths: ['src/'] });
    ventures.setDeploymentEnabled(v.id, true);
  }
  return v;
}

const work = (ventureId, tool = 'open_pull_request', at) =>
  activity.recordActivity({ agentId: 'forge_engineer', kind: 'action', tool, ok: true, ventureId }, at);

function scripted(responses, seen = []) {
  let i = 0;
  return {
    messages: {
      create: async (params) => {
        seen.push(params);
        if (i >= responses.length) throw new Error(`scripted client ran out at call ${i}`);
        return responses[i++];
      },
    },
  };
}
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }], usage: { input_tokens: 5, output_tokens: 5 } });

test('the kickoff asks for work, not a report, and never for the founder to decide what to work on', () => {
  const v = venture('Happy Company');
  const kick = ws.workSessionKickoff(v);
  assert.match(kick, /This is a work session, not a meeting/);
  assert.match(kick, /Its only output is work done/);
  assert.match(kick, /next_task/);
  assert.match(kick, /open_pull_request/);
  assert.match(kick, /Do not stop to ask what to work on: pick/);
  assert.doesNotMatch(kick, /recommendations? for the founder/i);
});

test('the daily meeting starts work instead of handing the founder a list', async () => {
  // The old kickoff said "make recommendations for the founder to act on
  // afterward" and ended the report with "Recommended Actions for the Founder".
  venture('Happy Company');
  const seen = [];
  await dm.runDailyMeeting({ anthropic: scripted([text('ok'), text('ok'), text('ok'), text('ok')], seen) }).catch(() => {});
  const kickoff = seen.map((p) => JSON.stringify(p.messages)).find((m) => /daily leadership sync|morning sync/.test(m)) || '';
  assert.ok(kickoff, 'the meeting reached the model');
  assert.doesNotMatch(kickoff, /Recommended Actions for the Founder/);
  assert.doesNotMatch(kickoff, /make recommendations for the founder/);
  assert.match(kickoff, /Work Started Today|set one now with set_objective/);
});

test('the venture furthest behind the founder\'s split is the one worked on', () => {
  const a = venture('Alpha');
  const b = venture('Beta');
  ventures.setFocus({ [a.id]: 50, [b.id]: 50 });
  // Alpha took all the work today: Beta is owed the next session.
  for (let i = 0; i < 4; i++) work(a.id);
  assert.equal(ws.pickVenture().id, b.id);
  // Beta catches up past its share: back to Alpha.
  for (let i = 0; i < 9; i++) work(b.id);
  assert.equal(ws.pickVenture().id, a.id);
});

test('with no split every venture is owed an equal share, and one that is untouched comes first', () => {
  const a = venture('Alpha');
  const b = venture('Beta');
  work(a.id);
  assert.equal(ws.pickVenture().id, b.id);
  assert.notEqual(a.id, b.id);
});

test('a venture without a repo and writes on cannot be worked on, and that is named', () => {
  venture('Idea only', { writes: false });
  assert.equal(ws.pickVenture(), null);
  assert.match(ws.skipReason(), /No active venture has a repo linked with writes on: LINK a repo, then DEPLOY ON/);
});

test('the guards each say what to change', () => {
  venture('Happy Company');
  assert.equal(ws.skipReason(), null, 'clear to run');

  process.env.WORK_SESSIONS_PER_DAY = '0';
  assert.match(ws.skipReason(), /WORK_SESSIONS_PER_DAY is 0: set it to 1 or more/);
  delete process.env.WORK_SESSIONS_PER_DAY;

  halt.haltRealActions('test');
  assert.match(ws.skipReason(), /halted: RESUME lifts it/);
  halt.resumeRealActions();

  process.env.DAILY_SPEND_CAP_USD = '0.5';
  assert.equal(ws.skipReason(), null, 'under the cap');
  spend.recordSpend(1);
  assert.match(ws.skipReason(), /daily model spend cap is reached: DAILY_SPEND_CAP_USD raises it/);
});

test('a session that ran produces a record, and the per-day limit is honoured', async () => {
  venture('Happy Company');
  process.env.WORK_SESSIONS_PER_DAY = '1';
  const before = Date.now();
  const result = await ws.runWorkSession({ anthropic: scripted([text('Nothing to do.')]) });
  assert.equal(result.ran, true);
  assert.equal(result.productive, false, 'a session that changed nothing is not productive');
  assert.ok(Date.parse(ws.listWorkSessions()[0].at) >= before - 1000);
  const again = await ws.runWorkSession({ anthropic: scripted([text('x')]) });
  assert.equal(again.ran, false);
  assert.match(again.reason, /Already ran 1 of 1 work sessions today/);
});

test('a failing session is recorded and does not throw', async () => {
  venture('Happy Company');
  const failing = { messages: { create: async () => { throw new Error('provider down'); } } };
  const result = await ws.runWorkSession({ anthropic: failing });
  assert.equal(result.ran, true);
  assert.equal(result.productive, false);
  assert.match(result.error, /provider down|Could not|failed/i);
});

test('two idle sessions in a row stop the loop until the next daily meeting', () => {
  venture('Happy Company');
  const day = (h) => new Date(`2026-09-30T${h}:00:00Z`);
  const idle = (at) => ({ at: at.toISOString(), ventureId: 'x', productive: false, work: 0, error: null });
  fs.writeFileSync(path.join(tmpDir, 'workSessions.json'), JSON.stringify({ entries: [idle(day('05')), idle(day('09'))] }));
  process.env.WORK_SESSIONS_PER_DAY = '5';
  const reason = ws.skipReason({ now: day('13') });
  assert.match(reason, /produced nothing, so they wait for the next daily meeting/);

  // A meeting after the last session gives them something new: they may run.
  fs.mkdirSync(path.join(tmpDir), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'dailyReports.json'), JSON.stringify({ reports: [{ date: '2026-10-01', generatedAt: '2026-10-01T01:00:00Z', text: 'r' }] }));
  assert.equal(ws.skipReason({ now: new Date('2026-10-01T05:00:00Z') }), null);
});

test('the slots are four hours apart after the meeting, and none when sessions are off', () => {
  const at = (iso, n) => ws.nextSlotUTC(new Date(iso), n)?.toISOString();
  assert.equal(at('2026-09-30T00:00:00Z', 2), '2026-09-30T05:00:00.000Z');
  assert.equal(at('2026-09-30T05:00:00Z', 2), '2026-09-30T09:00:00.000Z', 'a slot that is now belongs to now');
  assert.equal(at('2026-09-30T09:00:00Z', 2), '2026-10-01T05:00:00.000Z');
  assert.equal(at('2026-09-30T00:00:00Z', 0), undefined);
  process.env.WORK_SESSIONS_PER_DAY = '99';
  assert.equal(ws.workSessionsPerDay(), 5, 'capped');
});

test('a session runs with the same handlers as the meeting, so no gate is loosened', () => {
  const handlers = Object.keys(dm.dailyCycleActionHandlers());
  for (const tool of ['open_pull_request', 'queue_work', 'next_task', 'set_objective', 'run_checks']) {
    assert.ok(handlers.includes(tool), `${tool} is available to a session`);
  }
  for (const barred of ['log_revenue', 'kill_venture', 'link_venture_repo']) {
    assert.ok(!handlers.includes(barred), `${barred} stays barred unattended`);
  }
});

test('a session is limited to one a day by default, with a dollar budget of its own', () => {
  assert.equal(ws.workSessionsPerDay(), 1, 'the default was 2, chosen without a budget conversation');
  assert.equal(ws.workSessionBudgetUsd(), 1);
  process.env.WORK_SESSION_BUDGET_USD = '2.5';
  assert.equal(ws.workSessionBudgetUsd(), 2.5);
  process.env.WORK_SESSION_BUDGET_USD = '-3';
  assert.equal(ws.workSessionBudgetUsd(), 1, 'nonsense falls back rather than removing the ceiling');
  delete process.env.WORK_SESSION_BUDGET_USD;
});
