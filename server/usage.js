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

// Prompt caching is billed as two extra token classes, at multiples of the
// base input price. Writing a cache entry costs more than sending the tokens
// uncached; reading one costs almost nothing.
//
// These multipliers are Anthropic's published ones for 5-minute ephemeral
// caching, pinned by hand like every other price in this app. Change them
// here and nowhere else.
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/**
 * What a call cost, including the tokens prompt caching bills separately.
 *
 * The separate fields are the whole point, and missing them was not a rounding
 * error. Anthropic reports `input_tokens` as the *uncached* input only, and
 * puts everything in the cached prefix into `cache_creation_input_tokens` and
 * `cache_read_input_tokens`. This app caches the two largest blocks it sends —
 * the shared company context and each agent's own system prompt — and the tool
 * schemas sit inside the same prefix. On a CEO call that is roughly 4,400 of
 * 4,600 input tokens.
 *
 * So for most of this company's life the daily spend cap was metering a small
 * fraction of the bill and was never going to fire. It did not leak money; it
 * could not see it. Anything that reads a cost from here — the cap, the daily
 * report, the founder's SPEND command — was reading the same blind number.
 *
 * Defaults of 0 keep every older saved usage object pricing exactly as before.
 */
export function priceUsage(
  { inputTokens = 0, outputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0 },
  modelSpec = DEFAULT_MODEL
) {
  const perMTokIn = modelSpec.inputPricePerMTok;
  return (
    (inputTokens / 1_000_000) * perMTokIn +
    (cacheWriteTokens / 1_000_000) * perMTokIn * CACHE_WRITE_MULTIPLIER +
    (cacheReadTokens / 1_000_000) * perMTokIn * CACHE_READ_MULTIPLIER +
    (outputTokens / 1_000_000) * modelSpec.outputPricePerMTok
  );
}

/**
 * Every input token a call was billed for, cached or not.
 *
 * Worth having separately from the dollar figure: "how many tokens did that
 * cost" and "was the cache actually hitting" are different questions, and the
 * second one decides whether caching is saving 90% or surcharging 25%.
 */
export function billedInputTokens(usage) {
  return (usage?.inputTokens || 0) + (usage?.cacheWriteTokens || 0) + (usage?.cacheReadTokens || 0);
}

/**
 * What share of the cached prefix was read rather than written, 0 to 1, or null
 * when nothing was cached at all.
 *
 * A cache read needs the entire prefix — tool schemas included, since those are
 * sent ahead of the system blocks — to repeat within the TTL. So this is the
 * number that says whether a breakpoint is earning its place: near 1 and it is
 * paying for itself many times over, near 0 and it is a 25% surcharge on every
 * call.
 */
export function cacheHitRate(usage) {
  const cached = (usage?.cacheWriteTokens || 0) + (usage?.cacheReadTokens || 0);
  if (!cached) return null;
  return (usage?.cacheReadTokens || 0) / cached;
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
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

export function sumUsage(...usages) {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u?.inputTokens || 0),
      outputTokens: acc.outputTokens + (u?.outputTokens || 0),
      // Absent on every usage object saved before caching was metered, which
      // is why these default rather than assuming the field is there.
      cacheWriteTokens: acc.cacheWriteTokens + (u?.cacheWriteTokens || 0),
      cacheReadTokens: acc.cacheReadTokens + (u?.cacheReadTokens || 0),
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
