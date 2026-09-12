// Eighteen mutating endpoints and no authentication: anyone with the URL
// could disable the kill switch, grant a venture deployment scope, read the
// WhatsApp log, or spend the Anthropic budget. The scope model rested on a
// founder the system had no way to identify, which made every guardrail
// conditional on nobody finding the address.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireAccess, isAccessProtected, accessStatus } from '../auth.js';

let saved;

before(() => { saved = process.env.APP_ACCESS_TOKEN; });
after(() => {
  if (saved === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = saved;
});
beforeEach(() => { process.env.APP_ACCESS_TOKEN = 'the-real-token'; });

// Minimal stand-ins for what the middleware actually touches.
function request({ path = '/api/ventures', authorization, jarvisToken } = {}) {
  const headers = {};
  if (authorization) headers.authorization = authorization;
  if (jarvisToken) headers['x-jarvis-token'] = jarvisToken;
  return { path, get: (name) => headers[name.toLowerCase()] };
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function run(req) {
  const res = response();
  let passed = false;
  requireAccess(req, res, () => { passed = true; });
  return { passed, res };
}

test('a request with no token is refused', () => {
  const { passed, res } = run(request());
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.hint, /Authorization: Bearer/);
});

test('the right token gets through', () => {
  assert.equal(run(request({ authorization: 'Bearer the-real-token' })).passed, true);
  assert.equal(run(request({ jarvisToken: 'the-real-token' })).passed, true);
});

test('a wrong token is refused, however close', () => {
  assert.equal(run(request({ authorization: 'Bearer the-real-toke' })).passed, false);
  assert.equal(run(request({ authorization: 'Bearer the-real-tokeN' })).passed, false);
  assert.equal(run(request({ authorization: 'Bearer ' })).passed, false);
});

test('the healthcheck stays open — locking it restarts the service in a loop', () => {
  // A denial of service you perform on yourself.
  assert.equal(run(request({ path: '/api/health' })).passed, true);
});

test('the WhatsApp webhook stays open, because it authenticates better', () => {
  // Meta cannot send a bearer token. It signs an HMAC over the raw body and
  // the sender is allowlisted — stronger than a shared secret.
  assert.equal(run(request({ path: '/api/whatsapp/webhook' })).passed, true);
});

test('the privacy policy stays open — Meta fetches it, and a policy behind a password is not one', () => {
  assert.equal(run(request({ path: '/privacy' })).passed, true);
});

test('the client bundle loads, since the token lives in the browser', () => {
  // The page has to render before it can present anything.
  assert.equal(run(request({ path: '/' })).passed, true);
  assert.equal(run(request({ path: '/assets/index.js' })).passed, true);
});

test('every other API path is protected, including ones not written yet', () => {
  for (const path of ['/api/kill-switch/resume', '/api/plan/approve', '/api/whatsapp/recent', '/api/something-new']) {
    assert.equal(run(request({ path })).passed, false, `${path} must be protected`);
  }
});

test('with no token configured everything passes, and the status says so', () => {
  // Failing closed would lock the founder out of their own running app on the
  // next deploy, from a phone, with no way to set a header. So it stays open
  // and is loud about it rather than quiet either way.
  delete process.env.APP_ACCESS_TOKEN;

  assert.equal(isAccessProtected(), false);
  assert.equal(run(request({ path: '/api/kill-switch/resume' })).passed, true);

  const status = accessStatus();
  assert.equal(status.ok, false);
  assert.match(status.detail, /Anyone with this URL/);
});

test('a whitespace-only token is not a token', () => {
  process.env.APP_ACCESS_TOKEN = '   ';
  assert.equal(isAccessProtected(), false, 'a blank value must not read as protection');
});

test('once configured, the status reports the app as locked', () => {
  const status = accessStatus();
  assert.equal(status.ok, true);
  assert.match(status.detail, /requires an access token/);
});
