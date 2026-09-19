import { readSecret, hasSecret } from '../env.js';
import { createChatCompletion } from './openaiCompatible.js';
// IONOS AI Model Hub, through its OpenAI-compatible endpoint.
//
// A European-hosted provider (Berlin) serving open models — Llama, Mistral,
// GPT-OSS — under EU data rules, which is the reason to have it at all: the
// travel advisor talks to agencies in Spain and France, and "where does the
// audio and the transcript go" is a question those agencies ask. Everything
// else about it is the protocol the other four alternative providers already
// speak, so this file keeps only the URL, the key and the model default.
//
// Model names and prices are read at call time like the other providers': the
// hub adds and retires models, and a stale name should be a variable to
// change rather than a redeploy. The base URL is overridable because the hub
// is regional and a second region would carry a different host.

const DEFAULT_BASE_URL = 'https://openai.inference.de-txl.ionos.com/v1';

export function isIonosConfigured() {
  return hasSecret('IONOS_API_KEY');
}

export function ionosBaseUrl() {
  return ((process.env.IONOS_BASE_URL || '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function ionosModel() {
  return (process.env.IONOS_MODEL || '').trim() || 'meta-llama/Llama-3.3-70B-Instruct';
}

export function listModelsUrl() {
  return `${ionosBaseUrl()}/models`;
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Per million tokens, for the daily spend cap. IONOS bills in euros per
// million tokens and the figure differs by model; the default is the order
// of magnitude of a 70B Llama on the hub, pinned by hand and overridable.
// Checked 2026-09-19.
export function ionosPriceSpec() {
  return {
    provider: 'ionos',
    model: ionosModel(),
    inputPricePerMTok: numberFromEnv('IONOS_INPUT_PRICE_PER_MTOK', 0.7),
    outputPricePerMTok: numberFromEnv('IONOS_OUTPUT_PRICE_PER_MTOK', 0.7),
  };
}

/**
 * One completion, in the Anthropic shape the agent loops read — content
 * blocks, snake_case usage and tool_use blocks included.
 */
export async function createCompletion({ model, system, messages, maxTokens, tools }) {
  const apiKey = readSecret('IONOS_API_KEY');
  if (!apiKey) throw new Error('IONOS_API_KEY is not set');

  return createChatCompletion({
    url: `${ionosBaseUrl()}/chat/completions`,
    apiKey,
    label: 'IONOS',
    model: model || ionosModel(),
    system,
    messages,
    maxTokens,
    tools,
  });
}
