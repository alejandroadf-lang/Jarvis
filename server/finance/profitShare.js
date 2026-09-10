// Every agent earns a share of what the company actually makes.
//
// The founder's framing: "every single agent wins a percentage once we start
// generating money." The hard part isn't the arithmetic, it's the honesty —
// you can't pay an agent for work you never recorded, and until now this app
// recorded *what* happened to a venture without ever recording *who* did it.
// So this is an attribution system first and a payout second.
//
// The design problem it has to survive: agents are told their own balance
// (the founder chose that deliberately), which hands every agent an
// incentive to inflate the number it's paid on. Four things make that hard,
// and only the last one is a prompt:
//
//   1. Contributions are recorded by the system when a real action
//      *succeeds*. There is deliberately no tool an agent can call to claim
//      credit — nothing here is self-reported.
//   2. The pool is a share of `net` from finance/ledger.js, and the only
//      writers to that ledger are log_revenue and log_expense, which require
//      the founder to have reported real money. Neither is wired into the
//      autonomous daily cycle (see dailyMeeting.js), so no unattended run can
//      move the figure the agents are paid on. There's a test for that.
//   3. Credit can't be farmed, because the actions that earn it are already
//      rate-limited per venture — a per-day cap defaulting to 1, plus a
//      cooldown (see ventures.js's enforceRateLimits).
//   4. Only then, prompt framing: the share follows real outcomes, and every
//      event behind a balance is visible to the founder.
//
// Nothing here pays anyone. Agents have no wallets; this is a record of who
// earned what, which is the part that has to be right before any question of
// settlement is even meaningful.

import { readJson, writeJson } from '../store.js';
import { getLedger } from './ledger.js';

const FILE = 'profitShare.json';

// Share of net profit distributed across the agents, as a percentage.
// Everything above this stays with the company.
const DEFAULT_SHARE_PCT = 10;

// The kinds of work that earn credit. Each corresponds to something the
// system observes succeeding, never to something an agent says it did.
export const CONTRIBUTION_KINDS = {
  propose_venture: { label: 'Started a venture', weight: 3 },
  deploy_code: { label: 'Shipped code', weight: 5 },
  send_customer_email: { label: 'Contacted a customer', weight: 3 },
  report_milestone_progress: { label: 'Recorded a milestone outcome', weight: 2 },
  log_contact_note: { label: 'Recorded what a contact said', weight: 1 },
  log_revenue: { label: 'Booked revenue the founder reported', weight: 1 },
  log_expense: { label: 'Booked an expense the founder reported', weight: 1 },
  kill_venture: { label: 'Ended a venture', weight: 2 },
};

// Weights are deliberately flat-ish. A wider spread would make the highest
// paying action the one every agent argues for, which is exactly the
// distortion this is trying to avoid — shipping code is worth more than
// filing a note, but not so much more that it's worth manufacturing.
export function sharePct() {
  // Blank has to mean "unset", not zero. `.env.example` ships every optional
  // var as `NAME=`, and Number('') is 0 — so without this trim an untouched
  // env file would silently set the share to nothing and no agent would ever
  // earn a cent, with no error anywhere to explain why.
  const raw = (process.env.AGENT_PROFIT_SHARE_PCT || '').trim();
  if (!raw) return DEFAULT_SHARE_PCT;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return DEFAULT_SHARE_PCT;
  return pct;
}

function load() {
  return readJson(FILE, { contributions: [] });
}

/**
 * Records that an agent did something real. Called from actionHandlers.js
 * after the underlying action has actually succeeded — never before, so a
 * failed deploy earns nothing.
 */
export function recordContribution({ agentId, kind, ventureId = null, detail = '' }) {
  if (!agentId) return null;
  if (!CONTRIBUTION_KINDS[kind]) return null;

  const data = load();
  const entry = {
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    kind,
    ventureId,
    detail: String(detail).slice(0, 200),
    weight: CONTRIBUTION_KINDS[kind].weight,
    at: new Date().toISOString(),
  };
  data.contributions.push(entry);
  writeJson(FILE, data);
  return entry;
}

export function listContributions(agentId = null) {
  const { contributions } = load();
  return agentId ? contributions.filter((c) => c.agentId === agentId) : contributions;
}

/**
 * The whole picture: the pool, and every agent's slice of it.
 *
 * Shares are by weighted contribution, so an agent that has done nothing
 * earns nothing — "every agent wins a percentage" means every agent who
 * actually worked, which is the only version that can be defended when the
 * founder looks at the events behind a balance.
 */
export function getProfitShare() {
  const { net } = getLedger();
  const pct = sharePct();
  // A share of a loss isn't a thing. Net at or below zero means the pool is
  // empty and every balance reads $0 — earned weight is still tracked, so
  // the moment the company is profitable it distributes without backfilling
  // anything retroactively.
  const poolUsd = net > 0 ? (net * pct) / 100 : 0;

  const contributions = listContributions();
  const byAgent = new Map();
  let totalWeight = 0;

  for (const c of contributions) {
    totalWeight += c.weight;
    const existing = byAgent.get(c.agentId) || { agentId: c.agentId, weight: 0, events: 0, kinds: {} };
    existing.weight += c.weight;
    existing.events += 1;
    existing.kinds[c.kind] = (existing.kinds[c.kind] || 0) + 1;
    byAgent.set(c.agentId, existing);
  }

  const agents = [...byAgent.values()]
    .map((a) => ({
      ...a,
      sharePct: totalWeight > 0 ? (a.weight / totalWeight) * 100 : 0,
      earnedUsd: totalWeight > 0 ? (poolUsd * a.weight) / totalWeight : 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  return { net, sharePct: pct, poolUsd, totalWeight, agents };
}

/**
 * One agent's own position, for its system prompt. Returns zeros rather than
 * null for an agent that hasn't earned yet, so the prompt can always say
 * something true.
 */
export function getAgentEarnings(agentId) {
  const { poolUsd, totalWeight, agents, sharePct: pct } = getProfitShare();
  const mine = agents.find((a) => a.agentId === agentId);
  return {
    agentId,
    events: mine?.events || 0,
    weight: mine?.weight || 0,
    sharePct: mine?.sharePct || 0,
    earnedUsd: mine?.earnedUsd || 0,
    poolUsd,
    companySharePct: pct,
    totalWeight,
  };
}
