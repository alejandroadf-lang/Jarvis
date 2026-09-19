// Automatic translation, on the same cascade the advisor already runs on.
//
// The advisor answers a Spanish agent in Spanish. That is not translation —
// it is one person being understood. Translation is the other job an agency
// has all day: the agent speaks Spanish and needs the same words in English
// for an airline desk, or receives a French message and needs it in Spanish
// before they can act on it.
//
// It costs nothing new to build. A model that can answer in three languages
// can move words between them, so this reuses the brain, the ears and the
// voice exactly as they are. No new provider, no media bridge, no realtime
// model. What it needs is its own prompt and its own routing, because a
// translator and an advisor must never be confused: an advisor that helpfully
// answers the question inside the sentence it was asked to translate has
// destroyed the thing it was given.
//
// ## The rule that makes this a travel translator
//
// A generic translator ruins travel text. "FXP" is not a word, MAD is not
// Madrid spelled oddly, and a fare basis of ONNAZ must arrive at the other
// end character for character. Translate those and the message becomes
// actively dangerous: an agent acts on a locator that no longer exists. So
// the prompt names what must survive untouched, and the checks below verify
// that it did, rather than trusting that it did.

import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, normalizeLanguage, DEFAULT_LANGUAGE } from './languages.js';
import { readJson, writeJson } from '../store.js';

const FILE = 'travelVoiceTranslate.json';

// --- what mode a conversation is in -----------------------------------------

function load() {
  const data = readJson(FILE, { modes: {} });
  if (!data.modes) data.modes = {};
  return data;
}

/**
 * The translation mode for one conversation, or null when it is talking to
 * the advisor as usual.
 *
 * Two shapes. `{ to }` is one-way: whatever you send comes back in that
 * language. `{ pair: [a, b] }` is a channel between two languages: speak
 * either and it comes out as the other, which is the shape that lets one
 * WhatsApp thread sit between a Spanish agent and a French client.
 */
export function modeFor(sessionId) {
  return load().modes[sessionId] || null;
}

export function setMode(sessionId, mode) {
  const data = load();
  if (mode) data.modes[sessionId] = mode;
  else delete data.modes[sessionId];
  writeJson(FILE, data);
  return mode;
}

export function clearMode(sessionId) {
  return setMode(sessionId, null);
}

/**
 * Which language this particular message should come out in.
 *
 * For a pair, the target is whichever of the two the speaker did not use.
 * A speaker using neither gets the first of the pair, because a French
 * client who drops into English in the middle of a Spanish-French channel
 * still wants the agent to hear Spanish.
 */
export function targetFor(mode, heardLanguage) {
  if (!mode) return null;
  if (mode.to) return mode.to;
  const [a, b] = mode.pair;
  if (heardLanguage === a) return b;
  if (heardLanguage === b) return a;
  return a;
}

export function describeMode(mode) {
  if (!mode) return 'off';
  if (mode.to) return `into ${LANGUAGE_NAMES[mode.to].native}`;
  const [a, b] = mode.pair;
  return `${LANGUAGE_NAMES[a].native} and ${LANGUAGE_NAMES[b].native}, both ways`;
}

// --- the prompt ---------------------------------------------------------------

// Everything a travel message carries that a translator must not touch. The
// list is in the prompt rather than enforced by regex on the way out, because
// a translation is not a substitution and clamping tokens back in afterwards
// produces sentences no human wrote. The check below verifies the outcome
// instead of constraining the method.
const PRESERVE = `Leave these EXACTLY as they appear, character for character, never translated, never expanded, never reformatted:
- Amadeus cryptic entries and any command-looking token: FXP, FXB, TTP, RT, FQN1*16, SS1Y2, NM1GARCIA/JUAN MR, XE2, TQT, TRDC.
- IATA and ICAO codes: airports (MAD, CDG, LHR), airlines (IB, AF, BA), cities. MAD stays MAD; it never becomes Madrid.
- Record locators and ticket numbers: ABC123, 075-1234567890.
- Fare basis codes and booking classes: ONNAZ, Y, J, tour codes.
- Numbers, prices, currencies, dates, times and flight numbers. A price or a date that changes in translation is worse than no translation at all.
- Proper names of people and companies.`;

// The trade's own words, as lemmas. Given to the model as terminology rather
// than enforced as string substitution, because a verbatim glossary is the
// documented way to break Spanish and French: "la localizador" is what you
// get when a masculine noun is pasted into a feminine slot. The model is
// told the term and told to inflect it.
export const GLOSSARY = [
  { en: 'record locator', es: 'localizador', fr: 'dossier (référence de réservation)' },
  { en: 'booking', es: 'reserva', fr: 'réservation' },
  { en: 'ticketing time limit', es: 'plazo de emisión', fr: "date limite d'émission" },
  { en: 'issue (a ticket)', es: 'emitir', fr: 'émettre' },
  { en: 'fare rules', es: 'condiciones de la tarifa', fr: 'conditions tarifaires' },
  { en: 'fare basis', es: 'base tarifaria', fr: 'base tarifaire' },
  { en: 'refund', es: 'reembolso', fr: 'remboursement' },
  { en: 'exchange (reissue)', es: 'cambio (reemisión)', fr: 'échange (réémission)' },
  { en: 'void', es: 'anulación (void)', fr: 'annulation (void)' },
  { en: 'queue', es: 'cola', fr: 'queue' },
  { en: 'validating carrier', es: 'compañía validadora', fr: 'compagnie émettrice' },
  { en: 'segment', es: 'segmento', fr: 'segment' },
  { en: 'waitlist', es: 'lista de espera', fr: "liste d'attente" },
  { en: 'schedule change', es: 'cambio de horario', fr: "changement d'horaire" },
  { en: 'package holiday', es: 'viaje combinado', fr: 'forfait touristique' },
  { en: 'travel agency', es: 'agencia de viajes', fr: 'agence de voyages' },
];

function glossaryFor(targetLanguage) {
  const lines = GLOSSARY.map((term) => `${term.en} = ${term[targetLanguage]}`);
  return `TERMINOLOGY, as lemmas. Use these words for these things and inflect them for gender, number and person as the sentence needs. Never paste a term in verbatim where it does not agree.
${lines.join('; ')}.`;
}

// What the model is told about the placeholders it will see when codes are
// protected before the call (see protectCodes below).
const PLACEHOLDERS = `Tokens of the form [[C1]], [[C2]] and so on are protected codes that were removed before you saw the text. Copy each one into the translation exactly as written, once, in the place the code belongs. Never translate, drop, renumber or invent one.`;

export function translationPrompt(sourceLabel, targetLanguage, { placeholders = false } = {}) {
  const target = LANGUAGE_NAMES[targetLanguage];
  return `You are a translator working inside a travel agency. You are NOT an advisor and you do NOT answer, explain, comment on, summarise, improve or shorten anything. You render what you are given into ${target.english} (${target.native}) and nothing else.

${PRESERVE}
${placeholders ? `\n${PLACEHOLDERS}\n` : ''}
${glossaryFor(targetLanguage)}

HOW TO RENDER
- Produce ONLY the translation. No preamble, no "here is the translation", no notes, no quotation marks around it.
- Keep the speaker's register. A curt message stays curt; a polite one stays polite.
- Keep it the same length. Do not pad and do not compress.
- If the text is a question, the translation is that question. Do not answer it.
- If the text is already entirely in ${target.english}, return it unchanged.
- If part of it is unintelligible, render what you can and leave the unclear part as you heard it rather than inventing a plausible word. In travel a guessed word is a wrong booking.
- The result is going to be read aloud, so write it the way a person would say it.

The text${sourceLabel ? ` is in ${sourceLabel} and` : ''} follows.`;
}

// --- running one -------------------------------------------------------------

function maxTokens() {
  const value = Number(process.env.TRAVEL_VOICE_TRANSLATE_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? value : 2000;
}

/** Whether codes are swapped for placeholders before the model sees them. On by default. */
export function protectionEnabled() {
  return (process.env.TRAVEL_VOICE_PROTECT_CODES || '').trim().toLowerCase() !== 'false';
}

/**
 * Whether a Spanish-French translation goes through English. Off by
 * default: it doubles the calls and the wait. It exists because a model's
 * translation between two non-English languages measures lower than the
 * same model's into and out of English, and for a pair where that shows,
 * two good hops beat one weak one.
 */
export function pivotViaEnglish() {
  return ['true', 'on', '1', 'yes'].includes((process.env.TRAVEL_VOICE_PIVOT_VIA_EN || '').trim().toLowerCase());
}

// --- protecting the codes ----------------------------------------------------

// Which tokens are lifted out before translation: anything with a digit in
// it (a locator, a flight number, a ticket, an entry like SS1Y2), and short
// all-caps tokens (IATA codes, fare bases, entries like FXP). Longer all-caps
// tokens are more likely to be a shouted word — URGENTE, GRACIAS — and a
// shouted word wants translating.
function shouldProtect(token) {
  return /\d/.test(token) || token.length <= 5;
}

const PLACEHOLDER = /\[\[\s*C?(\d+)\s*\]\]/gi;

/**
 * Swaps every code for a numbered placeholder the translator is told to
 * copy through. Returns the text to translate and the map to put it back.
 *
 * This is the boundary the whole cascade exists for. A native speech
 * translation model has no such seam; here there is text on both sides of
 * the model, and a locator that never enters the model cannot come out of
 * it changed.
 */
export function protectCodes(text) {
  const codes = codesIn(text).filter(shouldProtect);
  const map = [];
  let out = String(text || '');
  codes.forEach((code, i) => {
    const placeholder = `[[C${i + 1}]]`;
    const pattern = new RegExp(`\\b${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    if (pattern.test(out)) {
      out = out.replace(pattern, placeholder);
      map.push({ placeholder, code });
    }
  });
  return { text: out, map };
}

/**
 * Puts the codes back. Reports which placeholders the model lost, so the
 * dropped-codes warning stays honest, and strips any it invented.
 */
export function restoreCodes(translated, map) {
  const byIndex = new Map(map.map((entry, i) => [i + 1, entry.code]));
  const seen = new Set();
  const out = String(translated || '').replace(PLACEHOLDER, (m, n) => {
    const index = Number(n);
    if (!byIndex.has(index)) return '';
    seen.add(index);
    return byIndex.get(index);
  });
  const missing = map.filter((entry, i) => !seen.has(i + 1)).map((entry) => entry.code);
  return { text: out.replace(/[ \t]{2,}/g, ' ').trim(), missing };
}

/**
 * Translates one message.
 *
 * Deliberately stateless. An advisor turn carries conversation history so it
 * can follow a thread; a translation must not, because the previous message
 * is a different sentence by possibly a different person, and letting it
 * influence this one is how a translator starts paraphrasing.
 *
 * @returns {Promise<{ text, target, source, usage, provider, model, ms }>}
 */
export async function runTranslation({ anthropic, provider = null, text, target, source = null, brain }) {
  const to = normalizeLanguage(target) || DEFAULT_LANGUAGE;
  const from = normalizeLanguage(source);
  const startedAt = Date.now();

  const protecting = protectionEnabled();
  const protectedInput = protecting ? protectCodes(text) : { text: String(text), map: [] };
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  async function hop(input, fromLang, toLang) {
    const sourceLabel = fromLang ? LANGUAGE_NAMES[fromLang].english : null;
    const system = [
      // The preserve rules are the same on every call, so they cache; the
      // target language changes, so it sits in its own block after them.
      { type: 'text', text: translationPrompt(sourceLabel, toLang, { placeholders: protecting && protectedInput.map.length > 0 }), cache_control: { type: 'ephemeral' } },
    ];
    const response = await brain.create(
      { model: brain.model(), max_tokens: maxTokens(), system, messages: [{ role: 'user', content: input }] },
      { anthropic }
    );
    const u = response.usage || {};
    for (const key of Object.keys(usage)) usage[key] += u[key] || 0;
    return (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  // Two hops through English for a Spanish-French pair when asked; one
  // hop otherwise. The placeholders ride through both.
  const pivot = pivotViaEnglish() && from && from !== 'en' && to !== 'en' && from !== to;
  let out;
  if (pivot) {
    const english = await hop(protectedInput.text, from, 'en');
    out = await hop(english, 'en', to);
  } else {
    out = await hop(protectedInput.text, from, to);
  }

  const restored = protecting ? restoreCodes(out, protectedInput.map) : { text: out, missing: [] };

  return {
    text: restored.text,
    target: to,
    source: from,
    usage,
    provider: brain.id,
    model: brain.model(),
    protectedCodes: protectedInput.map.map((entry) => entry.code),
    lostPlaceholders: restored.missing,
    pivot,
    ms: Date.now() - startedAt,
  };
}

// --- verifying it ---------------------------------------------------------------

// A token that must come out the other side unchanged: an Amadeus entry, an
// airport code, a locator, a flight number, a price, a date. Deliberately
// broad — a false positive costs one comparison, a false negative lets a
// mistranslated locator reach an agent who acts on it.
// The first alternative is a six-character locator with at least one digit
// in any position — X7K2PQ — which none of the letter-then-digit shapes
// after it would catch.
const CODE = /\b(?:(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{6}|[A-Z]{2,3}\d{1,4}[A-Z]?|[A-Z]{3,8}\*?\d*|\d{1,4}[A-Z]{2,6}|\d{3}-\d{6,})\b/g;

// Words that look like codes but are ordinary in the three languages, plus
// the shouting people do in messages. Without this, "OK" and "PNR" get
// flagged on every message and the warning stops meaning anything.
const NOT_A_CODE = new Set([
  'OK', 'OKAY', 'YES', 'NO', 'SI', 'SÍ', 'OUI', 'NON', 'HOLA', 'HELLO', 'BONJOUR', 'MERCI',
  'GRACIAS', 'THANKS', 'PLEASE', 'POR', 'FAVOR', 'AND', 'THE', 'PARA', 'PERO', 'MAIS', 'POUR',
  'AVEC', 'CON', 'WITH', 'PNR', 'IATA', 'URGENT', 'ASAP',
]);

export function codesIn(text) {
  const found = String(text || '').match(CODE) || [];
  return [...new Set(found.filter((token) => !NOT_A_CODE.has(token.toUpperCase())))];
}

/**
 * Which codes went into a translation and did not come out.
 *
 * This is the check that makes the preserve rule real rather than hopeful.
 * It reports; it does not repair. Silently reinserting a locator into a
 * sentence the model did not write there would put it in the wrong place,
 * and a locator in the wrong place reads as correct.
 */
export function droppedCodes(original, translated) {
  const after = new Set(codesIn(translated).map((c) => c.toUpperCase()));
  return codesIn(original).filter((code) => !after.has(code.toUpperCase()));
}

// --- the caller-facing command ---------------------------------------------------

// Said in all three languages because the people using it are the people who
// need it. TRADUCIR and TRADUIRE are the same command.
const VERB = '(?:translate|traducir|traduce|traduire|traduis|traduction|traduccion|traducción)';
const LANG_WORD = '(?:es|fr|en|spanish|espa[nñ]ol|french|fran[cç]ais|frances|francés|english|ingl[eé]s|anglais)';

const OFF = new RegExp(`^${VERB}\\s+(?:off|stop|no|basta|arr[eê]t(?:er)?|desactivar|d[eé]sactiver)$`, 'i');
const STATUS = new RegExp(`^${VERB}$`, 'i');
// The separator between the two languages: a symbol, a joining word, or
// nothing but a space. The space has to come last so the more specific forms
// win — "es a en" is a joining word, not a space, a space.
const PAIR = new RegExp(
  `^${VERB}\\s+(${LANG_WORD})(?:\\s*[<>/|+-]+\\s*|\\s+(?:and|y|et|to|a|à|vers)\\s+|\\s+)(${LANG_WORD})$`,
  'i'
);
const ONE_WAY = new RegExp(`^${VERB}\\s+(?:(?:to|into|a|al|en|vers|in)\\s+)?(${LANG_WORD})$`, 'i');

/**
 * A translation command from whoever is talking to the advisor.
 *
 * Unlike the TRAVEL commands, this one is caller-facing on purpose: it is a
 * feature of the product, not an admin control. It changes only that one
 * conversation, reaches nothing else, and is bounded by the same rate limit,
 * so a guest running it is exactly as safe as a guest asking a question.
 */
export function parseTranslateCommand(text) {
  const trimmed = String(text || '').trim();
  if (STATUS.test(trimmed)) return { kind: 'status' };
  if (OFF.test(trimmed)) return { kind: 'off' };

  const pair = trimmed.match(PAIR);
  if (pair) {
    const a = normalizeLanguage(pair[1]);
    const b = normalizeLanguage(pair[2]);
    if (a && b && a !== b) return { kind: 'pair', pair: [a, b] };
    if (a && b) return { kind: 'same', language: a };
  }

  const one = trimmed.match(ONE_WAY);
  if (one) {
    const to = normalizeLanguage(one[1]);
    if (to) return { kind: 'to', to };
  }
  return null;
}

// What the caller is told, in the language they are already being served in.
const REPLIES = {
  on_to: {
    es: (l) => `Modo traducción: todo lo que envíes te lo devuelvo en ${l}, en voz y en texto. Escribe TRADUCIR OFF para volver al asesor.`,
    fr: (l) => `Mode traduction : tout ce que vous envoyez revient en ${l}, en voix et en texte. Écrivez TRADUIRE OFF pour revenir au conseiller.`,
    en: (l) => `Translation mode: everything you send comes back in ${l}, spoken and written. Send TRANSLATE OFF to go back to the advisor.`,
  },
  on_pair: {
    es: (l) => `Modo traducción entre ${l}. Habla en cualquiera de los dos y te lo devuelvo en el otro. Escribe TRADUCIR OFF para volver al asesor.`,
    fr: (l) => `Mode traduction entre ${l}. Parlez dans l'une des deux et je vous rends l'autre. Écrivez TRADUIRE OFF pour revenir au conseiller.`,
    en: (l) => `Translating between ${l}. Speak either one and it comes back as the other. Send TRANSLATE OFF to go back to the advisor.`,
  },
  off: {
    es: () => 'Modo traducción desactivado. Vuelves a hablar con el asesor de viajes.',
    fr: () => 'Mode traduction désactivé. Vous parlez de nouveau au conseiller voyage.',
    en: () => 'Translation mode off. You are talking to the travel advisor again.',
  },
  status_off: {
    es: () => 'La traducción está desactivada. Escribe TRADUCIR EN para activarla, o TRADUCIR ES FR para los dos sentidos.',
    fr: () => "La traduction est désactivée. Écrivez TRADUIRE EN pour l'activer, ou TRADUIRE ES FR dans les deux sens.",
    en: () => 'Translation is off. Send TRANSLATE EN to turn it on, or TRANSLATE ES FR for both directions.',
  },
  same: {
    es: () => 'Esos son el mismo idioma. Elige dos distintos, por ejemplo TRADUCIR ES EN.',
    fr: () => 'Ce sont la même langue. Choisissez-en deux différentes, par exemple TRADUIRE FR EN.',
    en: () => 'Those are the same language. Pick two different ones, for example TRANSLATE ES EN.',
  },
};

export function replyFor(kind, language, argument = '') {
  const lang = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  return REPLIES[kind][lang](argument);
}

export function __resetTranslateForTests() {
  writeJson(FILE, { modes: {} });
}

export { SUPPORTED_LANGUAGES };
