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
// How much speech a character is worth, by script.
//
// The budget was a flat character count, which silently meant "however long
// 700 English characters take". 700 Chinese characters is several minutes:
// each one is a syllable or a whole word, where a Latin character is a
// fraction of one. Thai sits in between and writes without spaces, so it
// overran too. The limit is a listening budget, so it is spent in units of
// speech rather than units of storage.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const THAI_LAO_KHMER_MYANMAR = /[\u0e00-\u0eff\u1780-\u17ff\u1000-\u109f]/;

function speechWeight(char) {
  if (CJK.test(char)) return 3;
  if (THAI_LAO_KHMER_MYANMAR.test(char)) return 1.6;
  return 1;
}

/** How far into `body` the listening budget reaches. */
function budgetedEnd(body, limit) {
  let spent = 0;
  for (let i = 0; i < body.length; i += 1) {
    spent += speechWeight(body[i]);
    if (spent > limit) return i;
  }
  return body.length;
}

// Sentence enders. The Latin ones need a space after them so "29.00" and
// "Dr. Vega" are not sentence breaks; the CJK and Indic ones are unambiguous
// on their own and are written with no following space at all — which is why
// a Chinese reply used to find no break and get cut mid-clause.
const HARD_STOPS = ['。', '！', '？', '…', '۔', '।', '॥', '॰'];
const LATIN_STOPS = ['. ', '? ', '! ', '." ', '?" ', '!" '];

function lastSentenceEnd(window) {
  let best = -1;
  for (const stop of LATIN_STOPS) {
    const at = window.lastIndexOf(stop);
    if (at > best) best = at; // index of the punctuation itself
  }
  for (const stop of HARD_STOPS) {
    const at = window.lastIndexOf(stop);
    if (at > best) best = at;
  }
  return best;
}

export function spokenExcerpt(text, limit = spokenLimit()) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return { text: '', truncated: false };

  const end = budgetedEnd(body, limit);
  if (end >= body.length) return { text: body, truncated: false };

  const window = body.slice(0, end);
  const lastStop = lastSentenceEnd(window);
  // Only break at a sentence if one lands reasonably late; otherwise a single
  // long opening sentence would be cut to almost nothing.
  let cut = lastStop > end * 0.5 ? lastStop + 1 : -1;

  // No usable sentence break: fall back to a word boundary, and then — for
  // Thai, Chinese and Japanese, which are written without spaces and where
  // lastIndexOf(' ') is always -1 — to the budget itself. A character cut in
  // those scripts is a normal line break, not the mid-word break it would be
  // in English.
  if (cut <= 0) {
    const lastSpace = window.lastIndexOf(' ');
    cut = lastSpace > end * 0.5 ? lastSpace : end;
  }

  return { text: body.slice(0, cut).trim(), truncated: true };
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

/**
 * What the team is told when the founder spoke instead of typed.
 *
 * Without this the transcription is invisible: the agents receive ordinary
 * text, and when asked about voice they answer from a self-model that says
 * they have none — "I only work from text, no audio or voice channel exists
 * on my end", sent by a company that had just listened to a voice note and
 * was about to answer in one. A capability nobody knows they have is a
 * capability the founder gets told does not exist.
 *
 * It also changes the right shape for the answer. Only the first
 * `spokenLimit()` characters are read aloud, so the conclusion has to be at
 * the top — a reply that builds to its point loses the point to the cut.
 *
 * Empty for a typed message, which is most of them.
 */
export function spokenReplyInstruction({ arrivedAsVoice = false } = {}) {
  if (!arrivedAsVoice) return '';

  const spoken = isSpeechConfigured() && process.env.VOICE_REPLIES !== 'false';
  if (!spoken) {
    return (
      'The founder sent this as a voice note and it was transcribed for you, so you did hear them — say so ' +
      'plainly if it comes up. Your answer goes back as text only, because spoken replies are switched off.'
    );
  }

  return (
    'The founder sent this as a voice note. It was transcribed for you, so you did hear them: never tell them ' +
    'you cannot receive audio or have no voice channel — you have both, and this message came through one. ' +
    `Your answer is sent as text and the first ${spokenLimit()} characters are also read back to them aloud. ` +
    'So put the answer in the opening sentences and the detail after it. Anything that only makes sense on a ' +
    'screen — a table, a list of ids, a long number — belongs below that opening, not inside it.'
  );
}
