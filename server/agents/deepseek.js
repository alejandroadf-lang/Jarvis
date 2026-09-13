// DeepSeek, the cheapest of the four providers by a wide margin.
//
// This file used to say: "three near-identical clients is less trouble than one
// that has to be correct for three providers' divergences at once; when a
// fourth arrives, that is the moment to extract, not before."
//
// A fourth arrived, and with it the need for tool calling in all of them —
// which would have meant four copies of the same tool_call_id translation. So
// the extraction happened: the HTTP call is in openaiCompatible.js and the
// Anthropic-to-OpenAI translation is in toolTranslation.js. What is left here
// is the only thing genuinely specific to DeepSeek: its URL, its key, and its
// model default.
//
// Tool calling means this is no longer leaf-only. An orchestrator can run here
// and still delegate, which is the whole point — ten agents were locked to
// Anthropic because the clients could not carry tools, not because they needed
// Claude.

import { readSecret, hasSecret } from '../env.js';
import { createChatCompletion } from './openaiCompatible.js';

const BASE_URL = 'https://api.deepseek.com/v1/chat/completions';

export function isDeepSeekConfigured() {
  return hasSecret('DEEPSEEK_API_KEY');
}

export function deepSeekModel() {
  return (process.env.DEEPSEEK_MODEL || '').trim() || 'deepseek-chat';
}

/**
 * One completion, returned in the shape agentRunner already reads from the
 * Anthropic SDK — content blocks and snake_case usage included — so no
 * caller has to branch on provider.
 *
 * @param {{model: string, system: string, messages: Array<{role: string, content: any}>, maxTokens: number}} opts
 */
export async function createCompletion({ model, system, messages, maxTokens, tools }) {
  const apiKey = readSecret('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');

  return createChatCompletion({
    url: BASE_URL,
    apiKey,
    label: 'DeepSeek',
    model: model || deepSeekModel(),
    system,
    messages,
    maxTokens,
    tools,
  });
}
