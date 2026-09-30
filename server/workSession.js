// Work sessions: the agents working between meetings, without being asked.
//
// The company met once a day, at 08:00 Bangkok, and every other hour it waited.
// The meeting itself was framed as "an internal status meeting ... make
// recommendations for the founder to act on afterward", its report ended in
// "Recommended Actions for the Founder", and the plan it submitted waited for
// an APPROVE. So the only way work started was the founder sending a message,
// which is a console with agents behind it, not a company that runs itself.
//
// A work session is the other half: a short, unattended turn whose only output
// is work done. The CTO picks the venture the founder's split (FOCUS) is
// furthest behind on, takes the next queued task, or, if the queue is empty,
// derives one from the venture's objective and queues it, then builds it and
// proposes it as a pull request. Nobody reads a report from it.
//
// What it does NOT do is widen anything. It runs with the same handlers as the
// daily meeting, so every gate still applies exactly as before: the approved
// plan for direct commits, the caps, the outreach allowlist, the halt and the
// daily spend cap. Pull requests need no plan (see authorizePullRequest), which
// is what lets a review-only venture (REVIEW ON) move every day with no
// approval and still land nothing until the founder merges.
//
// Cost is bounded three ways, because this is the first thing here that spends
// money on a timer with nobody watching: a few sessions a day at most
// (WORK_SESSIONS_PER_DAY, 0 turns it off), the daily spend cap checked before
// each one, and a backoff: two sessions in a row that produced no work stop
// the loop until the next daily meeting, so a stuck team does not burn the
// budget retrying the same wall.

import { runAgent } from './agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS } from './agents/orgChart.js';
import { buildCompanyContext, buildPerAgentContext, buildRepoManifests } from './finance/context.js';
import { listVentures, getFocus, REVENUE_GOAL_EUR } from './finance/ventures.js';
import { dailyCycleActionHandlers } from './dailyMeeting.js';
import { isDailyMeetingRunning, TARGET_UTC_HOUR } from './scheduler.js';
import { getKillSwitch } from './killSwitch.js';
import { dailyCapUsd, getSpendToday, withSpendContext } from './spend.js';
import { listActivity } from './activityLog.js';
import { getLatestDailyReport } from './dailyReports.js';
import { readJson, updateJson } from './store.js';
import { readFounderSteering, publishWorkSession } from './workspace/vault.js';

const FILE = 'workSessions.json';
const DAY_MS = 24 * 60 * 60 * 1000;
// One a day by default. Two was chosen without a budget conversation and, with
// the meeting, doubled what the unattended team could spend; raise it once the
// SPEND breakdown shows what one session costs.
const DEFAULT_PER_DAY = 1;
// A session's own ceiling, so one build that keeps reading files cannot eat
// the day's cap. WORK_SESSION_BUDGET_USD overrides it.
const DEFAULT_SESSION_BUDGET_USD = 1;
const MAX_PER_DAY = 5;
// Sessions start this many hours apart, after the daily meeting.
const SLOT_GAP_HOURS = 4;
const STARTUP_LOG = 'Work sessions';

// What counts as work: tools that change something. Reading a file or checking
// the plan is how a turn starts, not how it ends, and a session that only read
// things produced nothing the founder could merge.
export const WORK_TOOLS = new Set([
  'open_pull_request',
  'deploy_code',
  'deploy_changes',
  'complete_task',
  'queue_work',
  'set_objective',
  'draft_customer_email',
  'update_pipeline',
  'run_checks',
  'log_venture_note',
]);

/** Dollars one session may spend: WORK_SESSION_BUDGET_USD, default $1. */
export function workSessionBudgetUsd() {
  const n = Number(process.env.WORK_SESSION_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_BUDGET_USD;
}

let running = false;

export function isWorkSessionRunning() {
  return running;
}

/** Sessions per day: WORK_SESSIONS_PER_DAY, default 1, 0 turns them off, at most 5. */
export function workSessionsPerDay() {
  const raw = process.env.WORK_SESSIONS_PER_DAY;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PER_DAY;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(MAX_PER_DAY, Math.max(0, n)) : DEFAULT_PER_DAY;
}

function loadEntries() {
  return readJson(FILE, { entries: [] }).entries;
}

export function listWorkSessions() {
  return loadEntries();
}

function isWork(e) {
  return e.kind === 'action' && e.ok && WORK_TOOLS.has(e.tool);
}

/** 'build' when the venture has a repo with writes on, otherwise 'grow'. */
export function sessionKind(venture) {
  return venture.repo?.enabled ? 'build' : 'grow';
}

/**
 * The venture the team is furthest behind on today, or null when there is no
 * active venture.
 *
 * Every active venture is eligible, not only ones with a repo: the founder's
 * aim is each of them on the road to €1M, and a venture with nothing to build
 * in yet still has a market to research, a price to set and prospects to find.
 * Those get a growth session instead of a build one (see sessionKind).
 *
 * "Behind" is against the founder's split: a venture's target share of the
 * last day's work less the share it actually got. With no split, every
 * eligible venture is owed an equal share, so a venture nobody touched still
 * comes first. This is what stops one venture taking every session because it
 * looks closer to revenue, the failure FOCUS was added for.
 */
export function pickVenture({ now = new Date() } = {}) {
  const eligible = listVentures().filter((v) => v.status === 'active');
  if (!eligible.length) return null;

  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const done = {};
  let total = 0;
  for (const e of listActivity({ since })) {
    if (!isWork(e) || !e.ventureId) continue;
    done[e.ventureId] = (done[e.ventureId] || 0) + 1;
    total += 1;
  }

  const focus = new Map(getFocus().map((f) => [f.id, f.pct]));
  const equal = 100 / eligible.length;
  const behind = (v) => (focus.get(v.id) ?? (focus.size ? 0 : equal)) - (total ? ((done[v.id] || 0) / total) * 100 : 0);

  return [...eligible].sort((a, b) => behind(b) - behind(a) || a.title.localeCompare(b.title))[0];
}

/**
 * Why a session should not run now, or null when it may.
 *
 * Every reason names what to change, because this runs unattended and a
 * founder reading the log at midnight should not have to guess which switch.
 */
export function skipReason({ now = new Date() } = {}) {
  const perDay = workSessionsPerDay();
  if (perDay === 0) return 'WORK_SESSIONS_PER_DAY is 0: set it to 1 or more to let the team work between meetings.';
  if (getKillSwitch().halted) return 'Real actions are halted: RESUME lifts it.';
  const cap = dailyCapUsd();
  if (cap && getSpendToday() >= cap) return 'The daily model spend cap is reached: DAILY_SPEND_CAP_USD raises it; otherwise this waits for tomorrow.';
  if (isDailyMeetingRunning()) return 'The daily meeting is running.';
  if (!pickVenture({ now })) return 'There is no active venture to work on: START <title> | <one-liner> begins one.';

  const entries = loadEntries();
  const today = now.toISOString().slice(0, 10);
  const todays = entries.filter((e) => e.at.slice(0, 10) === today).length;
  if (todays >= perDay) return `Already ran ${todays} of ${perDay} work sessions today.`;

  // Two idle sessions in a row: wait for a new daily meeting, which is what
  // gives a stuck team something new to work on (an objective, a plan).
  const [last, before] = [entries[entries.length - 1], entries[entries.length - 2]];
  if (last && before && !last.productive && !before.productive) {
    const report = getLatestDailyReport();
    if (!report || Date.parse(report.generatedAt) <= Date.parse(last.at)) {
      return 'The last two work sessions produced nothing, so they wait for the next daily meeting rather than retry.';
    }
  }
  return null;
}

/** The kickoff. Its only output is work: there is no report section for the founder to skim. */
export function workSessionKickoff(venture, { now = new Date() } = {}) {
  const split = getFocus().find((f) => f.id === venture.id);
  const share = split ? ` The founder's split gives it ${split.pct}% of the team's work.` : '';
  const goal = REVENUE_GOAL_EUR.toLocaleString('en');
  const opening = `It's ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC. This is a work session, not a meeting: nobody reads a status report from it, and nobody will tell you what to do. Its only output is work done.

Venture: "${venture.title}" [${venture.id}].${share} The founder's aim is for it to reach €${goal} a year in recurring revenue; the latest Road to €1M in your context lists the improvements the team proposed for it.`;

  if (sessionKind(venture) === 'grow') {
    return `${opening}

This venture has no repo with writes on, so today's work is growing the business, not building code.

1. Call next_task for this venture. If there is one: start_task, do it, then complete_task, or fail_task with the reason.
2. If the queue is empty, take the top improvement the Road to €1M proposes for this venture. If it has no open objective, set one now with set_objective: one measurable target and a date, in what a customer pays for. Break the next step into at most three concrete tasks with queue_work and start the first.
3. Do it. Research the buyer and the competitors, sharpen the offer and the price, find prospects (update_pipeline), draft the outreach (draft_customer_email: a draft reaches nobody, the founder releases it). Ask the specialists that fit the task.
4. Write down what you learned and any better improvement than the one on the roadmap, with its evidence (log_venture_note), so the next week's roadmap starts from it.
5. Do not stop to ask what to work on: pick. Ask the founder only for something only they can do (a credential, a payment, a legal decision), say exactly what, and say what you did in the meantime.

Finish in three lines: what you did, what is queued next, and what you need from the founder, if anything.`;
  }

  return `${opening}

1. Call next_task for this venture. If there is one: start_task, do it, then complete_task, or fail_task with the reason.
2. If the queue is empty, take the top improvement the Road to €1M proposes for this venture, or find its open objective. If it has none, set one now with set_objective: one measurable target and a date, derived from its one-liner and the founder's standing direction. Then break the next step into at most three concrete, testable tasks with queue_work, and start the first.
3. Build it by delegating to the Engineering Lead or the Forge Engineer, and read the repo before writing to it. Code goes out as open_pull_request, one per task, with run_checks and list_checks first. Direct commits only where the approved plan and the venture's setting allow them: a refusal names the reason, so follow it and do not retry it.
4. Research, drafting and pipeline work count too: ask the Health Researcher, the Privacy Officer or the Pilot Manager when the task needs them.
5. Do not stop to ask what to work on: pick. Ask the founder only for something only they can do (a credential, a payment, a legal decision), say exactly what, and say what you did in the meantime.

Finish in three lines: what you did, what is queued next, and what you need from the founder, if anything.`;
}

/**
 * One work session, if it may run. Never throws: a failed session is recorded
 * and the timer carries on, so one provider outage does not stop the loop.
 */
export async function runWorkSession({ anthropic, now = new Date() }) {
  const reason = skipReason({ now });
  if (reason) return { ran: false, reason };

  const venture = pickVenture({ now });
  const startedAt = new Date().toISOString();
  const entry = { at: startedAt, ventureId: venture.id, productive: false, work: 0, error: null };
  try {
    const repoManifests = await buildRepoManifests().catch(() => '');
    const steering = await readFounderSteering().catch(() => '');
    const reply = await withSpendContext({ source: 'session' }, () =>
      runAgent({
        anthropic,
        agents: COMPANY_AGENTS,
        agentId: sessionKind(venture) === 'grow' ? 'coo' : 'cto',
        messages: [{ role: 'user', content: workSessionKickoff(venture, { now }) }],
        actionHandlers: dailyCycleActionHandlers(),
        extraContext: [buildCompanyContext(), steering].filter(Boolean).join('\n\n'),
        perAgentContext: (agentId) => buildPerAgentContext(agentId, { repoManifests }),
        budgetUsd: workSessionBudgetUsd(),
      }),
    );
    entry.summary = String(reply?.text ?? reply ?? '').slice(0, 600);
  } catch (err) {
    entry.error = String(err?.message || err).slice(0, 300);
  }
  entry.work = listActivity({ since: startedAt }).filter(isWork).length;
  entry.productive = entry.work > 0;

  updateJson(FILE, { entries: [] }, (data) => {
    data.entries = [...data.entries, entry].slice(-60);
  });
  // A note in the founder's vault of what this session did: the log they read,
  // and, through the weekly knowledge pass, part of what the team learns from.
  // Fail-quiet, and inert when no workspace is set.
  await publishWorkSession(entry, venture);
  return { ran: true, ...entry };
}

export async function runWorkSessionNow({ anthropic }) {
  if (running) return { ran: false, reason: 'A work session is already in progress.' };
  running = true;
  try {
    return await runWorkSession({ anthropic });
  } finally {
    running = false;
  }
}

/**
 * The next slot at or after `from`: daily meeting hour + 4h, + 8h, ... for as
 * many sessions as the day allows. Null when sessions are off.
 */
export function nextSlotUTC(from = new Date(), perDay = workSessionsPerDay()) {
  if (perDay <= 0) return null;
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (let k = 1; k <= perDay; k++) {
      const slot = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayOffset, TARGET_UTC_HOUR + k * SLOT_GAP_HOURS, 0, 0, 0));
      if (slot > from) return slot;
    }
  }
  return null;
}

export function startWorkSessionScheduler({ anthropic }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`${STARTUP_LOG} disabled: no ANTHROPIC_API_KEY configured.`);
    return;
  }
  if (workSessionsPerDay() === 0) {
    console.log(`${STARTUP_LOG} disabled: WORK_SESSIONS_PER_DAY is 0.`);
    return;
  }

  const scheduleNext = () => {
    const slot = nextSlotUTC();
    if (slot) setTimeout(tick, slot.getTime() - Date.now());
  };

  const tick = async () => {
    try {
      const result = await runWorkSessionNow({ anthropic });
      console.log(result.ran ? `Work session on ${result.ventureId}: ${result.work} piece(s) of work.` : `Work session skipped: ${result.reason}`);
    } catch (err) {
      console.error('Work session failed:', err);
    }
    scheduleNext();
  };

  scheduleNext();
}
