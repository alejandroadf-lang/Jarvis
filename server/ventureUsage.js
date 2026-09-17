// What the venture actually did, as opposed to what the team thinks it did.
//
// The company measures its own cost precisely — every model call, every token,
// priced and capped (see usage.js and spend.js) — and measures its product's
// use not at all. So the daily report can say what a day cost and cannot say
// whether anybody used the thing, which is the wrong half of the equation to
// know exactly.
//
// This is the receiving end, built deliberately before the venture launches.
// Usage is the one number that cannot be backfilled: a request that was not
// counted when it happened is gone, and "we had customers that first week but
// no idea how many" is a permanent hole in the only evidence that matters. The
// venture's own code needs three lines; this is everything on the other side
// of them.
//
// Counters, not an event log. A per-request log of a product that succeeds
// would outgrow this server's disk in a month, and nothing anyone asks —
// how many calls, from how many customers, failing how often — needs the
// individual rows. Days are the grain because that is what a daily report and
// a monthly invoice both want.

import { readJson, writeJson } from './store.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const FILE = 'ventureUsage.json';

// Ninety days of daily counters per venture. Long enough to see a trend and to
// invoice a quarter, short enough that the file stays small forever.
export const DAYS_KEPT = 90;

// Distinct callers per day, capped. The cap exists because the set is the one
// unbounded thing here: a product that goes viral would otherwise write a
// million identifiers into a JSON file this server rewrites on every request.
// Past this, the count keeps rising and the identities stop being recorded,
// which is the right thing to lose first.
export const MAX_TRACKED_CALLERS = 500;

function load() {
  return readJson(FILE, { ventures: {} });
}

function save(data) {
  writeJson(FILE, data);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The credential a venture's deployed code presents.
 *
 * Minted here and shown to the founder once, because the founder is the only
 * one who can put it where it belongs: the venture's own deployment
 * environment. It is deliberately not readable by any agent tool — an agent
 * writing the venture's code needs to write `os.environ["JARVIS_USAGE_KEY"]`,
 * which requires knowing the variable's name and not its value. A key an agent
 * could read is a key that ends up in a commit.
 */
export function mintIngestKey(ventureId) {
  const data = load();
  const key = `vu_${randomBytes(24).toString('hex')}`;
  data.ventures[ventureId] = { ...(data.ventures[ventureId] || { days: {} }), key, keyMintedAt: new Date().toISOString() };
  save(data);
  return key;
}

export function hasIngestKey(ventureId) {
  return Boolean(load().ventures[ventureId]?.key);
}

export function verifyIngestKey(ventureId, presented) {
  const expected = load().ventures[ventureId]?.key;
  if (!expected || typeof presented !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Length has to match before timingSafeEqual, and comparing lengths first
  // leaks only the length — which the format already gives away.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Records one batch of usage.
 *
 * Batched rather than per-request on purpose. A product calling this server
 * once per inbound request would make this server its latency floor and its
 * availability ceiling, which is an absurd thing to do to a product for the
 * sake of a counter. The venture accumulates and flushes — every minute, every
 * hundred requests, whatever suits it — and a flush that fails is retried or
 * dropped without the customer ever noticing.
 */
export function recordUsage(ventureId, { calls = 0, errors = 0, callers = [], endpoint = '', outcomes = 0 } = {}) {
  const countedCalls = Math.max(0, Math.floor(Number(calls) || 0));
  const countedErrors = Math.max(0, Math.floor(Number(errors) || 0));
  // The outcome is the unit the customer pays for — pages processed, documents
  // extracted — and the number the CEO's objective is written in. Calls are
  // activity; this is the thing the activity was for.
  const countedOutcomes = Math.max(0, Math.floor(Number(outcomes) || 0));
  if (!countedCalls && !countedErrors && !countedOutcomes) {
    throw new Error('A usage report needs at least one call or error to record.');
  }

  const data = load();
  const venture = data.ventures[ventureId] || { days: {} };
  venture.days = venture.days || {};

  const date = today();
  const day = venture.days[date] || { calls: 0, errors: 0, callers: [], endpoints: {}, outcomes: 0 };
  day.calls += countedCalls;
  day.errors += countedErrors;
  day.outcomes = (day.outcomes || 0) + countedOutcomes;

  const seen = new Set(day.callers);
  for (const caller of Array.isArray(callers) ? callers : []) {
    const id = String(caller || '').trim().slice(0, 120);
    if (!id || seen.has(id)) continue;
    if (seen.size >= MAX_TRACKED_CALLERS) break;
    seen.add(id);
  }
  day.callers = [...seen];

  if (endpoint) {
    const name = String(endpoint).slice(0, 120);
    day.endpoints[name] = (day.endpoints[name] || 0) + countedCalls;
  }

  venture.days[date] = day;
  venture.lastSeenAt = new Date().toISOString();

  // Trim by date rather than by count: a venture that goes quiet for a month
  // should lose the old days, not keep them because there were only a few.
  const cutoff = new Date(Date.now() - DAYS_KEPT * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of Object.keys(venture.days)) {
    if (key < cutoff) delete venture.days[key];
  }

  data.ventures[ventureId] = venture;
  save(data);
  return { date, ...day, callers: day.callers.length };
}

/**
 * What a venture did over the last N days.
 *
 * `silent` is the field worth having. A venture with a linked repo, a green
 * deploy and zero calls looks identical in every other view of this app to one
 * that is working — and those are the two most different states a venture can
 * be in.
 */
export function usageSummary(ventureId, { days = 7 } = {}) {
  const venture = load().ventures[ventureId];
  // "Has a record" is not "has reported". Minting a key creates the record, so
  // checking for the object would make a venture that was never instrumented
  // indistinguishable from one that is counting and seeing nobody. Those are
  // the two states this whole module exists to tell apart: one is an
  // engineering problem, the other is a demand problem, and confusing them
  // sends the team to fix the wrong one.
  if (!venture || !Object.keys(venture.days || {}).length) {
    return { known: false, silent: true, days: [], calls: 0, errors: 0, callers: 0, outcomes: 0, errorRate: 0, lastSeenAt: null };
  }

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = Object.entries(venture.days)
    .filter(([date]) => date >= from)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, day]) => ({
      date,
      calls: day.calls,
      errors: day.errors,
      callers: (day.callers || []).length,
      outcomes: day.outcomes || 0,
    }));

  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const errors = rows.reduce((sum, row) => sum + row.errors, 0);
  const outcomes = rows.reduce((sum, row) => sum + row.outcomes, 0);
  // Distinct across the window, not the sum of the daily distincts — the same
  // customer calling every day is one customer, and summing would report seven.
  const callers = new Set();
  for (const [date, day] of Object.entries(venture.days)) {
    if (date < from) continue;
    for (const caller of day.callers || []) callers.add(caller);
  }

  return {
    known: true,
    silent: calls === 0 && outcomes === 0,
    days: rows,
    calls,
    errors,
    outcomes,
    callers: callers.size,
    errorRate: calls ? errors / (calls + errors) : 0,
    lastSeenAt: venture.lastSeenAt || null,
  };
}

/** Every venture that has ever reported, for the daily report. */
export function allUsage({ days = 1 } = {}) {
  const data = load();
  const out = {};
  for (const id of Object.keys(data.ventures)) {
    if (!Object.keys(data.ventures[id].days || {}).length) continue;
    out[id] = usageSummary(id, { days });
  }
  return out;
}
