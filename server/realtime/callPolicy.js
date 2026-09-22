// Who may ring the company, and what a call is allowed to cost.
//
// A phone number is the most exposed surface this app has. The WhatsApp
// webhook at least requires Meta to forward a message from an account; a
// published number can be dialled by a wrong number, an autodialer, or
// anyone who reads it off a screenshot. And unlike a message, a call bills
// by the minute for as long as it stays open, so the failure mode of getting
// this wrong is not an unwanted conversation — it is an unwanted conversation
// that runs until somebody notices.
//
// Two separate limits, because they fail differently:
//
//   1. WHO. An allowlist of numbers, failing closed exactly like the WhatsApp
//      one. No allowlist means nobody, never everybody.
//   2. HOW LONG. A hard cap per call and a budget per day. The model has no
//      concept of a phone bill and will happily talk until the sun comes up.

import { allowedNumbers } from '../channels/whatsapp.js';
import { describeLanguageMenu } from './languageMenu.js';

function numberFromEnv(name, fallback) {
  const raw = Number(String(process.env[name] || '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Digits only, so +66 81 234 5678 and 66812345678 compare equal. Same
// normalisation as the WhatsApp allowlist, and for the same reason: a
// mismatch here locks the founder out of their own company.
function normalizeNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Numbers allowed to call in.
 *
 * Defaults to the WhatsApp allowlist, because the founder who messages the
 * company is the founder who calls it, and a second list to keep in sync is a
 * second list to forget. CALL_ALLOWED_NUMBERS overrides it when the two
 * should differ.
 */
export function callAllowedNumbers() {
  const own = (process.env.CALL_ALLOWED_NUMBERS || '')
    .split(',')
    .map(normalizeNumber)
    .filter(Boolean);
  return own.length ? own : allowedNumbers();
}

/** Whether calls are switched on at all. Off unless explicitly enabled. */
export function isCallingEnabled() {
  return process.env.VOICE_CALLS === 'true';
}

/**
 * Who the line is for.
 *
 *   founder — the founder's own assistant, full company state, allowlisted
 *             callers only. The default, because it is the one that leaks
 *             if it is ever answered to the wrong person.
 *   support — a public support desk. Anyone may ring it, so the allowlist
 *             does not apply; the caps still do, because the caps are what
 *             stop a public number becoming a public bill.
 */
export function callMode() {
  return (process.env.CALL_MODE || '').trim().toLowerCase() === 'support' ? 'support' : 'founder';
}

/**
 * Whether this caller gets through.
 *
 * Fails closed on every uncertainty: calling disabled, no allowlist, a
 * withheld caller ID. A call from an unknown number is the case this exists
 * for, so it cannot be the case that slips.
 */
export function isAllowedCaller(from) {
  if (!isCallingEnabled()) return false;
  const allowed = callAllowedNumbers();
  if (!allowed.length) return false;
  const caller = normalizeNumber(from);
  if (!caller) return false; // withheld or malformed caller ID
  return allowed.includes(caller);
}

/** Hard ceiling on one call, in seconds. */
export function maxCallSeconds() {
  return numberFromEnv('CALL_MAX_SECONDS', 600); // ten minutes
}

/** Total call minutes allowed in a day. */
export function maxCallMinutesPerDay() {
  return numberFromEnv('CALL_MAX_MINUTES_PER_DAY', 60);
}

// Minutes spent today, in memory. Deliberately not persisted: a restart
// clearing it is the right failure. The cap exists to stop a runaway call
// loop, and a restart means no call is running.
let spentDay = '';
let spentMinutes = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** How much of today's call budget is left, in minutes. */
export function callMinutesRemaining() {
  if (spentDay !== today()) return maxCallMinutesPerDay();
  return Math.max(0, maxCallMinutesPerDay() - spentMinutes);
}

/** Records a finished call against today's budget. */
export function recordCallSeconds(seconds) {
  const day = today();
  if (spentDay !== day) {
    spentDay = day;
    spentMinutes = 0;
  }
  spentMinutes += Math.max(0, Number(seconds) || 0) / 60;
}

/**
 * Why this call cannot be taken, or null if it can.
 *
 * A string rather than a boolean because the caller hears it: "the company is
 * not taking calls" tells the founder which switch to flip, where a dead line
 * tells them nothing and looks like a bug.
 */
export function refuseCall(from) {
  if (!isCallingEnabled()) return 'Voice calls are switched off. Set VOICE_CALLS to true to take them.';
  // A support line is public by definition. The allowlist is the founder's
  // line's protection, not this one's; the budget below is.
  if (callMode() !== 'support' && !isAllowedCaller(from)) return 'This number is not on the call allowlist.';
  if (callMinutesRemaining() <= 0) {
    return `The daily call budget of ${maxCallMinutesPerDay()} minutes is spent. It resets tomorrow.`;
  }
  return null;
}

/** For the integration check and the founder: the calling setup in one line. */
export function describeCalling() {
  if (!isCallingEnabled()) return 'Voice calls are off. VOICE_CALLS=true turns them on.';
  const menu = describeLanguageMenu();
  if (callMode() === 'support') {
    const left = Math.round(callMinutesRemaining());
    return (
      `Voice calls are on as a public support desk — any caller gets through. ` +
      `Up to ${Math.round(maxCallSeconds() / 60)} minutes a call, ${left} of ${maxCallMinutesPerDay()} minutes left today.` +
      (menu ? ` ${menu}` : '')
    );
  }
  const allowed = callAllowedNumbers().length;
  if (!allowed) return 'Voice calls are on but no number is allowed to call — nobody gets through.';
  const left = Math.round(callMinutesRemaining());
  return (
    `Voice calls are on for ${allowed} number${allowed === 1 ? '' : 's'}. ` +
    `Up to ${Math.round(maxCallSeconds() / 60)} minutes a call, ${left} of ${maxCallMinutesPerDay()} minutes left today.`
  );
}

// Exported for tests, which must be able to start from a known budget.
export function __resetCallBudgetForTests() {
  spentDay = '';
  spentMinutes = 0;
}
