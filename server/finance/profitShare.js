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

// A hard ceiling on the *whole* pool, not on any one agent's slice — at most
// this much of net profit is ever shared, however AGENT_PROFIT_SHARE_PCT is
// set. It's enforced here rather than left to whoever edits the env var,
// because this is the one number in the system that decides how much of the
// company's profit leaves it, and a fat-fingered 100 shouldn't be able to
// give the entire thing away.
export const MAX_SHARE_PCT = 20;

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
  // Without this, 18 of the 24 agents could never earn anything: credit came
  // only from action tools, and a specialist doesn't have one. Every
  // researcher, analyst and critic on the bench was told it had a stake in a
  // pool it was structurally unable to touch, which is worse than not
  // telling it at all — the ideation team in particular exists entirely to
  // be consulted.
  //
  // Weighted lowest deliberately. Answering when asked is real work, but it
  // must not out-earn doing the thing, and it's the one kind of credit a
  // manager could hand out freely — so it's cheap, capped by the runner's
  // own MAX_ROUNDS, and paid for out of the same daily model-spend budget
  // that bounds everything else.
  consulted: { label: 'Gave a specialist opinion when consulted', weight: 1 },
  // The one kind whose weight is not fixed here, because it is the amount.
  //
  // Every other entry pays for an action. This pays for an outcome, and it
  // exists because the table above was quietly telling the company the wrong
  // thing: shipping a file earned 5, booking revenue earned 1. An agent that
  // shipped ten files out-earned one whose work brought in ten thousand
  // dollars, fifty to one. No prompt about a "money mindset" survives an
  // incentive pointing the other way.
  //
  // The fix is not to pay more for log_revenue — that weight of 1 is right,
  // since logging is clerical: the founder reports the money and an agent
  // writes it down. Paying more for typing would reward clerking. The hole
  // was that nothing rewarded *causing* revenue. Credit was recorded the
  // moment an action succeeded and the outcome never fed back, so the email
  // to the customer who paid earned exactly what the email to the customer
  // who ignored it did.
  //
  // So when revenue lands on a venture, the agents who did real work on that
  // venture are credited in proportion to the money — see distributeRevenue.
  revenue_earned: { label: 'Worked on a venture that earned', weight: 0 },
};

// How much credit a dollar of revenue is worth, relative to the table above.
//
// The default puts $100 of revenue at the same weight as one shipped file.
// That is a deliberate ratio rather than a discovered one: it makes a single
// real customer outweigh a week of commits, which is the whole point, while
// staying inside the same order of magnitude as the other kinds so the
// history stays readable. Configurable because it is a judgement, and the
// right number will become obvious once there is any revenue at all to
// look at.
function revenueWeightPerUsd() {
  const configured = (process.env.REVENUE_WEIGHT_PER_USD || '').trim();
  if (!configured) return 0.05;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.05;
}

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
  // Garbage and negatives fall back to the default; a real number that's
  // simply too high is clamped rather than rejected, since someone setting 50
  // wants as much as they can have, not the default they didn't ask for.
  if (!Number.isFinite(pct) || pct < 0) return DEFAULT_SHARE_PCT;
  return Math.min(pct, MAX_SHARE_PCT);
}

// How many individual events stay on the log. Past this the oldest are
// folded into per-agent totals — see compact() for why folding rather than
// deleting is the only safe move here.
//
// Every recordContribution() does a synchronous full-file read *and* rewrite
// (store.js is sync), and it fires on every consultation, so the cost of one
// write grows with the whole history: measured at 1.5ms after 1k entries,
// 6.8ms after 5k, and effectively unusable by 20k. That time blocks the
// event loop, so it stalls the whole server rather than just that agent.
const MAX_KEPT_EVENTS = 500;

function load() {
  const data = readJson(FILE, { contributions: [], totals: {} });
  // Files written before compaction existed have no totals key.
  if (!data.totals) data.totals = {};
  return data;
}

/**
 * Folds the oldest events into per-agent running totals.
 *
 * Deleting them outright would be wrong in a way that's easy to miss:
 * contributions *are* the basis for the share split, so dropping an agent's
 * old work silently reduces what it has earned. Rolling the weight into a
 * total preserves every share exactly while bounding the file — the founder
 * loses the individual event rows for old work, not the earnings behind
 * them.
 */
function compact(data) {
  if (data.contributions.length <= MAX_KEPT_EVENTS) return data;

  const overflow = data.contributions.slice(0, data.contributions.length - MAX_KEPT_EVENTS);
  data.contributions = data.contributions.slice(-MAX_KEPT_EVENTS);

  for (const c of overflow) {
    const t = data.totals[c.agentId] || { weight: 0, events: 0, kinds: {} };
    t.weight += c.weight;
    t.events += 1;
    t.kinds[c.kind] = (t.kinds[c.kind] || 0) + 1;
    data.totals[c.agentId] = t;
  }
  return data;
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
  writeJson(FILE, compact(data));
  return entry;
}

/**
 * Credits the agents who worked on a venture, when that venture earns.
 *
 * Called after log_revenue succeeds, which means after the founder has
 * personally reported money that actually arrived. Nothing here can be
 * triggered by an agent deciding it deserves something: the amount comes
 * from the founder, the recipients come from work already on record, and
 * there is no tool that reaches this function directly.
 *
 * Distribution is by each agent's existing weight on that venture, so the
 * people who built and sold the thing are paid for the thing selling. An
 * agent with no recorded work on the venture gets nothing, however much it
 * has done elsewhere — this is a share of *this* outcome.
 *
 * The agent that called log_revenue is deliberately not special-cased. If
 * the CFO has done real work on the venture it shares like anyone else; if
 * it has not, filing the paperwork earns it the flat weight of 1 that
 * log_revenue already pays and nothing more.
 *
 * @returns {Array<object>} the credits written, newest first
 */
export function distributeRevenue({ ventureId, amountUsd }) {
  if (!ventureId) return [];
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) return [];

  const data = load();

  // Only work on this venture counts, and only work that already happened.
  // Weight is summed per agent so an agent that shipped five files on it has
  // five files' worth of claim, not one.
  const onThisVenture = new Map();
  let totalWeight = 0;
  for (const c of data.contributions) {
    if (c.ventureId !== ventureId) continue;
    // Earlier revenue credits are excluded from the basis. Including them
    // would compound: the first customer would make every later customer
    // pay the same agents more, regardless of who did the work in between.
    if (c.kind === 'revenue_earned') continue;
    onThisVenture.set(c.agentId, (onThisVenture.get(c.agentId) || 0) + c.weight);
    totalWeight += c.weight;
  }

  // Revenue on a venture nobody is on record as having worked on. Possible
  // after history is compacted, or for a venture the founder ran themselves.
  // Crediting everybody would be worse than crediting nobody.
  if (totalWeight <= 0) return [];

  const pot = amount * revenueWeightPerUsd();
  const written = [];
  for (const [agentId, weight] of onThisVenture) {
    const share = (weight / totalWeight) * pot;
    if (share <= 0) continue;
    written.push({
      id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      kind: 'revenue_earned',
      ventureId,
      detail: `$${amount.toFixed(2)} earned; ${((weight / totalWeight) * 100).toFixed(0)}% of the work on this venture`,
      // Rounded to keep the ledger readable; a fraction of a weight point
      // changes no decision and makes every balance look like a rounding
      // error.
      weight: Math.round(share * 100) / 100,
      at: new Date().toISOString(),
    });
  }

  data.contributions.push(...written);
  writeJson(FILE, compact(data));
  return written;
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

  const data = load();
  const byAgent = new Map();
  let totalWeight = 0;

  // Start from whatever has already been folded away, so a compacted history
  // pays out exactly as it did before compaction.
  for (const [agentId, t] of Object.entries(data.totals)) {
    totalWeight += t.weight;
    byAgent.set(agentId, { agentId, weight: t.weight, events: t.events, kinds: { ...t.kinds } });
  }

  for (const c of data.contributions) {
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
