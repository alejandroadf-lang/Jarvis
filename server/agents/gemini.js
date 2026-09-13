import { readSecret, hasSecret } from '../env.js';
import { createChatCompletion } from './openaiCompatible.js';
// Gemini, through Google's OpenAI-compatible endpoint.
//
// This file used to speak the native API, whose shape differs from everyone
// else's in three ways: the key goes in a query parameter, the assistant role is
// called "model", and message text lives in a `parts` array. That was a
// reasonable amount of special-casing while the only call shape was text in and
// text out.
//
// Adding tool calling changed the arithmetic. Native Gemini has function calling
// but in its own vocabulary — `functionDeclarations`, `functionCall`,
// `functionResponse` — so supporting it would have meant a second translation
// layer kept in step with the OpenAI one forever. The compatibility endpoint
// speaks the protocol the other three providers already speak, so one tested
// translation (toolTranslation.js) serves all four and this file keeps only the
// URL and the key.
//
// listModelsUrl still points at the native API: the integration probe uses it
// and there is no compatibility equivalent.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export function isGeminiConfigured() {
  return hasSecret('GEMINI_API_KEY');
}

export function geminiModel() {
  return (process.env.GEMINI_MODEL || '').trim() || 'gemini-2.0-flash';
}

export function listModelsUrl() {
  return `${BASE_URL}/models?key=${encodeURIComponent(readSecret('GEMINI_API_KEY') || '')}`;
}

/**
 * One completion, in the shape agentRunner already handles from the Anthropic
 * SDK — content blocks and snake_case usage included.
 *
 * Routed through Google's **OpenAI-compatible** endpoint rather than the native
 * `generateContent` one this file used to call. Native Gemini has function
 * calling too, but in its own shape: `functionDeclarations`, `functionCall`,
 * `functionResponse`, and a `parts` array instead of messages. Supporting tools
 * natively would have meant a second translation layer to keep in step with the
 * OpenAI one forever, for no benefit — the compatibility endpoint speaks the
 * protocol the other three providers already speak, so one tested translation
 * serves all four.
 *
 * The key moves from a query parameter to a bearer header as part of that. The
 * native base URL is still used by listModelsUrl, which the integration probe
 * calls and which has no compatibility equivalent.
 */
export async function createCompletion({ model, system, messages, maxTokens, tools }) {
  const apiKey = readSecret('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  return createChatCompletion({
    url: `${BASE_URL}/openai/chat/completions`,
    apiKey,
    label: 'Gemini',
    // The compatibility endpoint takes a bare model name; a "models/" prefix is
    // valid in the native API and a 404 here.
    model: (model || geminiModel()).replace(/^models\//, ''),
    system,
    messages,
    maxTokens,
    tools,
  });
}
