// Builds the treasury/venture status text every agent team (Executive Team,
// Venture Studio, and the autonomous daily meeting cycle in
// server/dailyMeeting.js) gets appended to its system prompt, so every agent
// always sees the same real numbers instead of drifting on stale context.

import { getLedger } from './ledger.js';
import { listVentures } from './ventures.js';
import { getLatestWeeklyReflection } from '../weeklyReflections.js';

function describeMilestones(venture) {
  if (!venture.milestones.length) return 'none listed';
  return venture.milestones.map((m, i) => `[${i}] ${m.title} (${m.status})`).join('; ');
}

function describeActiveVenture(venture) {
  const pending = venture.pendingTranche
    ? ` — PENDING TRANCHE REQUEST: $${venture.pendingTranche.amount} for "${venture.pendingTranche.description}" (awaiting founder approval; don't request another for this venture until it's resolved)`
    : '';
  return `"${venture.title}" [id: ${venture.id}] — milestones: ${describeMilestones(venture)}${pending}`;
}

export function buildTreasuryContext() {
  const { balance, startingCapital } = getLedger();
  const ventures = listVentures();
  const active = ventures.filter((v) => v.status === 'active');
  const proposed = ventures.filter((v) => v.status === 'proposed');

  const activeList = active.length ? active.map(describeActiveVenture).join('\n') : 'none yet';
  const proposedList = proposed.length
    ? proposed.map((v) => `"${v.title}" [id: ${v.id}] (asking $${v.budgetRequested})`).join('; ')
    : 'none yet';

  return `Company treasury: $${balance.toFixed(2)} available out of a $${startingCapital} starting seed.

Active (funded) ventures:
${activeList}

Proposed (not yet funded) ventures: ${proposedList}

This treasury funds cheap first experiments, not the ceiling on how big any
venture is allowed to become — keep the budget *ask* realistic against
what's actually left, but keep the *ambition* aimed at a real venture-scale
outcome. Funding here is staged: when the founder reports a real outcome
for a specific milestone on an active venture, use its id and milestone
index above to call report_milestone_progress. Once a venture's current
milestone is marked done and there's a concrete next step, request_tranche
can ask the founder to fund it — never while a tranche is already pending
for that venture.`;
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

// What the Venture Studio's agents see: treasury/venture status, the
// record of what's already been tried and killed, and the latest weekly
// reflection, so ideation compounds instead of resetting every session.
// Not used by the Executive Team — avoiding re-pitches and recalibrating
// on a weekly verdict are ideation concerns, not execution ones.
export function buildStudioContext() {
  return `${buildTreasuryContext()}\n\n${buildPastLessonsContext()}\n\n${buildWeeklyReflectionContext()}`;
}
