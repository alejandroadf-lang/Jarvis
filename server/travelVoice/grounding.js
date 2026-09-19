// Money the advisor did not get from anywhere.
//
// The one answer this product can least afford is a confident price. A
// model asked "what does the change fee come to" will, some of the time,
// name a figure — plausible, specific, and made up — and an agency will
// repeat it to a client. The prompt already forbids this. The check here
// is what makes the prohibition real: every amount in a finished reply is
// looked for in the tool results of the turn and in what the caller
// themselves said, and an amount found in neither is treated the way a
// wrong-language reply is treated — one correction call, then the result
// is recorded either way.
//
// Deliberately narrow. It looks for money, not numbers: flight numbers,
// dates, category numbers and "the five mandatory elements" are the
// advisor's stock in trade and would drown the signal.

import { normalizeLanguage, DEFAULT_LANGUAGE, LANGUAGE_NAMES } from './languages.js';

// "€189.40", "189,40 €", "EUR 189.40", "189.40 EUR", "$1,234", "35 GBP",
// and the spelled-out "189 euros" / "189,40 euros" / "35 dólares".
// A number here is digits with separators inside it, never ending in one,
// so "€189.40," does not swallow the comma after it.
const NUMBER = '(\\d(?:[\\d.,]*\\d)?)';
const MONEY = [
  new RegExp(`([€$£])\\s?${NUMBER}`, 'g'),
  new RegExp(`${NUMBER}\\s?([€$£])`, 'g'),
  new RegExp(`\\b(EUR|USD|GBP|CHF|MXN)\\s?${NUMBER}`, 'gi'),
  new RegExp(`${NUMBER}\\s?(EUR|USD|GBP|CHF|MXN)\\b`, 'gi'),
  new RegExp(`${NUMBER}\\s?(euros?|d[oó]lares?|dollars?|libras?|livres?|pounds?)\\b`, 'gi'),
];

// "1.234,50" and "1,234.50" are the same number. A trailing pair of digits
// after the last separator is the cents; every other separator is grouping.
export function amountValue(raw) {
  const s = String(raw).replace(/\s/g, '');
  const m = s.match(/^(\d[\d.,]*?)(?:[.,](\d{2}))?$/);
  if (!m) return null;
  const whole = m[1].replace(/[.,]/g, '');
  const value = Number(`${whole}.${m[2] || '00'}`);
  return Number.isFinite(value) ? value : null;
}

/** Every money amount in a text, as numeric values, with the text it came from. */
export function amountsIn(text) {
  const body = String(text || '');
  const found = new Map();
  for (const pattern of MONEY) {
    for (const m of body.matchAll(pattern)) {
      const raw = /^\d/.test(m[1]) ? m[1] : m[2];
      const value = amountValue(raw);
      if (value !== null && value > 0 && !found.has(value)) found.set(value, m[0].trim());
    }
  }
  return [...found.entries()].map(([value, text]) => ({ value, text }));
}

// Every number in a blob of tool output, as values, so "total": "189.40"
// and "price": 189.4 both ground a reply that says 189,40 €.
function valuesIn(text) {
  const values = new Set();
  for (const m of String(text || '').matchAll(/\d[\d.,]*/g)) {
    const v = amountValue(m[0]);
    if (v !== null) values.add(v);
    const plain = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(plain)) values.add(plain);
  }
  return values;
}

/**
 * Which amounts in a reply are backed by nothing in the turn.
 *
 * @param {string} reply
 * @param {object} sources
 * @param {string[]} [sources.toolOutputs] the raw tool results of this turn
 * @param {string[]} [sources.callerText] what the caller said, this turn and before
 * @returns {{ amounts: Array<{value:number,text:string}>, ungrounded: Array<{value:number,text:string}> }}
 */
export function groundingCheck(reply, { toolOutputs = [], callerText = [] } = {}) {
  const amounts = amountsIn(reply);
  if (!amounts.length) return { amounts, ungrounded: [] };
  const known = valuesIn([...toolOutputs, ...callerText].join('\n'));
  const ungrounded = amounts.filter((a) => !known.has(a.value));
  return { amounts, ungrounded };
}

// Written in the target language first, for the same reason the language
// correction is (see replyCheck.js).
const CORRECTIONS = {
  es: (list) =>
    `Tu respuesta anterior cita importes (${list}) que no proceden de ninguna búsqueda ni de lo que dijo el interlocutor. Vuelve a darla sin inventar cifras: di claramente que el importe exacto debe comprobarse en la tarifa o con la compañía, indica cómo (por ejemplo FQN en la categoría correspondiente, o FXP), y mantén todo lo demás igual y con la misma brevedad. Sin disculpas.`,
  fr: (list) =>
    `Votre réponse précédente cite des montants (${list}) qui ne proviennent d'aucune recherche ni de ce qu'a dit l'interlocuteur. Redonnez-la sans inventer de chiffres : dites clairement que le montant exact doit être vérifié dans le tarif ou auprès de la compagnie, indiquez comment (par exemple FQN sur la catégorie concernée, ou FXP), et gardez tout le reste identique et aussi bref. Sans excuses.`,
  en: (list) =>
    `Your previous answer quotes amounts (${list}) that came from no search result and from nothing the caller said. Give it again without inventing figures: say plainly that the exact amount must be checked in the fare rule or with the carrier, say how (for example FQN on the relevant category, or FXP), and keep everything else the same and as brief. No apologies.`,
};

/** The one message sent to make an ungrounded reply come back honest. */
export function groundingCorrectionPrompt(language, ungrounded) {
  const wanted = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const list = ungrounded.map((a) => a.text).join(', ');
  return `${CORRECTIONS[wanted](list)}\n\n(Answer in ${LANGUAGE_NAMES[wanted].english} only. Do not state any amount that is not in a tool result or in the caller's own words.)`;
}

/** Whether an ungrounded reply is worth a second call. On by default. */
export function groundingRetryEnabled() {
  return (process.env.TRAVEL_VOICE_GROUNDING_RETRY || '').trim().toLowerCase() !== 'false';
}
