// Persists conversation history for all three chat modes (Jarvis, Executive
// Team, Venture Studio) to disk, so it survives a server restart — before
// this, every session lived only in an in-memory Map and vanished the
// moment the process stopped, which matters more the longer this app is
// meant to run as an actual company. One JSON file, one key per mode.

import { readJson, writeJson } from './store.js';

const FILE = 'sessions.json';

function load() {
  return readJson(FILE, { jarvis: {}, company: {}, studio: {} });
}

// Returns a Map(sessionId -> messages[]) for the given mode, seeded from disk.
export function loadSessions(kind) {
  const data = load();
  return new Map(Object.entries(data[kind] || {}));
}

export function saveSession(kind, sessionId, history) {
  const data = load();
  data[kind] = data[kind] || {};
  data[kind][sessionId] = history;
  writeJson(FILE, data);
}

export function deleteSession(kind, sessionId) {
  const data = load();
  if (data[kind]) delete data[kind][sessionId];
  writeJson(FILE, data);
}
