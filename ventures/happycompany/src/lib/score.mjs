// From metrics to a grade a manager can act on.
//
// ## Why these indicators
//
// ISO 45003 (psychological health and safety at work) lists the psychosocial
// hazards an employer is expected to identify and manage. Five of them leave
// traces in Jira and Confluence without asking anyone anything, and
// SIGNALS.md carries the evidence for each:
//
//  - Hours and recovery: activity after quiet hours, late at night, on rest
//    days; days that span eleven hours or more; streaks without a day off; no
//    week away in three months.
//  - Workload and pace: uneven spread, people far above the team's median
//    open work, overdue work, too much in progress at once.
//  - Fragmentation: many different items and separate bursts in a person-day,
//    and the mention load that drives it.
//  - Deadline pressure: due dates bunching into the same week, priorities
//    inflated to High.
//  - Rework: work reopened after being done.
//
// Other hazards (job control, support, role clarity, change) do not show up
// in these tools reliably, and the page says so instead of inventing a number.
//
// ## Why linear bands
//
// Each indicator maps to 0-100 between a "good" value (100) and a "poor" value
// (0). The bands are starting points from the research cited in SIGNALS.md,
// not calibrated cut-offs; the pilots calibrate them. They live in one table
// so that calibration is a one-line change.
//
// An indicator with no data is left out of the mean rather than counted as 0
// or 100, and an indicator an admin switched off is left out the same way.

export const BANDS = Object.freeze({
  afterHoursShare: { good: 0.08, poor: 0.25, label: 'Activity outside working hours', dimension: 'hours' },
  lateShare: { good: 0.02, poor: 0.1, label: 'Activity late at night', dimension: 'hours' },
  weekendShare: { good: 0.04, poor: 0.15, label: 'Activity on weekends and holidays', dimension: 'hours' },
  longSpanShare: { good: 0.1, poor: 0.35, label: 'Long days', dimension: 'hours' },
  streakShare: { good: 0.0, poor: 0.3, label: 'People without a day off', dimension: 'hours' },
  noRestShare: { good: 0.2, poor: 0.6, label: 'People without a week away in three months', dimension: 'hours' },
  concentration: { good: 0.1, poor: 0.35, label: 'Work concentrated on one person', dimension: 'workload' },
  overloadedShare: { good: 0.0, poor: 0.3, label: 'People carrying far more open work than the team', dimension: 'workload' },
  overdueShare: { good: 0.08, poor: 0.3, label: 'Open work that is overdue', dimension: 'workload' },
  wipMean: { good: 2, poor: 5, label: 'Work in progress per person', dimension: 'workload' },
  carryOverShare: { good: 0.1, poor: 0.25, label: 'Sprint work carried over', dimension: 'workload' },
  inflowRatio: { good: 1.1, poor: 1.5, label: 'New work arriving faster than it is finished', dimension: 'workload' },
  itemsMedian: { good: 4, poor: 10, label: 'Different items touched in a day', dimension: 'fragmentation' },
  burstyShare: { good: 0.1, poor: 0.4, label: 'Days broken into many separate bursts', dimension: 'fragmentation' },
  mentionsPerPersonDay: { good: 3, poor: 8, label: 'Mentions received per person per day', dimension: 'fragmentation' },
  mentionTopShare: { good: 0.25, poor: 0.5, label: 'Mentions landing on one person', dimension: 'fragmentation' },
  dueCrunch: { good: 2, poor: 4, label: 'Due dates bunching into one week', dimension: 'deadline' },
  highPriorityShare: { good: 0.2, poor: 0.5, label: 'Open work marked High or Highest', dimension: 'deadline' },
  unplannedShare: { good: 0.1, poor: 0.3, label: 'Work created mid-sprint', dimension: 'deadline' },
  dueMoveRate: { good: 0.1, poor: 0.35, label: 'Due dates being moved', dimension: 'deadline' },
  loadSurge: { good: 1.3, poor: 2, label: 'Workload surge this week', dimension: 'deadline' },
  reopenRate: { good: 0.05, poor: 0.15, label: 'Work reopened after being done', dimension: 'rework' },
});

export const DIMENSIONS = Object.freeze({
  hours: { label: 'Hours and recovery' },
  workload: { label: 'Workload and pace' },
  fragmentation: { label: 'Fragmentation' },
  deadline: { label: 'Deadline pressure' },
  rework: { label: 'Rework' },
});

export const INDICATOR_KEYS = Object.freeze(Object.keys(BANDS));

export function indicatorScore(key, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const { good, poor } = BANDS[key];
  if (value <= good) return 100;
  if (value >= poor) return 0;
  return Math.round(100 * (1 - (value - good) / (poor - good)));
}

function mean(values) {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (!present.length) return null;
  return Math.round(present.reduce((a, b) => a + b, 0) / present.length);
}

export function statusOf(score) {
  if (score === null) return 'unknown';
  if (score >= 70) return 'good';
  if (score >= 45) return 'watch';
  return 'act';
}

export { mean as meanOf };

export function gradeOf(score) {
  if (score === null) return null;
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}

/** Indicator values from period metrics (activity) and the open-work snapshot. */
export function indicatorValues(metrics, snapshot) {
  const m = metrics || {};
  const s = snapshot || {};
  const values = {
    afterHoursShare: m.afterHoursShare ?? null,
    lateShare: m.lateShare ?? null,
    weekendShare: m.weekendShare ?? null,
    longSpanShare: m.longSpanShare ?? null,
    streakShare: m.streakShare ?? null,
    noRestShare: m.noRestShare ?? null,
    concentration: null,
    overloadedShare: s.overloadedShare ?? null,
    overdueShare: s.overdueShare ?? null,
    wipMean: s.wipMean ?? null,
    carryOverShare: m.carryOverShare ?? null,
    inflowRatio: m.inflowRatio ?? null,
    unplannedShare: m.unplannedShare ?? null,
    dueMoveRate: m.dueMoveRate ?? null,
    loadSurge: m.loadSurge ?? null,
    itemsMedian: m.itemsMedian ?? null,
    burstyShare: m.burstyShare ?? null,
    mentionsPerPersonDay: m.mentionsPerPersonDay ?? null,
    mentionTopShare: m.mentionTopShare ?? null,
    dueCrunch: s.dueCrunch ?? null,
    highPriorityShare: s.highPriorityShare ?? null,
    reopenRate: m.reopenRate ?? null,
  };
  if (m.topShare !== null && m.topShare !== undefined && m.contributors > 0) {
    values.concentration = Math.max(0, m.topShare - 1 / m.contributors);
  }
  return values;
}

// Shown to the nearest 5%: close enough to act on, too coarse to single out
// one person's contribution in a small team (one action in twenty moves an
// exact share by 5 points; rounded, it usually does not).
const pct = (v) => `${Math.round(v * 20) * 5}%`;
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

// What the number means, and what a manager could do about it. Two sentences,
// no jargon, no blame: the page is read by the people it describes.
const TEXT = {
  afterHoursShare: (v) => [`${pct(v)} of activity happened outside working hours.`, 'Which meeting could move so this work fits inside the day?'],
  lateShare: (v) => [`${pct(v)} of activity happened between 22:00 and 05:00.`, 'Late-night work costs sleep first and quality second. Agree a hard stop.'],
  weekendShare: (v) => [`${pct(v)} of activity happened on weekends or holidays.`, 'Recovery at the weekend decides how Monday starts. Name who is on call, and let everyone else off.'],
  longSpanShare: (v) => [`${pct(v)} of person-days stretched eleven hours or more from first to last action.`, 'Long days are the strongest health signal here. Look at what fills the middle of them.'],
  streakShare: (v) => [`${pct(v)} of active people have not had a day off in a week or more.`, 'Ask them to take the next two days, and cover for them.'],
  noRestShare: (v) => [`${pct(v)} of the team has had no week away in three months.`, 'A vacation with Jira in it is not a vacation. Plan real absences into the roadmap.'],
  concentration: (v) => (v < 0.05 ? ['Activity is spread evenly across the team.', ''] : [`The busiest person did ${pct(v)} more of the activity than an even share.`, 'Move two pieces of their work to someone else this week.']),
  overloadedShare: (v) => (v === 0 ? ['Nobody carries far more open work than the team median.', ''] : [`${pct(v)} of people carry at least twice the team's median open work.`, 'Rebalance before the next planning, not at it.']),
  overdueShare: (v) => [`${pct(v)} of open work is past its due date.`, 'Re-date or drop what will not happen; overdue lists are a standing reproach.'],
  wipMean: (v) => [`People have ${num(v)} items in progress at once on average.`, 'Finish before starting: a work-in-progress limit of two per person.'],
  itemsMedian: (v) => [`A typical person-day touches ${num(v)} different items.`, 'That is context switching. Protect one two-hour block a day with no tickets.'],
  burstyShare: (v) => [`${pct(v)} of person-days were broken into four or more separate bursts.`, 'Work is happening in the gaps between meetings. Fewer, shorter meetings first.'],
  mentionsPerPersonDay: (v) => [`People receive ${num(v)} mentions a day on average.`, 'Every mention is an expectation to answer. Agree when mentions are appropriate.'],
  mentionTopShare: (v) => [`${pct(v)} of all mentions land on one person.`, 'That person is the team’s bottleneck and its burnout risk. Share their knowledge deliberately.'],
  dueCrunch: (v) => [`The busiest due-date week holds ${num(v)}× the usual load.`, 'Spread the dates, or accept now that some will slip.'],
  highPriorityShare: (v) => [`${pct(v)} of open work is marked High or Highest.`, 'When everything is urgent nothing is. Agree a priority budget.'],
  reopenRate: (v) => [`${pct(v)} of finished work was reopened.`, 'Rework is demoralising. Look at the definition of done and the review step.'],
  carryOverShare: (v) => [`${pct(v)} of sprint work was carried over unfinished.`, 'Commit to less next sprint, on purpose, and see whether the carry-over stops.'],
  inflowRatio: (v) => [`New work arrives ${num(v)}× as fast as work gets finished.`, 'The backlog is growing. Decide what will not be done, and say so.'],
  unplannedShare: (v) => [`${pct(v)} of sprint work was created after the sprint started.`, 'Protect the sprint: unplanned work goes to a named slot, not on top.'],
  dueMoveRate: (v) => [`Due dates moved ${num(v)} times per dated item this week.`, 'Dates that keep moving stop meaning anything and keep the pressure on. Re-plan once, properly.'],
  loadSurge: (v) => [`This week carried ${num(v)}× the usual activity per person.`, 'Quarter ends and releases are predictable. Plan the surge down next time, or plan the recovery after it.'],
};

/** The full scorecard for one period. `disabled` is the admin's per-signal switch set. */
export function scorecard(metrics, snapshot, disabled = {}) {
  const values = indicatorValues(metrics, snapshot);
  const dimensions = {};
  for (const [dimKey, dim] of Object.entries(DIMENSIONS)) dimensions[dimKey] = { key: dimKey, label: dim.label, score: null, status: 'unknown', indicators: [] };
  const all = [];
  for (const key of INDICATOR_KEYS) {
    if (disabled[key] === false) continue;
    const value = values[key];
    const score = indicatorScore(key, value);
    const [text, action] = score === null ? ['No data for this period.', ''] : TEXT[key](value);
    const indicator = { key, label: BANDS[key].label, value, score, status: statusOf(score), text, action };
    dimensions[BANDS[key].dimension].indicators.push(indicator);
    all.push(indicator);
  }
  for (const d of Object.values(dimensions)) {
    d.score = mean(d.indicators.map((i) => i.score));
    d.status = statusOf(d.score);
  }
  const score = mean(Object.values(dimensions).map((d) => d.score));
  const actions = all
    .filter((i) => i.score !== null && i.status !== 'good' && i.action)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);
  return { score, grade: gradeOf(score), status: statusOf(score), dimensions, actions };
}

export const GRADE_FLOORS = Object.freeze({ A: 85, B: 70, C: 55, D: 40, E: 0 });

/** A value as the browser may see it: shares to 5%, other figures to one decimal. */
export function publicValue(key, value) {
  if (value === null || value === undefined) return null;
  const isShare = key.endsWith('Share') || key === 'concentration' || key === 'reopenRate';
  return isShare ? Math.round(value * 20) / 20 : Math.round(value * 10) / 10;
}

/** Change against the mean of earlier scores. ±5 points is noise. */
export function trend(current, earlier) {
  const base = mean(earlier);
  if (current === null || base === null) return { delta: null, direction: 'flat' };
  const delta = current - base;
  return { delta, direction: delta > 5 ? 'up' : delta < -5 ? 'down' : 'flat' };
}
