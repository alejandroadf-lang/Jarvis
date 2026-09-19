import { readSecret, hasSecret } from '../env.js';
import { createChatCompletion } from './openaiCompatible.js';
// An OpenAI client covering the two things this app asks of it: a plain
// completion (same shape as openrouter.js) and audio transcription.
//
// Raw fetch rather than the SDK, matching openrouter.js and deploy/github.js
// for the same reason: the chat path now carries tool calling through
// the shared OpenAI-compatible client, and still uses no streaming or
// structured output — so an SDK would be a dependency for the one thing this
// file still does alone, which is audio transcription.
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
export async function createCompletion({ model, system, messages, maxTokens, tools }) {
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  return createChatCompletion({
    url: CHAT_URL,
    apiKey,
    label: 'OpenAI',
    model: model || chatModel(),
    system,
    messages,
    maxTokens,
    tools,
    // OpenAI renamed this field and rejects the old one on its newer models.
    maxTokensField: 'max_completion_tokens',
  });
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
  // Ask for the detected language as well as the words. Without it a reply to
  // a Spanish voice note comes back in English, which is a translation nobody
  // asked for — and knowing the language is what makes answering in it
  // possible at all.
  form.append('response_format', 'verbose_json');

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
  return {
    text: (data?.text || '').trim(),
    // ISO-639-1 where Whisper is confident, empty where it is not. Empty is a
    // real answer: it means answer in whatever the text looks like rather than
    // guessing a language and being confidently wrong in it.
    language: String(data?.language || '').trim().toLowerCase(),
  };
}
