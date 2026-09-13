import { readSecret, hasSecret } from '../env.js';
import { createChatCompletion } from './openaiCompatible.js';
// A deliberately small OpenRouter client for the one call shape this app
// needs from it: system prompt + messages in, text out.
//
// Raw fetch rather than a provider SDK, matching deploy/github.js. The
// OpenAI-compatible surface is a single POST, and pulling in an SDK to make
// it would add a dependency whose tool-calling, streaming and structured
// output features this path deliberately never uses.
//
// It never uses them because only leaf agents route here (see models.js's
// canUseAlternativeModel): no delegation tools, no action tools, no server
// tools. That constraint is what lets this stay a plain completion call
// instead of a second tool-use loop to keep in step with the Anthropic one.

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function isOpenRouterConfigured() {
  return hasSecret('OPENROUTER_API_KEY');
}

/**
 * Which model OpenRouter serves when it is standing in for Anthropic, rather
 * than running a leaf agent on the cheap tier. Defaults to the cheap-tier
 * model because that one is pinned and known to work; set
 * OPENROUTER_FALLBACK_MODEL to an Anthropic model on OpenRouter (they are
 * offered there) and this becomes the closest substitute in the chain — the
 * same model, billed through a different account, which is exactly what you
 * want when the direct account is the thing that ran out.
 */
export function openRouterFallbackModel() {
  return (process.env.OPENROUTER_FALLBACK_MODEL || '').trim() || 'nousresearch/hermes-4-70b';
}

/**
 * One completion. Returns the same shape agentRunner already handles from
 * the Anthropic SDK, so the caller doesn't branch on provider to read a
 * result — content blocks and snake_case usage included.
 *
 * @param {{model: string, system: string, messages: Array<{role: string, content: any}>, maxTokens: number}} opts
 */
export async function createCompletion({ model, system, messages, maxTokens, tools }) {
  const apiKey = readSecret('OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  return createChatCompletion({
    url: BASE_URL,
    apiKey,
    label: 'OpenRouter',
    model,
    system,
    messages,
    maxTokens,
    tools,
    // OpenRouter attributes traffic with this; it carries nothing about the
    // founder or the business.
    headers: { 'X-Title': 'Jarvis' },
  });
}

/**
 * The models OpenRouter is actually serving right now, cheapest first.
 *
 * This exists because a pinned model id is a hostage to someone else's
 * catalogue: "nousresearch/hermes-4-70b" was live when it was pinned and
 * retired weeks later, at which point every specialist silently fell back to
 * Claude at 25x the price. The integration probe caught that, but the fix
 * still meant opening a browser to find a name that works — so this puts the
 * catalogue itself one WhatsApp message away.
 *
 * No key needed: the catalogue is public. Prices come back per token as
 * strings, hence the conversion to the per-million-token unit the rest of
 * this app uses.
 *
 * @param {{limit?: number, search?: string, maxOutputPricePerMTok?: number}} opts
 */
export async function listAffordableModels({ limit = 8, search = '', maxOutputPricePerMTok = 1 } = {}) {
  const response = await fetch(`${BASE_URL.replace('/chat/completions', '')}/models`);
  if (!response.ok) throw new Error(`OpenRouter returned ${response.status} for its model list.`);

  const body = await response.json();
  const needle = String(search || '').trim().toLowerCase();

  return (body?.data || [])
    .map((model) => ({
      id: String(model.id || ''),
      contextLength: Number(model.context_length) || 0,
      inputPricePerMTok: perMillion(model.pricing?.prompt),
      outputPricePerMTok: perMillion(model.pricing?.completion),
    }))
    .filter((model) => model.id && Number.isFinite(model.inputPricePerMTok) && Number.isFinite(model.outputPricePerMTok))
    // A search wins over the price ceiling: asking for "hermes" and being
    // shown nothing because every Hermes is a cent too expensive would be
    // the tool refusing to answer the question it was asked.
    .filter((model) => (needle ? model.id.toLowerCase().includes(needle) : model.outputPricePerMTok <= maxOutputPricePerMTok))
    .sort((a, b) => a.outputPricePerMTok - b.outputPricePerMTok || a.inputPricePerMTok - b.inputPricePerMTok)
    .slice(0, limit);
}

// Prices arrive per token, so the conversion lands on values like
// 0.39999999999999997. Rounded here rather than at each display site: a
// price is only ever shown or compared, and four decimals is finer than
// anything OpenRouter actually charges.
function perMillion(price) {
  const raw = Number(price) * 1e6;
  return Number.isFinite(raw) ? Math.round(raw * 1e4) / 1e4 : NaN;
}
