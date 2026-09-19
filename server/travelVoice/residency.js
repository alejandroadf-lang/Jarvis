// Where a caller's words are allowed to go.
//
// A Spanish or French agency asking "where does my client's booking
// question go" deserves an answer, and "a US API" is only acceptable if
// somebody chose it. So every provider says where it runs, and one switch
// — TRAVEL_VOICE_RESIDENCY=eu, or TRAVEL RESIDENCY EU from a phone — makes
// the provider slots refuse anything that is not hosted in the European
// Union: the pinned choice, the deployment default and the first-configured
// fallback alike. A provider named outright that is not EU-hosted is
// refused with the reason, never swapped for one that is.
//
// What "EU" means per vendor is a declaration, not a probe: a vendor's
// region is a fact of the account and the endpoint, and the code cannot
// see it. IONOS is EU by construction. Claude is EU only through an EU
// region of Bedrock or Vertex (the direct API offers no EU-only inference
// geography — see agents/anthropicClient.js). OpenAI, ElevenLabs, Deepgram
// and AssemblyAI each offer an EU endpoint or project on some plans; the
// variable says whether this deployment is on one. Unset means "not EU",
// which is the safe direction to be wrong in.

import { override as settingOverride } from './settings.js';

export const MODES = ['any', 'eu'];

/** 'eu' to refuse anything not hosted in the EU; 'any' otherwise. */
export function residencyMode() {
  const pinned = settingOverride('residency');
  if (pinned !== undefined) return pinned;
  const env = (process.env.TRAVEL_VOICE_RESIDENCY || '').trim().toLowerCase();
  return MODES.includes(env) ? env : 'any';
}

export function euOnly() {
  return residencyMode() === 'eu';
}

// What a vendor's declaration variable may say.
const REGIONS = new Set(['eu', 'us', 'global', 'unknown']);

/**
 * Reads a vendor's declared region from a variable, e.g. OPENAI_RESIDENCY.
 * An EU-looking base URL counts as a declaration too, so a deployment that
 * already points at api.eu.assemblyai.com does not have to say it twice.
 */
export function declaredResidency(envName, { baseUrl = '', fallback = 'us' } = {}) {
  const declared = (process.env[envName] || '').trim().toLowerCase();
  if (REGIONS.has(declared)) return declared;
  if (/\/\/[^/]*\b(eu|europe)[-.]/i.test(String(baseUrl || '')) || /\.eu\.[a-z]/i.test(String(baseUrl || ''))) return 'eu';
  return fallback;
}

/** Whether a provider may run under the current mode. */
export function allowedHere(provider) {
  if (!euOnly()) return true;
  return residencyOf(provider) === 'eu';
}

export function residencyOf(provider) {
  try {
    const r = typeof provider?.residency === 'function' ? provider.residency() : provider?.residency;
    return REGIONS.has(r) ? r : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Why a provider was refused, in a sentence a founder can act on. */
export function refusal(provider, kind) {
  const region = residencyOf(provider);
  return `${provider.label} is ${region === 'unknown' ? 'not declared as' : 'not'} EU-hosted (${region}) and residency is set to eu. ` +
    `Pick an EU-hosted ${kind} provider, declare this one with its _RESIDENCY variable if it is on an EU endpoint, or TRAVEL RESIDENCY ANY.`;
}
