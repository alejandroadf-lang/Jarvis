// A person, when a person is wanted.
//
// Every recommendation about a customer-facing agent ends the same way: a
// human must be reachable, with the authority to overrule, and the handoff
// must be logged. That is also what takes the product out of the automated-
// decision rules: a person who can genuinely intervene, not a rubber stamp.
//
// Three ways a conversation comes to a person here:
//
//   The caller asks. AGENTE, CONSEILLER, AGENT, "quiero hablar con una
//   persona" — matched deterministically, before any model runs, so a
//   caller who has decided they want a human never has to argue with the
//   machine about it.
//
//   The advisor asks. The model has a `request_human` tool for the moment it
//   recognises it should not be the one answering: a complaint, a dispute,
//   a question it cannot ground. It says what it can and hands over.
//
//   The founder takes it. TRAVEL TAKE <number> from the founder's line.
//
// While a handoff is open the advisor is silent on that conversation. What
// the caller sends is forwarded to the people on TRAVEL_VOICE_ESCALATION_
// NUMBERS (the founder's own allowlisted line by default) with the caller's
// number, so a person can pick up the phone; the person can also answer
// through the advisor's number with TRAVEL SAY, which is the override, and
// hands the conversation back with TRAVEL RESUME. All of it is logged.

import { readJson, writeJson } from '../store.js';
import { normalizeNumber, allowedNumbers } from '../channels/whatsapp.js';
import { normalizeLanguage, DEFAULT_LANGUAGE, LANGUAGE_NAMES } from './languages.js';

const FILE = 'travelVoiceEscalations.json';
const MAX_LOG = 200;
const MAX_FORWARDED = 50;

// --- who is told -----------------------------------------------------------------

/** The numbers a handoff is sent to: the escalation list, else the founder's own. */
export function escalationNumbers() {
  const own = (process.env.TRAVEL_VOICE_ESCALATION_NUMBERS || '')
    .split(',')
    .map(normalizeNumber)
    .filter(Boolean);
  return own.length ? own : allowedNumbers();
}

// --- asking for a person -------------------------------------------------------------

// Whole-message words, and the sentences people actually type. Matched
// against the message or the transcript, lower-cased.
const WORDS = /^(?:agente|agent|conseiller|conseill[eè]re|humano|humana|persona|personne|humain|human|operador|op[eé]rateur|operator)\s*[.!?]*$/i;
const PHRASES = [
  /\b(?:hablar|habla|hable|contactar|pasa(?:r|rme|me)?|ponme|p[oó]ngame)\s+(?:con\s+)?(?:un[ao]?\s+)?(?:agente|persona|humano|operador|alguien|asesor humano)\b/i,
  /\b(?:quiero|necesito|prefiero)\s+(?:un[ao]?\s+)?(?:agente|persona|humano|operador)\b/i,
  /\b(?:parler|parle|contacter|passe[rz]?(?:-moi)?|mettre)\s+(?:à|a|avec|en relation avec)?\s*(?:un[e]?\s+)?(?:agent|conseill[eè]re?|personne|humain|op[eé]rateur|quelqu'un)\b/i,
  /\b(?:je veux|je voudrais|j'aimerais|il me faut)\s+(?:un[e]?\s+)?(?:agent|conseill[eè]re?|personne|humain|op[eé]rateur)\b/i,
  /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a|an|the)?\s*(?:real\s+)?(?:person|human|agent|operator|someone|advisor)\b/i,
  /\b(?:i want|i need|i'd like|get me|give me|transfer me to)\s+(?:a|an|the)?\s*(?:real\s+)?(?:person|human|agent|operator)\b/i,
  /\bno (?:eres|es) (?:una )?persona\b|\bnot a (?:real )?person\b/i,
];

/** Whether a message is a request for a person. */
export function isHandoffRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (WORDS.test(t)) return true;
  return PHRASES.some((p) => p.test(t));
}

// --- the tool the advisor can use ----------------------------------------------------

export const REQUEST_HUMAN_TOOL = {
  name: 'request_human',
  description:
    'Hand this conversation to a person. Use it when the caller asks for one, when they are making a complaint or a dispute that needs a decision, when a question turns on something you cannot ground (a specific fare, a carrier ruling, a refund entitlement), or when the same problem has come round twice. Say what you can first; a person will continue from here.',
  input_schema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'One sentence a colleague can act on: what the caller needs and why you are handing over.' } },
    required: ['reason'],
  },
};

// --- the store ------------------------------------------------------------------------

function load() {
  const data = readJson(FILE, { open: {}, log: [] });
  if (!data.open) data.open = {};
  if (!Array.isArray(data.log)) data.log = [];
  return data;
}

function save(data) {
  writeJson(FILE, data);
}

function logEvent(data, entry) {
  data.log.push({ at: new Date().toISOString(), ...entry });
  if (data.log.length > MAX_LOG) data.log = data.log.slice(-MAX_LOG);
}

/** The open handoff for a caller, or null. */
export function openHandoff(number) {
  return load().open[normalizeNumber(number)] || null;
}

export function isEscalated(number) {
  return Boolean(openHandoff(number));
}

/**
 * Opens a handoff. Idempotent: a second request while one is open updates
 * the reason and keeps the record.
 */
export function openHandoffFor(number, { reason, by = 'caller', language = null, transcript = '' } = {}) {
  const data = load();
  const key = normalizeNumber(number);
  const existing = data.open[key];
  const now = new Date().toISOString();
  data.open[key] = existing
    ? { ...existing, reason: reason || existing.reason, lastAt: now }
    : { number: key, openedAt: now, lastAt: now, by, reason: reason || null, language: language || null, transcript: String(transcript || '').slice(0, 500), forwarded: [], said: [] };
  logEvent(data, { kind: existing ? 'handoff_repeated' : 'handoff_opened', number: mask(key), by, reason: reason || null, language });
  save(data);
  return data.open[key];
}

/** Records what the caller sent while a person was in charge. */
export function recordForwarded(number, { text, voice = false } = {}) {
  const data = load();
  const entry = data.open[normalizeNumber(number)];
  if (!entry) return null;
  entry.forwarded.push({ at: new Date().toISOString(), text: String(text || '').slice(0, 500), voice });
  if (entry.forwarded.length > MAX_FORWARDED) entry.forwarded = entry.forwarded.slice(-MAX_FORWARDED);
  entry.lastAt = new Date().toISOString();
  save(data);
  return entry;
}

/** Records what the person said through the advisor's number: the override. */
export function recordSaid(number, { text, by }) {
  const data = load();
  const key = normalizeNumber(number);
  const entry = data.open[key];
  if (entry) {
    entry.said.push({ at: new Date().toISOString(), text: String(text || '').slice(0, 500), by: mask(by) });
    entry.lastAt = new Date().toISOString();
  }
  logEvent(data, { kind: 'human_said', number: mask(key), by: mask(by), chars: String(text || '').length });
  save(data);
  return entry || null;
}

/** Closes a handoff and hands the caller back to the advisor. */
export function closeHandoff(number, { by = null } = {}) {
  const data = load();
  const key = normalizeNumber(number);
  const entry = data.open[key];
  if (!entry) return null;
  delete data.open[key];
  logEvent(data, { kind: 'handoff_closed', number: mask(key), by: mask(by), openMinutes: Math.round((Date.now() - Date.parse(entry.openedAt)) / 60000) });
  save(data);
  return entry;
}

export function listOpenHandoffs() {
  return Object.values(load().open).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export function recentHandoffEvents(limit = 20) {
  return load().log.slice(-limit).reverse();
}

function mask(number) {
  const digits = normalizeNumber(number);
  return digits ? `…${digits.slice(-4)}` : null;
}

// --- the words -----------------------------------------------------------------------------

const STRINGS = {
  // The caller, when a handoff opens.
  opened: {
    es: 'De acuerdo, paso tu conversación a una persona. Te responderá por aquí mismo en cuanto pueda; mientras tanto puedes seguir escribiendo y lo verá. El asistente automático queda en pausa.',
    fr: "Entendu, je transmets votre conversation à une personne. Elle vous répondra ici même dès que possible ; en attendant, vous pouvez continuer à écrire, elle le verra. L'assistant automatique est en pause.",
    en: 'Understood, I am passing your conversation to a person. They will answer you right here as soon as they can; in the meantime you can keep writing and they will see it. The automated assistant is paused.',
  },
  // The caller, on each message while it stays open.
  waiting: {
    es: 'Tu mensaje ha llegado a la persona que atiende tu caso. Te responderá por aquí.',
    fr: 'Votre message est parvenu à la personne qui suit votre demande. Elle vous répondra ici.',
    en: 'Your message has reached the person handling your case. They will answer you here.',
  },
  // The caller, when handed back.
  resumed: {
    es: 'Vuelves a hablar con el asistente automático. Escribe AGENTE si necesitas de nuevo a una persona.',
    fr: "Vous parlez de nouveau à l'assistant automatique. Écrivez CONSEILLER si vous avez à nouveau besoin d'une personne.",
    en: 'You are talking to the automated assistant again. Send AGENT if you need a person again.',
  },
};

export function handoffText(kind, language) {
  const l = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  return STRINGS[kind][l];
}

/** What the person on the escalation list is sent when a handoff opens. */
export function notificationFor(entry, { from = null } = {}) {
  const lang = entry.language ? LANGUAGE_NAMES[entry.language]?.english || entry.language : 'unknown language';
  return [
    `Travel advisor handoff — a person is needed.`,
    `Caller: +${entry.number} (${lang})`,
    `Asked by: ${entry.by === 'advisor' ? 'the advisor' : entry.by === 'founder' ? 'you' : 'the caller'}${entry.reason ? ` — ${entry.reason}` : ''}`,
    entry.transcript ? `Last message: "${entry.transcript}"` : null,
    '',
    `TRAVEL SAY +${entry.number} <message> answers them from the advisor's number.`,
    `TRAVEL RESUME +${entry.number} hands them back to the advisor.`,
    from ? `Or message them directly from your own phone.` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function __resetEscalationsForTests() {
  writeJson(FILE, { open: {}, log: [] });
}
