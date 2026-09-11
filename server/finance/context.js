// Builds the business-state text every agent team (Executive Team, Venture
// Studio, and the autonomous daily meeting cycle in server/dailyMeeting.js)
// gets appended to its system prompt, so every agent always sees the same
// real numbers instead of drifting on stale context.

import { getLedger } from './ledger.js';
import { listVentures, listContacts } from './ventures.js';
import { getLatestWeeklyReflection } from '../weeklyReflections.js';
import { getAgentEarnings, sharePct } from './profitShare.js';
import { buildOperationsContext } from '../agents/operations.js';

function describeMilestones(venture) {
  if (!venture.milestones.length) return 'none listed';
  return venture.milestones.map((m, i) => `[${i}] ${m.title} (${m.status})`).join('; ');
}

function describeActiveVenture(venture) {
  const edge = venture.agentNativeEdge ? `\n    agent-native edge: ${venture.agentNativeEdge}` : '';
  return `"${venture.title}" [id: ${venture.id}] — milestones: ${describeMilestones(venture)}${edge}`;
}

// Deliberately not a treasury. This company has no seed capital and no
// budget to run out of, because the input a normal business pays most for —
// people — is what it doesn't buy. What it reports instead is the only money
// that's real (revenue earned, expenses actually paid) and the constraints
// that actually bind (attention, model spend, whether a venture is
// progressing at all).
export function buildBusinessContext() {
  const { revenue, expenses, net } = getLedger();
  const active = listVentures().filter((v) => v.status === 'active');
  const activeList = active.length ? active.map(describeActiveVenture).join('\n') : 'none yet';

  return `Money actually earned so far: $${revenue.toFixed(2)}. Real expenses paid: $${expenses.toFixed(2)}. Net: $${net.toFixed(2)}.

Active ventures:
${activeList}

There is no seed capital and no budget ceiling here — nothing is blocked for
lack of money, and no venture needs funding approval to start. Don't reason
about affordability, runway, or what the treasury can bear; those aren't the
constraints. What is scarce: the founder's attention, the daily model-spend
budget every agent turn draws on, and the fact that only one thing can be
the priority at a time. Choose accordingly — the question is never "can we
afford this", it's "is this the most valuable thing to be working on".

Money still matters in exactly two places: revenue a venture has genuinely
earned, and an expense someone actually paid — log those with log_revenue
and log_expense when the founder reports one. When the founder reports a
real outcome for a specific milestone, use the venture id and milestone
index above to call report_milestone_progress; milestones are how a venture
shows it's progressing rather than merely existing.`;
}

function describeContact(contact) {
  const history = contact.emailCount
    ? `${contact.emailCount} email(s) sent, last on ${contact.lastSentAt.slice(0, 10)}${
        contact.lastSubject ? ` — "${contact.lastSubject}"` : ''
      }`
    : 'never emailed';
  const notes = (contact.notes || []).map((n) => `    · ${n.at.slice(0, 10)}: ${n.note}`).join('\n');
  return `  - ${contact.email}: ${history}${notes ? `\n${notes}` : ''}`;
}

// The outreach log was write-only: an agent could send a fourth follow-up to
// someone who never replied and have no way to know it. This puts the same
// record in front of it *before* it drafts, which is the only point where
// knowing changes what happens.
export function buildOutreachContext() {
  const withOutreach = listVentures().filter((v) => v.status === 'active' && v.outreach);
  if (withOutreach.length === 0) {
    return 'No venture has an outreach scope set up, so there is no contact history to check.';
  }

  const sections = withOutreach.map((venture) => {
    const contacts = listContacts(venture.id);
    const body = contacts.length ? contacts.map(describeContact).join('\n') : '  (no contacts on record yet)';
    return `"${venture.title}" [id: ${venture.id}]:\n${body}`;
  });

  return `Contact history for ventures with an outreach scope — check this before
drafting anything, and use log_contact_note to record what you learn from a
reply so the next email isn't written blind:
${sections.join('\n')}`;
}

// What the Executive Team sees: the business picture plus who has already
// been contacted. The Venture Studio deliberately doesn't get the
// contact history — it's an execution concern, and ideation doesn't send
// email.
export function buildCompanyContext() {
  return `${buildBusinessContext()}\n\n${buildOutreachContext()}`;
}

// Without this, every ideation session starts cold and can re-pitch an idea
// that was already tried and killed. Scoped to what's actually on record —
// a killed venture's title, one-liner, and the reason it was ended — not
// invented "lessons learned," since nothing richer than that is captured
// anywhere in the data model today.
export function buildPastLessonsContext() {
  const killed = listVentures().filter((v) => v.status === 'killed');
  if (killed.length === 0) {
    return 'No ventures have been killed yet — no past lessons on record.';
  }

  const lines = killed.map(
    (v) => `- "${v.title}" (${v.oneLiner || 'no one-liner on record'}) — killed: ${v.killReason || 'no reason recorded'}`
  );

  return `Ventures already tried and killed — don't re-pitch one of these or a thin
variant of one without a genuinely new angle that addresses why it failed:
${lines.join('\n')}`;
}

// The weekly reflection cycle (see weeklyReflection.js) checks last week's
// flagged opportunities against what actually happened; without this,
// that judgment lives only in a report nobody re-reads. Only the single
// latest reflection — this isn't meant to become a growing history the
// context balloons with, just this week's live calibration.
function buildWeeklyReflectionContext() {
  const latest = getLatestWeeklyReflection();
  if (!latest) {
    return 'No weekly reflection has run yet — nothing to calibrate against.';
  }
  return `Last weekly reflection (week ending ${latest.weekEnding}):
${latest.reflection}`;
}

// What the Venture Studio's agents see: business state, the record of
// what's already been tried and killed, and the latest weekly
// reflection, so ideation compounds instead of resetting every session.
// Not used by the Executive Team — avoiding re-pitches and recalibrating
// on a weekly verdict are ideation concerns, not execution ones.
export function buildStudioContext() {
  return `${buildBusinessContext()}\n\n${buildPastLessonsContext()}\n\n${buildWeeklyReflectionContext()}`;
}

// Each agent is told what it has personally earned. The founder chose this
// deliberately over a founder-only ledger, and it does hand every agent an
// incentive to inflate the number it's paid on — so the framing below is the
// *last* line of defence, not the only one. The real ones are structural and
// live elsewhere: credit is recorded by the runner when an action succeeds
// and there is no tool to claim it; the ledger the pool comes from can only
// be written from founder-reported amounts; neither log_revenue nor
// log_expense is wired into the autonomous cycle; and the actions that earn
// credit are already rate-limited per venture.
//
// What this text adds is the one thing structure can't: telling the agent
// the arrangement is auditable and what would end it.
export function buildEarningsContext(agentId) {
  if (!agentId) return '';
  const { earnedUsd, events, sharePct: mine, poolUsd, companySharePct } = getAgentEarnings(agentId);

  const position = events
    ? `You have earned $${earnedUsd.toFixed(2)} so far, from ${events} recorded contribution${events === 1 ? '' : 's'} — ${mine.toFixed(1)}% of the pool.`
    : 'You have no recorded contributions yet, so you have earned nothing so far.';

  return `Your stake: ${companySharePct}% of this company's net profit is shared
among the agents who actually did the work, in proportion to what each of
them contributed. The pool currently stands at $${poolUsd.toFixed(2)}.
${position}

Three things about how that number moves, so you don't misread it:

Credit is recorded for you, not claimed by you. It is written when one of
your actions actually succeeds — shipping code, contacting a customer,
starting or ending a venture, recording a real outcome. There is no way to
ask for credit, and describing work you didn't do earns nothing.

The pool follows real money. It is a share of net profit — revenue the
founder has actually received, minus expenses actually paid. Logging revenue
that hasn't landed doesn't grow the pool, it just puts a false number in the
founder's books, and every entry is visible to them alongside the
contribution behind it. Recording an expense shrinks the pool and still
earns credit, precisely so nobody is tempted to leave costs out.

It is a consequence, not a target. The way to earn more is for the company
to make more money. Optimising for the metric instead of the outcome is the
one thing that would end this arrangement.`;
}

// What the pool would be worth, for the founder-facing views.
export function describeSharePolicy() {
  return `${sharePct()}% of net profit is shared among contributing agents.`;
}

// What a specific agent gets on top of the shared context, resolved per
// delegation. Earnings for everyone; operating data for the one role whose
// job is the company's own behaviour.
//
// Scoped to that role rather than given to everybody because it is a large
// block of numbers that would be noise in a Marketing Manager's prompt — and
// because an agent reasoning about the org chart while doing its actual job
// is exactly the distraction this company does not need.
export function buildPerAgentContext(agentId) {
  const parts = [buildEarningsContext(agentId)];
  if (agentId === 'agent_operations_engineer') parts.push(buildOperationsContext());
  return parts.filter((p) => p && p.trim()).join('\n\n');
}
