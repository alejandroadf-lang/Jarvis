// Numbers the founder has invited to try the advisor.
//
// This exists so a demo needs one WhatsApp number instead of two.
//
// The company's own line is allowlisted (WHATSAPP_ALLOWED_NUMBERS) because
// what sits behind it can commit code and email customers. That allowlist is
// exactly right and must not be widened to show someone a demo — adding a
// prospect to it would hand a stranger the Engineering Lead.
//
// So a guest list is a second, much narrower door into the same number. A
// guest's message reaches the travel advisor and nothing else: not the
// company turn, not the founder commands, not the daily plan. The advisor has
// two read-only tools and no route back to the org chart (see advisor.js), so
// the worst a guest can do is ask about Amadeus and spend a little of the
// daily cap, which the rate limit already bounds.
//
// The asymmetry is the point and is enforced by routing, not by a prompt: the
// webhook checks this list before the founder allowlist and, on a match, has
// exactly one thing it is allowed to call.

import { readJson, writeJson } from '../store.js';

const FILE = 'travelVoiceGuests.json';

// Digits only, matching channels/whatsapp.js, so "+34 600 111 222" and
// "34600111222" are the same guest. A formatting mismatch here means an
// invited prospect messages the number and is silently ignored, which is the
// worst possible moment for it.
function normalize(value) {
  return String(value || '').replace(/\D/g, '');
}

function load() {
  const data = readJson(FILE, { guests: [] });
  if (!Array.isArray(data.guests)) data.guests = [];
  return data;
}

/** Whether this number was invited to talk to the advisor. */
export function isGuest(number) {
  const digits = normalize(number);
  if (!digits) return false;
  return load().guests.some((g) => g.number === digits);
}

export function listGuests() {
  return load().guests;
}

export function addGuest(number, { language = null, note = '' } = {}) {
  const digits = normalize(number);
  if (!digits) throw new Error('A phone number is required');
  const data = load();
  const existing = data.guests.find((g) => g.number === digits);
  if (existing) {
    if (language) existing.language = language;
    if (note) existing.note = note;
  } else {
    data.guests.push({ number: digits, language, note, addedAt: new Date().toISOString() });
  }
  writeJson(FILE, data);
  return digits;
}

export function removeGuest(number) {
  const digits = normalize(number);
  const data = load();
  const before = data.guests.length;
  data.guests = data.guests.filter((g) => g.number !== digits);
  writeJson(FILE, data);
  return data.guests.length < before;
}

export function clearGuests() {
  writeJson(FILE, { guests: [] });
}

export function __resetGuestsForTests() {
  clearGuests();
}
