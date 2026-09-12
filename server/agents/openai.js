import { readSecret, hasSecret } from '../env.js';
// An OpenAI client covering the two things this app asks of it: a plain
// completion (same shape as openrouter.js) and audio transcription.
//
// Raw fetch rather than the SDK, matching openrouter.js and deploy/github.js
// for the same reason: this path deliberately never uses tool calling,
// streaming or structured output, so an SDK would be a dependency carrying
// features nothing here touches.
//
// Model names and prices are pinned by hand like every other provider in this
// app — but unlike the others they are also env-overridable, because OpenAI
// renames and retires models faster than this file gets edited. A stale
// default should be a one-variable fix in Railway, not a redeploy.

const CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

export function isOpenAIConfigured() {
  return hasSecret('OPENAI_API_KEY');
}

export function chatModel() {
  return (process.env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini';
}

export function fallbackModel() {
  return (process.env.OPENAI_FALLBACK_MODEL || '').trim() || 'gpt-4o';
}

export function transcribeModel() {
  return (process.env.OPENAI_TRANSCRIBE_MODEL || '').trim() || 'whisper-1';
}

/**
 * One completion, returned in the shape agentRunner already handles from the
 * Anthropic SDK — content blocks and snake_case usage included — so no caller
 * branches on provider to read a result.
 */
export async function createCompletion({ model, system, messages, maxTokens }) {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || chatModel(),
      max_completion_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map(toOpenAiMessage),
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`OpenAI request failed (${response.status}): ${detail.slice(0, 300)}`);
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

/**
 * Transcribes a voice note. Returns the spoken text, or throws with a reason
 * worth relaying — the founder is holding their phone waiting for an answer,
 * so "transcription failed because X" beats silence.
 *
 * @param {Buffer|Uint8Array} audio - the raw audio bytes
 * @param {string} filename - used only for the format hint OpenAI reads from
 *   the extension; WhatsApp voice notes are .ogg (opus).
 */
export async function transcribeAudio(audio, filename = 'voice.ogg') {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  const form = new FormData();
  form.append('file', new Blob([audio]), filename);
  form.append('model', transcribeModel());

  const response = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form, // no Content-Type: fetch sets the multipart boundary itself
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Transcription failed (${response.status}): ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return (data?.text || '').trim();
}

// A leaf agent's history is plain text in practice, but the Anthropic message
// shape allows content blocks. Flatten those rather than sending an object the
// OpenAI schema would reject.
function toOpenAiMessage(message) {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  const text = (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { role: message.role, content: text };
}
