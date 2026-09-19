// The dials of the demo, turnable from a phone.
//
// Every one of these already existed as an environment variable, which means
// changing one meant a redeploy. That is the right shape for a deployment
// default and the wrong shape for the thing you actually want mid-demo: an
// agency owner says the answer was too long, or the voice is wrong, or they
// only ever want French, and the useful response is to change it in the next
// ten seconds rather than the next release.
//
// So each setting resolves in three steps: what was set from a phone, then
// the environment variable, then the built-in default. The environment stays
// the base — a redeploy still puts a deployment where its config says it
// should be — and the phone is an override on top, persisted so a restart
// mid-demo does not silently undo it.
//
// The registry below is the whole contract. Adding a dial means adding one
// entry here and reading it where the value is used; the command, the
// listing, the validation and the help text all come from the entry.

import { readJson, writeJson } from '../store.js';
import { SUPPORTED_LANGUAGES, normalizeLanguage } from './languages.js';

const FILE = 'travelVoiceSettings.json';

// Words that mean "stop overriding this and go back to the configuration".
const CLEARING = new Set(['default', 'defaults', 'auto', 'clear', 'reset', 'unset', 'none']);

function bool(value) {
  const v = String(value).trim().toLowerCase();
  if (['on', 'yes', 'true', '1', 'si', 'sí', 'oui'].includes(v)) return true;
  if (['off', 'no', 'false', '0', 'non'].includes(v)) return false;
  throw new Error('say on or off');
}

function positiveInt(value, { min, max }) {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) throw new Error('needs a whole number');
  if (n < min || n > max) throw new Error(`needs to be between ${min} and ${max}`);
  return n;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'off'];

/**
 * Every dial, in the order they are listed back to a phone: the ones most
 * likely to be reached for during a demo first.
 */
export const SETTINGS = {
  voice: {
    label: 'voice',
    help: 'a voice id or name from whichever speech provider is live',
    // Provider-specific, and stored per provider: "alloy" means nothing to
    // ElevenLabs and an ElevenLabs id means nothing to OpenAI, so switching
    // provider must not carry the wrong one across.
    perProvider: 'tts',
    parse: (value) => String(value).trim(),
  },
  tier: {
    label: 'tier',
    help: 'quality for the best voice, fast for the low-latency one (ElevenLabs)',
    envName: 'ELEVENLABS_TTS_MODEL',
    parse: (value) => {
      const v = String(value).trim().toLowerCase();
      if (!['quality', 'fast'].includes(v)) throw new Error('needs to be quality or fast');
      return v;
    },
    describeDefault: 'quality (eleven_multilingual_v2)',
  },
  language: {
    label: 'language',
    help: `${SUPPORTED_LANGUAGES.join(', ')}, or auto to detect it`,
    parse: (value) => {
      const lang = normalizeLanguage(value);
      if (!lang) throw new Error(`needs to be one of ${SUPPORTED_LANGUAGES.join(', ')}, or auto`);
      return lang;
    },
    describeDefault: 'auto (detected from what the caller says)',
  },
  length: {
    label: 'length',
    help: 'how many words the spoken answer may run to before it is cut',
    envName: 'TRAVEL_VOICE_SPOKEN_MAX_WORDS',
    fallback: 220,
    parse: (value) => positiveInt(value, { min: 20, max: 2000 }),
  },
  effort: {
    label: 'effort',
    help: EFFORTS.join(', '),
    envName: 'TRAVEL_VOICE_EFFORT',
    fallback: 'low',
    parse: (value) => {
      const v = String(value).trim().toLowerCase();
      if (!EFFORTS.includes(v)) throw new Error(`needs to be one of ${EFFORTS.join(', ')}`);
      return v;
    },
  },
  model: {
    label: 'model',
    help: 'a model id for whichever brain is live',
    envName: 'TRAVEL_VOICE_MODEL',
    parse: (value) => String(value).trim(),
    describeDefault: "the brain's own default",
  },
  text: {
    label: 'text',
    help: 'on to send the words alongside the voice note, off for voice only',
    envName: 'TRAVEL_VOICE_TEXT_TOO',
    fallback: true,
    parse: bool,
  },
  retry: {
    label: 'retry',
    help: 'on to re-ask an answer that came back in the wrong language',
    envName: 'TRAVEL_VOICE_LANGUAGE_RETRY',
    fallback: true,
    parse: bool,
  },
  residency: {
    label: 'residency',
    help: 'eu to refuse any provider not hosted in the European Union, any to allow all',
    envName: 'TRAVEL_VOICE_RESIDENCY',
    fallback: 'any',
    parse: (value) => {
      const v = String(value).trim().toLowerCase();
      if (!['any', 'eu'].includes(v)) throw new Error('needs to be eu or any');
      return v;
    },
  },
  consent: {
    label: 'consent',
    help: 'required to ask before hearing a voice note, notice to only disclose, off for a demo on your own phone',
    envName: 'TRAVEL_VOICE_CONSENT',
    fallback: 'required',
    parse: (value) => {
      const v = String(value).trim().toLowerCase();
      if (!['required', 'notice', 'off'].includes(v)) throw new Error('needs to be required, notice or off');
      return v;
    },
  },
  cap: {
    label: 'cap',
    help: 'dollars one conversation may spend in a day',
    envName: 'TRAVEL_VOICE_SESSION_CAP_USD',
    fallback: 1,
    parse: (value) => {
      const n = Number(String(value).trim().replace(/^\$/, ''));
      if (!Number.isFinite(n) || n <= 0 || n > 100) throw new Error('needs a dollar amount between 0.01 and 100');
      return n;
    },
  },
  sample: {
    label: 'sample',
    help: 'percent of answered turns copied for a person to review, 0 to 100',
    envName: 'TRAVEL_VOICE_REVIEW_SAMPLE_PCT',
    fallback: 3,
    parse: (value) => {
      const n = Number(String(value).trim().replace(/%$/, ''));
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('needs a percentage between 0 and 100');
      return n;
    },
  },
  limit: {
    label: 'limit',
    help: 'how many questions one caller may ask per hour',
    envName: 'TRAVEL_VOICE_MAX_TURNS_PER_HOUR',
    fallback: 20,
    parse: (value) => positiveInt(value, { min: 1, max: 500 }),
  },
};

export function findSetting(name) {
  const key = String(name || '').trim().toLowerCase();
  // A couple of words people reach for that are not the key.
  const aliases = { words: 'length', lang: 'language', idioma: 'language', langue: 'language', rate: 'limit', voiceid: 'voice', thinking: 'effort' };
  const resolved = aliases[key] || key;
  return SETTINGS[resolved] ? resolved : null;
}

export function isClearing(value) {
  return CLEARING.has(String(value || '').trim().toLowerCase());
}

function load() {
  const data = readJson(FILE, { values: {} });
  if (!data.values) data.values = {};
  return data;
}

function storageKey(key, providerId) {
  return SETTINGS[key].perProvider && providerId ? `${key}:${providerId}` : key;
}

/**
 * What was set from a phone, or undefined when the configuration still
 * decides. Callers fall back to their own environment variable, which is why
 * this returns undefined rather than a default.
 */
export function override(key, providerId = null) {
  return load().values[storageKey(key, providerId)];
}

export function setOverride(key, value, providerId = null) {
  if (!SETTINGS[key]) throw new Error(`Unknown setting "${key}"`);
  const data = load();
  data.values[storageKey(key, providerId)] = value;
  writeJson(FILE, data);
  return value;
}

export function clearOverride(key, providerId = null) {
  const data = load();
  const had = storageKey(key, providerId) in data.values;
  delete data.values[storageKey(key, providerId)];
  writeJson(FILE, data);
  return had;
}

export function clearAll() {
  writeJson(FILE, { values: {} });
}

/**
 * The value a consumer should use, and where it came from. `envValue` is
 * passed in rather than read here so each consumer keeps owning how its own
 * variable is parsed — an empty string means something different for effort
 * (send none) than for a number (unset).
 */
export function resolve(key, { envValue = undefined, providerId = null } = {}) {
  const pinned = override(key, providerId);
  if (pinned !== undefined) return { value: pinned, source: 'phone' };
  if (envValue !== undefined && envValue !== null && envValue !== '') return { value: envValue, source: 'config' };
  return { value: SETTINGS[key]?.fallback, source: 'default' };
}

/** Everything that has been set from a phone, for the listing. */
export function allOverrides() {
  return { ...load().values };
}

export function __resetSettingsForTests() {
  clearAll();
}
