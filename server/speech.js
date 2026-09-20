// Talking back.
//
// This app could already listen: a WhatsApp voice note is downloaded and run
// through Whisper, and the text goes to the team. It could not answer in kind.
// The only text-to-speech in the codebase lives in the browser client
// (useSpeechSynthesis.js), which speaks through the viewer's own device and is
// unreachable from a webhook — so a founder who sent a voice note got a wall of
// text back, which is the wrong shape for the moment they are in. Somebody
// sends a voice note because their hands are full.
//
// Same OPENAI_API_KEY the transcription already uses. No new credential for the
// founder to set, which matters: everything else in this file would be ready
// and the one missing variable would make it all inert.
//
// Opus in an ogg container, because that is what WhatsApp renders as a playable
// voice note rather than a file attachment. An mp3 arrives as something you
// download, and the difference decides whether this feature gets used.

import { readSecret, hasSecret } from './env.js';

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

export function isSpeechConfigured() {
  return hasSecret('OPENAI_API_KEY');
}

export function speechModel() {
  return (process.env.OPENAI_SPEECH_MODEL || '').trim() || 'gpt-4o-mini-tts';
}

export function speechVoice() {
  return (process.env.OPENAI_SPEECH_VOICE || '').trim() || 'alloy';
}

/**
 * How much of a reply gets spoken.
 *
 * A status report read aloud is unlistenable, and this company's replies run to
 * thousands of characters. So the voice note carries the top of the answer and
 * the text message carries all of it — the spoken part is an answer, not a
 * recital.
 */
export function spokenLimit() {
  const raw = Number((process.env.VOICE_REPLY_MAX_CHARS || '').trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 700;
}

/**
 * The part worth saying out loud, cut at a sentence rather than mid-word.
 *
 * Returns whether it was cut, so the caller can say so — a voice note that
 * stops mid-thought with no explanation reads as a bug, and the founder would
 * be right to think something broke.
 */
export function spokenExcerpt(text, limit = spokenLimit()) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return { text: '', truncated: false };
  if (body.length <= limit) return { text: body, truncated: false };

  const window = body.slice(0, limit);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  // Only break at a sentence if one lands reasonably late; otherwise a single
  // long opening sentence would be cut to almost nothing.
  const cut = lastStop > limit * 0.5 ? lastStop + 1 : window.lastIndexOf(' ');
  return { text: body.slice(0, cut > 0 ? cut : limit).trim(), truncated: true };
}

/**
 * Speech for one piece of text. Returns the audio bytes, or throws.
 *
 * @returns {Promise<{buffer: Buffer, mimeType: string, filename: string}>}
 */
export async function synthesize(text, { voice = speechVoice(), instructions = '' } = {}) {
  const body = String(text || '').trim();
  if (!body) throw new Error('Nothing to say.');
  const apiKey = readSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set, so nothing can be spoken.');

  const response = await fetch(SPEECH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: speechModel(),
      voice,
      input: body,
      // Opus/ogg is what WhatsApp plays inline as a voice note.
      response_format: 'opus',
      ...(instructions ? { instructions } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Speech synthesis failed (${response.status}): ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimeType: 'audio/ogg', filename: 'reply.ogg' };
}
