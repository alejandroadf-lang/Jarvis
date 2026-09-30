// A dollar ceiling on model spend, enforced before every paid call.
//
// usage.js already turned token counts into a cost estimate, but only ever
// to *report* one after the fact — which is no help against the failure this
// guards: an agent loop that keeps calling the API because nothing tells it
// to stop. A per-venture count cap ("3 deploys a week") doesn't help either,
// since the runaway spend happens in the model calls between actions, not in
// the actions themselves.
//
// So the ledger here accumulates real per-call cost as it happens, and
// agentRunner.js checks it *before* each request rather than after. The cap
// resets with the UTC day, matching how every other date-keyed store in this
// app (daily reports, weekly reflections) already thinks about "a day".

import { AsyncLocalStorage } from 'node:async_hooks';
import { readJson, writeJson } from './store.js';
import { formatUsd } from './usage.js';

const FILE = 'spend.json';
const DEFAULT_DAILY_CAP_USD = 5;
const DAYS_KEPT = 30;

function load() {
  // `cache` is absent in every file written before caching was metered, so it
  // is defaulted rather than assumed — an older ledger keeps its dollar
  // history and simply reports no cache figures for those days.
  return readJson(FILE, { days: {}, cache: {} });
}

// Where spend came from, without threading two arguments through every call.
//
// The ledger knew what a day cost and nothing about why: a $8 day could be the
// morning meeting, the Studio, the pitch, or forty WhatsApp messages, and every
// cut made was a guess. So the entry points name their source
// (withSpendContext({source: 'meeting'}, ...)) and the runner names the agent,
// and recordSpend, which every paid call already passes through, reads them.
// Anything unnamed is 'chat': the founder talking to the company.
const spendContext = new AsyncLocalStorage();

export function withSpendContext(patch, fn) {
  return spendContext.run({ ...(spendContext.getStore() || {}), ...patch }, fn);
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export function dailyCapUsd() {
  const configured = Number(process.env.DAILY_SPEND_CAP_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DAILY_CAP_USD;
}

/** {"YYYY-MM-DD": usd} for the last `days` days that had any spend (oldest kept: DAYS_KEPT). */
export function spendByDay(days = 7, now = new Date()) {
  const since = dayKey(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
  return Object.fromEntries(Object.entries(load().days).filter(([day]) => day >= since));
}

/**
 * Where the last `days` days of spend went: [[name, usd]] by source (meeting,
 * studio, pitch, session, weekly, chat) and by agent, largest first. Only
 * spend recorded since attribution began is here, so the total can be less
 * than spendByDay's.
 */
export function spendBreakdown(days = 7, now = new Date()) {
  const since = dayKey(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
  const bySource = {};
  const byAgent = {};
  for (const [day, entry] of Object.entries(load().by || {})) {
    if (day < since) continue;
    for (const [name, usd] of Object.entries(entry.source)) bySource[name] = (bySource[name] || 0) + usd;
    for (const [name, usd] of Object.entries(entry.agent)) byAgent[name] = (byAgent[name] || 0) + usd;
  }
  const sorted = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const total = Object.values(bySource).reduce((a, b) => a + b, 0);
  return { total, bySource: sorted(bySource), byAgent: sorted(byAgent) };
}

export function getSpendToday() {
  return load().days[dayKey()] || 0;
}

/**
 * How much of today's cached input was read back rather than written.
 *
 * Worth reporting because the alternative is taking it on trust. A cache read
 * costs a tenth of the same tokens uncached; a write costs 1.25x. So a cache
 * that never hits is a 25% surcharge wearing the word "optimisation", and this
 * is the only number that tells the difference. Null when nothing was cached
 * today — which is a different statement from "cached and never read".
 */
export function getCacheSummary() {
  const { write = 0, read = 0 } = load().cache?.[dayKey()] || {};
  if (!write && !read) return null;
  return { writeTokens: write, readTokens: read, hitRate: read / (write + read) };
}

export function getSpendSummary() {
  const spentUsd = getSpendToday();
  const capUsd = dailyCapUsd();
  return { spentUsd, capUsd, date: dayKey(), overCap: spentUsd >= capUsd, cache: getCacheSummary() };
}

/**
 * @param {number} usd what the call cost
 * @param {{cacheWriteTokens?: number, cacheReadTokens?: number}} [tokens] cached
 *   token counts, so the founder can see whether caching is earning its place
 */
export function recordSpend(usd, tokens = {}) {
  if (!Number.isFinite(usd) || usd <= 0) return getSpendToday();

  const data = load();
  const key = dayKey();
  data.days[key] = (data.days[key] || 0) + usd;

  const { source = 'chat', agentId = 'unknown' } = spendContext.getStore() || {};
  data.by = data.by || {};
  const today = data.by[key] || { source: {}, agent: {} };
  today.source[source] = (today.source[source] || 0) + usd;
  today.agent[agentId] = (today.agent[agentId] || 0) + usd;
  data.by[key] = today;

  const write = Number(tokens.cacheWriteTokens) || 0;
  const read = Number(tokens.cacheReadTokens) || 0;
  if (write || read) {
    data.cache = data.cache || {};
    const today = data.cache[key] || { write: 0, read: 0 };
    data.cache[key] = { write: today.write + write, read: today.read + read };
  }

  // Nothing reads further back than the last month, and this file is written
  // on every single API call — prune so it can't grow without bound.
  const cutoff = dayKey(new Date(Date.now() - DAYS_KEPT * 24 * 60 * 60 * 1000));
  for (const day of Object.keys(data.days)) {
    if (day < cutoff) delete data.days[day];
  }
  for (const day of Object.keys(data.cache || {})) {
    if (day < cutoff) delete data.cache[day];
  }
  for (const day of Object.keys(data.by || {})) {
    if (day < cutoff) delete data.by[day];
  }

  writeJson(FILE, data);
  return data.days[key];
}

// Throws rather than returning false: this sits in front of a paid call, and
// a caller that forgot to check the return value would silently spend money.
export function assertUnderDailyCap() {
  const { spentUsd, capUsd } = getSpendSummary();
  if (spentUsd >= capUsd) {
    throw new Error(
      `Daily spend cap reached: ${formatUsd(spentUsd)} of ${formatUsd(capUsd)} used today. Raise DAILY_SPEND_CAP_USD or wait for the UTC day to roll over.`
    );
  }
}

// Cost per unit of revenue and per paying customer, over the last thirty
// days. The company measured cost per day precisely and had no number that
// related it to anything a customer did — KPMG's respondents name exactly this
// visibility as the thing they are now building. Meaningless at zero revenue;
// the first number that matters once there is any.
export function economicsLast30({ revenue = 0, payingCustomers = 0 } = {}) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const days = load().days;
  let spentUsd = 0;
  for (const [day, usd] of Object.entries(days)) {
    if (day >= cutoff) spentUsd += Number(usd) || 0;
  }
  return {
    spentUsd,
    revenue,
    payingCustomers,
    spendPerRevenueUnit: revenue > 0 ? spentUsd / revenue : null,
    spendPerPayingCustomer: payingCustomers > 0 ? spentUsd / payingCustomers : null,
  };
}
