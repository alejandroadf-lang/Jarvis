// The team plans its day; the founder approves it once; the team executes it
// without asking again.
//
// This is the middle ground between the two bad options. Approving every
// action individually makes the founder the bottleneck on a company whose
// whole point is that it runs itself. Approving nothing makes the scope model
// decorative, because an agent that grants itself a scope has no scope. A
// plan approved each morning is one decision a day, made with the whole day's
// intent visible at once — which is also the only way to notice that six
// reasonable-looking actions add up to something you would not have agreed to.
//
// Enforcement is here, at the data layer, not in a prompt. An agent that
// argues its way to a different conclusion still cannot get past a function
// that refuses to return.

import { readJson, writeJson } from './store.js';

const FILE = 'dailyPlans.json';
const MAX_KEPT_DAYS = 60;

export const PLAN_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
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

export function today() {
  return new Date().toISOString().slice(0, 10);
}

function load() {
  const data = readJson(FILE, { plans: {} });
  if (!data.plans) data.plans = {};
  return data;
}

function save(data) {
  // Old plans are the record of what was approved and when, but they are not
  // worth keeping forever in a file read on every action.
  const days = Object.keys(data.plans).sort();
  for (const day of days.slice(0, Math.max(0, days.length - MAX_KEPT_DAYS))) {
    delete data.plans[day];
  }
  writeJson(FILE, data);
}

export function getPlan(date = today()) {
  return load().plans[date] || null;
}

/**
 * Submits the day's intended work for approval.
 *
 * Resubmitting replaces a pending or rejected plan — the team should be able
 * to answer a "no" with a better plan the same day. An *approved* plan is not
 * replaceable, because work has already been authorised against it and
 * silently swapping what was agreed is the one move this whole mechanism
 * exists to prevent.
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
  const date = today();
  const existing = data.plans[date];
  if (existing?.status === PLAN_STATUS.APPROVED) {
    throw new Error(
      "Today's plan is already approved. Work under it, and submit a new plan tomorrow — " +
        'an approved plan cannot be edited after the fact.'
    );
  }

  data.plans[date] = {
    date,
    status: PLAN_STATUS.PENDING,
    items: cleaned,
    summary: summary ? String(summary) : null,
    submittedBy: submittedBy || null,
    submittedAt: new Date().toISOString(),
    decidedAt: null,
    note: null,
  };
  save(data);
  return data.plans[date];
}

export function approvePlan({ note } = {}) {
  const data = load();
  const plan = data.plans[today()];
  if (!plan) throw new Error('There is no plan for today to approve.');
  plan.status = PLAN_STATUS.APPROVED;
  plan.decidedAt = new Date().toISOString();
  plan.note = note ? String(note) : null;
  save(data);
  return plan;
}

export function rejectPlan({ reason } = {}) {
  const data = load();
  const plan = data.plans[today()];
  if (!plan) throw new Error('There is no plan for today to reject.');
  plan.status = PLAN_STATUS.REJECTED;
  plan.decidedAt = new Date().toISOString();
  plan.note = reason ? String(reason) : null;
  save(data);
  return plan;
}

/**
 * True when an approved item covers this action.
 *
 * An item with no target covers any target for that action on that venture —
 * "email three prospects" is a reasonable thing to approve without naming
 * them in advance. An item *with* a target covers only that target, because
 * naming one and then acting on another is not what was agreed.
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
  const plan = getPlan();
  if (!plan || plan.status !== PLAN_STATUS.APPROVED) return false;
  return plan.items.some((item) => covers(item, { ventureId, action, target }));
}

/**
 * Throws with a reason worth relaying unless today's approved plan covers
 * this. Called by every real action when a plan is required.
 */
export function assertInApprovedPlan({ ventureId, action, target }) {
  if (!isPlanRequired()) return;

  const plan = getPlan();
  if (!plan) {
    throw new Error(
      `No plan has been submitted for today, so nothing is approved yet. Submit one with submit_daily_plan ` +
        `covering "${action}" and the founder can approve the day's work in one go.`
    );
  }
  if (plan.status === PLAN_STATUS.PENDING) {
    throw new Error(
      "Today's plan is still waiting on the founder. Nothing runs until they approve it."
    );
  }
  if (plan.status === PLAN_STATUS.REJECTED) {
    throw new Error(
      `The founder rejected today's plan${plan.note ? `: ${plan.note}` : '.'} ` +
        'Submit a revised one rather than proceeding.'
    );
  }
  if (!isCoveredByApprovedPlan({ ventureId, action, target })) {
    throw new Error(
      `"${action}"${target ? ` on ${target}` : ''} is not in today's approved plan. ` +
        'The plan is what was agreed — do the work that is in it, and put this in tomorrow\'s.'
    );
  }
}

/** For the agent-facing context: what the team is actually cleared to do. */
export function describePlanForAgents() {
  if (!isPlanRequired()) return '';
  const plan = getPlan();
  if (!plan) {
    return 'Today\'s plan: none submitted yet. Real actions are blocked until a plan is submitted and the founder approves it.';
  }
  const lines = plan.items.map(
    (item) => `- ${item.action}${item.target ? ` on ${item.target}` : ''} (${item.ventureId}): ${item.intent}`
  );
  if (plan.status === PLAN_STATUS.APPROVED) {
    return `Today's plan is APPROVED. You may do exactly these, and nothing else:\n${lines.join('\n')}`;
  }
  if (plan.status === PLAN_STATUS.REJECTED) {
    return `Today's plan was REJECTED${plan.note ? `: ${plan.note}` : ''}. Submit a revised plan; no real actions run until one is approved.`;
  }
  return `Today's plan is waiting on the founder. Nothing runs until they approve it:\n${lines.join('\n')}`;
}

export function listPlans(limit = 30) {
  const data = load();
  return Object.keys(data.plans)
    .sort()
    .slice(-limit)
    .reverse()
    .map((date) => data.plans[date]);
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
 * Only ever returns a decision while a plan is actually pending. "Approve" on
 * a day with nothing waiting is far more likely to be part of a sentence than
 * a command, and acting on it would be inventing consent.
 */
export function parsePlanCommand(text) {
  const raw = String(text || '');
  if (STATUS.test(raw)) return { kind: 'status' };

  const plan = getPlan();
  const pending = plan?.status === PLAN_STATUS.PENDING;
  if (!pending) return null;

  const approve = raw.match(APPROVE);
  if (approve) return { kind: 'approve', note: (approve[2] || '').trim() || null };

  const reject = raw.match(REJECT);
  if (reject) return { kind: 'reject', reason: (reject[2] || '').trim() || null };

  return null;
}

/** The plan as a WhatsApp message — short, and explicit about what replying does. */
export function formatPlanForWhatsApp(plan) {
  if (!plan) return 'No plan has been submitted today.';

  const lines = plan.items.map(
    (item, i) =>
      `${i + 1}. ${item.action}${item.target ? ` → ${item.target}` : ' (any target)'}\n   ${item.intent}`
  );

  if (plan.status === PLAN_STATUS.PENDING) {
    return (
      `Plan for ${plan.date} — waiting on you.\n\n` +
      `${plan.summary ? `${plan.summary}\n\n` : ''}${lines.join('\n')}\n\n` +
      'Reply APPROVE to clear exactly this, or REJECT <reason>. Nothing runs until you do.'
    );
  }

  return (
    `Plan for ${plan.date} — ${plan.status.toUpperCase()}${plan.note ? ` (${plan.note})` : ''}.\n\n` +
    lines.join('\n')
  );
}
