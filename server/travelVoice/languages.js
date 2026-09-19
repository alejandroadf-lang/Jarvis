// The three languages the travel advisor speaks, and how it decides which one
// a caller is using.
//
// Language is the first thing that has to be right on a voice channel. A text
// chat can survive answering in the wrong language for a turn — the person
// reads it, sighs, and types "en español por favor". A voice reply in the
// wrong language is thirty seconds of noise on a phone, and the caller has no
// idea whether the thing understood them at all.
//
// Detection has three sources, in order of trust:
//
//   1. What the caller chose. A web session can pin a language; a WhatsApp
//      caller can say "in French" and the advisor switches. Chosen beats
//      guessed, always.
//   2. What the transcription service heard. Whisper reports the language it
//      decoded, and it hears the difference between Spanish and French far
//      more reliably than any word list.
//   3. A word-frequency heuristic over the text, for typed messages and for
//      transcription models that report no language. Deliberately small: it
//      only has to tell three languages apart, and it says "unknown" rather
//      than guessing when nothing matches.
//
// English is the fallback when nothing else decides. Not because it is the
// most likely — the venture's first callers are Spanish- and French-speaking
// agencies — but because it is the language every travel professional can
// muddle through, so a wrong guess costs least there.

export const SUPPORTED_LANGUAGES = ['es', 'fr', 'en'];
export const DEFAULT_LANGUAGE = 'en';

export const LANGUAGE_NAMES = {
  es: { native: 'Español', english: 'Spanish' },
  fr: { native: 'Français', english: 'French' },
  en: { native: 'English', english: 'English' },
};

// Whisper names languages rather than coding them ("spanish", not "es"), and
// occasionally with a capital letter. Anything outside the three is treated
// as unknown rather than mapped to the nearest one — a Portuguese caller is
// better served by the English fallback than by confident Spanish.
const WHISPER_NAMES = {
  spanish: 'es',
  español: 'es',
  castilian: 'es',
  french: 'fr',
  français: 'fr',
  english: 'en',
};

/**
 * Normalises whatever a caller, a transcriber or a query string said the
 * language was into one of the supported codes, or null.
 */
export function normalizeLanguage(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  // "es-ES", "fr_CA", "en-GB" all carry the code up front.
  const code = raw.split(/[-_]/)[0];
  if (SUPPORTED_LANGUAGES.includes(code)) return code;
  return WHISPER_NAMES[raw] || null;
}

export function isSupportedLanguage(value) {
  return normalizeLanguage(value) !== null;
}

// Function words, because content words are shared across all three (hotel,
// Amadeus, PNR, Madrid). The lists are short on purpose: every word here is
// one that almost never appears in the other two languages, so a single hit
// is meaningful and the score is a count rather than a probability.
const MARKERS = {
  es: [
    'el', 'la', 'los', 'las', 'de', 'del', 'que', 'para', 'con', 'por', 'una', 'uno',
    'es', 'está', 'necesito', 'quiero', 'vuelo', 'vuelos', 'hola', 'gracias', 'reserva',
    'billete', 'tarifa', 'cómo', 'puedo', 'tengo', 'hay', 'pero', 'también', 'mañana',
    'buenos', 'buenas', 'días', 'tardes', 'quisiera', 'cuánto', 'cuesta', 'desde', 'hasta',
    'y', 'o', 'sí', 'no', 'muy', 'este', 'esta', 'cliente', 'pasajero', 'agencia', 'viaje',
  ],
  fr: [
    'le', 'la', 'les', 'des', 'du', 'que', 'pour', 'avec', 'une', 'un', 'est', 'je',
    'vous', 'nous', 'bonjour', 'merci', 'vol', 'vols', 'réservation', 'billet', 'tarif',
    'comment', 'peux', 'puis', 'ai', 'il', 'elle', 'mais', 'aussi', 'demain', 'voudrais',
    'combien', 'coûte', 'depuis', 'jusqu', 'et', 'ou', 'oui', 'non', 'très', 'ce', 'cette',
    'client', 'passager', 'agence', 'voyage', 'dans', 'sur', 'pas', 'suis', 'être', 'faire',
  ],
  en: [
    'the', 'an', 'of', 'that', 'for', 'with', 'is', 'are', 'i', 'you', 'we', 'hello',
    'hi', 'thanks', 'thank', 'flight', 'flights', 'booking', 'ticket', 'fare', 'how', 'can',
    'have', 'there', 'but', 'also', 'tomorrow', 'would', 'like', 'much', 'cost', 'from', 'to',
    'and', 'or', 'yes', 'no', 'very', 'this', 'customer', 'passenger', 'agency', 'trip',
    'in', 'not', 'be', 'do', 'need', 'want', 'please', 'what', 'which', 'when',
  ],
};

const MARKER_SETS = Object.fromEntries(
  Object.entries(MARKERS).map(([lang, words]) => [lang, new Set(words)])
);

/**
 * Guesses the language of a piece of text from its function words.
 *
 * Returns { language, confidence, hits } where language is null when nothing
 * matched — a string of IATA codes and a date, say — so the caller can fall
 * back to a hint or the default rather than to a coin toss. Confidence is the
 * winning share of all marker hits, 0 to 1; `hits` is how many markers the
 * winner actually matched, which is the difference between a guess resting on
 * one word and one resting on twenty.
 */
export function guessLanguage(text) {
  const words = String(text || '')
    .toLowerCase()
    // Keep accented letters: "está" and "coûte" are the strongest markers
    // there are, and stripping diacritics would turn them into noise.
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const scores = { es: 0, fr: 0, en: 0 };
  for (const word of words) {
    for (const lang of SUPPORTED_LANGUAGES) {
      if (MARKER_SETS[lang].has(word)) scores[lang] += 1;
    }
  }

  const total = scores.es + scores.fr + scores.en;
  if (total === 0) return { language: null, confidence: 0, hits: 0 };

  const [best, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const confidence = bestScore / total;
  // A dead heat between two languages is not a detection. Two hits each for
  // Spanish and French ("la reserva de un vol") tells you nothing.
  const runnerUp = Object.entries(scores).filter(([l]) => l !== best).map(([, s]) => s).sort((a, b) => b - a)[0];
  if (bestScore === runnerUp) return { language: null, confidence, hits: bestScore };

  return { language: best, confidence, hits: bestScore };
}

/**
 * The one decision the rest of the module relies on: which language to
 * answer in.
 *
 * @param {object} args
 * @param {string} [args.chosen] what the caller explicitly picked, if anything
 * @param {string} [args.heard] what the transcriber reported, if anything
 * @param {string} [args.text] the message itself, for the word heuristic
 * @param {string} [args.previous] the language of the last turn in this session
 * @returns {{ language: string, source: 'chosen'|'heard'|'guessed'|'previous'|'default' }}
 */
export function resolveLanguage({ chosen, heard, text, previous } = {}) {
  const picked = normalizeLanguage(chosen);
  if (picked) return { language: picked, source: 'chosen' };

  const transcribed = normalizeLanguage(heard);
  if (transcribed) return { language: transcribed, source: 'heard' };

  const guess = guessLanguage(text);
  // A single stray "la" in an otherwise English sentence must not flip the
  // conversation into Spanish. Below this, the previous turn's language wins
  // — a conversation almost never changes language mid-way without saying so.
  if (guess.language && guess.confidence >= 0.6) return { language: guess.language, source: 'guessed' };

  const last = normalizeLanguage(previous);
  if (last) return { language: last, source: 'previous' };

  if (guess.language) return { language: guess.language, source: 'guessed' };
  return { language: DEFAULT_LANGUAGE, source: 'default' };
}

/**
 * "En français, s'il vous plaît" — a caller asking to switch language, in any
 * of the three. Returns the requested code or null. Checked before the
 * advisor runs so the switch is honoured on this turn, not the next.
 */
export function requestedLanguageSwitch(text) {
  const t = String(text || '').toLowerCase();
  const asks = [
    [/\b(en|in|dans)\s+(espa[ñn]ol|spanish|espagnol|castellano)\b/, 'es'],
    [/\b(en|in|dans)\s+(fran[çc]ais|french|franc[ée]s)\b/, 'fr'],
    [/\b(en|in|dans)\s+(ingl[ée]s|english|anglais)\b/, 'en'],
    [/\b(habla|hablame|háblame|parle|parlez|speak|talk)\s+(en\s+|in\s+)?(espa[ñn]ol|spanish|espagnol|castellano)\b/, 'es'],
    [/\b(habla|hablame|háblame|parle|parlez|speak|talk)\s+(en\s+|in\s+)?(fran[çc]ais|french|franc[ée]s)\b/, 'fr'],
    [/\b(habla|hablame|háblame|parle|parlez|speak|talk)\s+(en\s+|in\s+)?(ingl[ée]s|english|anglais)\b/, 'en'],
  ];
  for (const [pattern, lang] of asks) {
    if (pattern.test(t)) return lang;
  }
  return null;
}

// A message that is nothing but a hello. Someone who has just been given
// this number types one, and answering it with a model call wastes a call to
// say what a fixed greeting says better — what this service is and what to
// send next. Matched whole, so "hola, ¿cómo valoro el PNR?" is a question.
const GREETINGS = [
  'hola', 'holaa', 'buenas', 'buenos dias', 'buenos días', 'buenas tardes', 'buenas noches', 'que tal', 'qué tal',
  'bonjour', 'bonsoir', 'salut', 'coucou', 'allo', 'allô',
  'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'yo',
];

export function isBareGreeting(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    // Drop punctuation and emoji; a wave after "hola" is still just a hello.
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return false;
  return GREETINGS.includes(cleaned);
}

// Everything the app says to a caller on its own behalf — not the advisor's
// answers, which the model writes in the right language, but the plumbing
// messages: "I'm listening", "that note was empty", "I can't take live calls
// yet". These have to exist in all three, because a Spanish caller who gets
// an English apology has learned nothing except that something went wrong.
const STRINGS = {
  greeting: {
    es: 'Hola, soy tu asesor de viajes. Puedo ayudarte con Amadeus, tarifas, reservas y cualquier tema del sector. Envíame una nota de voz o escríbeme.',
    fr: 'Bonjour, je suis votre conseiller voyage. Je peux vous aider avec Amadeus, les tarifs, les réservations et tout sujet du secteur. Envoyez-moi un message vocal ou écrivez-moi.',
    en: "Hello, I'm your travel advisor. I can help with Amadeus, fares, bookings and anything in the industry. Send me a voice note or a message.",
  },
  emptyVoiceNote: {
    es: 'No he podido distinguir palabras en esa nota. ¿Puedes repetirla?',
    fr: "Je n'ai pas pu distinguer de mots dans ce message. Pouvez-vous le répéter ?",
    en: "I couldn't make out any words in that one. Could you say it again?",
  },
  transcriptionFailed: {
    es: 'No he podido transcribir la nota de voz. Inténtalo de nuevo o escríbeme.',
    fr: "Je n'ai pas pu transcrire le message vocal. Réessayez ou écrivez-moi.",
    en: "I couldn't transcribe that voice note. Try again, or type it.",
  },
  answerFailed: {
    es: 'No he podido responder a eso ahora mismo. Inténtalo de nuevo en un momento.',
    fr: "Je n'ai pas pu répondre pour le moment. Réessayez dans un instant.",
    en: "I couldn't answer that just now. Please try again in a moment.",
  },
  rateLimited: {
    es: 'Has enviado muchas consultas en poco tiempo. Espera unos minutos y vuelve a intentarlo.',
    fr: 'Vous avez envoyé beaucoup de demandes en peu de temps. Attendez quelques minutes et réessayez.',
    en: "You've sent a lot of questions in a short time. Give it a few minutes and try again.",
  },
  unsupportedType: {
    es: 'Puedo escuchar notas de voz y leer mensajes de texto. Ese tipo de mensaje no lo puedo abrir.',
    fr: 'Je peux écouter les messages vocaux et lire les textes. Je ne peux pas ouvrir ce type de message.',
    en: "I can listen to voice notes and read text messages. I can't open that kind of message.",
  },
  liveCallUnavailable: {
    es: 'Todavía no puedo atender llamadas en directo. Envíame una nota de voz con tu pregunta y te respondo con otra nota de voz.',
    fr: "Je ne peux pas encore prendre d'appels en direct. Envoyez-moi un message vocal avec votre question et je vous réponds par message vocal.",
    en: "I can't take live calls yet. Send me a voice note with your question and I'll answer with a voice note.",
  },
  callPermissionIntro: {
    es: 'Soy el asesor de viajes. Me gustaría llamarte para hablar de tu consulta. Acepta la solicitud de llamada y te llamo.',
    fr: "Je suis le conseiller voyage. J'aimerais vous appeler pour parler de votre demande. Acceptez la demande d'appel et je vous appelle.",
    en: "This is the travel advisor. I'd like to call you about your query. Accept the call request and I'll ring you.",
  },
  demoModeOn: {
    es: 'Modo asesor de viajes activado: todo lo que envíes ahora lo responde el asesor, en voz si me hablas en voz. Escribe TRAVEL OFF para volver al equipo.',
    fr: "Mode conseiller voyage activé : tout ce que vous envoyez maintenant est traité par le conseiller, en voix si vous parlez. Écrivez TRAVEL OFF pour revenir à l'équipe.",
    en: 'Travel advisor mode is on: everything you send now goes to the advisor, in voice if you speak. Send TRAVEL OFF to go back to the team.',
  },
  demoModeOff: {
    es: 'Modo asesor de viajes desactivado. Vuelves a hablar con el equipo.',
    fr: "Mode conseiller voyage désactivé. Vous parlez de nouveau à l'équipe.",
    en: 'Travel advisor mode is off. You are talking to the team again.',
  },
};

/** A plumbing message in the caller's language, falling back to English. */
export function localized(key, language) {
  const entry = STRINGS[key];
  if (!entry) throw new Error(`No localized string for "${key}"`);
  return entry[normalizeLanguage(language) || DEFAULT_LANGUAGE];
}
