// Turns the token counts agentRunner.js accumulates into a dollar figure.
//
// This used to multiply one flat price pair over the whole run, which was
// right while every agent shared a model. Now that leaf specialists can run
// on a cheaper one (see agents/models.js), a total of "1.2M in / 300K out"
// no longer has a single price — the same token could have cost $2.00/MTok
// or $0.13/MTok depending on which agent produced it. So cost is summed at
// the point of the call, where the model is known, and carried on the usage
// accumulator itself as `costUsd`.
import { MODELS, DEFAULT_TIER } from './agents/models.js';

const DEFAULT_MODEL = MODELS[DEFAULT_TIER];

export function priceUsage({ inputTokens = 0, outputTokens = 0 }, modelSpec = DEFAULT_MODEL) {
  return (
    (inputTokens / 1_000_000) * modelSpec.inputPricePerMTok +
    (outputTokens / 1_000_000) * modelSpec.outputPricePerMTok
  );
}

/**
 * The cost of a run. Prefers the real per-call total accumulated during it;
 * falls back to pricing the tokens at the default model's rate, which is
 * what every daily report saved before mixed-model routing existed carries
 * (they'd otherwise read $0.00 rather than their true cost).
 */
export function estimateCostUsd(usage) {
  if (usage && typeof usage.costUsd === 'number') return usage.costUsd;
  return priceUsage(usage || {});
}

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function sumUsage(...usages) {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u?.inputTokens || 0),
      outputTokens: acc.outputTokens + (u?.outputTokens || 0),
      // An older usage object has no costUsd — price its tokens at the
      // default rate rather than dropping them from the total silently.
      costUsd: acc.costUsd + (u ? estimateCostUsd(u) : 0),
    }),
    emptyUsage()
  );
}

// $0.62 reads fine; a run cheap enough to round to $0.00 at 2 decimals is
// common for a single agent turn, so show more precision below a cent.
export function formatUsd(amount) {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
