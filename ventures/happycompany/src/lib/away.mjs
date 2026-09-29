// Days a person marks as away, and the one thing the team learns from them.
//
// People mark their own days away (holiday, parental leave, a training week;
// no reason is asked or stored) on the Team health page. The list is kept
// under the person's pseudonym and shown to nobody but that person: not to
// the manager, not to administrators, not in any export.
//
// What it is for: "work on days marked away", the share of a team's
// away-workdays on which the person was still active in this project or
// space. A vacation with Jira in it is not a vacation (SIGNALS.md), and
// without the marks the app can only guess that someone was away.
//
// The share is shown only when at least MIN_AWAY_PEOPLE different people
// were away that week. Colleagues usually know who was on holiday; with one
// or two people away, any share above zero would say who worked through it.

import { addDays } from './time.mjs';
import { isRestDay } from './signals.mjs';
import { RETAIN_DAYS } from './privacy.mjs';

export const MIN_AWAY_PEOPLE = 3;
export const MAX_RANGE_DAYS = 60;
export const MAX_AHEAD_DAYS = 366;
export const MAX_MARKED_DAYS = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const valid = (d) => DAY.test(String(d)) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** Every day from `from` to `to`, checked against what may be marked. */
export function daysInRange(from, to, today) {
  if (!valid(from) || !valid(to)) throw new Error('Dates must be written YYYY-MM-DD.');
  if (to < from) throw new Error('The last day away is before the first.');
  if (from < addDays(today, -RETAIN_DAYS)) throw new Error(`Days more than ${RETAIN_DAYS} days ago can no longer be marked.`);
  if (to > addDays(today, MAX_AHEAD_DAYS)) throw new Error('Mark days up to a year ahead.');
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > MAX_RANGE_DAYS) throw new Error(`Mark at most ${MAX_RANGE_DAYS} days at a time.`);
  }
  return out;
}

/** The stored list after adding or removing days, sorted, without days past retention. */
export function updateAway(current, { add = [], remove = [] }, today) {
  const oldest = addDays(today, -RETAIN_DAYS);
  const set = new Set((current || []).filter((d) => d >= oldest));
  for (const d of add) set.add(d);
  for (const d of remove) set.delete(d);
  const days = [...set].sort();
  if (days.length > MAX_MARKED_DAYS) throw new Error(`At most ${MAX_MARKED_DAYS} days can be marked at once.`);
  return days;
}

/**
 * For one week: of the workdays team members marked away, on how many were
 * they active in this team? `rows` are the week's day buckets up to today;
 * `awayByPerson` maps pseudonym -> marked days for the team's people.
 */
export function awayWorkStats(rows, awayByPerson, weekDays, settings) {
  const activeOn = new Map(rows.map((r) => [r.day, r.bucket?.people || {}]));
  const counted = new Set(rows.map((r) => r.day));
  let awayPeople = 0;
  let awayDays = 0;
  let awayActive = 0;
  for (const [who, marked] of Object.entries(awayByPerson)) {
    const days = weekDays.filter((d) => counted.has(d) && marked.includes(d) && !isRestDay(weekdayOf(d), d, settings));
    if (!days.length) continue;
    awayPeople += 1;
    awayDays += days.length;
    awayActive += days.filter((d) => activeOn.get(d)?.[who]).length;
  }
  return { awayPeople, awayDays, awayActive, awayWorkShare: awayPeople >= MIN_AWAY_PEOPLE ? awayActive / awayDays : null };
}
