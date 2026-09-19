// The record of every turn, what is kept and for how long, the sample a
// person reviews, and the numbers per language.
//
// Four things that every review of a customer-facing agent asks for and
// that a log of the last hundred turns cannot give:
//
//   AN AUDIT TRAIL. One line per event, append-only, with everything about
//   the turn except the words: which ears, brain and voice; the model and
//   the prompt version; the tools called; whether the disclosure had been
//   sent and what the consent state was; the cost; the timings; and every
//   quality flag (wrong language, ungrounded amount, dropped code, short
//   clip, handoff). The caller is a salted hash, so one person's turns can
//   be joined and nobody can be rung from the file.
//
//   RETENTION WITH CLOCKS. Transcripts and conversation histories live for
//   TRAVEL_VOICE_RETENTION_DAYS (six months by default, the period the
//   French regulator names for quality recordings); the review sample for
//   a year; the trail itself, which holds no words, for five. A sweeper
//   runs on start and daily. The disclosure quotes the same number.
//
//   A SAMPLE FOR A PERSON. A few per cent of answered turns are copied,
//   words included, into a queue a person reads — the one control that
//   catches what no automatic check knows to look for. The rate is a
//   variable; the queue is read and cleared from a phone.
//
//   NUMBERS PER LANGUAGE. Regressions hide in aggregates: a French error
//   rate twice the Spanish one averages to "fine". So every figure here is
//   per language first, and the headline is cost per resolved
//   conversation rather than cost per call.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { readJson, writeJson, dataPath } from '../store.js';
import { normalizeNumber } from '../channels/whatsapp.js';
import { SUPPORTED_LANGUAGES } from './languages.js';
import { override as settingOverride } from './settings.js';

const AUDIT_FILE = 'travelVoiceAudit.jsonl';
const REVIEW_FILE = 'travelVoiceReview.json';
const SPEND_FILE = 'travelVoiceSessionSpend.json';
const MAX_REVIEW_QUEUE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long transcripts and conversation histories are kept. Default 180 days. */
export function retentionDays() {
  return daysFromEnv('TRAVEL_VOICE_RETENTION_DAYS', 180);
}

/** How long a sampled turn waits in the review queue. Default a year. */
export function reviewRetentionDays() {
  return daysFromEnv('TRAVEL_VOICE_REVIEW_RETENTION_DAYS', 365);
}

/** How long the (wordless) audit trail is kept. Default five years. */
export function auditRetentionDays() {
  return daysFromEnv('TRAVEL_VOICE_AUDIT_RETENTION_DAYS', 5 * 365);
}

/** Share of answered turns copied for a person to read. Default 3%. */
export function reviewSamplePercent() {
  const pinned = settingOverride('sample');
  if (pinned !== undefined) return pinned;
  const value = Number(process.env.TRAVEL_VOICE_REVIEW_SAMPLE_PCT);
  return Number.isFinite(value) && value >= 0 ? Math.min(100, value) : 3;
}

// --- who ---------------------------------------------------------------------------

/**
 * A stable, salted hash of a caller's number: joins their turns in the
 * trail without putting a number in it. The salt is a variable so a copy
 * of the trail and a copy of the code do not together reveal anyone.
 */
export function callerKey(number) {
  const digits = normalizeNumber(number);
  if (!digits) return null;
  const salt = process.env.TRAVEL_VOICE_AUDIT_SALT || 'jarvis-travel-voice';
  return crypto.createHash('sha256').update(`${salt}:${digits}`).digest('hex').slice(0, 16);
}

// --- the trail --------------------------------------------------------------------

// The fields that carry words. Never written to the trail.
const WORDS = new Set(['transcript', 'reply', 'text', 'detail']);

/**
 * Appends one event. `entry` is a turn-log entry (see index.js) plus
 * whatever the caller adds; the words are stripped here, so a mistake
 * upstream cannot put a transcript in the trail.
 */
export function recordAudit(entry) {
  try {
    const line = {};
    for (const [key, value] of Object.entries(entry || {})) {
      if (WORDS.has(key)) continue;
      line[key] = value;
    }
    if (!line.at) line.at = new Date().toISOString();
    fs.appendFileSync(dataPath(AUDIT_FILE), `${JSON.stringify(line)}\n`);
  } catch (err) {
    console.error('Travel voice: could not write the audit trail:', err.message);
  }
}

/** Every event since `since` (a Date or ms), oldest first. */
export function readAudit({ since = 0 } = {}) {
  const file = dataPath(AUDIT_FILE);
  if (!fs.existsSync(file)) return [];
  const cutoff = since instanceof Date ? since.getTime() : Number(since) || 0;
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw);
      if (Date.parse(line.at) >= cutoff) out.push(line);
    } catch {
      // A torn line from a crash mid-write is skipped, not fatal.
    }
  }
  return out;
}

// --- the sample ----------------------------------------------------------------------

function loadReview() {
  const data = readJson(REVIEW_FILE, { queue: [], reviewed: [] });
  if (!Array.isArray(data.queue)) data.queue = [];
  if (!Array.isArray(data.reviewed)) data.reviewed = [];
  return data;
}

/**
 * Decides whether this turn is one a person reads, and files it if so.
 * `random` is injectable so a test can make the decision deterministic.
 */
export function maybeSample(turn, { random = Math.random } = {}) {
  const pct = reviewSamplePercent();
  if (pct <= 0 || random() * 100 >= pct) return null;
  const data = loadReview();
  const id = `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const item = {
    id,
    at: new Date().toISOString(),
    caller: callerKey(turn.from) || turn.from || null,
    language: turn.language || null,
    voice: Boolean(turn.voice),
    providers: turn.providers || null,
    model: turn.model || null,
    transcript: String(turn.transcript || '').slice(0, 2000),
    reply: String(turn.reply || '').slice(0, 4000),
    flags: turn.flags || {},
  };
  data.queue.push(item);
  if (data.queue.length > MAX_REVIEW_QUEUE) data.queue = data.queue.slice(-MAX_REVIEW_QUEUE);
  writeJson(REVIEW_FILE, data);
  return item;
}

export function reviewQueue(limit = 5) {
  return loadReview().queue.slice(0, limit);
}

export function reviewQueueSize() {
  return loadReview().queue.length;
}

/** A person's verdict on one sampled turn. Moves it out of the queue, keeps the verdict. */
export function markReviewed(id, { verdict, note = '', by = null } = {}) {
  const data = loadReview();
  const index = data.queue.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const [item] = data.queue.splice(index, 1);
  const entry = { id: item.id, at: item.at, reviewedAt: new Date().toISOString(), language: item.language, verdict, note: String(note || '').slice(0, 500), by: by ? callerKey(by) : null };
  data.reviewed.push(entry);
  if (data.reviewed.length > MAX_REVIEW_QUEUE) data.reviewed = data.reviewed.slice(-MAX_REVIEW_QUEUE);
  writeJson(REVIEW_FILE, data);
  recordAudit({ kind: 'review', ...entry, note: undefined });
  return entry;
}

export function reviewVerdicts() {
  return loadReview().reviewed;
}

// --- spend per conversation ----------------------------------------------------------------

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** The cap one conversation may spend in a UTC day. Default $1. */
export function sessionCapUsd() {
  const pinned = settingOverride('cap');
  if (pinned !== undefined) return pinned;
  const value = Number(process.env.TRAVEL_VOICE_SESSION_CAP_USD);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function loadSpend() {
  const data = readJson(SPEND_FILE, { sessions: {} });
  if (!data.sessions) data.sessions = {};
  return data;
}

export function sessionSpendToday(sessionId) {
  return loadSpend().sessions[sessionId]?.[dayKey()] || 0;
}

export function recordSessionSpend(sessionId, usd) {
  if (!Number.isFinite(usd) || usd <= 0) return sessionSpendToday(sessionId);
  const data = loadSpend();
  const days = data.sessions[sessionId] || {};
  days[dayKey()] = (days[dayKey()] || 0) + usd;
  // Only today and yesterday matter; the rest is in the trail.
  const keep = new Set([dayKey(), dayKey(new Date(Date.now() - DAY_MS))]);
  for (const day of Object.keys(days)) if (!keep.has(day)) delete days[day];
  data.sessions[sessionId] = days;
  writeJson(SPEND_FILE, data);
  return days[dayKey()];
}

/** Whether a conversation may spend more today. */
export function sessionUnderCap(sessionId, cap = sessionCapUsd()) {
  return sessionSpendToday(sessionId) < cap;
}

// --- retention ----------------------------------------------------------------------------

/**
 * Applies the clocks. Returns what was removed. Safe to run at any time
 * and idempotent; the caller decides when (start, daily, TRAVEL SWEEP).
 *
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {(cutoffMs:number) => number} [opts.sweepConversations] removes
 *   conversation histories and log entries older than the cutoff; owned
 *   by index.js, which knows where they live
 */
export function sweepRetention({ now = Date.now(), sweepConversations = null } = {}) {
  const removed = { conversations: 0, reviewItems: 0, auditLines: 0 };

  const transcriptCutoff = now - retentionDays() * DAY_MS;
  if (sweepConversations) removed.conversations = sweepConversations(transcriptCutoff) || 0;

  const review = loadReview();
  const reviewCutoff = now - reviewRetentionDays() * DAY_MS;
  const before = review.queue.length + review.reviewed.length;
  review.queue = review.queue.filter((item) => Date.parse(item.at) >= reviewCutoff);
  review.reviewed = review.reviewed.filter((item) => Date.parse(item.reviewedAt || item.at) >= reviewCutoff);
  removed.reviewItems = before - review.queue.length - review.reviewed.length;
  if (removed.reviewItems) writeJson(REVIEW_FILE, review);

  const file = dataPath(AUDIT_FILE);
  if (fs.existsSync(file)) {
    const auditCutoff = now - auditRetentionDays() * DAY_MS;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    const kept = lines.filter((raw) => {
      try {
        return Date.parse(JSON.parse(raw).at) >= auditCutoff;
      } catch {
        return false;
      }
    });
    removed.auditLines = lines.length - kept.length;
    if (removed.auditLines) fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
  }

  recordAudit({ kind: 'sweep', ...removed, retentionDays: retentionDays(), reviewRetentionDays: reviewRetentionDays(), auditRetentionDays: auditRetentionDays() });
  return removed;
}

// --- the numbers ---------------------------------------------------------------------------

function blank() {
  return {
    turns: 0,
    answered: 0,
    voice: 0,
    failed: 0,
    costUsd: 0,
    latencyMs: 0,
    latencyCount: 0,
    wrongLanguage: 0,
    wrongLanguageFixed: 0,
    ungrounded: 0,
    droppedCodes: 0,
    readBacks: 0,
    shortClips: 0,
    handoffs: 0,
    consentRequired: 0,
    tooLong: 0,
  };
}

function finish(bucket) {
  const per = (n) => (bucket.answered ? n / bucket.answered : null);
  return {
    ...bucket,
    costPerAnswer: per(bucket.costUsd),
    avgLatencyMs: bucket.latencyCount ? Math.round(bucket.latencyMs / bucket.latencyCount) : null,
    wrongLanguageRate: per(bucket.wrongLanguage),
    ungroundedRate: per(bucket.ungrounded),
    entityIssueRate: per(bucket.droppedCodes + bucket.readBacks),
    handoffRate: per(bucket.handoffs),
  };
}

/**
 * The figures for the last `days`, per language and in total.
 *
 * A conversation is one caller on one day. It counts as resolved when it
 * had at least one answered turn, no failure, and no handoff — the advisor
 * finished the job. Cost per resolved conversation is the whole period's
 * spend over that count, so the cost of the conversations that did not
 * resolve is carried by the ones that did, which is what it costs.
 */
export function metrics({ days = 7, now = Date.now() } = {}) {
  const since = now - days * DAY_MS;
  const events = readAudit({ since });
  const byLanguage = Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l, blank()]));
  const total = blank();
  const conversations = new Map(); // caller+day -> { answered, failed, handoff, costUsd }

  for (const e of events) {
    if (!e.stage) continue;
    const l = SUPPORTED_LANGUAGES.includes(e.language) ? e.language : null;
    const buckets = l ? [byLanguage[l], total] : [total];
    const cost = Number(e.costUsd) || 0;
    const key = `${e.caller || e.from || '?'}:${String(e.at).slice(0, 10)}`;
    const conv = conversations.get(key) || { answered: 0, failed: 0, handoff: 0, costUsd: 0 };
    conv.costUsd += cost;
    conversations.set(key, conv);

    for (const b of buckets) {
      b.turns += 1;
      b.costUsd += cost;
      if (e.stage === 'answered' || e.stage === 'translated') {
        b.answered += 1;
        if (e.voice) b.voice += 1;
        const t = e.timings || {};
        const latency = (t.sttMs || 0) + (t.llmMs || 0) + (t.ttsMs || 0);
        if (latency > 0) {
          b.latencyMs += latency;
          b.latencyCount += 1;
        }
        if (e.drift) {
          b.wrongLanguage += 1;
          if (e.drift.corrected) b.wrongLanguageFixed += 1;
        }
        if (e.grounding && (e.grounding.stillUngrounded?.length || !e.grounding.corrected)) b.ungrounded += 1;
        if (Array.isArray(e.dropped) && e.dropped.length) b.droppedCodes += 1;
        if (Array.isArray(e.readBack) && e.readBack.length) b.readBacks += 1;
        if (e.shortClip) b.shortClips += 1;
        if (e.words) b.tooLong += 1;
      }
      if (e.stage === 'failed') b.failed += 1;
      if (e.stage === 'handoff_opened' || e.handoff) b.handoffs += 1;
      if (e.stage === 'consent_required') b.consentRequired += 1;
    }
    if (e.stage === 'answered' || e.stage === 'translated') conv.answered += 1;
    if (e.stage === 'failed') conv.failed += 1;
    if (e.stage === 'handoff_opened' || e.handoff) conv.handoff += 1;
  }

  let resolved = 0;
  for (const conv of conversations.values()) {
    if (conv.answered > 0 && conv.failed === 0 && conv.handoff === 0) resolved += 1;
  }

  return {
    days,
    since: new Date(since).toISOString(),
    languages: Object.fromEntries(Object.entries(byLanguage).map(([l, b]) => [l, finish(b)])),
    total: finish(total),
    conversations: conversations.size,
    resolvedConversations: resolved,
    costPerResolvedConversation: resolved ? total.costUsd / resolved : null,
    reviewQueue: reviewQueueSize(),
    reviewed: reviewVerdicts().length,
  };
}

export function __resetAuditForTests() {
  const file = dataPath(AUDIT_FILE);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  writeJson(REVIEW_FILE, { queue: [], reviewed: [] });
  writeJson(SPEND_FILE, { sessions: {} });
}
