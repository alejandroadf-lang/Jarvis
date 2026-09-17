// The supervisor's veto.
//
// Project Vend phase two is the closest published analogue to this company: an
// AI running a real shop. It went from losing money every week to profitable,
// and the change with the clearest causal link was not a smarter shopkeeper.
// It was a CEO agent with an objectives tool who vetoed most requests for
// improper discounts. The worst loss afterwards was an order of magnitude
// smaller, and weeks with negative revenue went to zero.
//
// This company had the CEO and the objectives and no veto. The only thing that
// could say no was the founder, once a day, at plan-approval time — which
// catches "the plan does not cover emailing Ada" and cannot catch "the plan
// said email Ada, and the email being sent offers her 60% off".
//
// Two layers, deliberately different in cost:
//
//   1. A deterministic price floor. The exact Vend failure — giving the
//      product away — is arithmetic, and arithmetic does not need a model.
//      Free, always on, cannot be talked around.
//   2. A CEO review before an irreversible outbound message. That one needs
//      judgment, so it costs a call, so it is opt-in and runs on the cheap
//      tier. Off by default: a company with no revenue is protecting nothing,
//      and a review that fires on every draft becomes a rubber stamp.

import { listObjectives, describePricing, monthlyValue } from './finance/ventures.js';
import { CHEAP_TIER, MODELS } from './agents/models.js';
import { createMessage } from './agents/agentRunner.js';

/** Whether the founder has turned the judgment layer on. */
export function isCeoReviewEnabled() {
  return process.env.CEO_REVIEW === 'true';
}

/**
 * The price floor, as arithmetic.
 *
 * A payment link below what the venture charges is the company giving its
 * product away, and it is the one failure Project Vend documents by name. The
 * founder can still authorise a specific discount — DISCOUNT records it — but
 * an agent cannot decide one for itself, however persuasive the customer.
 *
 * Returns null when the amount is fine, or a refusal string when it is not.
 */
export function priceFloorRefusal(venture, { amount, expectedUnits = 0 }) {
  const pricing = venture?.pricing;
  if (!pricing) return null; // No price on record: nothing to be below.

  // One month's worth, whether the link recurs or is charged once. A one-time
  // link is how this company sells a month up front, not how it sells a
  // discount — so `kind` changes what Stripe is told, never what the floor is.
  const expected = monthlyValue(venture, expectedUnits);
  if (expected <= 0) return null;

  // A hair of tolerance for rounding, not for negotiation.
  const floor = venture.discount?.approvedFloor ?? expected;
  if (amount >= floor - 0.005) return null;

  const approved = venture.discount?.approvedFloor
    ? ` The founder approved a floor of ${pricing.currency} ${venture.discount.approvedFloor.toFixed(2)}, and this is below even that.`
    : '';

  return (
    `${pricing.currency} ${Number(amount).toFixed(2)} is below what "${venture.title}" charges — the price on record is ` +
    `${describePricing(venture)}, which comes to ${pricing.currency} ${expected.toFixed(2)} at that volume.${approved} ` +
    'Discounting is the founder\'s decision, not yours: they authorise one with ' +
    `"DISCOUNT ${venture.id} <floor>" and it applies until they clear it. Quote the real price, or say plainly ` +
    'that the customer asked for a discount and let the founder answer.'
  );
}

const VETO = /^\s*VETO\b/i;

/**
 * One cheap call asking the CEO whether an outbound act serves the objectives.
 *
 * Structured so a veto is the easy answer to give: the model is asked for one
 * word and a reason, and anything that is not a clear veto passes. A reviewer
 * that has to argue its way to "yes" blocks good work, and a reviewer nobody
 * can predict gets routed around.
 *
 * Never throws. A review that errors approves — an unreachable supervisor must
 * not become an outage, and the deterministic floor above still holds.
 *
 * @returns {Promise<{approved: boolean, reason: string, reviewed: boolean}>}
 */
export async function reviewOutbound({ anthropic, venture, action, summary }) {
  if (!isCeoReviewEnabled()) return { approved: true, reason: '', reviewed: false };
  if (!anthropic) return { approved: true, reason: '', reviewed: false };

  const objectives = listObjectives(venture.id);
  const objectiveText = objectives.length
    ? objectives.map((o) => `- ${o.key}: ${o.target}${o.by ? ` by ${o.by}` : ''}`).join('\n')
    : '- (none set)';

  const prompt = `You are the CEO of "${venture.title}", reviewing one outbound action before it happens.

Open objectives:
${objectiveText}

Price on record: ${describePricing(venture)}

Action: ${action}
${summary}

Answer in one line, starting with exactly one word:

APPROVE — it is consistent with the objectives and says nothing the company would have to retract.
VETO — it gives something away, promises something not on the record, misstates the price, or would embarrass the company with a real customer.

Then one sentence of reason. Veto only for those specific problems; a message that is merely plain, short or imperfect is approved. You are the last check before a real person reads this.`;

  try {
    const spec = MODELS[CHEAP_TIER] || MODELS.frontier;
    const response = await createMessage(anthropic, spec, {
      max_tokens: 200,
      system: 'You review outbound actions for a small company. You are terse and you do not hedge.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (response?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();

    if (VETO.test(text)) {
      return { approved: false, reason: text.replace(VETO, '').replace(/^[\s—:-]+/, '').trim(), reviewed: true };
    }
    return { approved: true, reason: '', reviewed: true };
  } catch (err) {
    // An unreachable reviewer is not a reason to stop the company working.
    console.error('CEO review failed, approving by default:', err.message);
    return { approved: true, reason: '', reviewed: false };
  }
}
