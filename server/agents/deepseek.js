// DeepSeek, as a fourth provider for leaf agents.
//
// Same shape as openrouter.js and for the same reasons: one call, text in
// and text out, no tool-use loop. Only leaf agents route here (see models.js
// and canUseAlternativeModel), so a plain completion is all that is ever
// needed — and keeping it plain is what stops a cheaper model silently
// losing the ability to delegate or act.
//
// The API is OpenAI-compatible, which is why this is a near-copy rather than
// a shared abstraction. Three near-identical clients is less trouble than
// one that has to be correct for three providers' divergences at once; when
// a fourth arrives, that is the moment to extract, not before.

import { readSecret, hasSecret } from '../env.js';

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
export async function createCompletion({ model, system, messages, maxTokens }) {
  const apiKey = readSecret('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || deepSeekModel(),
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map(toOpenAiMessage),
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`DeepSeek request failed (${response.status}): ${detail.slice(0, 300)}`);
    // agentRunner's retry predicate reads `.status`, the same property the
    // Anthropic SDK sets, so a 429 here retries exactly like a 429 there.
    err.status = response.status;
    throw err;
  }

  const data = await response.json();

  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: data?.choices?.[0]?.message?.content ?? '' }],
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
  };
}

// A leaf agent's history is plain text in practice, but the Anthropic message
// shape allows an array of content blocks. Flatten those to the text the
// OpenAI schema expects rather than sending an object it would reject.
//
// Images are dropped here, deliberately and harmlessly: an image only ever
// reaches the orchestrator, which is always on the frontier model, and it
// describes what it saw when it delegates.
function toOpenAiMessage(message) {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  const text = (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { role: message.role, content: text };
}
