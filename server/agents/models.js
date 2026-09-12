import { hasSecret } from '../env.js';
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
// A third option for leaf agents, for when OpenAI is the provider with credit
// on it. Same leaf-only rule as the others — see canUseAlternativeModel.
export const OPENAI_TIER = 'assistant';
export const GEMINI_TIER = 'analyst';

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
  // Read at call time like the other two alternatives. OpenRouter retires
  // and renames models as readily as anyone, and a pinned name that stops
  // existing should be a variable to change rather than a redeploy — the
  // same reasoning that already applied to OpenAI and Gemini, and no reason
  // for this one to be the exception.
  [CHEAP_TIER]: {
    provider: 'openrouter',
    get model() {
      return (process.env.OPENROUTER_MODEL || '').trim() || 'nousresearch/hermes-4-70b';
    },
    get inputPricePerMTok() {
      return numberFromEnv('OPENROUTER_INPUT_PRICE_PER_MTOK', 0.13);
    },
    get outputPricePerMTok() {
      return numberFromEnv('OPENROUTER_OUTPUT_PRICE_PER_MTOK', 0.4);
    },
  },
  // Model name and prices are read at call time rather than frozen here:
  // OpenAI retires and renames models faster than this file gets edited, and
  // a stale default should be fixable from Railway's variables rather than a
  // redeploy. See agents/openai.js for the env names.
  [OPENAI_TIER]: {
    provider: 'openai',
    get model() {
      return (process.env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini';
    },
    get inputPricePerMTok() {
      return numberFromEnv('OPENAI_INPUT_PRICE_PER_MTOK', 0.15);
    },
    get outputPricePerMTok() {
      return numberFromEnv('OPENAI_OUTPUT_PRICE_PER_MTOK', 0.6);
    },
  },
  // Read at call time for the same reason as the OpenAI tier above.
  [GEMINI_TIER]: {
    provider: 'gemini',
    get model() {
      return (process.env.GEMINI_MODEL || '').trim() || 'gemini-2.0-flash';
    },
    get inputPricePerMTok() {
      return numberFromEnv('GEMINI_INPUT_PRICE_PER_MTOK', 0.1);
    },
    get outputPricePerMTok() {
      return numberFromEnv('GEMINI_OUTPUT_PRICE_PER_MTOK', 0.4);
    },
  },
};

// Prices feed the daily spend cap, so a wrong one silently mis-meters the
// company's only real cost. Overridable for exactly that reason.
//
// The blank check is not defensive padding. Number('') is 0, and 0 passes a
// ">= 0" test, so an unset variable read as a price of zero — which meant
// every OpenAI and Gemini fallback call was metered at nothing and the daily
// cap quietly stopped counting them. Second time this exact trap has bitten
// in this codebase; the first was a blank profit-share percentage silently
// zeroing every agent's earnings.
function numberFromEnv(name, fallback) {
  const configured = (process.env[name] || '').trim();
  if (!configured) return fallback;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

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
  if (!isProviderAvailable(spec.provider, alternativeAvailable) || !canUseAlternativeModel(agent)) {
    return MODELS[DEFAULT_TIER];
  }
  return spec;
}

// `alternativeAvailable` predates there being more than one alternative, and
// still means OpenRouter — callers pass isOpenRouterConfigured(). OpenAI is
// checked directly rather than threaded through every call site.
function isProviderAvailable(provider, openRouterAvailable) {
  if (provider === 'openai') return hasSecret('OPENAI_API_KEY');
  if (provider === 'gemini') return hasSecret('GEMINI_API_KEY');
  return openRouterAvailable;
}
