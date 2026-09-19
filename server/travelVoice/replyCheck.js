// Checking the advisor's own answer before the caller hears it.
//
// The advisor leans on two instructions harder than anything else in its
// prompt: answer entirely in the caller's language, and keep it short enough
// to listen to. A frontier model follows both nearly always. An open model on
// a European host — the reason the brain slot exists at all — follows them
// less reliably, and both failures are worse on a voice channel than
// anywhere else:
//
//   WRONG LANGUAGE is a total loss. A Spanish agent who receives thirty
//   seconds of English audio has not been given a worse answer, they have
//   been given no answer, and they cannot skim it to find out. This is worth
//   a second model call to fix, which is what happens below.
//
//   TOO LONG is a partial loss, and a different kind. Four hundred words of
//   synthesised speech is ninety seconds nobody listens to the end of, but
//   the words themselves are fine — the text message carries them intact. So
//   this is not retried; the spoken version is cut at a sentence boundary and
//   the overrun is recorded, because "which brain rambles" is exactly the
//   comparison the Travel Voice tab exists to make.
//
// Both checks are deliberately reluctant. A false positive on the language
// check costs a whole extra call and doubles the wait on a phone, so it fires
// only on strong evidence and stays silent on anything it cannot judge — a
// reply that is mostly Amadeus entries and IATA codes has no language to
// detect, and that is the common case for the shortest answers.

import { guessLanguage, normalizeLanguage, DEFAULT_LANGUAGE, LANGUAGE_NAMES } from './languages.js';
import { override as settingOverride } from './settings.js';

// Higher than the 0.6 used on the way in. Acting on the caller's own words
// costs nothing if it is wrong; acting on the advisor's costs a second call
// and the seconds the caller spends waiting for it.
const DRIFT_CONFIDENCE = 0.7;

// How much evidence the guess must rest on. A reply of "Oui." or "Use FXP."
// scores one marker or none, and one marker is not a language.
const DRIFT_MIN_HITS = 6;

// Each of these is settable from a phone mid-demo (see settings.js), which
// is why the override is consulted before the environment rather than after.
export function spokenMaxWords() {
  const pinned = settingOverride('length');
  if (pinned !== undefined) return pinned;
  const value = Number(process.env.TRAVEL_VOICE_SPOKEN_MAX_WORDS);
  return Number.isFinite(value) && value > 0 ? value : 220;
}

/** Whether a drifted reply is worth a second call. On by default. */
export function languageRetryEnabled() {
  const pinned = settingOverride('retry');
  if (pinned !== undefined) return pinned;
  return (process.env.TRAVEL_VOICE_LANGUAGE_RETRY || '').trim().toLowerCase() !== 'false';
}

export function countWords(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/**
 * Looks at a finished reply and says what is wrong with it, if anything.
 *
 * @param {string} reply
 * @param {object} opts
 * @param {string} opts.language the language it was asked for
 * @returns {{ drifted: boolean, detected: string|null, confidence: number, words: number, tooLong: boolean }}
 */
export function checkReply(reply, { language } = {}) {
  const wanted = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const text = String(reply || '').trim();
  const words = countWords(text);
  const guess = guessLanguage(text);

  const drifted =
    Boolean(guess.language) &&
    guess.language !== wanted &&
    guess.confidence >= DRIFT_CONFIDENCE &&
    (guess.hits || 0) >= DRIFT_MIN_HITS;

  return {
    drifted,
    detected: guess.language,
    confidence: guess.confidence,
    words,
    tooLong: words > spokenMaxWords(),
  };
}

// Written in the target language first, because a model that just ignored an
// English instruction to speak Spanish is not obviously going to obey a
// second one. The English half is there for the same reason in reverse: a
// model weak enough to drift may also be weak enough to misread the Spanish.
const CORRECTIONS = {
  es: 'Tu respuesta anterior no estaba en español. Vuelve a darla entera en español, con el mismo contenido y la misma brevedad. No añadas disculpas ni comentarios sobre el idioma.',
  fr: "Votre réponse précédente n'était pas en français. Redonnez-la entièrement en français, avec le même contenu et la même brièveté. N'ajoutez ni excuses ni commentaires sur la langue.",
  en: 'Your previous answer was not in English. Give it again entirely in English, with the same content and the same brevity. Do not add apologies or any comment about the language.',
};

/** The one message sent to make a drifted reply come back in the right language. */
export function correctionPrompt(language) {
  const wanted = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const names = LANGUAGE_NAMES[wanted];
  return `${CORRECTIONS[wanted]}\n\n(Answer in ${names.english} / ${names.native} only.)`;
}

/**
 * Cuts a spoken reply to something a person will actually listen to the end
 * of, at a sentence boundary rather than mid-word.
 *
 * Returns the text unchanged when it is already short enough, and never
 * returns an empty string: a single sentence longer than the whole budget is
 * better spoken in full than not spoken at all.
 */
export function trimToSentence(text, maxWords = spokenMaxWords()) {
  const body = String(text || '').trim();
  if (countWords(body) <= maxWords) return body;

  // Sentence ends, keeping the punctuation that makes speech sound finished.
  const sentences = body.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || [body];
  const kept = [];
  let total = 0;
  for (const sentence of sentences) {
    const size = countWords(sentence);
    if (kept.length && total + size > maxWords) break;
    kept.push(sentence.trim());
    total += size;
  }
  return kept.join(' ').trim() || body;
}
