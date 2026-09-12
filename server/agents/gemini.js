// A Gemini client for the one call shape this app needs: system prompt +
// messages in, text out. Same scope and the same reasons as openrouter.js and
// openai.js — raw fetch, no SDK, no tool calling.
//
// Google's API differs from the other two in three ways that all have to be
// handled here rather than by the caller: the key goes in a query parameter,
// the assistant role is called "model", and message text lives in a `parts`
// array. Everything is converted back to the Anthropic-shaped response the
// rest of the app reads, so no caller branches on provider.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function geminiModel() {
  return (process.env.GEMINI_MODEL || '').trim() || 'gemini-2.0-flash';
}

export function listModelsUrl() {
  return `${BASE_URL}/models?key=${encodeURIComponent(process.env.GEMINI_API_KEY || '')}`;
}

/**
 * One completion, in the shape agentRunner already handles from the Anthropic
 * SDK — content blocks and snake_case usage included.
 */
export async function createCompletion({ model, system, messages, maxTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const name = (model || geminiModel()).replace(/^models\//, '');
  const response = await fetch(
    `${BASE_URL}/models/${encodeURIComponent(name)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.map(toGeminiContent),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 300)}`);
    // agentRunner's retry predicate reads `.status`, same as the other two.
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: data?.usageMetadata?.promptTokenCount || 0,
      output_tokens: data?.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

// Two conversions in one: Anthropic's content blocks flatten to text, and
// "assistant" becomes "model" — Gemini rejects the former outright rather
// than ignoring it.
function toGeminiContent(message) {
  const text =
    typeof message.content === 'string'
      ? message.content
      : (message.content || [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
  return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
}
