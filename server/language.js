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

// Whisper's `verbose_json` reports the language as an English word —
// "spanish", not "es" — and this function only ever looked at the first two
// characters of it. That made it a coin flip. French, Thai, Japanese, Korean,
// Italian, Russian and Arabic worked by accident, because their English names
// happen to start with their own ISO code. Spanish became "sp", German "ge",
// Portuguese and Polish both "po", Chinese "ch", Dutch "du" — none of them in
// the table, so the instruction came back empty and the team answered in
// English. The one bug this whole feature exists to prevent, surviving inside
// it because a label said ISO-639-1 and nothing checked.
//
// So both forms are accepted, and the fix does not depend on being right about
// which one the API sends. Whisper's own spellings for languages it names
// differently from this table are aliased rather than added as codes.
// Keys are in post-normalisation form: lowercase, underscores already spaces.
const ALIASES = {
  mandarin: 'zh', 'mandarin chinese': 'zh', cantonese: 'zh',
  castilian: 'es', flemish: 'nl', farsi: 'fa', 'modern greek': 'el',
  moldavian: 'ro', moldovan: 'ro',
  bokmal: 'no', nynorsk: 'no', 'norwegian bokmal': 'no', 'norwegian bokmål': 'no',
};

const BY_NAME = new Map(Object.entries(NAMES).map(([code, name]) => [name.toLowerCase(), code]));

/**
 * The English name of a language, from an ISO-639-1 code or an English name.
 *
 * Empty for anything unrecognised, which is a real answer: it means say
 * nothing rather than instruct a model into a language the founder may not
 * have been speaking.
 */
export function languageName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';

  // An exact two-letter code, checked first so "no" stays Norwegian.
  if (NAMES[raw]) return NAMES[raw];

  // A BCP-47 tag: a two-letter code plus a region or script subtag, such as
  // pt-BR or zh-Hans. Matched by shape rather than by taking a prefix — the
  // structure is what makes the first two letters a code here, and what makes
  // them meaningless in "spanish".
  const tagged = /^([a-z]{2})[-_][a-z0-9-]+$/.exec(raw);
  if (tagged && NAMES[tagged[1]]) return NAMES[tagged[1]];

  const spelled = raw.replace(/_/g, ' ');
  const code = BY_NAME.get(spelled) || ALIASES[spelled];
  return code ? NAMES[code] || '' : '';
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

// When a spoken reply is cut for length, the founder is told so — and that
// sentence was hardcoded English, so a Thai voice note ended with an English
// sentence spoken by a Thai voice. A small thing that breaks the illusion
// completely: the one moment the reply stops being in your language is the
// moment it admits it is incomplete.
//
// Only languages translated with confidence are listed. Everything else falls
// back to English, which is honest — a mistranslated apology is worse than a
// clearly foreign one, and the alternative is inventing phrasing in a language
// nobody here can check.
const REST_IS_IN_THE_MESSAGE = {
  English: 'The rest is in the message.',
  Spanish: 'El resto está en el mensaje.',
  French: 'La suite est dans le message.',
  German: 'Der Rest steht in der Nachricht.',
  Portuguese: 'O resto está na mensagem.',
  Italian: 'Il resto è nel messaggio.',
  Dutch: 'De rest staat in het bericht.',
  Polish: 'Reszta jest w wiadomości.',
  Russian: 'Остальное — в сообщении.',
  Ukrainian: 'Решта — у повідомленні.',
  Turkish: 'Geri kalanı mesajda.',
  Arabic: 'البقية في الرسالة.',
  Hebrew: 'השאר בהודעה.',
  Hindi: 'बाकी संदेश में है।',
  Indonesian: 'Selebihnya ada di pesan.',
  Malay: 'Selebihnya ada dalam mesej.',
  Vietnamese: 'Phần còn lại nằm trong tin nhắn.',
  Thai: 'ส่วนที่เหลืออยู่ในข้อความ',
  Chinese: '其余内容在消息里。',
  Japanese: '残りはメッセージにあります。',
  Korean: '나머지는 메시지에 있습니다.',
  Swedish: 'Resten finns i meddelandet.',
  Danish: 'Resten står i beskeden.',
  Norwegian: 'Resten står i meldingen.',
  Finnish: 'Loput ovat viestissä.',
  Czech: 'Zbytek je ve zprávě.',
  Romanian: 'Restul este în mesaj.',
  Greek: 'Τα υπόλοιπα είναι στο μήνυμα.',
};

/**
 * "The rest is in the message", in the language being spoken.
 *
 * @param {string} language - an English language name, ISO code, or nothing.
 */
export function truncationNotice(language = '') {
  const name = languageName(language);
  return REST_IS_IN_THE_MESSAGE[name] || REST_IS_IN_THE_MESSAGE.English;
}

/** Which language the spoken reply is actually in: pinned beats detected. */
export function spokenLanguage({ detected = '' } = {}) {
  return pinnedLanguage() || languageName(detected) || '';
}
