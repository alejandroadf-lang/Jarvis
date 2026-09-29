// The team page, condensed for the Rovo agent.
//
// Rovo turns whatever an action returns into prose, so this returns exactly
// what the Team health page already shows its viewers, in fewer words, and
// nothing else: no per-person figure exists in the report to leak, and the
// use ban travels with every answer so the model repeats it rather than
// improvising around it.

import { USE_BAN } from './transparency.mjs';

const WORD = { good: 'fine', watch: 'watch', act: 'act now', unknown: 'no data' };
const DIRECTION = { up: 'improving', down: 'worsening', flat: 'steady' };

/** @param report teamHealth(...) output; @param name the project or space name */
export function briefOf(report, name) {
  const c = report.current;
  const base = { team: name, week: c.week, rules: USE_BAN, open: 'The full picture is on the Team health page of this project or space.' };
  if (!c.hasData) return { ...base, status: 'no data', says: 'No activity has been counted for this team yet.' };
  if (c.suppressed) return { ...base, status: 'too few people', says: `Fewer than ${report.minGroup} people were active, so nothing is shown. This protects individuals and cannot be lowered.` };
  return {
    ...base,
    status: 'graded',
    grade: c.grade,
    score: c.score,
    trend: DIRECTION[report.trend.direction],
    dimensions: Object.values(c.dimensions || {}).map((d) => ({ dimension: d.label, status: WORD[d.status] })),
    changesSuggested: c.actions.map((a) => ({ signal: a.label, finding: a.text, change: a.action })),
    nextGrade: report.path?.target ? { grade: report.path.target, pointsNeeded: report.path.pointsNeeded, levers: report.path.levers.map((l) => l.label) } : null,
    committedThisWeek: report.loop.committed.map((i) => i.label || i.key),
    actionsDone: report.loop.completion.rate === null ? null : `${Math.round(report.loop.completion.rate * 100)}% of closed actions`,
    checks: report.checks.map((k) => k.text),
    notes: report.notes,
  };
}
