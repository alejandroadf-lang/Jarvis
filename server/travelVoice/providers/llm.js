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

import { MODELS, DEFAULT_TIER, CHEAP_TIER, OPENAI_TIER, GEMINI_TIER, DEEPSEEK_TIER } from '../../agents/models.js';
import { hasSecret } from '../../env.js';
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

// Anthropic: the request passes through untouched, cache markers included.
// `anthropic` is the SDK client index.js already holds, injected per call so
// tests can hand in a stub.
export const anthropicBrain = {
  id: 'anthropic',
  label: 'Anthropic Claude',
  configured: () => hasSecret('ANTHROPIC_API_KEY'),
  model: () => (process.env.TRAVEL_VOICE_MODEL || '').trim() || MODELS[DEFAULT_TIER].model,
  priceSpec: () => MODELS[DEFAULT_TIER],
  create(request, { anthropic }) {
    if (!anthropic) throw new Error('No Anthropic client was provided');
    return anthropic.messages.create({ ...request, model: this.model() });
  },
};

function compatibleBrain({ id, label, configured, model, priceSpec, call }) {
  return {
    id,
    label,
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
  configured: isIonosConfigured,
  model: ionosModel,
  priceSpec: ionosPriceSpec,
  call: ionosCreate,
});

export const openaiBrain = compatibleBrain({
  id: 'openai',
  label: 'OpenAI',
  configured: isOpenAIConfigured,
  model: openaiModel,
  priceSpec: () => MODELS[OPENAI_TIER],
  call: openaiCreate,
});

export const geminiBrain = compatibleBrain({
  id: 'gemini',
  label: 'Google Gemini',
  configured: isGeminiConfigured,
  model: geminiModel,
  priceSpec: () => MODELS[GEMINI_TIER],
  call: geminiCreate,
});

export const deepseekBrain = compatibleBrain({
  id: 'deepseek',
  label: 'DeepSeek',
  configured: isDeepSeekConfigured,
  model: deepSeekModel,
  priceSpec: () => MODELS[DEEPSEEK_TIER],
  call: deepseekCreate,
});

export const openrouterBrain = compatibleBrain({
  id: 'openrouter',
  label: 'OpenRouter',
  configured: isOpenRouterConfigured,
  model: () => MODELS[CHEAP_TIER].model,
  priceSpec: () => MODELS[CHEAP_TIER],
  call: openrouterCreate,
});

export const BRAINS = [anthropicBrain, ionosBrain, openaiBrain, geminiBrain, deepseekBrain, openrouterBrain];

export const __testing = { flattenSystem };
