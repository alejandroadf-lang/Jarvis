// How ready is this company to make its first million, without looking at the
// bank balance.
//
// "You are not making money, so you are far away" is true of every company on
// its first day and helps nobody. What decides whether the money can arrive is
// whether each thing it depends on exists: a product someone can buy, a buyer
// who has heard of it, a way to reach more of them, a team that runs without
// its founder in the loop, a memory that is true, the rules it lives under.
// This scores those, from the company's own records, and lays each venture out
// on a ladder from "a price is set" to "a million euros a year" with the first
// rung it has not reached.
//
// It is code and not a model on purpose. A consultant that writes "readiness is
// 2.4 out of 4" from a feeling is the failure this exists to avoid: every score
// here follows from numbers that are printed beside it as cited facts (E1, E2…),
// so the founder can check any of them, and the models that write the narrative
// are handed the facts and cannot change them.
//
// The eight dimensions are the ones AI-readiness reviews in the style of the
// large consultancies use (strategy and value, product and technology,
// go-to-market, operations, data and learning, risk and governance, financial
// discipline, people and leadership), reworded for a company whose staff are
// agents. The levels run 0 to 4: initial, emerging, defined, managed, optimised.

import { readJson } from '../store.js';
import { listVentures, pipelineSummary, listPayments, describePricing, listReplies, REVENUE_GOAL_EUR } from '../finance/ventures.js';
import { usageSummary } from '../ventureUsage.js';
import { listWorkSessions } from '../workSession.js';
import { getLatestDailyReport } from '../dailyReports.js';
import { getLatestRoadmap } from '../roadmapStore.js';
import { getPlan } from '../dailyPlan.js';
import { pendingDrafts } from '../outreachDrafts.js';
import { getKillSwitch } from '../killSwitch.js';
import { spendByDay, getSpendToday, dailyCapUsd, economicsLast30 } from '../spend.js';
import { isEmailConfigured } from '../email.js';
import { lessonMetrics } from '../workspace/lessons.js';
import { isWorkspaceConfigured } from '../workspace/vault.js';

const DAY = 86_400_000;
const LEVELS = ['Initial', 'Emerging', 'Defined', 'Managed', 'Optimised'];

export const LADDER = [
  ['price', 'A price is set'],
  ['product', 'A working product exists (repo linked and something shipped)'],
  ['used', 'People are using it'],
  ['buyers', 'Ten or more buyers identified'],
  ['talking', 'First conversations under way (contacted, replied, a call booked)'],
  ['paying', 'First paying customer'],
  ['repeatable', 'Three or more paying customers'],
  ['tenk', '€10,000 a month recurring'],
  ['goal', `€${REVENUE_GOAL_EUR.toLocaleString('en')} a year recurring`],
];

const bar = (level) => '▰'.repeat(Math.round(level)) + '▱'.repeat(4 - Math.round(level));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const one = (n) => Math.round(n * 10) / 10;

/**
 * The scorecard, from records. `notes` is the vault's notes when the caller has
 * them (rules pages live there); without them the risk score says so instead of
 * guessing.
 */
export function buildScorecard({ now = new Date(), notes = null } = {}) {
  const facts = [];
  const fact = (dim, text) => {
    const id = `E${facts.length + 1}`;
    facts.push({ id, dim, text });
    return id;
  };

  const active = listVentures().filter((v) => v.status === 'active');
  const posthog = readJson('posthog-circadian.json', null);

  // --- per venture: the ladder ----------------------------------------------
  const ventures = active.map((v) => {
    const pipe = pipelineSummary(v.id);
    const payments = listPayments(v.id);
    const usage = usageSummary(v.id, { days: 14 });
    const stages = pipe.byStage || {};
    const paying = stages.paying || 0;
    const talking = (stages.contacted || 0) + (stages.replied || 0) + (stages.call_booked || 0) + (stages.pilot || 0) + paying;
    const sent = (v.sentEmails || []).length;
    const replies = listReplies(v.id).length;
    const priced = describePricing(v) !== 'no price set';
    const shipped = (v.deployments || []).length + (v.pullRequests || []).length;
    const seenInApp = /circadian/i.test(v.title) && posthog?.weeks?.this?.app_opened?.devices > 0;
    const mrr = pipe.payingMonthly;

    const done = {
      price: priced,
      product: Boolean(v.repo) && shipped > 0,
      used: usage.calls > 0 || Boolean(seenInApp),
      buyers: pipe.contacts >= 10,
      talking: talking > 0 || sent > 0 || replies > 0,
      paying: paying > 0 || payments.length > 0,
      repeatable: paying >= 3,
      tenk: mrr >= 10_000,
      goal: mrr * 12 >= REVENUE_GOAL_EUR,
    };

    const cite = {
      price: fact('venture', `${v.title}: price on record is "${describePricing(v)}".`),
      product: fact('venture', `${v.title}: ${v.repo ? `repo ${v.repo.owner}/${v.repo.name} is linked` : 'no repo is linked'}; ${(v.deployments || []).length} deployments and ${(v.pullRequests || []).length} pull requests recorded.`),
      used: fact('venture', `${v.title}: ${usage.known ? `${usage.calls} calls from ${usage.callers} callers reported in 14 days` : 'no usage has ever been reported'}${/circadian/i.test(v.title) ? (posthog ? `; PostHog shows ${posthog.weeks?.this?.app_opened?.devices || 0} devices opened the app this week` : '; PostHog is not being read') : ''}.`),
      buyers: fact('venture', `${v.title}: ${pipe.contacts} contacts in the pipeline (${JSON.stringify(stages)}), open value €${pipe.pipelineMonthly}/month.`),
      talking: fact('venture', `${v.title}: ${sent} outreach emails sent, ${replies} replies received.`),
      paying: fact('venture', `${v.title}: ${paying} paying customers, recurring €${mrr}/month, ${payments.length} payments recorded.`),
    };

    const next = LADDER.find(([key]) => !done[key]);
    const reached = LADDER.filter(([key]) => done[key]).length;
    return { id: v.id, title: v.title, done, reached, next: next ? { key: next[0], label: next[1], evidence: cite[next[0]] || cite.paying } : null, cite, mrr, pipe };
  });

  // --- the eight dimensions -------------------------------------------------
  const dims = [];
  const add = (key, name, level, why, next) => dims.push({ key, name, level: Math.max(0, Math.min(4, level)), why, next });

  // 1. Product and technology
  const productLevels = ventures.map((v) => ((v.done.price ? 1 : 0) + (v.done.product ? 1 : 0) + (v.done.used ? 1 : 0)) * (4 / 3));
  add('product', 'Product and technology', avg(productLevels), ventures.map((v) => v.cite.product), 'Ship something for the venture furthest from a working product, and get usage reporting on.');

  // 2. Revenue engine
  const revLevels = ventures.map((v) => {
    const d = v.done;
    return d.repeatable ? 4 : d.paying ? 3 : d.talking ? 2 : d.buyers ? 1.5 : d.price ? 0.5 : 0;
  });
  add('revenue', 'Revenue engine', avg(revLevels), ventures.flatMap((v) => [v.cite.buyers, v.cite.paying]), 'Move the venture nearest a customer to its first paid conversation.');

  // 3. Go-to-market machinery
  const emailOk = isEmailConfigured();
  const imapOk = Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
  const outreachOn = active.some((v) => v.outreach?.enabled);
  const everSent = active.some((v) => (v.sentEmails || []).length > 0);
  const gtmId = fact('gtm', `Outreach plumbing: email sending ${emailOk ? 'configured' : 'NOT configured'}, inbound replies ${imapOk ? 'configured' : 'NOT configured (IMAP)'}, outreach enabled on ${active.filter((v) => v.outreach?.enabled).length} ventures, any email ever sent: ${everSent ? 'yes' : 'no'}.`);
  add('gtm', 'Go-to-market machinery', [emailOk, imapOk, outreachOn, everSent].filter(Boolean).length, [gtmId], 'Set up the mailbox (IMAP) and enable outreach on one venture with sourced contacts.');

  // 4. Operations and autonomy
  const sessions = listWorkSessions().filter((e) => now.getTime() - Date.parse(e.at) < 7 * DAY);
  const productive = sessions.filter((s) => s.productive).length;
  const report = getLatestDailyReport();
  const reportAge = report ? (now.getTime() - Date.parse(report.generatedAt)) / DAY : null;
  const opsId = fact('ops', `Operations: last daily report ${reportAge === null ? 'never' : `${one(reportAge)} days ago`}; ${sessions.length} work sessions in 7 days, ${productive} productive.`);

  // 8 (computed early: it feeds operations). Founder leverage: what only the founder can unblock.
  const rulesNotes = (notes || []).filter((n) => n.fm?.type === 'rule');
  const rulesOpen = rulesNotes.filter((n) => /needs-legal-read|source-changed|to-verify/.test(String(n.fm.status)));
  const plan = getPlan();
  const decisions = readJson('decisions.json', { items: [] }).items.filter((d) => d.decision === 'pending');
  const drafts = pendingDrafts().length;
  const waiting = (plan?.status === 'pending' ? 1 : 0) + decisions.length + drafts + rulesOpen.length;
  const founderId = fact('founder', `Waiting on the founder alone: ${plan?.status === 'pending' ? 'a plan to approve, ' : ''}${decisions.length} decisions, ${drafts} outreach drafts, ${rulesOpen.length} rules to read${notes ? '' : ' (vault not read, so rules are not counted)'}.`);

  add(
    'ops',
    'Operations and autonomy',
    (reportAge !== null && reportAge <= 2 ? 1 : 0) + (sessions.length >= 3 ? 1 : 0) + (sessions.length && productive / sessions.length >= 0.5 ? 1 : 0) + (waiting <= 3 ? 1 : 0),
    [opsId, founderId],
    'Keep work sessions productive and clear what waits on you so the team is never blocked on one person.',
  );

  // 5. Data and learning
  const lm = lessonMetrics();
  const roadmap = getLatestRoadmap();
  const roadmapAge = roadmap ? (now.getTime() - Date.parse(roadmap.generatedAt)) / DAY : null;
  const learnId = fact('learning', `Learning: vault ${isWorkspaceConfigured() ? 'connected' : 'NOT connected'}; ${lm.trusted} trusted, ${lm.candidate} unconfirmed lessons; ${lm.totalReads} reads; roadmap ${roadmapAge === null ? 'never written' : `${one(roadmapAge)} days old`}.`);
  add(
    'learning',
    'Data and learning',
    (isWorkspaceConfigured() ? 1 : 0) + (lm.trusted > 0 ? 1 : 0) + (lm.totalReads > 0 ? 1 : 0) + (roadmapAge !== null && roadmapAge <= 8 ? 1 : 0),
    [learnId],
    'Get a first lesson confirmed and read, so what the team learns starts to compound.',
  );

  // 6. Risk, governance and compliance
  const halted = getKillSwitch().halted;
  const riskId = fact('risk', `Governance: kill switch ${halted ? 'ENGAGED' : 'ready'}; ${notes ? `${rulesOpen.length} of ${rulesNotes.length} outside rules are unread or changed (${rulesOpen.map((n) => n.path.split('/').pop().replace(/\.md$/, '')).join(', ') || 'none'})` : 'the rules register could not be read'}.`);
  add(
    'risk',
    'Risk, governance and compliance',
    notes ? 4 - Math.min(3, Math.ceil(rulesOpen.length / 2)) : 1,
    [riskId],
    'Read the primary text of the open rules, starting with WHOOP’s API terms, and mark each reviewed.',
  );

  // 7. Financial discipline
  const spent7 = Object.values(spendByDay(7)).reduce((a, b) => a + Number(b || 0), 0);
  const revenue30 = active.reduce((sum, v) => sum + listPayments(v.id).filter((p) => now.getTime() - Date.parse(p.paidAt) < 30 * DAY).reduce((s, p) => s + Number(p.amount || 0), 0), 0);
  const econ = economicsLast30({ revenue: revenue30, payingCustomers: ventures.reduce((n, v) => n + (v.pipe.byStage.paying || 0), 0) });
  const cap = dailyCapUsd();
  const finId = fact('finance', `Money: model spend $${one(spent7)} in 7 days ($${one(econ.spentUsd)} in 30), today $${one(getSpendToday())} of a $${cap} daily cap; recorded revenue in 30 days ${one(revenue30)}.`);
  add('finance', 'Financial discipline', 1 + (revenue30 > 0 ? 1 : 0) + (revenue30 >= econ.spentUsd && revenue30 > 0 ? 1 : 0) + (revenue30 >= 3 * econ.spentUsd && revenue30 > 0 ? 1 : 0), [finId], 'Reach revenue that covers what the team costs to run.');

  // 8. Founder leverage (people and leadership): fewer things waiting on one person is better.
  add('founder', 'Founder leverage', waiting === 0 ? 4 : waiting <= 2 ? 3 : waiting <= 5 ? 2 : waiting <= 9 ? 1 : 0, [founderId], 'Clear the decisions, drafts and rule reads that only you can do.');

  const dimensions = dims.map((d) => ({ ...d, level: one(d.level), why: [...new Set(d.why)] }));
  const readiness = one(avg(dimensions.map((d) => d.level)));
  const critical = dimensions.filter((d) => ['product', 'revenue', 'gtm'].includes(d.key)).sort((a, b) => a.level - b.level)[0];
  const closest = [...ventures].sort((a, b) => b.reached - a.reached)[0] || null;

  return {
    generatedAt: now.toISOString(),
    facts,
    dimensions,
    ventures,
    readiness,
    stage: LEVELS[Math.min(4, Math.floor(readiness))],
    bindingConstraint: critical ? { key: critical.key, name: critical.name, level: critical.level } : null,
    closest: closest ? { id: closest.id, title: closest.title, reached: closest.reached, of: LADDER.length, next: closest.next } : null,
  };
}

/** The deterministic part of the digest: what the numbers are. Written by code, so no model can change it. */
export function renderScorecard(sc) {
  const lines = [`Readiness ${sc.readiness}/4 (${sc.stage}). This is a score of whether the machine can earn, not of how much it has earned.`, ''];
  for (const d of sc.dimensions) {
    lines.push(`${bar(d.level)} ${d.level.toFixed(1)}  ${d.name}  [${d.why.join(', ')}]`);
  }
  if (sc.bindingConstraint) lines.push('', `Binding constraint: ${sc.bindingConstraint.name} (${sc.bindingConstraint.level}/4). Raising anything else first is polishing.`);
  lines.push('', 'Distance to €1M a year, venture by venture (rungs reached of ' + LADDER.length + '):');
  for (const v of sc.ventures) {
    const marks = LADDER.map(([key]) => (v.done[key] ? '✓' : '·')).join('');
    lines.push(`${v.title}: ${v.reached}/${LADDER.length}  ${marks}`);
    lines.push(`   next rung: ${v.next ? `${v.next.label} [${v.next.evidence}]` : 'none: the goal is met'}`);
  }
  return lines.join('\n');
}

export function renderFacts(sc) {
  return sc.facts.map((f) => `[${f.id}] ${f.text}`).join('\n');
}
