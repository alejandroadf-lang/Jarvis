// The help desk, for a voice bot that is not ours.
//
// The founder wants a second, separate phone number answered by the IONOS AI
// Receptionist — IONOS's own bot, on IONOS's own line — so the two can be
// tried side by side. That bot cannot run our realtime session or our tools;
// what it can do, on its higher plans, is call an external REST API during a
// call. So the desk's two abilities are exposed as plain HTTP: look up a
// procedure, open a ticket. Whichever bot is on the line, the caller gets the
// same procedures and the same ticket in the same inbox.
//
// Written without having read IONOS's side. Their documentation is not
// reachable from the environment this was built in, so the request shape is
// deliberately forgiving: JSON or form-encoded, and the fields under the
// names a no-code integration is likely to use. The response carries a
// `spoken` line a bot can read out verbatim as well as the structured data,
// because a bot that can only speak a string should still be able to help.
//
// Keyed on DESK_API_KEY, and closed without it. This surface opens tickets
// that email the founder; unlike the Twilio line there is no other guard, so
// an unset key means refused, not open.

import { readSecret, hasSecret } from '../env.js';
import { safeEqual } from './twilioAuth.js';
import { findIssues, openTicket, describeSupportDesk, supportDeskName } from './supportDesk.js';

export function isDeskApiConfigured() {
  return hasSecret('DESK_API_KEY');
}

/**
 * Whether the request carries the desk key.
 *
 * Three places, because integrators differ in what they can set: a bearer
 * header, a custom header, or a query string — the last for bots that can
 * only be given a URL. All three compare in constant time.
 */
export function verifyDeskKey(req) {
  if (!isDeskApiConfigured()) return false;
  const expected = readSecret('DESK_API_KEY');
  const header = String(req.get?.('authorization') || '');
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  const candidates = [
    bearer ? bearer[1].trim() : '',
    String(req.get?.('x-desk-key') || '').trim(),
    String(req.query?.key || '').trim(),
  ].filter(Boolean);
  return candidates.some((c) => safeEqual(expected, c));
}

// The first non-empty value among the names an integration might use.
function pick(body, ...names) {
  for (const name of names) {
    const value = body?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

/**
 * Procedures for a caller's problem.
 *
 * @returns {{found: number, spoken: string, matches: Array<{title: string, symptoms: string, steps: string}>}}
 */
export function deskLookup(body = {}) {
  const problem = pick(body, 'problem', 'question', 'query', 'text', 'message', 'input', 'utterance');
  if (!problem) {
    return { found: 0, spoken: 'Could you tell me what the problem is?', matches: [], error: 'No problem was given.' };
  }
  const matches = findIssues(problem).map(({ issue }) => ({ title: issue.title, symptoms: issue.symptoms, steps: issue.steps }));
  if (!matches.length) {
    return {
      found: 0,
      spoken: "I don't have a procedure for that one on record. I can log it so that a person comes back to you — shall I?",
      matches: [],
    };
  }
  return { found: matches.length, spoken: matches[0].steps, matches };
}

/**
 * Opens a ticket. The email to the founder is sent inside openTicket.
 *
 * @returns {Promise<{ticketId: number, spoken: string}>}
 */
export async function deskTicket(body = {}, { from = '' } = {}) {
  const summary = pick(body, 'summary', 'problem', 'description', 'text', 'message', 'issue');
  if (!summary) throw new Error('A ticket needs a summary of the problem.');
  const ticket = await openTicket({
    summary,
    callerName: pick(body, 'callerName', 'caller_name', 'name', 'caller'),
    contact: pick(body, 'contact', 'phone', 'email', 'number', 'callback', 'phone_number'),
    language: pick(body, 'language', 'lang', 'locale'),
    from: from || pick(body, 'from', 'caller_number', 'callerNumber'),
  });
  return {
    ticketId: ticket.id,
    spoken: `I've logged this as ticket number ${ticket.id}. Someone will come back to you${ticket.contact ? ` at ${ticket.contact}` : ''}.`,
  };
}

/** For the founder and the integration check. */
export function describeDeskApi() {
  if (!isDeskApiConfigured()) {
    return 'Not set — no outside voice bot can reach the desk. Set DESK_API_KEY to wire one (the IONOS AI Receptionist, or any IVR).';
  }
  return `An outside voice bot can reach ${supportDeskName()} at /api/desk/lookup and /api/desk/ticket with the desk key. ${describeSupportDesk()}`;
}
