// How much of the company's capacity is actually used, and what would use more.
//
// "Capacity" here is four things the founder already pays for or grants, each
// measured against its own ceiling, never blended into one flattering number:
//
//   - the roster: how many of the agents did anything, and how many did real
//     work (an action that succeeded, not only advice);
//   - the commit allowance each linked venture was given with CAPS, read with
//     the same arithmetic the deploy gate and READY use (rateLimitState);
//   - the daily model budget (DAILY_SPEND_CAP_USD) against what was spent;
//   - the daily cycle: on how many days of the window it actually ran.
//
// Plus two that say whether the capacity that was used turned into work:
// the share of actions that got past their gates, and queued tasks finished.
//
// Recommendations are rules over those numbers, each naming the command that
// acts on it. They are advice for the founder, not something any agent reads:
// a team told "use more budget" is a team given a reason to spend it.

import { agentPerformance, listActivity, activitySince } from './activityLog.js';
import { listVentures, rateLimitState, getFocus } from './finance/ventures.js';
import { spendByDay, dailyCapUsd } from './spend.js';
import { listDailyReports } from './dailyReports.js';
import { listTasks } from './tasks.js';
import { AGENTS as COMPANY_AGENTS } from './agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS } from './agents/ideationTeam.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

// What each refusal category means to the founder, and the command that opens it.
const GATE_ADVICE = {
  plan: (n) => `${n} action${n === 1 ? '' : 's'} waited on the daily plan. Send PLAN and APPROVE earlier, or ask the team for a plan that covers the work.`,
  cap: (n) => `${n} action${n === 1 ? '' : 's'} hit a commit cap. If the work you are merging is good, raise it: CAPS <ventureId> <per day> <per week>.`,
  cooldown: (n) => `${n} action${n === 1 ? '' : 's'} fired within a minute of the previous one. Usually a loop in one turn; check AGENT <id> for who.`,
  halt: (n) => `${n} action${n === 1 ? '' : 's'} met the halt. RESUME when you are ready.`,
  spend: (n) => `${n} action${n === 1 ? '' : 's'} met the daily budget cap. Raise DAILY_SPEND_CAP_USD in Railway, or MODE ECO to stretch it.`,
  scope: (n) => `${n} action${n === 1 ? '' : 's'} tried to write outside the allowed paths. Widen them with LINK if that work was right.`,
  repo: (n) => `${n} action${n === 1 ? '' : 's'} needed a repo or deployments turned on. LINK <ventureId> <owner/repo> <paths> or DEPLOY ON <ventureId>.`,
  outreach: (n) => `${n} outreach action${n === 1 ? '' : 's'} had no scope. OUTREACH <ventureId> <emails or @domains> if you want them to reach people.`,
  config: (n) => `${n} action${n === 1 ? '' : 's'} needed a key the server does not have. INTEGRATIONS shows which.`,
  other: (n) => `${n} action${n === 1 ? '' : 's'} failed for other reasons. AGENT <id> shows who.`,
};

/** Every figure the KPI block and the recommendations are built from. */
export function capacityReport({ days = 7, now = new Date() } = {}) {
  const roster = Object.keys({ ...STUDIO_AGENTS, ...COMPANY_AGENTS }).length;
  const perf = agentPerformance({ days, now });
  const active = perf.agents.length;
  const working = perf.agents.filter((a) => a.done > 0).length;
  const done = perf.agents.reduce((n, a) => n + a.done, 0);
  const refused = perf.agents.reduce((n, a) => n + a.refused, 0);

  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const gates = {};
  const byVenture = {};
  for (const e of listActivity({ since })) {
    if (e.kind === 'action' && !e.ok) gates[e.gate || 'other'] = (gates[e.gate || 'other'] || 0) + 1;
    if (e.kind === 'action' && e.ok && e.ventureId) byVenture[e.ventureId] = (byVenture[e.ventureId] || 0) + 1;
  }
  // Where the work went against the founder's split (FOCUS): actions that
  // succeeded, by the venture they named.
  const ventureActions = Object.values(byVenture).reduce((a, b) => a + b, 0);
  const focus = getFocus().map((f) => ({ ...f, actual: pct(byVenture[f.id] || 0, ventureActions) }));

  // Agent figures cover only the time the activity log has existed.
  const started = activitySince();
  const coveredDays = started ? Math.min(days, Math.max(1, Math.ceil((now.getTime() - Date.parse(started)) / DAY_MS))) : 0;
  const activity = { since: started, coveredDays, partial: coveredDays < days };

  // Busiest agent's share of all successful actions: one name doing most of
  // the work is a bottleneck, and a single point of failure.
  const busiest = [...perf.agents].sort((a, b) => b.done - a.done)[0];
  const concentration = done >= 5 && busiest ? { agentId: busiest.agentId, share: pct(busiest.done, done) } : null;

  const ventures = listVentures()
    .filter((v) => v.status === 'active' && v.repo)
    .map((v) => {
      const state = rateLimitState({ entries: v.deployments || [], timestampKey: 'deployedAt', scope: v.repo });
      const open = listTasks({ ventureId: v.id, limit: 100000 }).filter((t) => t.status === 'queued' || t.status === 'running').length;
      return { id: v.id, title: v.title, enabled: Boolean(v.repo.enabled), used: state.inWeek, allowed: state.maxPerWeek, pct: pct(state.inWeek, state.maxPerWeek), openTasks: open };
    });

  const cap = dailyCapUsd();
  const spent = Object.values(spendByDay(days, now)).reduce((a, b) => a + b, 0);
  const budget = { cap, avgPerDay: spent / days, pct: pct(spent / days, cap) };

  const firstDay = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const cyclesRan = listDailyReports().filter((r) => r.date >= firstDay).length;

  const tasks = listTasks({ limit: 100000 });
  const tasksDone = tasks.filter((t) => t.status === 'done').length;
  const tasksFailed = tasks.filter((t) => t.status === 'failed').length;

  const activeVentures = listVentures().filter((v) => v.status === 'active').length;

  return {
    days,
    activity,
    focus,
    ventureActions,
    activeVentures,
    roster: { total: roster, active, working, activePct: pct(active, roster), workingPct: pct(working, roster), idle: perf.idle },
    actions: { done, refused, successPct: pct(done, done + refused), gates },
    concentration,
    ventures,
    budget,
    cycles: { ran: Math.min(cyclesRan, days), days },
    tasks: { done: tasksDone, failed: tasksFailed, open: tasks.filter((t) => t.status === 'queued' || t.status === 'running').length },
  };
}

/** Rules over the report, most important first, each naming the command that acts on it. */
export function recommendations(r) {
  const out = [];
  const missed = r.cycles.days - r.cycles.ran;
  if (missed >= 2) out.push(`The daily meeting ran on ${r.cycles.ran} of ${r.cycles.days} days. Nothing happens on a day it does not run: check Railway is up and REPORT for the last one.`);

  const gates = Object.entries(r.actions.gates).sort((a, b) => b[1] - a[1]);
  for (const [gate, n] of gates.slice(0, 2)) out.push(GATE_ADVICE[gate] ? GATE_ADVICE[gate](n) : GATE_ADVICE.other(n));

  for (const v of r.ventures) {
    if (!v.enabled) out.push(`${v.title} has a repo but deployments are off, so its allowance is unused. DEPLOY ON ${v.id} when you want it built.`);
    else if (v.allowed > 0 && v.used >= v.allowed) out.push(`${v.title} used its whole allowance (${v.used} of ${v.allowed} this week). If you are merging what it ships, raise it: CAPS ${v.id} <per day> <per week>.`);
    else if (v.pct !== null && v.pct < 30) {
      out.push(
        v.openTasks
          ? `${v.title} used ${v.used} of ${v.allowed} commits this week with ${v.openTasks} task${v.openTasks === 1 ? '' : 's'} open: the work is planned but not moving. READY ${v.id} says what is stopping it.`
          : `${v.title} used ${v.used} of ${v.allowed} commits this week and has nothing queued. Give the team a concrete objective for it, in one message, and it will plan the work.`,
      );
    }
  }

  // Several ventures and no split: the shared context then says "one thing
  // can be the priority at a time", and the team single-tracks one of them.
  if ((r.activeVentures || 0) >= 2 && !(r.focus || []).length) {
    out.push(`${r.activeVentures} ventures are active and no split is set, so the team works on one at a time. FOCUS <ventureId> <share> <ventureId> <share> makes it a multi-venture team.`);
  }
  if ((r.ventureActions || 0) >= 5) {
    for (const f of r.focus || []) {
      if (f.actual !== null && Math.abs(f.actual - f.pct) >= 25) {
        out.push(`${f.title} got ${f.actual}% of the work against your ${f.pct}%. Remind the team in one message, or change the split with FOCUS.`);
      }
    }
  }

  if (r.budget.pct !== null && r.budget.pct >= 90) out.push(`The model budget is ${r.budget.pct}% used on average. MODE ECO moves routine roles to cheaper models; or raise DAILY_SPEND_CAP_USD.`);
  else if (!r.activity?.partial && r.budget.pct !== null && r.budget.pct < 25 && r.roster.workingPct !== null && r.roster.workingPct < 25) {
    out.push(`Only ${r.budget.pct}% of the daily budget is used and few agents do real work: the limit is direction, not money. Give each active venture one measurable objective.`);
  }

  if (r.concentration && r.concentration.share >= 60) out.push(`${r.concentration.agentId} did ${r.concentration.share}% of all real work: a bottleneck and a single point of failure. Ask its manager to spread it.`);

  if (r.tasks.failed) out.push(`${r.tasks.failed} queued task${r.tasks.failed === 1 ? '' : 's'} failed. BUILD <ventureId> shows which and why.`);

  // Not advised on a log younger than the window: an agent absent from
  // three days of records is not an agent nobody asks.
  if (!r.activity?.partial && r.roster.idle.length >= r.roster.total / 2) {
    out.push(`${r.roster.idle.length} of ${r.roster.total} agents were never asked. Ask the Agent Operations Engineer, in one message, which to cut or re-describe: every idle role is one more option every manager weighs on every turn.`);
  }
  return out.slice(0, 6);
}

/** The KPI block and recommendations, as WhatsApp text. */
export function describeCapacity(r) {
  const lines = [`KPIs, last ${r.days} day${r.days === 1 ? '' : 's'}:`];
  if (r.activity?.partial) {
    lines.push(
      r.activity.since
        ? `(Agent and action figures cover only since ${r.activity.since.slice(0, 10)}, when recording began; meeting, budget and queue cover the full ${r.days} days.)`
        : '(No agent activity recorded yet: agent and action figures start with the next turn or daily meeting.)',
    );
  }
  lines.push(`• Agents in use: ${r.roster.active} of ${r.roster.total} active (${r.roster.activePct ?? 0}%), ${r.roster.working} did real work (${r.roster.workingPct ?? 0}%)`);
  lines.push(`• Actions that got through: ${r.actions.successPct === null ? 'none tried' : `${r.actions.successPct}% (${r.actions.done} done, ${r.actions.refused} refused)`}`);
  if (r.ventures.length) {
    lines.push(`• Commit allowance used this week: ${r.ventures.map((v) => `${v.title} ${v.used}/${v.allowed}${v.pct === null ? '' : ` (${v.pct}%)`}${v.enabled ? '' : ' deploy off'}`).join('; ')}`);
  } else lines.push('• Commit allowance: no venture has a repo linked');
  if ((r.focus || []).length) {
    lines.push(`• Work split vs your FOCUS: ${r.focus.map((f) => `${f.title} ${f.actual ?? 0}% (target ${f.pct}%)`).join('; ')}${r.ventureActions ? '' : ' (no venture actions yet)'}`);
  }
  lines.push(`• Model budget used: ${r.budget.pct ?? 0}% (average $${r.budget.avgPerDay.toFixed(2)} a day of $${r.budget.cap.toFixed(2)})`);
  lines.push(`• Daily meeting ran: ${r.cycles.ran} of ${r.cycles.days} days`);
  lines.push(`• Queued work: ${r.tasks.done} done, ${r.tasks.failed} failed, ${r.tasks.open} open`);
  const recs = recommendations(r);
  lines.push('', recs.length ? 'To use more of it:' : 'Nothing to change: capacity is being used and nothing is stuck.');
  recs.forEach((rec, i) => lines.push(`${i + 1}. ${rec}`));
  return lines.join('\n');
}
