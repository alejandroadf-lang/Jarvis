// Short-lived tokens for links the founder opens on their phone.
//
// The app authenticates with APP_ACCESS_TOKEN in an Authorization header,
// which works for the client bundle and not at all for "tap this link in
// WhatsApp": a browser following a link sends no custom headers.
//
// The obvious fix is `?token=...`, and this codebase's own api-authentication
// skill spends a paragraph on why not: a URL is logged by the web server, the
// proxy, the CDN, the browser history and every error tracker in between, so a
// correctly generated and correctly stored secret ends up in plaintext
// somewhere a support engineer can read. Writing that down and then doing it
// anyway would be worse than never writing it.
//
// So the token rides in the URL **fragment** (`/graph#t=...`). Fragments are
// never sent to the server — they exist only in the browser — so the token
// appears in no request line and no access log. The page reads it from
// location.hash and presents it as a normal Authorization header on its own
// API call.
//
// Two further properties, both from the same reasoning:
//
//   - It expires. A WhatsApp message is forwarded, screenshotted and backed
//     up; a link that grants access forever is a credential in a chat log.
//   - It is not APP_ACCESS_TOKEN. It is derived from it, so a leaked view link
//     cannot be replayed against the mutating API — it opens one read-only
//     view until it expires, and nothing else.

import crypto from 'node:crypto';
import { readSecret, hasSecret } from './env.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function viewTokenTtlMs() {
  const configured = Number(process.env.VIEW_TOKEN_TTL_MINUTES);
  if (Number.isFinite(configured) && configured > 0) return configured * 60 * 1000;
  return DEFAULT_TTL_MS;
}

// Derived rather than reused, so the signing key for view links is not the
// key that authorises halting the company.
function signingKey() {
  const base = readSecret('APP_ACCESS_TOKEN') || '';
  return crypto.createHmac('sha256', base).update('jarvis:view-token:v1').digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/**
 * A token good for one read-only view until it expires.
 * @param {{ttlMs?: number, now?: number}} [opts]
 */
export function mintViewToken({ ttlMs = viewTokenTtlMs(), now = Date.now() } = {}) {
  const expiresAt = now + ttlMs;
  const payload = String(expiresAt);
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/**
 * @returns {{valid: boolean, reason?: string, expiresAt?: number}}
 */
export function verifyViewToken(token, { now = Date.now() } = {}) {
  if (!hasSecret('APP_ACCESS_TOKEN')) {
    // Nothing is protected at all in this state, and pretending a view token
    // means something would be theatre. requireAccess already says so loudly.
    return { valid: true, reason: 'the app has no access token set, so nothing is protected' };
  }
  if (typeof token !== 'string' || !token.includes('.')) return { valid: false, reason: 'malformed' };

  const [encoded, signature] = token.split('.', 2);
  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  const expected = sign(payload);
  // Constant time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  if (signature.length !== expected.length) return { valid: false, reason: 'bad signature' };
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return { valid: false, reason: 'bad signature' };
  }

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt)) return { valid: false, reason: 'malformed' };
  if (now > expiresAt) return { valid: false, reason: 'expired' };

  return { valid: true, expiresAt };
}

/**
 * Where the founder should tap. RAILWAY_PUBLIC_DOMAIN is set by the platform;
 * PUBLIC_URL overrides it for anything else.
 */
export function publicBaseUrl() {
  const configured = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railway) return `https://${railway.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return '';
}

export function graphLink() {
  const base = publicBaseUrl();
  const token = mintViewToken();
  const path = `/graph#t=${token}`;
  return base ? `${base}${path}` : path;
}
