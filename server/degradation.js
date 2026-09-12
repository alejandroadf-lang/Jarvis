// Records when an agent ran on a model other than the one it was configured
// for, and what that cost extra.
//
// This exists because of a failure that cost weeks and produced no error at
// all. "nousresearch/hermes-4-70b" was retired from OpenRouter; the key was
// still valid, the credit was still there, and every specialist call 404'd
// and fell back to Claude — correctly, silently, at 25x the intended price.
// The only trace was a console.warn in a log nobody reads, and the founder
// found out because they happened to run an integration check.
//
// That is the real multi-provider failure mode. An outage is loud: things
// break, somebody notices. Degradation just works, slightly worse and much
// more expensively, forever. So the fallback path writes here, and the
// number reaches the founder on its own rather than waiting to be asked for.
//
// Deliberately not an alert that fires per event: twelve specialists falling
// back on one turn is one problem, not twelve, and a phone that buzzes
// twelve times teaches its owner to ignore it.

import { readJson, writeJson } from './store.js';

const FILE = 'degradation.json';
const DAYS_KEPT = 14;

function load() {
  return readJson(FILE, { days: {} });
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // UTC, like every other day-keyed store here
}

/**
 * One agent turn that ran somewhere other than where it was meant to.
 *
 * @param {{from: string, to: string, reason: string, extraUsd?: number}} event
 */
export function recordFallback({ from, to, reason, extraUsd = 0 }) {
  const data = load();
  const key = dayKey();
  const day = data.days[key] || { count: 0, extraUsd: 0, reasons: {} };

  day.count += 1;
  day.extraUsd += Number.isFinite(extraUsd) && extraUsd > 0 ? extraUsd : 0;
  // Keyed by reason so a hundred identical 404s collapse to one line with a
  // count, rather than a hundred lines the founder has to read past.
  const label = `${from} → ${to}: ${reason}`;
  day.reasons[label] = (day.reasons[label] || 0) + 1;

  data.days[key] = day;

  const keep = Object.keys(data.days).sort().slice(-DAYS_KEPT);
  data.days = Object.fromEntries(keep.map((k) => [k, data.days[k]]));

  writeJson(FILE, data);
  return day;
}

export function getDegradationToday() {
  const day = load().days[dayKey()];
  return day ? { date: dayKey(), ...day } : { date: dayKey(), count: 0, extraUsd: 0, reasons: {} };
}

/**
 * One line for the founder, or '' when nothing degraded.
 *
 * Empty rather than "all good" on purpose: this gets appended to replies and
 * reports, and a reassurance on every single message is noise that makes the
 * one real warning harder to see.
 */
export function describeDegradation() {
  const { count, extraUsd, reasons } = getDegradationToday();
  if (!count) return '';

  const worst = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  const cost = extraUsd > 0 ? ` (about $${extraUsd.toFixed(2)} more than intended)` : '';
  return `⚠️ ${count} agent turn${count === 1 ? '' : 's'} ran on a fallback model today${cost}. Most common: ${worst[0]} ×${worst[1]}.`;
}
