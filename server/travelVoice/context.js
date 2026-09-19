// What the advisor still knows about a caller after the conversation has
// grown too long to carry.
//
// History already persists and is trimmed to the most recent 120 messages
// (see sessionStore.js). That is the right rule for a chat and the wrong
// one for a helpdesk, because of where the facts live: an agent opens with
// "el localizador X7K2PQ de Iberia, el cliente quiere el reembolso" and
// then sends thirty short messages about it. The trim drops the oldest
// first, which is precisely the message that said what the case is. The
// agent then gets asked for the locator they gave an hour ago, which is
// the moment a helpdesk stops feeling like a colleague.
//
// So the case is kept apart from the transcript. Two halves:
//
//   THE FACTS, extracted from every message and reply for nothing: the
//   locators and ticket numbers in play, the carriers and the route, the
//   Amadeus entries already suggested (so it does not suggest FXP twice),
//   and what the case is about. No model call, no latency, and it survives
//   any amount of trimming because it was never in the transcript.
//
//   THE STORY, one short paragraph, rewritten ONLY when the trim actually
//   dropped something. That is roughly once every hundred messages rather
//   than every turn, so the cost is a rounding error and the caller never
//   waits for it on an ordinary reply.
//
// Deliberately NOT kept: any amount of money. The advisor may only state a
// figure that came from a tool result or from the caller this turn (see
// grounding.js), and a remembered price would quietly become a third
// source that nothing checks. A fare from last week is a wrong fare.
//
// The case lives and dies with the transcript: the same retention clock,
// the same BORRAR, the same sweep. It never reaches the audit trail, which
// outlives it by years and holds no codes at all (see audit.js).

import { readJson, writeJson } from '../store.js';
import { codesIn } from './translate.js';
import { normalizeLanguage } from './languages.js';
import { assertUnderDailyCap, recordSpend } from '../spend.js';
import { priceUsage } from '../usage.js';

const FILE = 'travelVoiceContext.json';

// How much is carried into the prompt. Small on purpose: this rides on
// every turn, after the cached part of the system prompt, so every line
// here is paid for on every single message.
const MAX_CODES = 6;
const MAX_CARRIERS = 4;
const MAX_ROUTES = 4;
const MAX_ENTRIES = 10;
const MAX_TOPICS = 5;
const MAX_SUMMARY_CHARS = 600;

// --- classifying what a message contains --------------------------------------

// Two-letter airline designators an agency in these markets actually deals
// with. A closed list, because a bare two-letter token is otherwise just as
// likely to be a word: "ok", "si", "le".
const CARRIERS = new Set([
  'IB', 'AF', 'BA', 'LH', 'AZ', 'KL', 'UX', 'VY', 'FR', 'U2', 'TP', 'SN', 'LX', 'OS', 'AY', 'SK',
  'AA', 'DL', 'UA', 'AC', 'AV', 'LA', 'AM', 'CM', 'AR', 'G3', 'AD', 'TK', 'EK', 'QR', 'EY', 'MS',
  'RAM', 'AT', 'TU', 'SU', 'JL', 'NH', 'SQ', 'CX', 'QF', 'ET', 'KQ', 'WY',
]);

// All-caps tokens that are words, not codes. Mirrors the list in spoken.js
// and adds the ones that only show up in a written message.
const NOT_A_CODE = new Set([
  'IATA', 'ATPCO', 'TIMATIC', 'ARC', 'BSP', 'ADM', 'APST', 'CEAV', 'EDIFACT', 'NDC', 'PNR', 'TST', 'TSM', 'EMD',
  'OK', 'OKAY', 'ASAP', 'URGENT', 'URGENTE', 'AVE', 'EUR', 'USD', 'GBP', 'IVA', 'TVA', 'VAT',
]);

const TICKET = /^\d{3}-?\d{10}$/;
const FLIGHT = /^([A-Z][A-Z0-9]|[0-9][A-Z])(\d{1,4})$/;
const AIRPORT = /^[A-Z]{3}$/;
const LOCATOR = /^(?=[A-Z0-9]{6}$)(?=[A-Z0-9]*\d)[A-Z0-9]{6}$/;
const MIXED = /^[A-Z]{1,6}[0-9*/][A-Z0-9*/]*$/;

// The Amadeus entries an agency types all day. A closed list, and the
// reason one is needed: FXP and MAD are both three capital letters, and
// only a list can say that one is a command and the other an airport.
// Airports are thousands and change; entries are a few dozen and do not.
const ENTRIES = new Set([
  'AN', 'SN', 'TN', 'SS', 'NM', 'AP', 'APE', 'APM', 'TK', 'TKOK', 'TKTL', 'TKXL', 'RF', 'ER', 'ET', 'RT', 'IG',
  'XE', 'XI', 'XR', 'FXP', 'FXB', 'FXA', 'FXX', 'FXD', 'FQD', 'FQN', 'FQP', 'FQQ', 'FQS',
  'TTP', 'TWD', 'TRDC', 'TRF', 'TRFQ', 'TQT', 'TTE', 'TTC', 'TTM', 'TSM', 'TST',
  'FE', 'FM', 'FP', 'FV', 'FT', 'FO', 'OS', 'SR', 'SM', 'ST', 'SB', 'FFN', 'FFD',
  'DO', 'DD', 'DF', 'QT', 'QC', 'QS', 'QE', 'QD', 'QI', 'QN', 'HE', 'GG', 'MD', 'MS',
]);

// Cue words that name the token after them as a booking reference. The only
// way to know an all-letter locator from a shouted word.
const LOCATOR_CUE = /\b(?:locali[sz]ador|localisateur|locator|dossier|pnr|r[ée]f[ée]rence|referencia|record(?:\s+locator)?)\b[^A-Za-z0-9]{0,12}([A-Z0-9]{6})\b/gi;

/**
 * Sorts the codes in a piece of text into the kinds a case is made of.
 *
 * Order matters, and it is the order of how sure each signal is. A cue word
 * naming a reference beats everything. Then the shapes only one thing has:
 * a 13-digit ticket, a known carrier with a flight number after it, a known
 * Amadeus entry. Only then is a bare six-character token with a digit in it
 * a locator, because IB3402 has exactly that shape and is a flight.
 */
export function classifyCodes(text) {
  const out = { locators: [], tickets: [], carriers: [], airports: [], entries: [] };
  const body = String(text || '');
  const cued = new Set();
  for (const m of body.matchAll(LOCATOR_CUE)) cued.add(m[1].toUpperCase());
  out.locators.push(...cued);

  for (const raw of codesIn(body)) {
    const token = raw.toUpperCase();
    if (NOT_A_CODE.has(token) || cued.has(token)) continue;
    if (TICKET.test(token)) {
      out.tickets.push(token);
      continue;
    }
    const flight = token.match(FLIGHT);
    if (flight && CARRIERS.has(flight[1])) {
      out.carriers.push(flight[1]);
      continue;
    }
    if (ENTRIES.has(token)) {
      out.entries.push(token);
      continue;
    }
    if (AIRPORT.test(token)) {
      out.airports.push(token);
      continue;
    }
    if (LOCATOR.test(token)) {
      out.locators.push(token);
      continue;
    }
    // An entry with a number stuck to it — SS1Y2, FQN1*16, XE2 — is still
    // an entry, and the stem is what says which one.
    if (MIXED.test(token)) {
      const stem = token.match(/^[A-Z]+/)[0];
      out.entries.push(ENTRIES.has(stem) ? stem : token);
    }
  }
  // A carrier named on its own — "el vuelo lo opera IB" — only counts when
  // it is in the closed list above.
  for (const token of String(text || '').match(/\b[A-Z0-9]{2}\b/g) || []) {
    if (CARRIERS.has(token)) out.carriers.push(token);
  }
  for (const key of Object.keys(out)) out[key] = [...new Set(out[key])];
  return out;
}

// What the case is about, in the words all three languages use for it.
const TOPICS = {
  refund: /\b(reembolso|reembolsar|remboursement|rembourser|refund|refunded|TRF)\b/i,
  exchange: /\b(cambio|cambiar|reemisi[oó]n|reemitir|[ée]change|[ée]changer|r[ée][ée]mission|exchange|reissue|revalidat)/i,
  cancellation: /\b(cancelar|cancelaci[oó]n|anular|annuler|annulation|cancel|cancelled|XE\d|\bXI\b)/i,
  ticketing: /\b(emisi[oó]n|emitir|emito|[ée]mission|[ée]mettre|ticketing|issue the ticket|TKTL|\bTTP\b|time limit)\b/i,
  pricing: /\b(valorar|valora|tarificar|tarifar|tarifer|tarification|pricing|price the|\bFXP\b|\bFXB\b|\bFXX\b)\b/i,
  fare_rules: /\b(condiciones|reglas de la tarifa|conditions tarifaires|fare rule|fare basis|\bFQN\b|categor[ií]a \d|cat[ée]gorie \d|category \d)\b/i,
  adm: /\b(ADM|d[ée]bit memo|agency debit)\b/i,
  eu261: /\b(EU\s?261|261\/2004|compensaci[oó]n|indemnisation|denied boarding|overbooking|retraso|retard|delay compensation)\b/i,
  baggage: /\b(equipaje|maleta|bagage|baggage|excess baggage|\bXBAG\b)\b/i,
  seats: /\b(asiento|si[èe]ge|seat map|seating|\bSM\d|\bST\b)\b/i,
  name_change: /\b(cambio de nombre|correcci[oó]n de nombre|changement de nom|name change|name correction|\bNM\d)\b/i,
  // Deliberately phrases only. The Amadeus status codes for this — UN, TK —
  // are two letters that are ordinary words in two of the three languages
  // ("un billet", "un vuelo"), and case-insensitive matching on them marks
  // every French sentence as a schedule change.
  schedule_change: /\b(cambio de horario|cambio de vuelo|changement d'horaire|changement de vol|schedule change|time change|reprotect|reacomod)/i,
  group: /\b(grupo|groupe|group booking|\bGN\b)\b/i,
  visa: /\b(visado|visa|pasaporte|passeport|passport|TIMATIC|TIFA|TIDFT)\b/i,
  corporate: /\b(empresa|corporativo|entreprise|corporate|tour code|negociad|n[ée]goci)/i,
};

export function topicsIn(text) {
  const body = String(text || '');
  return Object.entries(TOPICS)
    .filter(([, pattern]) => pattern.test(body))
    .map(([topic]) => topic);
}

// --- the store ------------------------------------------------------------------

function load() {
  const data = readJson(FILE, { cases: {} });
  if (!data.cases) data.cases = {};
  return data;
}

function blank(sessionId) {
  return {
    sessionId,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    turns: 0,
    language: null,
    locators: [],
    tickets: [],
    carriers: [],
    airports: [],
    entries: [],
    topics: [],
    summary: null,
    summaryAt: null,
    summaryThrough: 0,
  };
}

/** The case for one conversation, or null when there is nothing yet. */
export function caseFor(sessionId) {
  const found = load().cases[sessionId];
  return found ? { ...found } : null;
}

export function forgetCase(sessionId) {
  const data = load();
  const had = sessionId in data.cases;
  delete data.cases[sessionId];
  writeJson(FILE, data);
  return had;
}

export function listCases() {
  return Object.values(load().cases);
}

// Most recent last, capped, without duplicates: a case that mentions the
// same locator forty times keeps one, and a second locator pushes the
// oldest out rather than growing the prompt without bound.
function merge(existing, found, max) {
  const out = (existing || []).filter((item) => !found.includes(item));
  out.push(...found);
  return out.slice(-max);
}

/**
 * Folds one exchange into the case. Free — no model call.
 *
 * The caller's words and the advisor's reply are read differently: a code
 * is a fact of the case whoever said it, but an ENTRY is only "already
 * tried" when the advisor suggested it, which is what stops it offering
 * FXP for the third time.
 */
export function rememberTurn(sessionId, { text = '', reply = '', language = null } = {}) {
  const data = load();
  const entry = data.cases[sessionId] || blank(sessionId);
  const said = classifyCodes(text);
  const answered = classifyCodes(reply);

  entry.locators = merge(entry.locators, [...said.locators, ...answered.locators], MAX_CODES);
  entry.tickets = merge(entry.tickets, [...said.tickets, ...answered.tickets], MAX_CODES);
  entry.carriers = merge(entry.carriers, [...said.carriers, ...answered.carriers], MAX_CARRIERS);
  entry.airports = merge(entry.airports, [...said.airports, ...answered.airports], MAX_ROUTES * 2);
  entry.entries = merge(entry.entries, answered.entries, MAX_ENTRIES);
  entry.topics = merge(entry.topics, topicsIn(`${text}\n${reply}`), MAX_TOPICS);
  entry.language = normalizeLanguage(language) || entry.language;
  entry.turns += 1;
  entry.lastSeen = new Date().toISOString();

  data.cases[sessionId] = entry;
  writeJson(FILE, data);
  return entry;
}

function saveSummary(sessionId, summary, through) {
  const data = load();
  const entry = data.cases[sessionId] || blank(sessionId);
  entry.summary = String(summary || '').trim().slice(0, MAX_SUMMARY_CHARS) || null;
  entry.summaryAt = new Date().toISOString();
  entry.summaryThrough = through;
  data.cases[sessionId] = entry;
  writeJson(FILE, data);
  return entry;
}

// --- the story -------------------------------------------------------------------

const SUMMARY_PROMPT = `You are keeping the case notes for a travel-industry helpdesk, so a colleague picking this conversation up knows where it stands.

Write ONE short paragraph, at most four sentences, in English, covering only:
- who the caller appears to be and what they are working on;
- the state of the case: what has been established, what the advisor already suggested, what is still open;
- anything they said about themselves that changes how to answer them (their market, their agency, how they work).

Rules:
- Facts only, from the conversation. Invent nothing and infer nothing about the person.
- Keep record locators, ticket numbers, airline and airport codes and Amadeus entries EXACTLY as written.
- NEVER include a fare, fee, penalty or any amount of money. The advisor must re-check every figure at the time, and a remembered price would be quoted as fact.
- Do not include anything about the caller's mood, health, age, gender or origin.
- If an earlier note is given, update it rather than repeating it.
- Write the note itself and nothing else.`;

/**
 * Rewrites the case note. Called only when the trim dropped messages, so
 * the cost lands roughly once per hundred, not once per turn.
 *
 * Never throws: a failed note leaves the facts — which are the load-bearing
 * half — exactly as they were.
 */
export async function summarizeCase(sessionId, { anthropic, brain, history = [], previous = null, through = 0 } = {}) {
  if (!brain) return null;
  const transcript = history
    .map((m) => {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
      return content ? `${m.role === 'user' ? 'Caller' : 'Advisor'}: ${content.slice(0, 600)}` : null;
    })
    .filter(Boolean)
    .slice(-40)
    .join('\n');
  if (!transcript) return null;

  try {
    assertUnderDailyCap();
    const response = await brain.create(
      {
        model: brain.model(),
        max_tokens: 400,
        system: [{ type: 'text', text: SUMMARY_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `${previous ? `Earlier note:\n${previous}\n\n` : ''}Conversation:\n${transcript}` }],
      },
      { anthropic }
    );
    const usage = response.usage || {};
    recordSpend(
      priceUsage(
        {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheWriteTokens: usage.cache_creation_input_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
        },
        brain.priceSpec()
      )
    );
    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) return null;
    return saveSummary(sessionId, stripAmounts(text), through);
  } catch (err) {
    console.warn(`Travel voice: could not update the case note for a conversation: ${err.message}`);
    return null;
  }
}

// The prompt forbids amounts; this enforces it, because the note is read
// back to the model as established fact and an amount that reaches it
// would be one the grounding check never sees.
//
// Two details that both cost a real bug once: the number must not end on a
// separator, or "$99." eats the full stop; and there is no word boundary
// after "€", because neither side of it is a word character, so a trailing
// \b would silently miss every amount written the way Spain and France
// write it. Only the spelled-out currencies get the letter guard.
const NUMBER = '\\d(?:[\\d.,]*\\d)?';
const SYMBOL = '[€$£]';
const NAMED = '(?:EUR|USD|GBP|CHF|MXN|euros?|d[oó]lares?|dollars?|pounds?|libras?|livres?)(?![A-Za-z])';
const MONEY = new RegExp(`(?:${SYMBOL}\\s?${NUMBER}|${NUMBER}\\s?(?:${SYMBOL}|${NAMED}))`, 'gi');

export function stripAmounts(text) {
  return String(text || '').replace(MONEY, 'an amount to re-check').replace(/\s{2,}/g, ' ').trim();
}

// --- what the advisor is told ------------------------------------------------------

const TOPIC_WORDS = {
  refund: 'a refund',
  exchange: 'an exchange or reissue',
  cancellation: 'a cancellation',
  ticketing: 'ticketing or a ticketing time limit',
  pricing: 'pricing a PNR',
  fare_rules: 'fare rules',
  adm: 'an ADM',
  eu261: 'EU261 / passenger rights',
  baggage: 'baggage',
  seats: 'seats',
  name_change: 'a name change',
  schedule_change: 'a schedule change',
  group: 'a group booking',
  visa: 'visa or documentation',
  corporate: 'corporate or negotiated fares',
};

/**
 * The block that rides on the system prompt, or null when there is nothing
 * worth carrying. Kept terse: it is paid for on every turn.
 */
export function contextPrompt(entry) {
  if (!entry) return null;
  const lines = [];
  if (entry.summary) lines.push(entry.summary);
  if (entry.locators.length) lines.push(`Record locator(s) in play: ${entry.locators.join(', ')}.`);
  if (entry.tickets.length) lines.push(`Ticket number(s): ${entry.tickets.join(', ')}.`);
  if (entry.carriers.length) lines.push(`Carrier(s): ${entry.carriers.join(', ')}.`);
  if (entry.airports.length >= 2) lines.push(`Airports mentioned: ${entry.airports.join(', ')}.`);
  if (entry.topics.length) lines.push(`This conversation is about ${entry.topics.map((t) => TOPIC_WORDS[t] || t).join(', ')}.`);
  if (entry.entries.length) lines.push(`Already suggested to them: ${entry.entries.join(', ')} — do not offer the same entry again as if it were new.`);
  if (!lines.length) return null;

  return `WHAT YOU ALREADY KNOW ABOUT THIS CALLER, from earlier in this conversation. Treat it as established and do not ask them to repeat it. It is not something they said in the message you are answering now, so do not thank them for it or act as if it just arrived. If it contradicts what they say now, what they say now wins.

${lines.join('\n')}

No amount of money is ever carried here. Every fare, fee or penalty must come from a tool result or from what the caller says in this conversation.`;
}

/** A line for the founder, or for the person taking a handoff. */
export function describeCase(entry) {
  if (!entry) return 'Nothing remembered about this conversation yet.';
  const parts = [];
  if (entry.summary) parts.push(entry.summary);
  const facts = [
    entry.locators.length ? `locators ${entry.locators.join(', ')}` : null,
    entry.tickets.length ? `tickets ${entry.tickets.join(', ')}` : null,
    entry.carriers.length ? `carriers ${entry.carriers.join(', ')}` : null,
    entry.airports.length ? `airports ${entry.airports.join(', ')}` : null,
    entry.topics.length ? `about ${entry.topics.map((t) => TOPIC_WORDS[t] || t).join(', ')}` : null,
    entry.entries.length ? `already suggested ${entry.entries.join(', ')}` : null,
  ].filter(Boolean);
  if (facts.length) parts.push(facts.join(' · '));
  parts.push(`${entry.turns} turn${entry.turns === 1 ? '' : 's'}, ${entry.language || '?'}, since ${entry.firstSeen.slice(0, 10)}.`);
  return parts.join('\n');
}

/** Forgets every case last touched before the cutoff. Used by the sweeper. */
export function sweepCases(cutoffMs) {
  const data = load();
  let removed = 0;
  for (const [sessionId, entry] of Object.entries(data.cases)) {
    if (Date.parse(entry.lastSeen) >= cutoffMs) continue;
    delete data.cases[sessionId];
    removed += 1;
  }
  if (removed) writeJson(FILE, data);
  return removed;
}

export function __resetContextForTests() {
  writeJson(FILE, { cases: {} });
}
