// Local time without a date library.
//
// Every signal in this app is about *when* someone worked in *their* day: an
// issue updated at 23:10 in Bangkok is after-hours, the same instant is 18:10
// in Berlin and is not. Intl.DateTimeFormat gives the local hour, weekday and
// calendar day for any IANA zone, and the Forge Node runtime ships full ICU,
// so there is nothing to bundle.
//
// Weeks are ISO weeks (Monday to Sunday, "2026-W40"). They are the unit the
// page shows and the unit the rollup aggregates to, so they have to be computed
// identically everywhere; this is the only module that does it.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map();

function formatter(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

export function isValidZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The local hour (0-23), weekday (0 = Sunday) and day ("YYYY-MM-DD") of an instant in a zone. */
export function localParts(when, zone) {
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) throw new Error(`not a time: ${when}`);
  const parts = {};
  for (const part of formatter(zone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    hour: Number(parts.hour) % 24,
    weekday: WEEKDAYS.indexOf(parts.weekday),
    day: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function utcDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(day, n) {
  const date = utcDate(day);
  date.setUTCDate(date.getUTCDate() + n);
  return dayKey(date);
}

/** ISO week key of a calendar day, e.g. "2026-W40". */
export function isoWeek(day) {
  const date = utcDate(day);
  const dow = date.getUTCDay() || 7;
  // Shift to the Thursday of the same week: its year is the ISO year.
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The Monday that starts an ISO week. */
export function mondayOf(week) {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) throw new Error(`not a week key: ${week}`);
  const year = Number(match[1]);
  const number = Number(match[2]);
  // 4 January is always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  jan4.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1) + (number - 1) * 7);
  return dayKey(jan4);
}

export function daysOfWeek(week) {
  const monday = mondayOf(week);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The n weeks before `week`, nearest first. */
export function previousWeeks(week, n) {
  const out = [];
  let monday = mondayOf(week);
  for (let i = 0; i < n; i++) {
    monday = addDays(monday, -7);
    out.push(isoWeek(monday));
  }
  return out;
}

/**
 * A Date from a product timestamp, or null when it cannot be read.
 *
 * Jira writes offsets as "+0700"; the ECMAScript date grammar wants "+07:00",
 * and a Date built from the former is engine-dependent. The colon is inserted
 * before parsing so that every engine agrees.
 */
export function parseInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string' || !value) return null;
  const fixed = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(fixed);
  return Number.isNaN(date.getTime()) ? null : date;
}
