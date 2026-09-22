// A language menu before the desk answers.
//
// The desk does not need this: one speech-to-speech model hears the caller
// and answers in whatever they spoke, and switches when they switch. The
// founder asked for a menu anyway — a call centre convention, and one that
// gives the caller a choice they can see rather than a behaviour they have to
// trust. So it exists, and it plays by default: English, French and Spanish,
// the three the founder asked for by name. CALL_LANGUAGES replaces that list;
// CALL_LANGUAGES=off removes the menu. One language is not a choice, so a
// list of one is treated as off too — a menu with one option is a delay with
// a prompt.
//
// The menu is Twilio's <Gather>, spoken by Twilio's own text-to-speech in
// each language, before the media stream opens. The realtime session costs
// money from the moment it opens; a menu played by Twilio costs nothing but
// the call minute. The choice rides into the stream as a <Parameter> and
// becomes the language the desk opens in — after which the desk still
// follows the caller, exactly as it does without a menu. A caller who
// presses nothing, or a digit that is not on the menu, gets the default
// (DESK_LANGUAGE, then REPLY_LANGUAGE, then English) and is never told they
// chose wrongly.

import { languageName } from '../language.js';

// The menu line, spoken in the language it offers, and the tag Twilio's
// <Say> needs to pick a voice for it. Anything not listed here is still
// offered — the line is just spoken in English ("For Swedish, press 4.").
const LINES = {
  English: { say: 'en-US', line: (n) => `For English, press ${n}.` },
  Spanish: { say: 'es-ES', line: (n) => `Para español, pulse ${n}.` },
  French: { say: 'fr-FR', line: (n) => `Pour le français, appuyez sur le ${n}.` },
  German: { say: 'de-DE', line: (n) => `Für Deutsch drücken Sie die ${n}.` },
  Italian: { say: 'it-IT', line: (n) => `Per l'italiano, premi ${n}.` },
  Portuguese: { say: 'pt-BR', line: (n) => `Para português, pressione ${n}.` },
  Dutch: { say: 'nl-NL', line: (n) => `Voor Nederlands, druk op ${n}.` },
  Thai: { say: 'th-TH', line: (n) => `สำหรับภาษาไทย กด ${n}` },
  Chinese: { say: 'cmn-CN', line: (n) => `中文请按 ${n}。` },
  Japanese: { say: 'ja-JP', line: (n) => `日本語は ${n} を押してください。` },
  Korean: { say: 'ko-KR', line: (n) => `한국어는 ${n}번을 누르세요.` },
  Russian: { say: 'ru-RU', line: (n) => `Для русского языка нажмите ${n}.` },
  Arabic: { say: 'arb', line: (n) => `للغة العربية اضغط ${n}.` },
  Hindi: { say: 'hi-IN', line: (n) => `हिंदी के लिए ${n} दबाएँ।` },
  Turkish: { say: 'tr-TR', line: (n) => `Türkçe için ${n} tuşuna basın.` },
  Polish: { say: 'pl-PL', line: (n) => `Aby wybrać polski, naciśnij ${n}.` },
  Swedish: { say: 'sv-SE', line: (n) => `För svenska, tryck ${n}.` },
};

// A phone keypad has nine digits that mean "choose"; 0 and the symbols are
// left alone because callers expect 0 to reach a person.
const MAX_CHOICES = 9;

// What plays when nothing is configured. In this order because the founder
// listed them in this order; the digit a caller learns should not move.
const DEFAULT_LANGUAGES = 'en,fr,es';

/**
 * The languages on the menu, in keypad order, as English names.
 *
 * From CALL_LANGUAGES, or the default list when it is unset: codes or names,
 * comma-separated. "off" (or "none") is an empty menu. Unrecognised entries
 * are dropped rather than offered, because a line reading "For undefined,
 * press 3" is the one thing worse than no menu. Duplicates collapse to the
 * first digit.
 */
export function menuLanguages() {
  const raw = String(process.env.CALL_LANGUAGES || '').trim();
  if (/^(off|none|false|0)$/i.test(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of (raw || DEFAULT_LANGUAGES).split(',')) {
    const name = languageName(entry.trim());
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length === MAX_CHOICES) break;
  }
  return out;
}

/** Two or more languages make a menu. Fewer, and the call goes straight to the desk. */
export function isLanguageMenuEnabled() {
  return menuLanguages().length >= 2;
}

/**
 * The language the digit chose, or '' for no digit, a digit off the menu, or
 * anything that is not a digit. Empty means "use the default", and the caller
 * is never told their press was ignored.
 */
export function chosenLanguage(digits) {
  const d = String(digits || '').trim();
  if (!/^[1-9]$/.test(d)) return '';
  return menuLanguages()[Number(d) - 1] || '';
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The TwiML that plays the welcome and the menu, and sends the digit to
 * /api/calls/language.
 *
 * The welcome — "Welcome to the travel help desk." — is spoken first, in
 * the voice of the first language on the menu, and inside the <Gather>: a
 * caller who knows the menu can press during it and skip the rest, which is
 * what regulars of any call centre do. Once, not once per language; a
 * welcome repeated three times is a delay.
 *
 * No digit within the timeout falls through to the <Redirect>, which reaches
 * the same endpoint with no Digits and connects in the default language. The
 * URLs are absolute — the same host Twilio reached the webhook on — for the
 * same reason the stream URL is: it is what Twilio dials back.
 */
export function languageMenuTwiml({ host, welcome = '' }) {
  const action = `https://${host}/api/calls/language`;
  const names = menuLanguages();
  const first = LINES[names[0]] || { say: 'en-US' };
  const hello = welcome ? `<Say language="${first.say}">${escapeXml(welcome)}</Say>` : '';
  const says = names
    .map((name, i) => {
      const spec = LINES[name] || { say: 'en-US', line: (n) => `For ${name}, press ${n}.` };
      return `<Say language="${spec.say}">${escapeXml(spec.line(i + 1))}</Say>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
    `<Gather input="dtmf" numDigits="1" timeout="6" action="${escapeXml(action)}" method="POST">${hello}${says}</Gather>` +
    `<Redirect method="POST">${escapeXml(action)}</Redirect>` +
    '</Response>'
  );
}

/** For the founder: what a caller is offered, in one clause. */
export function describeLanguageMenu() {
  const names = menuLanguages();
  if (names.length < 2) return '';
  return `Callers first pick a language on the keypad: ${names.map((n, i) => `${i + 1} for ${n}`).join(', ')}.`;
}
