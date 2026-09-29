// Enablers: what helps a team, scored apart from the grade.
//
// McKinsey's Health Institute separates demands (which drive burnout) from
// enablers (which drive good health), and says employers need to work on
// both. The grade measures demands. These signals describe the other side,
// from the same metadata, and are shown as their own score so a team with a
// heavy week and good conditions around it can see both.
//
//  - Blocked work: in-progress items flagged as impediments (BCG: access to
//    resources is one of the four levers against burnout).
//  - Reprioritisation churn: priority changes per person per week (Gartner:
//    change fatigue cuts intent to stay by up to 42%).
//  - Self-assigned work: the share of assignments people made to themselves
//    (Gartner: autonomy lowers fatigue). A team share, never per person.
//  - Solo work: the share of items only one person touched in a week (a
//    bus-factor proxy: no backup means no real vacation).

import { meanOf, statusOf } from './score.mjs';

export const ENABLER_BANDS = Object.freeze({
  blockedShare: { good: 0.1, poor: 0.3, label: 'Work in progress that is blocked', text: (v) => `${pct(v)} of work in progress is flagged as blocked.`, action: 'Clear one blocker a day at stand-up, before starting anything new.' },
  reprioritisationRate: { good: 0.5, poor: 2, label: 'Priorities changing mid-flight', text: (v) => `Priorities changed ${num(v)} times per person this week.`, action: 'Batch priority changes into planning, not the middle of the week.' },
  selfAssignedShare: { good: 0.6, poor: 0.2, higherIsBetter: true, label: 'Work people pick up themselves', text: (v) => `${pct(v)} of assignments were people picking up work themselves.`, action: 'Let people pull work from a ready column instead of being handed it.' },
  soloShare: { good: 0.5, poor: 0.85, label: 'Work only one person touches', text: (v) => `${pct(v)} of items touched this week had only one person on them.`, action: 'Pair on one item a week so nobody is the only one who can cover it.' },
});

const pct = (v) => `${Math.round(v * 20) * 5}%`;
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function enablerScore(key, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const { good, poor, higherIsBetter } = ENABLER_BANDS[key];
  if (higherIsBetter) {
    if (value >= good) return 100;
    if (value <= poor) return 0;
    return Math.round((100 * (value - poor)) / (good - poor));
  }
  if (value <= good) return 100;
  if (value >= poor) return 0;
  return Math.round(100 * (1 - (value - good) / (poor - good)));
}

export function enablerCard(metrics, snapshot, disabled = {}) {
  const values = {
    blockedShare: snapshot?.blockedShare ?? null,
    reprioritisationRate: metrics?.reprioritisationRate ?? null,
    selfAssignedShare: metrics?.selfAssignedShare ?? null,
    soloShare: metrics?.soloShare ?? null,
  };
  const indicators = [];
  for (const [key, band] of Object.entries(ENABLER_BANDS)) {
    if (disabled[key] === false) continue;
    const score = enablerScore(key, values[key]);
    indicators.push({
      key,
      label: band.label,
      value: values[key] === null ? null : Math.round(values[key] * 20) / 20,
      score,
      status: statusOf(score),
      text: score === null ? 'No data for this period.' : band.text(values[key]),
      action: score === null || score >= 70 ? '' : band.action,
    });
  }
  const score = meanOf(indicators.map((i) => i.score));
  return { score, status: statusOf(score), indicators };
}

export const ENABLER_KEYS = Object.freeze(Object.keys(ENABLER_BANDS));
