// Answering in the language the question was asked in.
//
// Nothing in this app handled language at all. A voice note in Spanish was
// transcribed correctly and then answered in English, because every system
// prompt is written in English and that is what the model matches. The
// translation was happening — silently, in the wrong direction, and nobody
// asked for it.
//
// Two mechanisms, deliberately separate, because they fail differently:
//
//   1. MIRROR (default). Answer in whatever language the founder used. The
//      language comes from Whisper's own detection rather than a guess, and
//      when Whisper is not confident the instruction is omitted entirely —
//      an empty answer is better than a confident wrong one, since a model
//      told "reply in en" when the founder spoke Catalan will obey.
//   2. PINNED. Always answer in one named language, whatever came in. This is
//      the actual translation case: brief the company in Spanish, read the
//      answer in English, or the reverse.
//
// The instruction goes in the prompt rather than through a translation API on
// the way out. Translating a finished English answer produces English
// sentences wearing Spanish words — idiom, register and the company's own
// vocabulary all survive better when the answer is composed in the target
// language in the first place.

// Whisper reports ISO-639-1. Named rather than coded in the prompt because
// "reply in Spanish" is an instruction a model follows more reliably than
// "reply in es", and because an unrecognised code should degrade to saying
// nothing rather than to a two-letter mystery.
const NAMES = {
  ar: 'Arabic', bn: 'Bengali', ca: 'Catalan', cs: 'Czech', da: 'Danish', de: 'German',
  el: 'Greek', en: 'English', es: 'Spanish', fa: 'Persian', fi: 'Finnish', fr: 'French',
  he: 'Hebrew', hi: 'Hindi', hu: 'Hungarian', id: 'Indonesian', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', ms: 'Malay', nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese',
  ro: 'Romanian', ru: 'Russian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian',
  ur: 'Urdu', vi: 'Vietnamese', zh: 'Chinese',
};

export function languageName(code) {
  const key = String(code || '').trim().toLowerCase().slice(0, 2);
  return NAMES[key] || '';
}

/** The founder's pinned language, if they set one. Empty means mirror. */
export function pinnedLanguage() {
  const raw = String(process.env.REPLY_LANGUAGE || '').trim().toLowerCase();
  if (!raw || raw === 'mirror' || raw === 'auto') return '';
  return languageName(raw) || (raw.length > 2 ? raw : '');
}

/**
 * The line appended to the system prompt, or nothing.
 *
 * Nothing is a real answer and the common one: a founder typing English to an
 * English-speaking team needs no instruction, and adding "reply in English" to
 * every turn would be tokens spent to change nothing.
 */
export function replyLanguageInstruction({ detected = '' } = {}) {
  const pinned = pinnedLanguage();
  if (pinned) {
    return `Reply in ${pinned}, whatever language the message is written in. Keep product names, code, commands and ventureIds exactly as they are — those are not words to translate.`;
  }

  const heard = languageName(detected);
  // No detection, or one this app has no name for: say nothing rather than
  // instruct the model into a language it may not have been.
  if (!heard || heard === 'English') return '';
  return `The founder is speaking ${heard}. Reply in ${heard}. Keep product names, code, commands and ventureIds exactly as they are — those are not words to translate.`;
}

/** For the founder: what the current setting actually does. */
export function describeLanguageSetting() {
  const pinned = pinnedLanguage();
  if (pinned) return `Replies are pinned to ${pinned}, whatever language you write in.`;
  return 'Replies mirror the language you use. Set REPLY_LANGUAGE to pin one instead.';
}
