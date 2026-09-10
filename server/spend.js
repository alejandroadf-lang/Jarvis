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

import { readJson, writeJson } from './store.js';
import { formatUsd } from './usage.js';

const FILE = 'spend.json';
const DEFAULT_DAILY_CAP_USD = 5;
const DAYS_KEPT = 30;

function load() {
  return readJson(FILE, { days: {} });
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export function dailyCapUsd() {
  const configured = Number(process.env.DAILY_SPEND_CAP_USD);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DAILY_CAP_USD;
}

export function getSpendToday() {
  return load().days[dayKey()] || 0;
}

export function getSpendSummary() {
  const spentUsd = getSpendToday();
  const capUsd = dailyCapUsd();
  return { spentUsd, capUsd, date: dayKey(), overCap: spentUsd >= capUsd };
}

export function recordSpend(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return getSpendToday();

  const data = load();
  const key = dayKey();
  data.days[key] = (data.days[key] || 0) + usd;

  // Nothing reads further back than the last month, and this file is written
  // on every single API call — prune so it can't grow without bound.
  const cutoff = dayKey(new Date(Date.now() - DAYS_KEPT * 24 * 60 * 60 * 1000));
  for (const day of Object.keys(data.days)) {
    if (day < cutoff) delete data.days[day];
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
