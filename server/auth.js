// Who is allowed to drive this company.
//
// Until now: anybody with the URL. Eighteen mutating endpoints and no
// authentication, so a stranger could disable the kill switch, grant a
// venture deployment scope, read the WhatsApp log, or spend the Anthropic
// budget. The scope model rests on a founder the system had no way to
// identify, which made every guardrail conditional on nobody finding the
// address.
//
// A single shared secret rather than accounts and passwords, because there is
// exactly one user and inventing a user table would be pretending otherwise.
//
// Three things stay public, each for a reason that is not convenience:
//
//   /api/health          — Railway's healthcheck. Locking it restarts the
//                          service in a loop, which is a denial of service
//                          you perform on yourself.
//   /api/whatsapp/webhook — Meta calls it and cannot send a bearer token. It
//                          has stronger authentication than this: an HMAC
//                          over the raw body, plus a sender allowlist.
//   /privacy             — Meta fetches it to publish the app, and a privacy
//                          policy behind a password is not a privacy policy.

import { readSecret, hasSecret } from './env.js';

const PUBLIC_PATHS = new Set(['/api/health', '/api/whatsapp/webhook', '/privacy']);

// Not public — these check their own credentials and need the middleware out of
// the way to do it. /api/graph accepts the app token *or* a short-lived view
// token, because a browser following a link from WhatsApp cannot send a custom
// header and the founder reads this on a phone (see viewToken.js).
// /api/payments/webhook is called by Stripe, which cannot send the app token
// and instead signs the raw body with a secret only it and this server hold
// (see payments.js) — stronger than the bearer check, not weaker.
//
// Kept as a separate set from PUBLIC_PATHS rather than folded into it: a reader
// scanning for what is unauthenticated must not find a path here that is in
// fact authenticated by other means, and vice versa.
//
// /api/desk/* is called by an outside voice bot — the IONOS AI Receptionist on
// its own number, or any IVR — with DESK_API_KEY, a credential that can look
// up a procedure and open a ticket and do nothing else (see realtime/deskApi.js).
// Same reasoning as the usage-ingest key below: handing a third party the app
// token would mean their bot could disable the kill switch.
//
// /api/calls/incoming is Twilio asking what to do with a call. Twilio cannot
// send the app token either; it signs the request with TWILIO_AUTH_TOKEN and
// the handler checks that (see realtime/twilioAuth.js). This line was missing
// for the whole time the bridge existed: every test exercised the handler
// directly, so nothing ever showed that on a deployment with an app token the
// middleware answered 401 before the TwiML was built. Same door as the desk
// paths above, one row down. /api/calls/language is the keypad choice from
// the language menu, posted by Twilio the same way and signed the same way.
const SELF_AUTHENTICATED_PATHS = new Set([
  '/api/graph',
  '/api/payments/webhook',
  '/api/calls/incoming',
  '/api/calls/language',
  '/api/desk/ping',
  '/api/desk/lookup',
  '/api/desk/ticket',
]);

// Usage ingest is the first endpoint a machine outside this company calls.
// It carries a per-venture key rather than the app token, and the distinction
// is the whole point: a venture's deployed code holds a credential that can
// increment that venture's counters and do nothing else. Handing it the app
// token would mean a compromised product could disable the kill switch.
//
// Matched by prefix rather than exact path because the venture id is in it.
const SELF_AUTHENTICATED_PREFIXES = ['/api/ventures/', '/api/usage/'];

function isUsageIngest(path) {
  return SELF_AUTHENTICATED_PREFIXES.some((prefix) => path.startsWith(prefix)) && path.endsWith('/usage/report');
}

export function isAccessProtected() {
  return hasSecret('APP_ACCESS_TOKEN');
}

function presentedToken(req) {
  const header = req.get('authorization') || '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return (req.get('x-jarvis-token') || '').trim();
}

// Compared in constant time. The difference is small at this scale, but a
// token check that returns early on the first wrong character is the kind of
// thing a security review flags and is trivial to just not do.
function matches(presented, expected) {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Express middleware. With no APP_ACCESS_TOKEN set this passes everything
 * through, which is deliberate and uncomfortable: failing closed would lock
 * the founder out of their own running app on the next deploy, from a phone,
 * with no way to set a header. So it stays open and says so — loudly at boot,
 * and red in the Integrations panel — rather than quietly either way.
 */
export function requireAccess(req, res, next) {
  if (!isAccessProtected()) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (SELF_AUTHENTICATED_PATHS.has(req.path)) return next();
  // Checks its own per-venture key inside the handler. The app token is
  // accepted there too, so the founder can test the endpoint from the panel.
  if (isUsageIngest(req.path)) return next();
  // Everything that isn't the API is the client bundle; the token lives in
  // the browser, so the page has to load before it can present one.
  if (!req.path.startsWith('/api/')) return next();

  if (matches(presentedToken(req), readSecret('APP_ACCESS_TOKEN'))) return next();

  return res.status(401).json({
    error: 'This app needs an access token.',
    hint: 'Send it as "Authorization: Bearer <token>" or the x-jarvis-token header.',
  });
}

/** Whether this request carries the full app token. */
export function hasAppToken(req) {
  if (!isAccessProtected()) return true;
  return matches(presentedToken(req), readSecret('APP_ACCESS_TOKEN'));
}

export function accessStatus() {
  return isAccessProtected()
    ? {
        configured: true,
        ok: true,
        detail: 'The API requires an access token. The WhatsApp webhook and healthcheck stay open by necessity.',
      }
    : {
        configured: false,
        ok: false,
        detail:
          'Anyone with this URL can halt or resume real actions, grant deployment scopes and read your messages. ' +
          'Set APP_ACCESS_TOKEN to close it.',
      };
}

export function warnIfUnprotected() {
  if (!isAccessProtected()) {
    console.warn(
      '⚠ No APP_ACCESS_TOKEN set: every API endpoint is open to anyone with this URL, ' +
        'including the kill switch and deployment scopes.'
    );
  }
}
