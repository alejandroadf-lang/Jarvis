// From metrics to a grade a manager can act on.
//
// ## Why these indicators
//
// ISO 45003 (psychological health and safety at work) lists the psychosocial
// hazards an employer is expected to identify and manage. Two of them leave
// traces in Jira and Confluence without asking anyone anything:
//
//  - Working hours and schedule: activity after quiet hours and on weekend
//    days. A team that ships at 23:00 every night is a hazard the standard
//    names, whatever the sprint report says.
//  - Workload and work pace: how unevenly work is spread (one person carrying
//    half the team's activity), how many people carry far more open work than
//    the team's median, and how much of the open work is overdue.
//
// Other hazards in the standard (job control, support, role clarity, change,
// remote work) do not show up in these tools reliably, and the app says so
// rather than inventing a number for them.
//
// ## Why linear bands
//
// Each indicator maps to 0-100 between a "good" value (100) and a "poor" value
// (0). The bands below are starting points from published workload and
// overtime research, not calibrated cut-offs; the pilot plan in PLAN.md exists
// to calibrate them against teams' own outcomes (sick days, attrition, survey
// scores). They live in one table so that calibration is a one-line change.
//
// An indicator with no data is left out of the mean rather than counted as 0
// or 100. A brand-new installation therefore shows "not enough data yet"
// instead of a misleading A or E.

export const BANDS = Object.freeze({
  afterHoursShare: { good: 0.08, poor: 0.25, label: 'Activity outside working hours' },
  weekendShare: { good: 0.04, poor: 0.15, label: 'Activity on weekend days' },
  // Excess concentration: the busiest person's share minus a fair share (1/n).
  concentration: { good: 0.1, poor: 0.35, label: 'Work concentrated on one person' },
  overloadedShare: { good: 0.0, poor: 0.3, label: 'People carrying far more open work than the team' },
  overdueShare: { good: 0.08, poor: 0.3, label: 'Open work that is overdue' },
});

export const DIMENSIONS = Object.freeze({
  hours: { label: 'Working hours and schedule', indicators: ['afterHoursShare', 'weekendShare'] },
  workload: { label: 'Workload and work pace', indicators: ['concentration', 'overloadedShare', 'overdueShare'] },
});

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
  const values = {
    afterHoursShare: metrics?.afterHoursShare ?? null,
    weekendShare: metrics?.weekendShare ?? null,
    concentration: null,
    overloadedShare: snapshot?.overloadedShare ?? null,
    overdueShare: snapshot?.overdueShare ?? null,
  };
  if (metrics && metrics.topShare !== null && metrics.contributors > 0) {
    values.concentration = Math.max(0, metrics.topShare - 1 / metrics.contributors);
  }
  return values;
}

const percent = (v) => `${Math.round(v * 100)}%`;

function describe(key, value) {
  switch (key) {
    case 'afterHoursShare':
      return `${percent(value)} of activity happened outside working hours.`;
    case 'weekendShare':
      return `${percent(value)} of activity happened on weekend days.`;
    case 'concentration':
      return value < 0.05
        ? 'Activity is spread evenly across the team.'
        : `The busiest person did ${percent(value)} more of the activity than an even share.`;
    case 'overloadedShare':
      return value === 0
        ? 'Nobody carries far more open work than the team median.'
        : `${percent(value)} of people carry at least twice the team's median open work.`;
    case 'overdueShare':
      return `${percent(value)} of open work is past its due date.`;
    default:
      return '';
  }
}

/** The full scorecard for one period. */
export function scorecard(metrics, snapshot) {
  const values = indicatorValues(metrics, snapshot);
  const dimensions = {};
  for (const [dimKey, dim] of Object.entries(DIMENSIONS)) {
    const indicators = dim.indicators.map((key) => {
      const value = values[key];
      const score = indicatorScore(key, value);
      return {
        key,
        label: BANDS[key].label,
        value,
        score,
        status: statusOf(score),
        text: score === null ? 'No data for this period.' : describe(key, value),
      };
    });
    const score = mean(indicators.map((i) => i.score));
    dimensions[dimKey] = { key: dimKey, label: dim.label, score, status: statusOf(score), indicators };
  }
  const score = mean(Object.values(dimensions).map((d) => d.score));
  return { score, grade: gradeOf(score), status: statusOf(score), dimensions };
}

/** Change against the mean of earlier scores. ±5 points is noise. */
export function trend(current, earlier) {
  const base = mean(earlier);
  if (current === null || base === null) return { delta: null, direction: 'flat' };
  const delta = current - base;
  return { delta, direction: delta > 5 ? 'up' : delta < -5 ? 'down' : 'flat' };
}
