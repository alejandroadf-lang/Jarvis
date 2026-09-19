// Brains: every model the advisor can think with.
//
// The advisor's loop (advisor.js) reads Anthropic-shaped responses — content
// blocks, tool_use, snake_case usage — and every alternative provider in this
// app already answers in that shape through agents/openaiCompatible.js and
// the tool translation behind it. So a brain is a thin thing:
//
//   { id, label, configured(), model(), priceSpec(), create(request) }
//
// where `request` is what advisor.js would have handed the Anthropic SDK.
// The one translation that happens here is the system prompt: Anthropic takes
// an array of blocks with cache markers, everyone else takes a string.
//
// IONOS is the reason this slot exists. It is a European host serving open
// models under EU data rules, and a Spanish or French agency asking "where
// does my client's booking question go" deserves an answer that is not "a US
// API". Whether Llama on IONOS explains a fare rule as well as Claude does
// is exactly the kind of thing the Travel Voice tab is for finding out.

import { MODELS, CHEAP_TIER, OPENAI_TIER, GEMINI_TIER, DEEPSEEK_TIER } from '../../agents/models.js';
import { hasSecret } from '../../env.js';
import { anthropicConfigured, anthropicResidency, modelForGateway } from '../../agents/anthropicClient.js';
import { declaredResidency } from '../residency.js';
import { override as settingOverride } from '../settings.js';
import { isOpenAIConfigured, createCompletion as openaiCreate, chatModel as openaiModel } from '../../agents/openai.js';
import { isIonosConfigured, createCompletion as ionosCreate, ionosModel, ionosPriceSpec } from '../../agents/ionos.js';
import { isGeminiConfigured, createCompletion as geminiCreate, geminiModel } from '../../agents/gemini.js';
import { isDeepSeekConfigured, createCompletion as deepseekCreate, deepSeekModel } from '../../agents/deepseek.js';
import { isOpenRouterConfigured, createCompletion as openrouterCreate } from '../../agents/openrouter.js';

function flattenSystem(system) {
  if (typeof system === 'string') return system;
  return (system || [])
    .map((block) => (typeof block === 'string' ? block : block?.text || ''))
    .filter(Boolean)
    .join('\n\n');
}

// The advisor's own default, deliberately not the company's.
//
// The rest of the org chart runs on the company's default tier and should keep
// doing so. The advisor is the one agent talking to a paying stranger, and
// the arithmetic of a voice channel is lopsided: synthesising a reply costs
// several cents, thinking of one costs a fraction of one. The model is
// roughly 2-5% of what an exchange costs, so saving money there saves
// almost nothing and buys the failure this product can least afford — a
// confidently invented fare rule that an agency acts on.
const ADVISOR_MODEL = 'claude-opus-5';

// Per million tokens, pinned by hand like every other price in this app, and
// keyed by model because the advisor's model is a variable. Getting this
// wrong does not cost money directly; it makes the daily cap meter the wrong
// number, which is how a cap stops protecting anything (see usage.js for the
// last time that happened here).
const ANTHROPIC_PRICES = {
  'claude-opus-5': { inputPricePerMTok: 5.0, outputPricePerMTok: 25.0 },
  'claude-sonnet-5': { inputPricePerMTok: 2.0, outputPricePerMTok: 10.0 },
  'claude-haiku-4-5': { inputPricePerMTok: 1.0, outputPricePerMTok: 5.0 },
  'claude-fable-5-1': { inputPricePerMTok: 10.0, outputPricePerMTok: 50.0 },
};

// How hard the advisor thinks. Low by default, and that is the whole point of
// affording the better model: a caller is holding a phone, and the question is
// bounded — "what does this entry do", "which category holds the penalty" —
// rather than the kind of open problem that repays deliberation. Low effort on
// the stronger model beats high effort on a weaker one for both latency and
// answer quality.
//
// Set TRAVEL_VOICE_EFFORT to empty to send no effort at all, which is what an
// older model that predates the parameter needs.
function advisorEffort() {
  // "off" is how a phone says "send no effort at all", which is what an
  // empty environment variable already meant.
  const pinned = settingOverride('effort');
  if (pinned !== undefined) return pinned === 'off' ? null : pinned;
  const raw = process.env.TRAVEL_VOICE_EFFORT;
  if (raw !== undefined && raw.trim() === '') return null;
  return (raw || '').trim() || 'low';
}

// Anthropic: the request passes through untouched, cache markers included.
// `anthropic` is the SDK client index.js already holds, injected per call so
// tests can hand in a stub.
export const anthropicBrain = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  // EU only through an EU region of Bedrock or Vertex; see agents/anthropicClient.js.
  residency: anthropicResidency,
  configured: anthropicConfigured,
  model: () => settingOverride('model') || (process.env.TRAVEL_VOICE_MODEL || '').trim() || ADVISOR_MODEL,
  priceSpec() {
    const model = this.model();
    // An unrecognised model is priced at the most expensive one known rather
    // than the cheapest. A cap that fires early is an inconvenience; one that
    // fires late is not a cap.
    const price = ANTHROPIC_PRICES[model] || ANTHROPIC_PRICES['claude-fable-5-1'];
    return { provider: 'anthropic', model, ...price };
  },
  create(request, { anthropic }) {
    if (!anthropic) throw new Error('No Anthropic client was provided');
    const effort = advisorEffort();
    return anthropic.messages.create({
      ...request,
      model: modelForGateway(this.model()),
      // Anthropic-only, so it is added here rather than by the advisor: the
      // OpenAI-compatible brains would either ignore the field or reject it.
      ...(effort ? { output_config: { effort } } : {}),
    });
  },
};

function compatibleBrain({ id, label, configured, model, priceSpec, call, residency = () => 'unknown' }) {
  return {
    id,
    label,
    residency,
    configured,
    model,
    priceSpec,
    create(request) {
      return call({
        model: this.model(),
        system: flattenSystem(request.system),
        messages: request.messages,
        maxTokens: request.max_tokens,
        tools: request.tools,
      });
    },
  };
}

export const ionosBrain = compatibleBrain({
  id: 'ionos',
  label: 'IONOS AI Model Hub (EU)',
  // EU by construction: the Model Hub runs in IONOS's German data centres.
  residency: () => 'eu',
  configured: isIonosConfigured,
  model: ionosModel,
  priceSpec: ionosPriceSpec,
  call: ionosCreate,
});

export const openaiBrain = compatibleBrain({
  id: 'openai',
  label: 'OpenAI',
  residency: () => declaredResidency('OPENAI_RESIDENCY'),
  configured: isOpenAIConfigured,
  model: openaiModel,
  priceSpec: () => MODELS[OPENAI_TIER],
  call: openaiCreate,
});

export const geminiBrain = compatibleBrain({
  id: 'gemini',
  label: 'Google Gemini',
  residency: () => declaredResidency('GEMINI_RESIDENCY', { fallback: 'global' }),
  configured: isGeminiConfigured,
  model: geminiModel,
  priceSpec: () => MODELS[GEMINI_TIER],
  call: geminiCreate,
});

export const deepseekBrain = compatibleBrain({
  id: 'deepseek',
  label: 'DeepSeek',
  residency: () => declaredResidency('DEEPSEEK_RESIDENCY', { fallback: 'unknown' }),
  configured: isDeepSeekConfigured,
  model: deepSeekModel,
  priceSpec: () => MODELS[DEEPSEEK_TIER],
  call: deepseekCreate,
});

export const openrouterBrain = compatibleBrain({
  id: 'openrouter',
  label: 'OpenRouter',
  residency: () => declaredResidency('OPENROUTER_RESIDENCY', { fallback: 'unknown' }),
  configured: isOpenRouterConfigured,
  model: () => MODELS[CHEAP_TIER].model,
  priceSpec: () => MODELS[CHEAP_TIER],
  call: openrouterCreate,
});

export const BRAINS = [anthropicBrain, ionosBrain, openaiBrain, geminiBrain, deepseekBrain, openrouterBrain];

// The second tier: the model that judges, offline, what the live path said.
//
// Two tiers is the shape every review of production voice agents ends up
// recommending: a live path that answers in the time a caller will wait,
// and a stronger, slower judge that reads samples and simulated
// conversations afterwards and says what went wrong. The judge runs on
// the same Anthropic client and gateway; its model is its own variable so
// the live model can be cut for cost without cutting the eyes on it.
export function judgeModel() {
  return (process.env.TRAVEL_VOICE_JUDGE_MODEL || '').trim() || 'claude-opus-5';
}

export function judgePriceSpec() {
  const model = judgeModel();
  return { provider: 'anthropic', model, ...(ANTHROPIC_PRICES[model] || ANTHROPIC_PRICES['claude-fable-5-1']) };
}

export const __testing = { flattenSystem };
