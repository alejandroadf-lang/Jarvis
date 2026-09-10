// The one control that overrides every venture's own scope at once.
//
// Per-venture toggles (see finance/ventures.js) are the right shape for
// deciding what a venture is *normally* allowed to do, but they're the wrong
// shape for an emergency: stopping everything meant visiting each venture in
// turn, which is exactly the failure mode "a real kill-switch is one action,
// not a tour of settings pages" describes. This module is that one action.
//
// Two layers, deliberately different in strength:
//
//   - The stored halt (halt/resume below) is flipped at runtime from the
//     Ventures panel and takes effect on the very next authorization check —
//     no restart, no redeploy, which is the whole point when something is
//     already going wrong.
//   - REAL_ACTIONS_DISABLED=true on the server is the stronger, one-way
//     version: it halts everything and the UI cannot un-halt it. That's for
//     when you want the deployed instance incapable of real-world action
//     until a human changes the environment and restarts it.
//
// Enforcement lives inside authorizeDeployment/authorizeOutreach rather than
// in each caller, so nothing — interactive chat, the unattended daily cycle,
// or anything added later — can route around it by forgetting to check.

import { readJson, writeJson } from './store.js';

const FILE = 'killSwitch.json';

function load() {
  return readJson(FILE, { halted: false, reason: '', changedAt: null });
}

function isEnvHalted() {
  return process.env.REAL_ACTIONS_DISABLED === 'true';
}

export function getKillSwitch() {
  const stored = load();
  const envLocked = isEnvHalted();
  return {
    halted: envLocked || Boolean(stored.halted),
    reason: envLocked ? 'REAL_ACTIONS_DISABLED is set on the server.' : stored.reason || '',
    changedAt: stored.changedAt || null,
    envLocked,
  };
}

export function haltRealActions(reason) {
  writeJson(FILE, {
    halted: true,
    reason: String(reason || '').trim() || 'Halted from the Ventures panel.',
    changedAt: new Date().toISOString(),
  });
  return getKillSwitch();
}

export function resumeRealActions() {
  if (isEnvHalted()) {
    throw new Error(
      'Real actions are halted by REAL_ACTIONS_DISABLED on the server — unset it and restart to resume.'
    );
  }
  writeJson(FILE, { halted: false, reason: '', changedAt: new Date().toISOString() });
  return getKillSwitch();
}

// Called by every real-action authorization path. Throws with the reason the
// founder gave, so the refusal that reaches the agent (and the log) says why
// it was stopped rather than looking like a scope misconfiguration.
export function assertRealActionsAllowed() {
  const state = getKillSwitch();
  if (state.halted) {
    throw new Error(`All real actions are halted. ${state.reason}`.trim());
  }
}
