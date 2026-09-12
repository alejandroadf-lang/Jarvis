// The team proposes a plan; the founder approves it once; the team executes
// it without asking again.
//
// This is the middle ground between the two bad options. Approving every
// action individually makes the founder the bottleneck on a company whose
// whole point is that it runs itself. Approving nothing makes the scope model
// decorative, because an agent that grants itself a scope has no scope. One
// approved plan is one decision, made with the whole intent visible at once —
// which is also the only way to notice that six reasonable-looking actions
// add up to something you would not have agreed to.
//
// Enforcement is here, at the data layer, not in a prompt. An agent that
// argues its way to a different conclusion still cannot get past a function
// that refuses to return.
//
// --- Why there are no dates in this file any more ---
//
// This was built as a *daily* plan, keyed by calendar date, and that was a
// mistake inherited from how human companies work. A day is a shift: the
// length of time a person can work before going home. Agents don't go home.
//
// The consequence was not theoretical. With one plan per calendar day and an
// approved plan locked, a plan approved in the morning for a venture that
// turned out not to exist froze the company until midnight UTC — unable to do
// the approved work, unable to propose different work, and correctly telling
// the founder it had no lever. Every part of that was working as designed,
// and the design was wrong.
//
// So the unit is now the plan, not the day. A plan is superseded when the
// next one is approved, which can be thirty seconds later. The founder's
// approval still gates every real action; what's gone is the calendar.

import { readJson, writeJson } from './store.js';

const FILE = 'dailyPlans.json';
const MAX_HISTORY = 60;

export const PLAN_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SUPERSEDED: 'superseded',
  WITHDRAWN: 'withdrawn',
};

/** Whether a plan is required before real actions may run. */
export function isPlanRequired() {
  const explicit = (process.env.DAILY_PLAN_REQUIRED || '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  // Handing the team self-service deployment without a plan to approve would
  // be autonomy with nothing bounding it, so turning that on turns this on.
  return Boolean((process.env.AUTONOMOUS_DEPLOY_REPOS || '').trim());
}

// Old files were { plans: { '2026-09-12': {...} } }. Rather than strand
// whatever is live when this deploys, the most recent plan is carried into
// the new shape by its status — an approved one stays in force, a pending one
// stays waiting. Anything older becomes history, which is all it ever was.
function migrate(data) {
  if (!data.plans) return data;
  const dates = Object.keys(data.plans).sort();
  const latest = dates.length ? data.plans[dates[dates.length - 1]] : null;
  const migrated = {
    pending: latest?.status === PLAN_STATUS.PENDING ? latest : null,
    approved: latest?.status === PLAN_STATUS.APPROVED ? latest : null,
    history: dates.slice(0, -1).map((d) => data.plans[d]).reverse(),
  };
  if (latest && !migrated.pending && !migrated.approved) migrated.history.unshift(latest);
  return migrated;
}

function load() {
  const data = readJson(FILE, { pending: null, approved: null, history: [] });
  if (data.plans) return migrate(data);
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}

function save(data) {
  data.history = data.history.slice(0, MAX_HISTORY);
  writeJson(FILE, data);
}

function archive(data, plan, status) {
  if (!plan) return;
  data.history.unshift({ ...plan, status, archivedAt: new Date().toISOString() });
}

/** The plan in force — the only one that clears any real action. */
export function getApprovedPlan() {
  return load().approved;
}

/**
 * What the founder should be looking at: whatever is waiting on them, or
 * failing that whatever is currently in force.
 */
export function getPlan() {
  const data = load();
  return data.pending || data.approved || null;
}

/**
 * Submits intended work for approval. Always allowed.
 *
 * Nothing is blocked by an existing plan, in either direction. A new
 * submission replaces anything pending, and leaves an approved plan in force
 * until this one is approved in its place — so proposing the next piece of
 * work never revokes clearance for work already under way, and never has to
 * wait for a clock.
 */
export function submitPlan({ items, summary, submittedBy }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('A plan needs at least one item saying what the team intends to do.');
  }

  const cleaned = items.map((item, i) => {
    if (!item?.ventureId) throw new Error(`Item ${i + 1} is missing ventureId.`);
    if (!item?.action) throw new Error(`Item ${i + 1} is missing action.`);
    if (!item?.intent) throw new Error(`Item ${i + 1} is missing intent — say what it is for.`);
    return {
      ventureId: String(item.ventureId),
      action: String(item.action),
      target: item.target ? String(item.target) : null,
      intent: String(item.intent),
    };
  });

  const data = load();
  // A pending plan nobody decided on is a draft, not a record.
  archive(data, data.pending, PLAN_STATUS.SUPERSEDED);
  data.pending = {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    status: PLAN_STATUS.PENDING,
    items: cleaned,
    summary: summary ? String(summary) : null,
    submittedBy: submittedBy || null,
    submittedAt: new Date().toISOString(),
    decidedAt: null,
    note: null,
  };
  save(data);
  return data.pending;
}

export function approvePlan({ note } = {}) {
  const data = load();
  if (!data.pending) throw new Error('There is no plan waiting for a decision.');
  // The plan being replaced is archived, not deleted: what was cleared, and
  // when it stopped being cleared, is the audit trail.
  archive(data, data.approved, PLAN_STATUS.SUPERSEDED);
  data.approved = {
    ...data.pending,
    status: PLAN_STATUS.APPROVED,
    decidedAt: new Date().toISOString(),
    note: note ? String(note) : null,
  };
  data.pending = null;
  save(data);
  return data.approved;
}

export function rejectPlan({ reason } = {}) {
  const data = load();
  if (!data.pending) throw new Error('There is no plan waiting for a decision.');
  const rejected = {
    ...data.pending,
    status: PLAN_STATUS.REJECTED,
    decidedAt: new Date().toISOString(),
    note: reason ? String(reason) : null,
  };
  archive(data, rejected, PLAN_STATUS.REJECTED);
  data.pending = null;
  save(data);
  return rejected;
}

/**
 * Revokes clearance the founder already gave.
 *
 * Separate from rejectPlan because they answer different questions: reject is
 * "no, not this", withdraw is "what I already said yes to no longer stands".
 * Without this, approval was a one-way door.
 */
export function withdrawPlan({ reason } = {}) {
  const data = load();
  if (!data.approved) throw new Error('There is no approved plan in force.');
  const withdrawn = { ...data.approved, note: reason ? String(reason) : null };
  archive(data, withdrawn, PLAN_STATUS.WITHDRAWN);
  data.approved = null;
  save(data);
  return withdrawn;
}

/**
 * True when an approved item covers this action.
 *
 * An item with no target covers any target for that action, because "email
 * three prospects" is a reasonable thing to approve without naming them in
 * advance. An item *with* a target covers only that target, because naming
 * one and then acting on another is not what was agreed.
 */
function covers(item, { ventureId, action, target }) {
  if (item.ventureId !== ventureId || item.action !== action) return false;
  if (!item.target) return true;
  if (!target) return false;
  // Prefix matching so a planned path of "src/" covers "src/index.ts", the
  // same way the deployment allowlist already works.
  return target === item.target || target.startsWith(item.target.replace(/\/?$/, '/'));
}

export function isCoveredByApprovedPlan({ ventureId, action, target }) {
  const approved = getApprovedPlan();
  if (!approved) return false;
  return approved.items.some((item) => covers(item, { ventureId, action, target }));
}

/**
 * Throws with a reason worth relaying unless the approved plan covers this.
 * Called by every real action when a plan is required.
 */
export function assertInApprovedPlan({ ventureId, action, target }) {
  if (!isPlanRequired()) return;

  const data = load();
  if (!data.approved) {
    if (data.pending) {
      throw new Error(
        'A plan is waiting on the founder. Nothing runs until they approve it — and nothing is blocking you from ' +
          'submitting a better one right now if this is not it.'
      );
    }
    // A rejection is the most useful thing to say at the point of refusal:
    // without it the agent sees "no plan approved" and resubmits the same
    // plan the founder just turned down.
    const last = data.history[0];
    const because =
      last?.status === PLAN_STATUS.REJECTED && last.note
        ? ` The last plan was rejected: ${last.note}.`
        : '';
    throw new Error(
      `No plan is approved, so nothing is cleared yet.${because} Submit one with submit_daily_plan covering ` +
        `"${action}" and the founder can approve it in one go. You can submit at any time; there is no queue ` +
        'and no waiting for tomorrow.'
    );
  }

  if (!isCoveredByApprovedPlan({ ventureId, action, target })) {
    throw new Error(
      `"${action}"${target ? ` on ${target}` : ''} is not in the approved plan. ` +
        'Either do the work that is in it, or submit a new plan covering this — a new plan can be submitted ' +
        'immediately and replaces this one the moment the founder approves it.'
    );
  }
}

/** For the agent-facing context: what the team is actually cleared to do. */
export function describePlanForAgents() {
  if (!isPlanRequired()) return '';
  const data = load();

  const render = (plan) =>
    plan.items
      .map((item) => `- ${item.action}${item.target ? ` on ${item.target}` : ''} (${item.ventureId}): ${item.intent}`)
      .join('\n');

  // Said explicitly everywhere below, because the absence of it is what made
  // a stuck team conclude it had to wait for tomorrow: there is no clock here.
  const always =
    '\n\nA new plan can be submitted at any time and takes effect the moment the founder approves it. ' +
    'Nothing about this waits for a new day.';

  if (data.pending) {
    return `A plan is waiting on the founder:\n${render(data.pending)}${
      data.approved ? `\n\nStill in force until they decide:\n${render(data.approved)}` : ''
    }${always}`;
  }
  if (data.approved) {
    return `The approved plan. You may do exactly these, and nothing else:\n${render(data.approved)}${always}`;
  }
  const last = data.history[0];
  if (last?.status === PLAN_STATUS.REJECTED) {
    return `The last plan was REJECTED${last.note ? `: ${last.note}` : ''}. Submit a revised one; no real actions run until a plan is approved.${always}`;
  }
  return `No plan is approved, so real actions are blocked. Submit one and the founder can approve it.${always}`;
}

export function listPlans(limit = 30) {
  const data = load();
  return [data.pending, data.approved, ...data.history].filter(Boolean).slice(0, limit);
}

// --- Deciding from a phone --------------------------------------------------
//
// A WhatsApp message from an allowlisted number is the founder, verified by
// Meta's signature and the allowlist — a stronger claim than the web app can
// make, since that has no authentication at all. So the phone is a legitimate
// place to approve from, and the natural one: the plan arrives there anyway.
//
// Parsing is deliberately narrow, and deliberately happens in the server
// rather than the company turn. An agent that interprets "approve" is an
// agent that can conclude it was approved; this way the founder's words go
// straight to the function that records the decision, and the team learns
// about it the same way it learns anything else — by reading the plan.

const APPROVE = /^\s*(approve|approved|approve\s+plan|go\s+ahead)\b\s*[:,\-–—]?\s*(.*)$/i;
const REJECT = /^\s*(reject|rejected|reject\s+plan|decline)\b\s*[:,\-–—]?\s*(.*)$/i;
const STATUS = /^\s*(plan|status|today'?s\s+plan)\s*\??\s*$/i;

/**
 * Reads a founder's reply as a decision, or null when it isn't one.
 *
 * Only ever returns a decision while a plan is actually pending. "Approve"
 * with nothing waiting is far more likely to be part of a sentence than a
 * command, and acting on it would be inventing consent.
 */
export function parsePlanCommand(text) {
  const raw = String(text || '');
  if (STATUS.test(raw)) return { kind: 'status' };

  if (!load().pending) return null;

  const approve = raw.match(APPROVE);
  if (approve) return { kind: 'approve', note: (approve[2] || '').trim() || null };

  const reject = raw.match(REJECT);
  if (reject) return { kind: 'reject', reason: (reject[2] || '').trim() || null };

  return null;
}

/** The plan as a WhatsApp message — short, and explicit about what replying does. */
export function formatPlanForWhatsApp(plan) {
  if (!plan) return 'No plan is waiting and none is approved. The team can submit one at any time.';

  const lines = plan.items.map(
    (item, i) =>
      `${i + 1}. ${item.action}${item.target ? ` → ${item.target}` : ' (any target)'}\n   ${item.intent}`
  );

  if (plan.status === PLAN_STATUS.PENDING) {
    return (
      'Plan waiting on you.\n\n' +
      `${plan.summary ? `${plan.summary}\n\n` : ''}${lines.join('\n')}\n\n` +
      'Reply APPROVE to clear exactly this, or REJECT <reason>. Nothing runs until you do.'
    );
  }

  return (
    `Plan — ${plan.status.toUpperCase()}${plan.note ? ` (${plan.note})` : ''}.\n\n` +
    `${lines.join('\n')}\n\nPLAN CLEAR withdraws this.`
  );
}
