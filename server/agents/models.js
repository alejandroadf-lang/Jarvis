// Which model each agent actually runs on, and what that model costs.
//
// Every agent used to run on claude-sonnet-5, which was the right default
// and the wrong bill. In a fan-out the leaf specialists dominate the call
// count — the CEO consults four C-suite agents, who consult their own
// reports — and most of those leaves are doing bounded, single-shot work
// (review this copy, poke holes in this idea) rather than orchestration.
// Paying frontier prices for all of it is the company's one genuine
// recurring cost, now that there's no capital model pretending otherwise.
//
// So an agent can name a TIER, and a tier resolves to a concrete model plus
// its price. Two rules keep this from turning into a quality cliff:
//
//   1. Only leaves qualify. A tier is ignored for any agent that
//      orchestrates, acts, or uses an Anthropic server tool — see
//      resolveModelForAgent() below for why that's enforced rather than
//      merely documented.
//   2. It's opt-in. With no OPENROUTER_API_KEY set, every tier collapses
//      back to the default and the company runs exactly as it did before.

export const DEFAULT_TIER = 'frontier';
export const CHEAP_TIER = 'specialist';

// Prices are per million tokens and are pinned by hand — same convention as
// the rest of this app. Anthropic's published pricing for claude-sonnet-5
// checked 2026-06-24; OpenRouter's for hermes-4-70b checked 2026-09-10.
// Update here if either moves; nothing else reads a price.
export const MODELS = {
  [DEFAULT_TIER]: {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    inputPricePerMTok: 2.0,
    outputPricePerMTok: 10.0,
  },
  [CHEAP_TIER]: {
    provider: 'openrouter',
    model: 'nousresearch/hermes-4-70b',
    inputPricePerMTok: 0.13,
    outputPricePerMTok: 0.4,
  },
};

export function getModelSpec(tier) {
  return MODELS[tier] || MODELS[DEFAULT_TIER];
}

// An agent can only leave the default model if its turn is a single
// request in and text out. The alternative provider is deliberately a
// plain completion call with no tool-use loop (see openrouter.js), so an
// agent with reports, actions, or server tools would silently lose the
// ability to delegate, act, or search — a far worse failure than a bigger
// bill, and one that would show up as a vague answer rather than an error.
// Enforcing it here rather than trusting each agent definition means a
// future edit that adds an action to a tiered agent can't quietly break it.
export function canUseAlternativeModel(agent) {
  return (
    (agent.reports || []).length === 0 &&
    (agent.actions || []).length === 0 &&
    (agent.serverTools || []).length === 0
  );
}

/**
 * Picks the model spec an agent's turn should actually run on.
 * @param {object} agent - the agent definition
 * @param {boolean} alternativeAvailable - whether the non-default provider is configured
 */
export function resolveModelForAgent(agent, alternativeAvailable) {
  const spec = getModelSpec(agent.modelTier);
  if (spec.provider === 'anthropic') return spec;
  if (!alternativeAvailable || !canUseAlternativeModel(agent)) return MODELS[DEFAULT_TIER];
  return spec;
}
