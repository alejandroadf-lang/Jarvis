// Persists conversation history for every chat mode (Jarvis, Executive Team,
// Venture Studio, and the help desk's strangers) to disk, so it survives a
// server restart — before this, every session lived only in an in-memory Map
// and vanished the moment the process stopped, which matters more the longer
// this app is meant to run as an actual company.
//
// One file per mode. It was one file for all of them, rewritten in full after
// every turn in any of them: a WhatsApp desk reply re-serialised every
// founder conversation, and the file only grows. A mode's file holds only that
// mode's sessions, so a turn rewrites what it touched.
//
// The old combined sessions.json is read once per mode, the first time that
// mode's own file does not exist yet, and then never again. It is left where
// it is: it is the only backup of those conversations until the new files
// have been through a restart, and deleting data to tidy up is the wrong way
// round.

import { readJson, writeJson, existsJson } from './store.js';

const LEGACY_FILE = 'sessions.json';

function fileFor(kind) {
  // The mode becomes part of a file name, so it is held to lower-case words:
  // nothing that could name a path (a slash, a dot) gets through.
  if (!/^[a-z][a-z-]*$/.test(String(kind))) throw new Error(`Unknown session mode "${kind}".`);
  return `sessions-${kind}.json`;
}

function load(kind) {
  const file = fileFor(kind);
  if (!existsJson(file) && existsJson(LEGACY_FILE)) {
    writeJson(file, readJson(LEGACY_FILE, {})[kind] || {});
  }
  return readJson(file, {});
}

// Returns a Map(sessionId -> messages[]) for the given mode, seeded from disk.
export function loadSessions(kind) {
  return new Map(Object.entries(load(kind)));
}

export function saveSession(kind, sessionId, history) {
  const data = load(kind);
  data[sessionId] = history;
  writeJson(fileFor(kind), data);
}

export function deleteSession(kind, sessionId) {
  // Deleting from a mode that has never been saved is a no-op, and must not
  // leave an empty file behind for it.
  if (!/^[a-z][a-z-]*$/.test(String(kind)) || (!existsJson(fileFor(kind)) && !existsJson(LEGACY_FILE))) return;
  const data = load(kind);
  if (!(sessionId in data)) return;
  delete data[sessionId];
  writeJson(fileFor(kind), data);
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
