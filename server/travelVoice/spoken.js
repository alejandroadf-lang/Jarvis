// What the advisor says out loud, as opposed to what it writes.
//
// A voice channel fails on the details a text channel gets for free. "MAD"
// read as a word is nonsense; a record locator like X7K2PQ heard once over
// a phone is wrong one time in seven, and the caller cannot see it to check;
// "1.234,50 €" is read three different ways by three different voices; and
// 25DEC is an Amadeus date, not a typo. None of this is the model's job to
// fix — the text twin of every voice note must keep the codes exactly as
// typed, because that is the version an agent copies into Amadeus — so the
// spoken version is derived from the written one here, deterministically,
// and only the audio is changed.
//
// The two things that matter most:
//
//   READ-BACK. A locator or ticket number in what the caller said is read
//   back to them in the spelling alphabet of their language — "X de
//   Xiquena, 7, K de Kilo" — before the answer, so a misheard letter is
//   caught by the one person who can catch it. This is the cheapest control
//   there is against the alphanumeric error rate every transcriber carries.
//
//   NORMALISATION. Codes are spelled, prices carry their currency and cents
//   the way the language says them, ISO and Amadeus dates become spoken
//   dates, and flight numbers are read digit by digit. A voice that is
//   handed "IB 3 4 5 6" says it right; one handed "IB3456" says whatever it
//   feels like.

import { normalizeLanguage, DEFAULT_LANGUAGE } from './languages.js';

// --- spelling alphabets -------------------------------------------------------

// The alphabets people in each market actually use on the phone. Spanish
// agencies spell with cities and names; French ones with first names; the
// English one is the ICAO/NATO alphabet every airline desk knows.
const ALPHABETS = {
  es: {
    A: 'Antonio', B: 'Barcelona', C: 'Carmen', D: 'Dolores', E: 'Enrique', F: 'Francia', G: 'Gerona',
    H: 'Historia', I: 'Inés', J: 'José', K: 'Kilo', L: 'Lorenzo', M: 'Madrid', N: 'Navarra', Ñ: 'Ñoño',
    O: 'Oviedo', P: 'París', Q: 'Querido', R: 'Ramón', S: 'Sábado', T: 'Tarragona', U: 'Ulises',
    V: 'Valencia', W: 'Washington', X: 'Xiquena', Y: 'Yegua', Z: 'Zaragoza',
  },
  fr: {
    A: 'Anatole', B: 'Berthe', C: 'Célestin', D: 'Désiré', E: 'Eugène', F: 'François', G: 'Gaston',
    H: 'Henri', I: 'Irma', J: 'Joseph', K: 'Kléber', L: 'Louis', M: 'Marcel', N: 'Nicolas', O: 'Oscar',
    P: 'Pierre', Q: 'Quintal', R: 'Raoul', S: 'Suzanne', T: 'Thérèse', U: 'Ursule', V: 'Victor',
    W: 'William', X: 'Xavier', Y: 'Yvonne', Z: 'Zoé',
  },
  en: {
    A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel',
    I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa',
    Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey',
    X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
  },
};

// "M de Madrid", "M comme Marcel", "M for Mike".
const LINK = { es: 'de', fr: 'comme', en: 'for' };

function lang(language) {
  return normalizeLanguage(language) || DEFAULT_LANGUAGE;
}

/**
 * Spells a code in the caller's spelling alphabet, digits read as digits.
 *
 *   spellOut('X7K2PQ', 'es') -> 'X de Xiquena, 7, K de Kilo, 2, P de París, Q de Querido'
 */
export function spellOut(code, language) {
  const l = lang(language);
  const alphabet = ALPHABETS[l];
  return [...String(code || '').toUpperCase()]
    .map((ch) => (alphabet[ch] ? `${ch} ${LINK[l]} ${alphabet[ch]}` : ch))
    .join(', ');
}

/** Letters separated so a voice reads them one by one: MAD -> "M-A-D". */
export function letterByLetter(code) {
  return [...String(code || '')].join('-');
}

// --- what counts as a code -----------------------------------------------------

// A record locator: six characters, letters and digits, as Amadeus, Sabre
// and the airlines issue them. Many are all letters, which a regex cannot
// tell from a six-letter shouted word, so the all-letter form only counts
// when the words around it say what it is.
const LOCATOR = /\b(?=[A-Z0-9]{6}\b)(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/g;
const LOCATOR_AFTER_CUE = /\b(?:locali[sz]ador|localisateur|locator|dossier|pnr|r[ée]f[ée]rence|referencia|record)\b[^A-Za-z0-9]{0,12}([A-Z0-9]{6})\b/gi;
// A 13-digit ticket number, with or without the airline-prefix dash.
const TICKET = /\b\d{3}-?\d{10}\b/g;
// Any other mixed letter-and-digit token: a fare basis, a tour code, an
// Amadeus entry like SS1Y2 or FQN1*16 — 4 to 12 characters, at least one of
// each. Read letter by letter, not in the spelling alphabet: that is how
// agents say entries to each other.
const MIXED = /\b(?=[A-Z0-9*/]{4,16}\b)(?=[A-Z0-9*/]*[A-Z])(?=[A-Z0-9*/]*\d)[A-Z0-9*/]+\b/g;

// All-caps tokens that are said as words, not letters.
const PRONOUNCED = new Set(['IATA', 'ATPCO', 'TIMATIC', 'ARC', 'BSP', 'EURO', 'EUROS', 'OK', 'AVE', 'ADM', 'APST', 'CEAV', 'EDIFACT']);

/**
 * Codes in a message that should be read back so the caller can correct
 * them: locators (with or without a cue word) and ticket numbers. Not
 * airport codes — a caller who said MAD does not need MAD confirmed.
 */
export function readBackCodes(text) {
  const body = String(text || '');
  const found = new Set();
  for (const m of body.matchAll(LOCATOR)) found.add(m[0]);
  for (const m of body.matchAll(LOCATOR_AFTER_CUE)) found.add(m[1].toUpperCase());
  for (const m of body.matchAll(TICKET)) found.add(m[0]);
  return [...found];
}

const READ_BACK = {
  es: { locator: 'Localizador', ticket: 'Billete', heard: 'He entendido' },
  fr: { locator: 'Dossier', ticket: 'Billet', heard: "J'ai compris" },
  en: { locator: 'Locator', ticket: 'Ticket', heard: 'I heard' },
};

/**
 * The read-back line for a message, spoken and written, or null when
 * there is nothing to read back.
 *
 * The spoken form spells each code in the spelling alphabet; the written
 * form shows it exactly as heard, which is what the caller compares against
 * their screen.
 */
export function readBack(text, language) {
  const codes = readBackCodes(text);
  if (!codes.length) return null;
  const l = lang(language);
  const words = READ_BACK[l];
  const spoken = codes
    .map((code) => (/^\d/.test(code) ? `${words.ticket} ${spokenDigits(code)}` : `${words.locator} ${spellOut(code, l)}`))
    .join('. ');
  const written = codes.map((code) => `${/^\d/.test(code) ? words.ticket : words.locator}: ${code}`).join(' · ');
  return { codes, spoken: `${words.heard}: ${spoken}.`, written: `${words.heard} — ${written}` };
}

function spokenDigits(digits) {
  return String(digits).replace(/-/g, ' ').split('').filter((c) => c !== ' ').join(' ').replace(/(\d \d \d) /, '$1, ');
}

// --- numbers, prices, dates, times -------------------------------------------------

const MONTHS = {
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const AMADEUS_MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function spokenDate(day, monthIndex, year, l) {
  const month = MONTHS[l][monthIndex];
  const d = Number(day);
  if (l === 'es') return `${d} de ${month}${year ? ` de ${year}` : ''}`;
  if (l === 'fr') return `${d === 1 ? '1er' : d} ${month}${year ? ` ${year}` : ''}`;
  return `${d} ${month}${year ? ` ${year}` : ''}`;
}

const CURRENCY_WORDS = {
  EUR: { es: ['euro', 'euros', 'céntimos'], fr: ['euro', 'euros', 'centimes'], en: ['euro', 'euros', 'cents'] },
  USD: { es: ['dólar', 'dólares', 'centavos'], fr: ['dollar', 'dollars', 'cents'], en: ['dollar', 'dollars', 'cents'] },
  GBP: { es: ['libra', 'libras', 'peniques'], fr: ['livre', 'livres', 'pence'], en: ['pound', 'pounds', 'pence'] },
  CHF: { es: ['franco suizo', 'francos suizos', 'céntimos'], fr: ['franc suisse', 'francs suisses', 'centimes'], en: ['Swiss franc', 'Swiss francs', 'centimes'] },
  MXN: { es: ['peso', 'pesos', 'centavos'], fr: ['peso', 'pesos', 'centavos'], en: ['peso', 'pesos', 'centavos'] },
};
const SYMBOLS = { '€': 'EUR', $: 'USD', '£': 'GBP' };

// "1.234,50" (es/fr) and "1,234.50" (en) both mean the same amount. The
// last separator followed by exactly two digits is the decimal point; every
// other separator is a thousands separator.
function parseAmount(raw) {
  const s = String(raw).replace(/\s/g, '');
  const m = s.match(/^(\d[\d.,]*?)(?:[.,](\d{2}))?$/);
  if (!m) return null;
  const whole = m[1].replace(/[.,]/g, '');
  return { whole, cents: m[2] || null };
}

function spokenAmount(raw, currency, l) {
  const parsed = parseAmount(raw);
  const words = CURRENCY_WORDS[currency]?.[l];
  if (!parsed || !words) return null;
  const [one, many, cents] = words;
  const unit = parsed.whole === '1' ? one : many;
  if (!parsed.cents || parsed.cents === '00') return `${parsed.whole} ${unit}`;
  const c = String(Number(parsed.cents));
  if (l === 'es') return `${parsed.whole} ${unit} con ${c} ${cents}`;
  if (l === 'fr') return `${parsed.whole} ${unit} ${c}`;
  return `${parsed.whole} ${unit} ${c} ${cents}`;
}

// Prices: "€1,234.50", "1.234,50 €", "EUR 1234.50", "1234.50 EUR", "$99".
const PRICE_SYMBOL_BEFORE = /([€$£])\s?(\d[\d.,]*)/g;
const PRICE_SYMBOL_AFTER = /(\d[\d.,]*)\s?([€$£])/g;
const PRICE_CODE_BEFORE = /\b(EUR|USD|GBP|CHF|MXN)\s?(\d[\d.,]*)/g;
const PRICE_CODE_AFTER = /(\d[\d.,]*)\s?(EUR|USD|GBP|CHF|MXN)\b/g;

// Dates: ISO 2026-09-19, and Amadeus 25DEC / 25DEC26.
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const AMADEUS_DATE = /\b(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})?\b/g;
// Times: 14:35, 09:05.
const TIME = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
// Flight numbers: IB3456, AF 1234, U24567 — two-character airline code then
// one to four digits, said letter by letter then digit by digit.
const FLIGHT = /\b([A-Z][A-Z0-9]|[0-9][A-Z])\s?(\d{1,4})\b(?![:\d])/g;
// Three-letter uppercase codes: airports, and the odd acronym.
const THREE_LETTERS = /\b[A-Z]{3}\b/g;
// Two-to-four letter uppercase entries: FXP, TTP, RT, TQT, TRDC, SM.
const SHORT_ENTRY = /\b[A-Z]{2,4}\b/g;

/**
 * The spoken form of a written reply, in one language.
 *
 * Order matters: prices before plain numbers (a price is a number with a
 * unit), dates before flight numbers (25DEC26 is not flight 25 DEC), ticket
 * numbers before the digit-grouping that would otherwise split them.
 */
export function spokenForm(text, language) {
  const l = lang(language);
  let out = String(text || '');

  // Prices.
  out = out.replace(PRICE_SYMBOL_BEFORE, (m, sym, amt) => spokenAmount(amt, SYMBOLS[sym], l) || m);
  out = out.replace(PRICE_SYMBOL_AFTER, (m, amt, sym) => spokenAmount(amt, SYMBOLS[sym], l) || m);
  out = out.replace(PRICE_CODE_BEFORE, (m, code, amt) => spokenAmount(amt, code, l) || m);
  out = out.replace(PRICE_CODE_AFTER, (m, amt, code) => spokenAmount(amt, code, l) || m);

  // Dates.
  out = out.replace(ISO_DATE, (m, y, mo, d) => (Number(mo) >= 1 && Number(mo) <= 12 ? spokenDate(d, Number(mo) - 1, y, l) : m));
  out = out.replace(AMADEUS_DATE, (m, d, mon, yy) => spokenDate(d, AMADEUS_MONTHS[mon], yy ? `20${yy}` : null, l));

  // Times.
  if (l === 'fr') out = out.replace(TIME, (m, h, mm) => `${Number(h)} h ${mm === '00' ? '' : mm}`.trim());

  // A locator the words around it name is a locator whatever it looks
  // like; that goes first, because "dossier AB1234" would otherwise be read
  // as a flight number below. Then ticket numbers, then flight numbers, then
  // any six-character code left that carries a digit.
  out = out.replace(LOCATOR_AFTER_CUE, (m, code) => m.replace(code, spellOut(code, l)));
  out = out.replace(TICKET, (m) => spokenDigits(m));
  out = out.replace(FLIGHT, (m, airline, num) => `${letterByLetter(airline)} ${num.split('').join(' ')}`);
  out = out.replace(LOCATOR, (m) => spellOut(m, l));

  // The remaining mixed tokens and short entries.
  out = out.replace(MIXED, (m) => letterByLetter(m));
  out = out.replace(THREE_LETTERS, (m) => (PRONOUNCED.has(m) ? m : letterByLetter(m)));
  out = out.replace(SHORT_ENTRY, (m) => (PRONOUNCED.has(m) || m.includes('-') ? m : letterByLetter(m)));

  return out;
}

export const __testing = { parseAmount, spokenAmount, ALPHABETS };
