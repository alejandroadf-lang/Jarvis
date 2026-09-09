// Turns the token counts agentRunner.js already accumulates into a dollar
// estimate. Pricing is pinned to the model agentRunner.js actually calls
// (claude-sonnet-5) and needs updating by hand if that model or its price
// ever changes — checked against Anthropic's published pricing as of
// 2026-06-24: $2.00 / MTok input, $10.00 / MTok output.
const INPUT_PRICE_PER_MTOK = 2.0;
const OUTPUT_PRICE_PER_MTOK = 10.0;

export function estimateCostUsd({ inputTokens, outputTokens }) {
  return (inputTokens / 1_000_000) * INPUT_PRICE_PER_MTOK + (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MTOK;
}

export function sumUsage(...usages) {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u?.inputTokens || 0),
      outputTokens: acc.outputTokens + (u?.outputTokens || 0),
    }),
    { inputTokens: 0, outputTokens: 0 }
  );
}

// $0.62 reads fine; a run cheap enough to round to $0.00 at 2 decimals is
// common for a single agent turn, so show more precision below a cent.
export function formatUsd(amount) {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
