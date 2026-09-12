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

// How much of a conversation to keep.
//
// This was 20 messages — user and assistant combined, so ten exchanges. Fine
// for a web chat someone opens to ask one thing, badly wrong for WhatsApp,
// where messages are short and a real conversation passes ten exchanges
// before lunch. The founder noticed the obvious way: the CEO stopped
// remembering what they had just agreed.
//
// Capped two ways because each catches what the other misses. A message count
// alone lets a handful of enormous messages dominate the context; a character
// budget alone lets hundreds of one-word replies through. Both are generous
// enough that a normal day of conversation survives intact, and history is
// re-sent on every turn, so neither is free.
// Read per call rather than frozen at import, so these are genuinely
// adjustable from Railway's variables rather than only at the next deploy.
function limit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function messageLength(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  try {
    return JSON.stringify(content || '').length;
  } catch {
    return 0;
  }
}

/**
 * Trims a conversation to what's worth carrying, keeping the most recent.
 * Always returns at least the last message — a turn with no history at all is
 * still better than one that drops what was just said.
 */
export function trimHistory(history) {
  const recent = (history || []).slice(-limit('SESSION_MAX_MESSAGES', 120));

  let total = 0;
  const kept = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const size = messageLength(recent[i]);
    if (kept.length > 0 && total + size > limit('SESSION_MAX_CHARS', 80000)) break;
    kept.unshift(recent[i]);
    total += size;
  }
  return kept;
}
