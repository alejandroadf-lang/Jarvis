// Circadian's own numbers, back in front of the team.
//
// The Circadian app sends usage events to PostHog (ventures/circadian/src/
// analytics.py): the question it answers is the one to settle before charging
// for anything, is anyone using this, and which parts. But it only ever sent.
// The team planned the product, its pricing and its SEO with no view of
// whether anyone opened the app, made a plan, turned on reminders or connected
// WHOOP. Real outcomes are what make what the team learns true, so this reads
// them back: two small queries a day, kept as a snapshot, one line in the
// shared context and one on Today.md.
//
// Off unless three variables are set. It needs a *personal* API key with the
// Query Read permission (the phc_ project key the app sends with can only
// write) and the project id.
//
// Counts only. Nothing here asks for a person, an IP address or a trip; the
// events carry none of those (see analytics.py), and the queries return event
// totals and distinct anonymous device counts.

import { readJson, writeJson } from './store.js';

const FILE = 'posthog-circadian.json';
const DEFAULT_HOST = 'https://us.posthog.com';

// The events analytics.py sends, and the ones worth a line.
const EVENTS = ['app_opened', 'plan_made', 'calendar_added', 'reminders_on', 'whoop_connected', 'moment_logged', 'morning_feel', 'api_key_issued', '$exception'];

export function posthogReadConfig() {
  const key = (process.env.POSTHOG_PERSONAL_API_KEY || '').trim();
  const project = (process.env.POSTHOG_PROJECT_ID || '').trim();
  if (!key || !project) return null;
  // The query API is on the app host, not the ingestion host the app sends to
  // (eu.i.posthog.com would be refused).
  const host = (process.env.POSTHOG_APP_HOST || DEFAULT_HOST).trim().replace(/\/+$/, '');
  return { key, project, host };
}

export const isPosthogReadConfigured = () => Boolean(posthogReadConfig());

async function hogql(cfg, query, fetchImpl) {
  const res = await fetchImpl(`${cfg.host}/api/projects/${encodeURIComponent(cfg.project)}/query/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, name: 'jarvis usage read-back' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`PostHog refused the key (${res.status}): POSTHOG_PERSONAL_API_KEY must be a personal API key with the Query Read permission, not the phc_ project key`);
  }
  if (!res.ok) throw new Error(`PostHog answered ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.results)) throw new Error('PostHog answered without results');
  return body.results;
}

const inList = EVENTS.map((e) => `'${e}'`).join(', ');

/**
 * Event totals and distinct devices for the last 14 days, split into this week
 * and the one before, and how many devices made a plan on two or more days.
 */
export async function fetchUsage({ fetchImpl = fetch } = {}) {
  const cfg = posthogReadConfig();
  if (!cfg) return null;

  const rows = await hogql(
    cfg,
    `select event, if(timestamp >= now() - interval 7 day, 'this', 'before') as week, count() as events, count(distinct distinct_id) as devices from events where timestamp >= now() - interval 14 day and event in (${inList}) group by event, week`,
    fetchImpl,
  );
  const weeks = { this: {}, before: {} };
  for (const [event, week, events, devices] of rows) {
    if (weeks[week]) weeks[week][event] = { events: Number(events) || 0, devices: Number(devices) || 0 };
  }

  // A second query that is allowed to fail on its own: "did anyone come back"
  // is the more interesting number, and the more likely to hit a SQL dialect
  // surprise, so its failure must not take the totals down with it.
  let returning = null;
  try {
    const r = await hogql(
      cfg,
      `select count() from (select distinct_id from events where event = 'plan_made' and timestamp >= now() - interval 14 day group by distinct_id having count(distinct toDate(timestamp)) >= 2)`,
      fetchImpl,
    );
    returning = Number(r?.[0]?.[0]);
    if (!Number.isFinite(returning)) returning = null;
  } catch (err) {
    console.error('PostHog read-back: the returning-devices query failed:', err.message);
  }
  return { at: new Date().toISOString(), weeks, returning };
}

/** Fetches and keeps the snapshot. Never throws; says nothing when unconfigured. */
export async function refreshPosthog({ fetchImpl } = {}) {
  try {
    const snapshot = await fetchUsage({ fetchImpl });
    if (!snapshot) return null;
    writeJson(FILE, snapshot);
    return snapshot;
  } catch (err) {
    console.error('PostHog read-back failed:', err.message);
    return null;
  }
}

const n = (week, event, field = 'events') => week?.[event]?.[field] || 0;
const arrow = (now, before) => (now > before ? '↑' : now < before ? '↓' : '=');

/** One line on what people did in the app, this week against the last. Empty when nothing has been read. */
export function describeUsage(snapshot) {
  if (!snapshot?.weeks) return '';
  const t = snapshot.weeks.this;
  const b = snapshot.weeks.before;
  const parts = [
    `${n(t, 'app_opened', 'devices')} devices opened it ${arrow(n(t, 'app_opened', 'devices'), n(b, 'app_opened', 'devices'))}`,
    `${n(t, 'plan_made', 'devices')} made a plan (${n(t, 'plan_made')} plans) ${arrow(n(t, 'plan_made', 'devices'), n(b, 'plan_made', 'devices'))}`,
    `${n(t, 'reminders_on', 'devices')} turned reminders on`,
    `${n(t, 'whoop_connected', 'devices')} connected WHOOP`,
  ];
  if (n(t, 'api_key_issued')) parts.push(`${n(t, 'api_key_issued')} API keys issued`);
  if (snapshot.returning !== null && snapshot.returning !== undefined) parts.push(`${snapshot.returning} devices made a plan on two or more days in the last fortnight`);
  if (n(t, '$exception')) parts.push(`${n(t, '$exception')} errors`);
  return `Circadian in the last 7 days (PostHog, arrows against the week before): ${parts.join('; ')}.`;
}

export function latestUsageLine() {
  try {
    return describeUsage(readJson(FILE, null));
  } catch {
    return '';
  }
}

/** For the shared context: what the product's users actually did, if it can be read. */
export function buildPosthogContext() {
  const line = latestUsageLine();
  return line ? `${line} These are anonymous counts from the app; nothing tells you who.` : '';
}
