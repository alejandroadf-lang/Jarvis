// Proving a call came from Twilio, and that a media stream belongs to a call
// we answered.
//
// A private founder line is protected by its allowlist. A public support
// line has no allowlist by design, which leaves two doors: anyone can POST to
// /api/calls/incoming pretending to be Twilio, and anyone who reads the
// stream URL out of the TwiML can open a WebSocket to it and be given a
// realtime-model session that bills by the minute. The daily cap bounds the
// damage; these two checks stop it happening at all.
//
//   1. Request signature. Twilio signs every webhook with X-Twilio-Signature:
//      base64(HMAC-SHA1(auth token, full URL + the POST fields sorted by name
//      and concatenated as name+value)). Same shape as the WhatsApp webhook's
//      Meta signature check, and for the same reason.
//   2. Stream token. The TwiML we return carries a per-call token —
//      HMAC(secret, CallSid) — as a <Parameter>. Twilio hands it back in the
//      stream's `start` event. A stream that does not carry the right token
//      for its CallSid was not opened in answer to our TwiML and gets no
//      session.
//
// Both are keyed on TWILIO_AUTH_TOKEN. With it unset they pass everything,
// loudly: the integration check says so, because a public line that only the
// caps protect is a decision the founder should be making on purpose.

import crypto from 'node:crypto';
import { readSecret, hasSecret } from '../env.js';

export function isTwilioAuthConfigured() {
  return hasSecret('TWILIO_AUTH_TOKEN');
}

/**
 * The URL Twilio signed, reconstructed behind a proxy.
 *
 * Twilio signs the public URL it called. Behind Railway's proxy the request
 * arrives as http:// on an internal host, so the public scheme and host are
 * taken from the forwarding headers — the same headers answerCallTwiml uses
 * to tell Twilio where the stream lives. A mismatch here fails every
 * signature, so this is the first place to look if real calls are refused.
 */
export function publicUrl(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return `${proto}://${host}${req.originalUrl || req.url || ''}`;
}

/** Twilio's signature for a URL and its POST fields. Exported for tests. */
export function twilioSignature(authToken, url, params = {}) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + String(params[key]), url);
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

/**
 * Whether this request really came from Twilio.
 *
 * True when the token is unset — see the module note — so an unconfigured
 * line still works, and the integration check carries the warning instead
 * of a silent refusal that reads as a broken number.
 */
export function verifyTwilioRequest(req) {
  if (!isTwilioAuthConfigured()) return true;
  const expected = twilioSignature(readSecret('TWILIO_AUTH_TOKEN'), publicUrl(req), req.body || {});
  const presented = String(req.get('x-twilio-signature') || '');
  return safeEqual(expected, presented);
}

/** The per-call token placed in the TwiML and expected back on the stream. */
export function streamToken(callSid) {
  if (!isTwilioAuthConfigured()) return '';
  return crypto.createHmac('sha256', readSecret('TWILIO_AUTH_TOKEN')).update(String(callSid || '')).digest('hex');
}

/** Whether a stream's start event carries the token we issued for its call. */
export function verifyStreamToken(callSid, presented) {
  if (!isTwilioAuthConfigured()) return true;
  if (!callSid) return false;
  return safeEqual(streamToken(callSid), String(presented || ''));
}

// Constant-time, and length-safe: timingSafeEqual throws on different
// lengths, which would turn a wrong signature into a 500. Exported because
// the desk API compares its own key the same way.
export function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
