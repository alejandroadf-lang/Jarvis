// Action-tool handlers shared by every place agents can actually touch the
// treasury or a venture: the interactive Executive Team / Venture Studio
// chat routes in index.js, and the autonomous daily-meeting cycle in
// dailyMeeting.js. Keeping them here (rather than inline in index.js) means
// the autonomous cycle can choose exactly which of these it wires up —
// today, only propose_venture (never money-moving or venture-killing
// actions; see dailyMeeting.js for why).

import { getLedger, addTransaction } from './finance/ledger.js';
import { getVenture, createVenture, setMilestoneStatus, requestTranche, killVenture } from './finance/ventures.js';
import { sendVentureProposedEmail, sendTrancheRequestEmail } from './email.js';

// A founder who greenlit a venture or approved a tranche and walked away
// won't see the CFO's next move until they happen to check back — these
// two are the actual decision points worth interrupting for (money about
// to be asked for, or a new idea worth a look), so they email immediately
// rather than waiting for the next daily digest. Never lets an email
// failure break the action itself: the venture is already logged either
// way, so a bad SMTP config should show up as a log line, not a broken
// conversation.
async function notify(sendFn, ...args) {
  try {
    await sendFn(...args);
  } catch (err) {
    console.error(`Failed to send ${sendFn.name}:`, err);
  }
}

export async function handleProposeVenture(input) {
  const venture = createVenture(input);
  await notify(sendVentureProposedEmail, venture);
  return `Logged venture proposal ${venture.id} ("${venture.title}"), asking $${venture.budgetRequested}. Status: proposed. Tell the founder they can greenlight it from the Ventures panel to allocate budget and hand it to the executive team.`;
}

// Shared validation for log_revenue/log_expense: a positive amount and,
// when given, a ventureId that actually exists. Returns either
// { amount, ventureId, description } or { error }.
function resolveTransactionInput(input, defaultDescription) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'amount must be a positive number.' };
  }

  let ventureId = null;
  if (input.ventureId) {
    const venture = getVenture(input.ventureId);
    if (!venture) {
      return { error: `no venture found with id "${input.ventureId}". Log it without a ventureId, or double-check the id.` };
    }
    ventureId = venture.id;
  }

  const description =
    typeof input.description === 'string' && input.description.trim() ? input.description.trim() : defaultDescription;

  return { amount, ventureId, description };
}

export async function handleLogRevenue(input) {
  const resolved = resolveTransactionInput(input, 'Revenue');
  if (resolved.error) return `Could not log revenue: ${resolved.error}`;

  const { amount, ventureId, description } = resolved;
  addTransaction({ type: 'revenue', amount, description, ventureId });
  const { balance } = getLedger();
  return `Logged $${amount} in revenue${ventureId ? ` for venture ${ventureId}` : ''} ("${description}"). Treasury balance is now $${balance.toFixed(2)}.`;
}

export async function handleLogExpense(input) {
  const resolved = resolveTransactionInput(input, 'Expense');
  if (resolved.error) return `Could not log expense: ${resolved.error}`;

  const { amount, ventureId, description } = resolved;
  addTransaction({ type: 'expense', amount, description, ventureId });
  const { balance } = getLedger();
  return `Logged $${amount} in expenses${ventureId ? ` for venture ${ventureId}` : ''} ("${description}"). Treasury balance is now $${balance.toFixed(2)}.`;
}

export async function handleReportMilestoneProgress(input) {
  const index = Number(input.milestoneIndex);
  if (!Number.isInteger(index) || index < 0) {
    return 'Could not update milestone: milestoneIndex must be a non-negative integer.';
  }
  if (!['done', 'missed'].includes(input.status)) {
    return 'Could not update milestone: status must be "done" or "missed".';
  }
  try {
    const venture = setMilestoneStatus(input.ventureId, index, input.status, input.note);
    const milestone = venture.milestones[index];
    return `Marked milestone [${index}] "${milestone.title}" as ${input.status} for "${venture.title}".`;
  } catch (err) {
    return `Could not update milestone: ${err.message}`;
  }
}

export async function handleRequestTranche(input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'Could not request tranche: amount must be a positive number.';
  }
  try {
    const venture = requestTranche(input.ventureId, { amount, description: input.description });
    await notify(sendTrancheRequestEmail, venture);
    return `Requested a $${amount} tranche for "${venture.title}" (${input.description}). Tell the founder they can approve it from the Ventures panel to add it to the treasury allocation.`;
  } catch (err) {
    return `Could not request tranche: ${err.message}`;
  }
}

export async function handleKillVenture(input) {
  try {
    const venture = killVenture(input.ventureId, input.reason);
    return `Killed "${venture.title}". Reason: ${venture.killReason}.`;
  } catch (err) {
    return `Could not kill venture: ${err.message}`;
  }
}
