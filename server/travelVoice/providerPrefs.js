// Which ears, brain and voice the demo is running on, changeable from a phone.
//
// The provider slots were built to be compared, and until now the only way to
// switch one was the Travel Voice tab's dropdowns or a redeploy. That is fine
// when there is a browser open and useless when the whole demo is a phone
// number and WhatsApp — which is the point at which someone actually wants to
// switch, standing in front of an agency owner who has just said the voice
// sounds robotic.
//
// So a founder command can pin a provider at runtime, and it survives a
// restart. This sits between the per-turn request and the environment
// default: a turn that names a provider still wins, because the tab's
// dropdowns must keep meaning what they say.
//
// Deliberately its own module rather than part of travelVoice/index.js:
// providers/index.js reads it, and index.js reads providers/index.js, so
// putting it there would be a cycle.

import { readJson, writeJson } from '../store.js';

const FILE = 'travelVoiceProviderPrefs.json';
const SLOTS = ['stt', 'llm', 'tts'];

function load() {
  const data = readJson(FILE, { overrides: {} });
  if (!data.overrides) data.overrides = {};
  return data;
}

/** The runtime pin for one slot, or null when the environment still decides. */
export function overrideFor(kind) {
  return load().overrides[kind] || null;
}

export function allOverrides() {
  return { ...load().overrides };
}

/**
 * Pins a slot to a provider. Validation of whether that provider exists and
 * has a key belongs to the caller (see commands.js) — this only remembers.
 */
export function setOverride(kind, providerId) {
  if (!SLOTS.includes(kind)) throw new Error(`Unknown provider slot "${kind}"`);
  const data = load();
  if (providerId) data.overrides[kind] = String(providerId).trim().toLowerCase();
  else delete data.overrides[kind];
  writeJson(FILE, data);
  return data.overrides[kind] || null;
}

/** Back to whatever the environment says. */
export function clearOverrides() {
  writeJson(FILE, { overrides: {} });
}

export function __resetPrefsForTests() {
  writeJson(FILE, { overrides: {} });
}
