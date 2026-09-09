// Stores the output of the weekly reflection cycle (see
// weeklyReflection.js): one reflection per week, keyed by the UTC date of
// the Sunday it covers up to, so a second run in the same week overwrites
// rather than duplicates.

import { readJson, writeJson } from './store.js';

const FILE = 'weeklyReflections.json';

function load() {
  return readJson(FILE, { reflections: {} });
}

// The Sunday (UTC) on or before `date` — the key for "the week ending on
// this date". Matches server/weeklyScheduler.js's target day (0 = Sunday).
export function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export function listWeeklyReflections() {
  const { reflections } = load();
  return Object.values(reflections).sort((a, b) => (a.weekEnding < b.weekEnding ? 1 : -1));
}

export function getWeeklyReflection(weekEnding) {
  const { reflections } = load();
  return reflections[weekEnding] || null;
}

export function getLatestWeeklyReflection() {
  return listWeeklyReflections()[0] || null;
}

export function hasReflectionForThisWeek() {
  return Boolean(getWeeklyReflection(weekKey()));
}

export function saveWeeklyReflection(reflection) {
  const data = load();
  data.reflections[reflection.weekEnding] = reflection;
  writeJson(FILE, data);
  return reflection;
}
