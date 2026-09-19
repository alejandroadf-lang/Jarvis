// Which ears, brain and voice a turn runs on.
//
// Three slots, each with several providers behind one contract (see stt.js,
// llm.js, tts.js). A choice is resolved in this order:
//
//   1. What the caller asked for on this turn — the dropdowns in the Travel
//      Voice tab, or the fields on the /turn endpoint. Refused, not silently
//      swapped, when that provider has no key: a founder comparing voices
//      needs to know they heard the one they picked.
//   2. A runtime pin set from a phone (see providerPrefs.js). This is how a
//      demo with no browser open switches voice mid-conversation.
//   3. The deployment's default — TRAVEL_VOICE_STT_PROVIDER, _LLM_PROVIDER,
//      _TTS_PROVIDER. This is what a WhatsApp caller gets when nothing is
//      pinned, since a phone has no dropdown.
//   4. The first configured provider in the slot's own order, which puts the
//      one that was here first (OpenAI for audio, Anthropic for the brain)
//      ahead of the newcomers.
//
// The registry also describes itself, so the tab can show what is available
// and what each option would need, rather than a list of names with no way
// to tell a working key from an absent one.

import { EARS } from './stt.js';
import { BRAINS } from './llm.js';
import { VOICES } from './tts.js';
import { overrideFor } from '../providerPrefs.js';
import { allowedHere, residencyOf, residencyMode, refusal } from '../residency.js';

export const SLOTS = {
  stt: { label: 'Ears (speech to text)', providers: EARS, envName: 'TRAVEL_VOICE_STT_PROVIDER' },
  llm: { label: 'Brain (the advisor model)', providers: BRAINS, envName: 'TRAVEL_VOICE_LLM_PROVIDER' },
  tts: { label: 'Voice (text to speech)', providers: VOICES, envName: 'TRAVEL_VOICE_TTS_PROVIDER' },
};

function slot(kind) {
  const found = SLOTS[kind];
  if (!found) throw new Error(`Unknown provider slot "${kind}"`);
  return found;
}

export function listProviders(kind) {
  return slot(kind).providers;
}

export function findProvider(kind, id) {
  if (!id) return null;
  return slot(kind).providers.find((p) => p.id === String(id).trim().toLowerCase()) || null;
}

export function defaultProviderId(kind) {
  return (process.env[slot(kind).envName] || '').trim().toLowerCase() || null;
}

/**
 * Where the active choice for a slot came from, for a status display that
 * has to explain itself without a browser: 'pinned', 'env', 'first' or
 * 'none'.
 */
export function providerSource(kind) {
  const usable = (p) => p && p.configured() && allowedHere(p);
  const pinned = overrideFor(kind);
  if (pinned && usable(findProvider(kind, pinned))) return 'pinned';
  const preset = defaultProviderId(kind);
  if (preset && usable(findProvider(kind, preset))) return 'env';
  return listProviders(kind).some(usable) ? 'first' : 'none';
}

/**
 * The provider a turn should use for one slot, or null when none is
 * configured at all. Throws when the caller named one that cannot run —
 * see the header for why that is not a fallback.
 */
export function resolveProvider(kind, requested = null) {
  const { providers, envName } = slot(kind);

  if (requested) {
    const chosen = findProvider(kind, requested);
    if (!chosen) throw new Error(`Unknown ${kind} provider "${requested}". Options: ${providers.map((p) => p.id).join(', ')}.`);
    if (!chosen.configured()) throw new Error(`${chosen.label} is not configured — see server/.env.example for what it needs.`);
    // Named outright and not EU-hosted while residency is eu: refused with
    // the reason, never swapped. See residency.js.
    if (!allowedHere(chosen)) throw new Error(refusal(chosen, kind));
    return chosen;
  }

  const usable = (p) => p && p.configured() && allowedHere(p);

  // A pin set from a phone. Same fall-through as the environment default: a
  // pin whose key was later removed must not take the demo down, it must
  // quietly stop applying and say so in the log. A pin that residency now
  // forbids falls through the same way, and says why.
  const pinned = overrideFor(kind);
  if (pinned) {
    const chosen = findProvider(kind, pinned);
    if (usable(chosen)) return chosen;
    if (chosen && chosen.configured()) console.warn(`Travel voice: the ${kind} slot is pinned to "${pinned}", which is not EU-hosted and residency is eu; falling through.`);
    else console.warn(`Travel voice: the ${kind} slot is pinned to "${pinned}", which is unknown or has no key; falling through.`);
  }

  const preset = defaultProviderId(kind);
  if (preset) {
    const chosen = findProvider(kind, preset);
    if (usable(chosen)) return chosen;
    if (chosen && chosen.configured()) console.warn(`Travel voice: ${envName}=${preset} is set but ${chosen.label} is not EU-hosted and residency is eu; using the first EU-hosted provider instead.`);
    else if (chosen) console.warn(`Travel voice: ${envName}=${preset} is set but ${chosen.label} has no key; using the first configured provider instead.`);
    else console.warn(`Travel voice: ${envName}=${preset} names no known provider; using the first configured one instead.`);
  }

  return providers.find(usable) || null;
}

export function hasProvider(kind) {
  return Boolean(resolveProvider(kind));
}

/** What the tab shows: every option in every slot, and which one is active. */
export function describeProviders() {
  const out = { residency: residencyMode() };
  for (const [kind, { label }] of Object.entries(SLOTS)) {
    const active = resolveProvider(kind);
    out[kind] = {
      label,
      active: active ? active.id : null,
      source: providerSource(kind),
      pinned: overrideFor(kind),
      options: slot(kind).providers.map((p) => ({
        id: p.id,
        label: p.label,
        configured: p.configured(),
        residency: residencyOf(p),
        allowed: allowedHere(p),
        model: safe(() => p.model()),
        voice: typeof p.voice === 'function' ? safe(() => p.voice()) : undefined,
        languages: p.languages,
      })),
    };
  }
  return out;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
