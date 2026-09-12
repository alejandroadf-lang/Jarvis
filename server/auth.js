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
  // Everything that isn't the API is the client bundle; the token lives in
  // the browser, so the page has to load before it can present one.
  if (!req.path.startsWith('/api/')) return next();

  if (matches(presentedToken(req), readSecret('APP_ACCESS_TOKEN'))) return next();

  return res.status(401).json({
    error: 'This app needs an access token.',
    hint: 'Send it as "Authorization: Bearer <token>" or the x-jarvis-token header.',
  });
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
