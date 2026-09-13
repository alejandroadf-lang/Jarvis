// The one request shape four providers share.
//
// OpenRouter, OpenAI, DeepSeek and Gemini all speak the OpenAI chat-completions
// protocol — Gemini through a compatibility endpoint alongside its native one.
// Each had its own near-identical copy of the same fetch, which was fine while
// the only call shape was "prompt in, text out" and stopped being fine the
// moment tool calling had to be added to all of them: four copies of a
// translation is four places for the tool_call_id handling to drift.
//
// So the HTTP call lives here once, the translation lives in
// toolTranslation.js, and each provider module keeps only what is genuinely
// specific to it: its URL, how its key is presented, and its model default.

import { toOpenAiTools, toOpenAiMessages, fromOpenAiResponse } from './toolTranslation.js';

/**
 * One chat completion against any OpenAI-compatible endpoint, returned in the
 * Anthropic shape agentRunner reads.
 *
 * @param {object} opts
 * @param {string} opts.url             full chat-completions URL
 * @param {string} opts.apiKey          bearer token
 * @param {string} opts.label           provider name, for error messages
 * @param {string} opts.model
 * @param {string} opts.system          already flattened to text by the caller
 * @param {Array}  opts.messages        Anthropic-shaped messages
 * @param {number} opts.maxTokens
 * @param {Array}  [opts.tools]         Anthropic-shaped tool definitions
 * @param {string} [opts.maxTokensField] OpenAI renamed this; see below
 * @param {object} [opts.headers]       extra provider headers
 */
export async function createChatCompletion({
  url,
  apiKey,
  label,
  model,
  system,
  messages,
  maxTokens,
  tools,
  maxTokensField = 'max_tokens',
  headers = {},
}) {
  const functions = toOpenAiTools(tools);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model,
      [maxTokensField]: maxTokens,
      messages: toOpenAiMessages(messages, system),
      // Omitted entirely rather than sent empty: an empty tools array is a 400
      // on some providers, and it would also change the cached prefix for the
      // leaf calls that have no tools at all.
      ...(functions.length ? { tools: functions, tool_choice: 'auto' } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`${label} request failed (${response.status}): ${detail.slice(0, 300)}`);
    // agentRunner's retry predicate and its outage detection both read
    // `.status`, the same property the Anthropic SDK sets — so a 429 here
    // retries exactly like a 429 there.
    err.status = response.status;
    throw err;
  }

  return fromOpenAiResponse(await response.json());
}
