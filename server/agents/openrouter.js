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
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/**
 * One completion. Returns the same shape agentRunner already handles from
 * the Anthropic SDK, so the caller doesn't branch on provider to read a
 * result — content blocks and snake_case usage included.
 *
 * @param {{model: string, system: string, messages: Array<{role: string, content: any}>, maxTokens: number}} opts
 */
export async function createCompletion({ model, system, messages, maxTokens }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // OpenRouter attributes traffic with these; both are optional and
      // neither carries anything about the founder or the business.
      'X-Title': 'Jarvis',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map(toOpenAiMessage),
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`OpenRouter request failed (${response.status}): ${detail.slice(0, 300)}`);
    // agentRunner's retry predicate reads `.status`, the same property the
    // Anthropic SDK sets — so a 429 here retries exactly like a 429 there.
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content ?? '';

  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
  };
}

// A leaf agent's history is plain text in practice, but the Anthropic
// message shape allows an array of content blocks. Flatten those to the
// text the OpenAI schema expects rather than sending an object it would
// reject outright.
function toOpenAiMessage(message) {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  const text = (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { role: message.role, content: text };
}
