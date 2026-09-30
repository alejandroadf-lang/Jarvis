// The KPIs an AI company making money is watched by, and where this one stands.
//
// The scorecard says whether the machine exists. This says how it is running,
// in the numbers that matter to a company whose staff are agents and whose
// costs are inference: recurring revenue and how many customers it takes, pipeline
// against the next target, activation and return in the product, what the
// models cost against what they earn, how much of the work the team does without
// the founder, whether the agents' judgement holds up under test, and how the
// code ships.
//
// Two honesty rules:
//
// 1. Every value is computed from the company's records and cited to a fact.
//    A KPI with no data behind it says NOT MEASURED, and that count is itself a
//    finding: you cannot steer by a number you do not collect.
// 2. The status thresholds are this company's own stage rules, written below and
//    printed in the email. They are not industry benchmarks. Where a benchmark
//    from outside is worth quoting, the review cites a verified source [P#]; the
//    table never presents a number of ours as a number of theirs.

import { readJson } from '../store.js';
import { listVentures, listReplies, REVENUE_GOAL_EUR } from '../finance/ventures.js';
import { usageSummary } from '../ventureUsage.js';
import { latestEvalRun } from '../evalRuns.js';
import { agentPerformance } from '../activityLog.js';
import { dailyCapUsd, spendByDay } from '../spend.js';
import { lessonMetrics } from '../workspace/lessons.js';
import { addFact } from './scorecard.js';
import { benchmarkKpis } from './competitors.js';
import { practiceKpis } from './practice.js';

const DAY = 86_400_000;
export const MRR_GOAL = REVENUE_GOAL_EUR / 12;

const STATUS = { on_track: 'ON TRACK', watch: 'WATCH', behind: 'BEHIND', unmeasured: 'NOT MEASURED' };
const WEIGHT = { on_track: 1, watch: 0.5, behind: 0 };
const eur = (n) => `€${Math.round(n).toLocaleString('en')}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const rate = (top, bottom) => (bottom > 0 ? top / bottom : null);

/**
 * Builds the table. Adds a fact to the card for each KPI, so each cites its own
 * evidence. `engineering` is the code review, when there was one.
 */
export function buildKpis(sc, { now = new Date(), engineering = null, benchmark = null, practice = null } = {}) {
  const raw = listVentures().filter((v) => v.status === 'active');
  const list = [];
  const add = ({ group, name, display, status, rule }) => {
    const n = list.length + 1;
    const evidence = addFact(sc, 'kpi', `KPI ${name}: ${display}.`);
    list.push({ id: `K${n}`, group, name, display, status, rule, evidence });
  };

  const mrr = sc.ventures.reduce((n, v) => n + v.mrr, 0);
  const paying = sc.ventures.reduce((n, v) => n + (v.pipe.byStage.paying || 0), 0);
  const contacts = sc.ventures.reduce((n, v) => n + v.pipe.contacts, 0);
  const open = sc.ventures.reduce((n, v) => n + v.pipe.pipelineMonthly, 0);

  // --- Revenue and growth ---------------------------------------------------
  add({
    group: 'Revenue and growth',
    name: 'Recurring revenue',
    display: `${eur(mrr)} a month, ${pct(mrr / MRR_GOAL)} of the ${eur(MRR_GOAL)} a month that €1M a year needs`,
    status: mrr >= MRR_GOAL ? 'on_track' : mrr > 0 ? 'watch' : 'behind',
    rule: 'on track at the goal; watch above zero',
  });

  const priced = raw.filter((v) => v.pricing?.floorMonthly > 0);
  const needs = priced.map((v) => ({ title: v.title, need: Math.ceil(MRR_GOAL / v.pricing.floorMonthly), price: v.pricing.floorMonthly, cur: v.pricing.currency, have: sc.ventures.find((x) => x.id === v.id)?.pipe.byStage.paying || 0 }));
  add({
    group: 'Revenue and growth',
    name: 'Customers the goal needs at today\'s price',
    display: needs.length ? needs.map((n) => `${n.title}: ${n.have} of ${n.need} at ${n.cur} ${n.price}/month`).join('; ') : 'no venture has a monthly price set, so the number of customers the goal needs cannot be worked out',
    status: !needs.length ? 'unmeasured' : needs.some((n) => n.have >= n.need) ? 'on_track' : needs.some((n) => n.have > 0) ? 'watch' : 'behind',
    rule: 'on track when one venture has all it needs; watch with any paying customer',
  });

  const target = mrr < 10_000 ? 10_000 : MRR_GOAL;
  const gap = Math.max(1, target - mrr);
  add({
    group: 'Revenue and growth',
    name: `Pipeline coverage of the next target (${eur(target)} a month)`,
    display: open > 0 ? `open pipeline ${eur(open)} a month is ${(open / gap).toFixed(1)}x the ${eur(gap)} still to find` : contacts ? `${contacts} contacts but none has a deal value recorded, so coverage cannot be computed` : 'no pipeline recorded',
    status: open > 0 ? (open / gap >= 3 ? 'on_track' : open / gap >= 1 ? 'watch' : 'behind') : contacts ? 'unmeasured' : 'behind',
    rule: 'on track at 3x or more, watch at 1x or more',
  });

  add({
    group: 'Revenue and growth',
    name: 'Buyers identified',
    display: `${contacts} contacts in the pipeline, ${paying} paying`,
    status: contacts >= 10 ? 'on_track' : contacts > 0 ? 'watch' : 'behind',
    rule: 'on track at ten or more',
  });

  // --- Sales activity -------------------------------------------------------
  const since = now.getTime() - 14 * DAY;
  const sent14 = raw.reduce((n, v) => n + (v.sentEmails || []).filter((e) => Date.parse(e.sentAt) >= since).length, 0);
  const replies14 = raw.reduce((n, v) => n + listReplies(v.id).filter((r) => Date.parse(r.receivedAt) >= since).length, 0);
  add({
    group: 'Sales activity',
    name: 'Outreach sent in 14 days',
    display: `${sent14} emails`,
    status: sent14 >= 25 ? 'on_track' : sent14 > 0 ? 'watch' : 'behind',
    rule: 'on track at 25 or more in a fortnight',
  });
  add({
    group: 'Sales activity',
    name: 'Reply rate',
    display: sent14 >= 10 ? `${pct(replies14 / sent14)} (${replies14} replies to ${sent14} emails)` : `only ${sent14} emails in 14 days, too few for a rate to mean anything`,
    status: sent14 >= 10 ? (replies14 / sent14 >= 0.1 ? 'on_track' : replies14 > 0 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track at 10% or more, once there are ten emails to measure',
  });

  // --- Product and usage ----------------------------------------------------
  const ph = readJson('posthog-circadian.json', null);
  const opened = ph?.weeks?.this?.app_opened?.devices || 0;
  const planned = ph?.weeks?.this?.plan_made?.devices || 0;
  add({
    group: 'Product and usage',
    name: 'Activation: opened the app, then made a plan (Circadian, 7 days)',
    display: ph ? (opened >= 20 ? `${pct(planned / opened)} (${planned} of ${opened} devices)` : `${opened} devices opened it this week, too few for a rate`) : 'PostHog usage is not being read, so activation is not measured',
    status: ph && opened >= 20 ? (planned / opened >= 0.4 ? 'on_track' : planned / opened >= 0.15 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track at 40% or more, watch at 15%, once 20 devices opened it',
  });
  add({
    group: 'Product and usage',
    name: 'Coming back (Circadian, devices that made a plan on two or more days in a fortnight)',
    display: ph && ph.returning !== null && ph.returning !== undefined ? `${ph.returning} devices` : 'not measured',
    status: ph && ph.returning !== null && ph.returning !== undefined ? (ph.returning >= 10 ? 'on_track' : ph.returning > 0 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track at ten or more devices',
  });
  const usages = raw.map((v) => ({ title: v.title, u: usageSummary(v.id, { days: 7 }) })).filter((x) => x.u.known);
  const apiCalls = usages.reduce((n, x) => n + x.u.calls, 0);
  const apiErrors = usages.reduce((n, x) => n + x.u.errors, 0);
  add({
    group: 'Product and usage',
    name: 'API use in 7 days',
    display: usages.length ? `${apiCalls} calls from ${usages.reduce((n, x) => n + x.u.callers, 0)} callers, ${apiCalls ? pct(apiErrors / apiCalls) : '0%'} errors` : 'no venture reports usage, so API use is not measured',
    status: usages.length ? (apiCalls > 0 && apiErrors / Math.max(1, apiCalls) < 0.05 ? 'on_track' : apiCalls > 0 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track with calls and under 5% errors',
  });

  // --- AI economics ---------------------------------------------------------
  const { spent7, spent30, revenue30, sessions, productive, waiting } = sc.signals;
  add({
    group: 'AI economics',
    name: 'Model cost as a share of revenue (30 days)',
    display: revenue30 > 0 ? `${pct(spent30 / revenue30)} ($${spent30.toFixed(2)} of model spend against ${revenue30.toFixed(2)} revenue)` : `no revenue recorded; the team spent $${spent30.toFixed(2)} in 30 days`,
    status: revenue30 > 0 ? (spent30 / revenue30 <= 0.3 ? 'on_track' : spent30 / revenue30 <= 0.6 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track at 30% or less, watch at 60%; the AI equivalent of cost of goods',
  });
  const cap = dailyCapUsd();
  const avgDay = Object.values(spendByDay(7)).length ? spent7 / 7 : 0;
  add({
    group: 'AI economics',
    name: 'Average daily model spend against the cap (7 days)',
    display: `$${avgDay.toFixed(2)} a day against a $${cap} cap (${pct(avgDay / cap)})`,
    status: avgDay / cap <= 0.5 ? 'on_track' : avgDay / cap <= 1 ? 'watch' : 'behind',
    rule: 'on track at half the cap or less',
  });

  // --- Autonomy and quality -------------------------------------------------
  add({
    group: 'Autonomy and quality',
    name: 'Work sessions that produced something (7 days)',
    display: sessions ? `${productive} of ${sessions} (${pct(productive / sessions)})` : 'no work sessions ran',
    status: sessions ? (productive / sessions >= 0.6 ? 'on_track' : productive / sessions >= 0.3 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track at 60% or more',
  });
  add({
    group: 'Autonomy and quality',
    name: 'Items waiting on the founder alone',
    display: `${waiting} (decisions, outreach drafts, a plan, rules to read)`,
    status: waiting <= 2 ? 'on_track' : waiting <= 5 ? 'watch' : 'behind',
    rule: 'on track at two or fewer, watch at five',
  });
  const run = latestEvalRun();
  const results = run?.results || [];
  add({
    group: 'Autonomy and quality',
    name: 'Agent behaviour evals passing',
    display: results.length ? `${results.filter((r) => r.pass).length} of ${results.length} scenarios (${pct(results.filter((r) => r.pass).length / results.length)}), run ${String(run.startedAt || '').slice(0, 10) || 'recently'}` : 'the evals have never run, so nobody has measured whether the agents\' judgement holds',
    status: results.length ? (results.filter((r) => r.pass).length / results.length >= 0.9 ? 'on_track' : results.filter((r) => r.pass).length / results.length >= 0.7 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track at 90% or more',
  });
  const perf = agentPerformance({ days: 7, now });
  const done = perf.agents.reduce((n, a) => n + a.done, 0);
  const refused = perf.agents.reduce((n, a) => n + a.refused, 0);
  add({
    group: 'Autonomy and quality',
    name: 'Actions the guardrails refused (7 days)',
    display: done + refused >= 10 ? `${pct(refused / (done + refused))} (${refused} of ${done + refused})` : `only ${done + refused} actions, too few for a rate`,
    status: done + refused >= 10 ? (refused / (done + refused) <= 0.15 ? 'on_track' : refused / (done + refused) <= 0.4 ? 'watch' : 'behind') : 'unmeasured',
    rule: 'on track at 15% or less: agents that keep hitting a gate are not yet trusted with the job',
  });
  const lm = lessonMetrics();
  add({
    group: 'Autonomy and quality',
    name: 'Lessons the team has confirmed and reads',
    display: `${lm.trusted} trusted of ${lm.total} kept; ${lm.totalReads} reads`,
    status: lm.trusted > 0 && lm.totalReads > 0 ? 'on_track' : lm.total > 0 ? 'watch' : 'behind',
    rule: 'on track once a lesson is confirmed and read',
  });

  // --- Delivery (needs the code review) -------------------------------------
  const readable = engineering?.repos?.filter((r) => !r.error) || [];
  if (readable.length) {
    const merged = readable.reduce((n, r) => n + (r.activity.merged14 || 0), 0);
    add({
      group: 'Delivery',
      name: 'Pull requests merged in 14 days',
      display: `${merged} across ${readable.length} repos`,
      status: merged >= 5 ? 'on_track' : merged > 0 ? 'watch' : 'behind',
      rule: 'on track at five or more in a fortnight',
    });
    const withCi = readable.filter((r) => r.activity.ci);
    add({
      group: 'Delivery',
      name: 'CI passing on the main branch',
      display: withCi.length ? withCi.map((r) => `${r.label}: ${r.activity.ci.green ? 'passing' : `${r.activity.ci.failed} failing, ${r.activity.ci.pending} pending`}`).join('; ') : 'no CI runs found on any repo',
      status: withCi.length ? (withCi.every((r) => r.activity.ci.green) ? 'on_track' : 'behind') : 'behind',
      rule: 'on track when every repo is green',
    });
    const essentials = readable.flatMap((r) => r.checklist.filter((c) => c.essential));
    add({
      group: 'Delivery',
      name: 'Engineering essentials in place',
      display: `${essentials.filter((c) => c.present).length} of ${essentials.length}`,
      status: essentials.filter((c) => c.present).length / essentials.length >= 0.85 ? 'on_track' : essentials.filter((c) => c.present).length / essentials.length >= 0.5 ? 'watch' : 'behind',
      rule: 'on track at 85% or more',
    });
  }

  // --- Technology against competitors, and the founder's building practice --
  for (const row of benchmarkKpis(benchmark)) add({ group: 'Technology against competitors', ...row });
  for (const row of practiceKpis(practice)) add({ group: 'Building practice', ...row });

  const measured = list.filter((k) => k.status !== 'unmeasured');
  const health = measured.length ? measured.reduce((n, k) => n + WEIGHT[k.status], 0) / measured.length : 0;
  const best = (key) => sc.ventures.some((v) => v.done[key]);
  const stage = mrr >= 10_000 ? 'Scaling' : best('repeatable') ? 'Repeatable revenue' : best('paying') ? 'Early revenue' : best('talking') ? 'Pre-revenue: selling' : best('product') ? 'Pre-revenue: built, no buyers yet' : 'Pre-revenue: building';
  return { kpis: list, measured: measured.length, total: list.length, health, stage };
}

/** The table for the email, grouped. Pure. */
export function renderKpis(k) {
  const lines = [
    `Company stage: ${k.stage}.`,
    `KPI health: ${pct(k.health)} across the ${k.measured} KPIs that can be measured today (${k.total - k.measured} of ${k.total} cannot be measured yet${k.total - k.measured ? ', which is itself a gap: you cannot steer by a number you do not collect' : ''}).`,
    'Status thresholds are this company\'s own stage rules, listed beside each KPI. They are not industry benchmarks.',
    '',
  ];
  let group = '';
  for (const x of k.kpis) {
    if (x.group !== group) {
      group = x.group;
      lines.push(`${group}`);
    }
    lines.push(`  ${x.id}  [${STATUS[x.status]}]  ${x.name}: ${x.display}`);
    lines.push(`        threshold: ${x.rule}  [${x.evidence}]`);
  }
  return lines.join('\n');
}

/** The KPI list as the models are given it: ids they can cite. */
export function kpiFactsText(k) {
  return k.kpis.map((x) => `[${x.id}] ${x.name}: ${x.display} (${STATUS[x.status]}; this company's threshold: ${x.rule})`).join('\n');
}
