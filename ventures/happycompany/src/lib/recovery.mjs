// Recovery: streaks without a day off, and the long gap that a vacation is.
//
// Both are about the calendar, not the clock, so they need activity *days*
// per person across more than one week. Streaks read the 21 days of day
// buckets the app keeps. Rest needs longer memory: whether someone has had
// five workdays off in the last 90 days cannot be answered from 21 days of
// data, so the rollup keeps three dates per pseudonym (first seen, last seen,
// last rest) in one record per team. That is the only per-person data that
// outlives a day bucket, and SIGNALS.md flags it as such.
//
// Why "five workdays": a week away. Weekends and holidays do not break a
// rest and do not count towards it, so a Friday-to-Monday gap over a long
// weekend is two workdays, not four.

import { addDays, localParts } from './time.mjs';
import { isRestDay } from './signals.mjs';

export const STREAK_DAYS = 7; // active seven calendar days in a row
export const NO_TWO_OFF_DAYS = 12; // or twelve days without two consecutive days off
export const REST_WORKDAYS = 5;
export const REST_WINDOW_DAYS = 90;
export const FORGET_AFTER_DAYS = 120; // a person not seen for this long is dropped from the record

/** {pseudonym: Set(day)} from [{day, bucket}] rows. */
export function activeDaysByPerson(rows) {
  const out = {};
  for (const { day, bucket } of rows) {
    for (const [who, p] of Object.entries(bucket?.people || {})) {
      if (!p?.n) continue;
      (out[who] ||= new Set()).add(day);
    }
  }
  return out;
}

function weekdayOf(day) {
  return localParts(`${day}T12:00:00Z`, 'UTC').weekday;
}

/** Whether the person's active days contain a no-recovery streak ending on or before `lastDay`. */
export function hasStreak(days, lastDay) {
  // Seven in a row, anywhere in the window.
  const sorted = [...days].filter((d) => d <= lastDay).sort();
  if (!sorted.length) return false;
  const first = sorted[0];
  let run = 0;
  let cursor = first;
  while (cursor <= lastDay) {
    run = days.has(cursor) ? run + 1 : 0;
    if (run >= STREAK_DAYS) return true;
    cursor = addDays(cursor, 1);
  }
  // Or twelve consecutive days ending at lastDay with no two consecutive days off.
  let off = 0;
  let span = 0;
  cursor = lastDay;
  for (let i = 0; i < NO_TWO_OFF_DAYS; i++) {
    if (cursor < first) return false;
    if (days.has(cursor)) off = 0;
    else {
      off += 1;
      if (off >= 2) return false;
    }
    span += 1;
    cursor = addDays(cursor, -1);
  }
  return span >= NO_TWO_OFF_DAYS;
}

/** Share of people active in `weekDays` who are in a streak. */
export function streakShare(byPerson, weekDays, lastDay) {
  const active = Object.entries(byPerson).filter(([, days]) => weekDays.some((d) => days.has(d)));
  if (!active.length) return null;
  return active.filter(([, days]) => hasStreak(days, lastDay)).length / active.length;
}

/**
 * Updates the per-team people record from the last window of day buckets.
 * record: {pseudonym: {firstSeen, lastSeen, lastRest}}.
 */
export function updatePeopleRecord(record, rows, settings, today) {
  const byPerson = activeDaysByPerson(rows);
  const windowDays = rows.map((r) => r.day).sort();
  const next = { ...record };
  for (const [who, days] of Object.entries(byPerson)) {
    const sorted = [...days].sort();
    const entry = { ...(next[who] || { firstSeen: sorted[0], lastSeen: sorted[0], lastRest: null }) };
    if (sorted[0] < entry.firstSeen) entry.firstSeen = sorted[0];
    if (sorted[sorted.length - 1] > entry.lastSeen) entry.lastSeen = sorted[sorted.length - 1];
    // A rest: REST_WORKDAYS consecutive workdays without activity, inside the
    // window, after the person's first seen day.
    let gap = 0;
    for (const day of windowDays) {
      if (day < entry.firstSeen) continue;
      if (isRestDay(weekdayOf(day), day, settings)) continue;
      gap = days.has(day) ? 0 : gap + 1;
      if (gap >= REST_WORKDAYS && (!entry.lastRest || day > entry.lastRest)) entry.lastRest = day;
    }
    next[who] = entry;
  }
  const forgetBefore = addDays(today, -FORGET_AFTER_DAYS);
  for (const [who, entry] of Object.entries(next)) if (entry.lastSeen < forgetBefore) delete next[who];
  return next;
}

/** Share of people active in the week, and known for 90 days, with no rest in 90 days. */
export function noRestShare(record, activeThisWeek, today) {
  const since = addDays(today, -REST_WINDOW_DAYS);
  const eligible = activeThisWeek.filter((who) => record[who] && record[who].firstSeen <= since);
  if (!eligible.length) return null;
  return eligible.filter((who) => !record[who].lastRest || record[who].lastRest < since).length / eligible.length;
}
