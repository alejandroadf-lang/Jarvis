// The latest Road to €1M (see roadmap.js). One record, replaced each time: a
// history of past roadmaps is not something the team's context should grow
// with, and the weekly reflection already keeps the record of what happened.
//
// Split from roadmap.js because the shared context reads it and roadmap.js
// reads the shared context: keeping the store on its own avoids the cycle.

import { readJson, writeJson } from './store.js';

const FILE = 'roadmap.json';

/** {generatedAt, text, costUsd} or null when none has been written. */
export function getLatestRoadmap() {
  return readJson(FILE, {}).latest || null;
}

export function saveRoadmap({ text, costUsd = 0 }) {
  const latest = { generatedAt: new Date().toISOString(), text: String(text || '').trim(), costUsd };
  writeJson(FILE, { latest });
  return latest;
}
