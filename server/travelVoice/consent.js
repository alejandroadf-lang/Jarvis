// Telling a caller they are talking to a machine, and asking before their
// voice is processed.
//
// Two obligations sit on the first message of every conversation, and both
// bind this product today. The first is disclosure: a person talking to an
// AI system must be told so at first interaction, in words they will hear
// or read (EU AI Act, Article 50, applying from 2 August 2026; Meta's own
// Business Messaging policy since January 2026). The second is consent: a
// voice recording is personal data whatever else it is, and processing it
// through a chain of AI vendors is not something a caller who was handed a
// phone number has agreed to by sending a note.
//
// So the first contact gets, before anything else: a short spoken
// disclosure in the advisor's own voice, the same words as text, and two
// reply buttons. The consent is captured as a button tap — a WhatsApp
// interactive reply carrying a message id and a timestamp — rather than a
// spoken "yes" that a transcriber may have misheard, and the id is kept.
//
// What is gated is the voice. Until the button is tapped, a voice note is
// not downloaded, not transcribed, not sent anywhere; the caller is told
// why, and text still works, because a caller who declines to be recorded
// has not declined to be helped. The founder can lower the bar to "notice"
// (disclose, do not gate) or "off" for a demo on their own phone, from the
// phone, and the setting is reported in the status so it cannot be lowered
// by accident and forgotten.

import { readJson, writeJson } from '../store.js';
import { normalizeNumber } from '../channels/whatsapp.js';
import { normalizeLanguage, DEFAULT_LANGUAGE } from './languages.js';
import { override as settingOverride } from './settings.js';

const FILE = 'travelVoiceConsent.json';

// Bumped when the wording of the disclosure changes in a way a caller who
// accepted the old one should see again.
export const DISCLOSURE_VERSION = 1;

export const MODES = ['required', 'notice', 'off'];

export const BUTTON_YES = 'consent_yes';
export const BUTTON_NO = 'consent_no';

// --- the mode -------------------------------------------------------------------

/** 'required' gates voice on consent; 'notice' discloses only; 'off' does neither. */
export function consentMode() {
  const pinned = settingOverride('consent');
  if (pinned !== undefined) return pinned;
  const env = (process.env.TRAVEL_VOICE_CONSENT || '').trim().toLowerCase();
  return MODES.includes(env) ? env : 'required';
}

// --- the store ---------------------------------------------------------------------

function load() {
  const data = readJson(FILE, { callers: {} });
  if (!data.callers) data.callers = {};
  return data;
}

function save(data) {
  writeJson(FILE, data);
}

function key(number) {
  return normalizeNumber(number);
}

/** What is on record for one caller, or null. Never the number itself. */
export function consentState(number) {
  const entry = load().callers[key(number)];
  if (!entry) return null;
  return { ...entry };
}

/** Whether this caller has yet to see the current disclosure. */
export function needsDisclosure(number) {
  if (consentMode() === 'off') return false;
  const entry = load().callers[key(number)];
  return !entry || entry.disclosureVersion !== DISCLOSURE_VERSION;
}

export function recordDisclosure(number, { language = null, messageId = null, spoken = false } = {}) {
  const data = load();
  const k = key(number);
  const existing = data.callers[k] || {};
  data.callers[k] = {
    ...existing,
    disclosedAt: new Date().toISOString(),
    disclosureVersion: DISCLOSURE_VERSION,
    disclosureMessageId: messageId,
    disclosureSpoken: spoken,
    language: language || existing.language || null,
    // A new version of the wording asks again; the old answer is kept for
    // the record but no longer counts.
    ...(existing.disclosureVersion !== DISCLOSURE_VERSION ? { consent: null, consentAt: null, consentMessageId: null } : {}),
  };
  save(data);
  return data.callers[k];
}

/**
 * Records the tap. The message id is the evidence: it is Meta's id for the
 * interactive reply, and it names the button, the sender and the moment.
 */
export function recordConsent(number, { granted, messageId = null, buttonId = null } = {}) {
  const data = load();
  const k = key(number);
  const existing = data.callers[k] || {};
  data.callers[k] = {
    ...existing,
    consent: granted ? 'granted' : 'declined',
    consentAt: new Date().toISOString(),
    consentMessageId: messageId,
    consentButton: buttonId,
    disclosureVersion: existing.disclosureVersion || DISCLOSURE_VERSION,
  };
  save(data);
  return data.callers[k];
}

/** Forgets one caller — what a deletion request asks for. */
export function forgetConsent(number) {
  const data = load();
  const had = key(number) in data.callers;
  delete data.callers[key(number)];
  save(data);
  return had;
}

/** Whether a voice note from this caller may be processed right now. */
export function voiceAllowed(number) {
  const mode = consentMode();
  if (mode !== 'required') return true;
  return load().callers[key(number)]?.consent === 'granted';
}

/** Every caller on record, masked, for the founder's listing. */
export function listConsents(mask) {
  return Object.entries(load().callers).map(([number, entry]) => ({
    number: mask ? mask(number) : number,
    consent: entry.consent || null,
    consentAt: entry.consentAt || null,
    disclosedAt: entry.disclosedAt || null,
    language: entry.language || null,
  }));
}

// --- the words -------------------------------------------------------------------------

function lang(language) {
  return normalizeLanguage(language) || DEFAULT_LANGUAGE;
}

/** Months the transcripts are kept, for the wording; the sweeper reads the same variable. */
function retentionMonths() {
  const days = Number(process.env.TRAVEL_VOICE_RETENTION_DAYS);
  return Math.max(1, Math.round((Number.isFinite(days) && days > 0 ? days : 180) / 30));
}

const DISCLOSURE = {
  es: (months, url) =>
    `Aviso: estás hablando con un asistente automático de inteligencia artificial, no con una persona. ` +
    `Tus mensajes y notas de voz se procesan con proveedores de IA para responderte, se conservan como máximo ${months} meses y una persona puede revisarlos para control de calidad. ` +
    `Escribe AGENTE en cualquier momento para que te atienda una persona.${url ? ` Más información: ${url}` : ''}\n\n` +
    `¿Aceptas que procesemos tus notas de voz? Sin tu aceptación seguiré ayudándote solo por texto.`,
  fr: (months, url) =>
    `Information : vous parlez à un assistant automatique fondé sur l'intelligence artificielle, pas à une personne. ` +
    `Vos messages et messages vocaux sont traités par des prestataires d'IA pour vous répondre, conservés au plus ${months} mois, et une personne peut les relire à des fins de qualité. ` +
    `Écrivez CONSEILLER à tout moment pour être mis en relation avec une personne.${url ? ` En savoir plus : ${url}` : ''}\n\n` +
    `Acceptez-vous que vos messages vocaux soient traités ? Sans votre accord, je continuerai à vous aider par écrit uniquement.`,
  en: (months, url) =>
    `Notice: you are talking to an automated AI assistant, not a person. ` +
    `Your messages and voice notes are processed by AI providers to answer you, kept for at most ${months} months, and may be reviewed by a person for quality. ` +
    `Send AGENT at any time to reach a person.${url ? ` More: ${url}` : ''}\n\n` +
    `Do you agree to your voice notes being processed? Without your agreement I will keep helping you by text only.`,
};

// Short, because it is spoken before the caller has heard anything else.
const SPOKEN = {
  es: 'Hola. Soy un asistente automático de inteligencia artificial, no una persona. Te envío por escrito cómo se tratan tus mensajes y un botón para aceptar. Escribe AGENTE si prefieres hablar con una persona.',
  fr: "Bonjour. Je suis un assistant automatique fondé sur l'intelligence artificielle, pas une personne. Je vous envoie par écrit la façon dont vos messages sont traités et un bouton pour accepter. Écrivez CONSEILLER si vous préférez parler à une personne.",
  en: 'Hello. I am an automated AI assistant, not a person. I am sending you in writing how your messages are handled, with a button to agree. Send AGENT if you would rather talk to a person.',
};

// WhatsApp caps a reply-button title at 20 characters.
const BUTTONS = {
  es: { yes: 'Acepto', no: 'No acepto' },
  fr: { yes: "J'accepte", no: 'Je refuse' },
  en: { yes: 'I agree', no: 'I decline' },
};

const ANSWERS = {
  granted: {
    es: 'Gracias. Ya puedes enviarme notas de voz o escribirme. Puedes retirar tu aceptación cuando quieras escribiendo BORRAR.',
    fr: 'Merci. Vous pouvez maintenant m’envoyer des messages vocaux ou m’écrire. Vous pouvez retirer votre accord à tout moment en écrivant SUPPRIMER.',
    en: 'Thank you. You can now send me voice notes or write to me. You can withdraw your agreement at any time by sending DELETE.',
  },
  declined: {
    es: 'Entendido. No procesaré tus notas de voz. Puedes seguir escribiéndome y te ayudo por texto.',
    fr: 'Entendu. Je ne traiterai pas vos messages vocaux. Vous pouvez continuer à m’écrire et je vous aiderai par écrit.',
    en: 'Understood. I will not process your voice notes. You can keep writing to me and I will help by text.',
  },
  needed: {
    es: 'Antes de escuchar una nota de voz necesito tu aceptación: pulsa Acepto en el mensaje anterior, o escríbeme tu pregunta.',
    fr: "Avant d'écouter un message vocal, j'ai besoin de votre accord : appuyez sur J'accepte dans le message précédent, ou écrivez-moi votre question.",
    en: 'Before I listen to a voice note I need your agreement: tap I agree on the message above, or type your question.',
  },
  forgotten: {
    es: 'Hecho. He borrado tu aceptación y el historial de esta conversación.',
    fr: "C'est fait. J'ai supprimé votre accord et l'historique de cette conversation.",
    en: 'Done. I have deleted your agreement and the history of this conversation.',
  },
};

export function disclosureText(language) {
  const url = (process.env.TRAVEL_VOICE_PRIVACY_URL || '').trim();
  return DISCLOSURE[lang(language)](retentionMonths(), url);
}

export function spokenDisclosure(language) {
  return SPOKEN[lang(language)];
}

export function consentAnswer(kind, language) {
  return ANSWERS[kind][lang(language)];
}

/** The interactive message: the disclosure with two reply buttons under it. */
export function disclosurePayload(language) {
  const l = lang(language);
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: disclosureText(l).slice(0, 1024) },
      action: {
        buttons: [
          { type: 'reply', reply: { id: BUTTON_YES, title: BUTTONS[l].yes } },
          { type: 'reply', reply: { id: BUTTON_NO, title: BUTTONS[l].no } },
        ],
      },
    },
  };
}

/** A button tap, or null. Recognised by id, never by the title's wording. */
export function parseConsentReply(buttonReply) {
  const id = String(buttonReply?.id || '').trim();
  if (id === BUTTON_YES) return { granted: true };
  if (id === BUTTON_NO) return { granted: false };
  return null;
}

// "BORRAR", "SUPPRIMER", "DELETE": withdraw consent and forget the conversation.
const FORGET = /^(?:borrar|olvidar|olvídame|supprimer|oublie[rz]?(?:-moi)?|delete|forget(?:\s+me)?)$/i;

export function isForgetRequest(text) {
  return FORGET.test(String(text || '').trim());
}

export function __resetConsentForTests() {
  writeJson(FILE, { callers: {} });
}
