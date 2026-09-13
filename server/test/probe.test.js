// Checking whether the deployed thing actually answers.
//
// Two halves, and the second is the one with teeth.
//
// The feature half: run_checks proves the tests passed inside a GitHub runner.
// Nothing proved the service was up. Those fail independently, and "green CI,
// dead service" was invisible to a company whose only product is an HTTP API.
//
// The security half: an outbound GET with an agent-chosen URL is a
// server-side request forgery primitive. It could reach the platform's
// metadata service — which hands out credentials, over plain http, to anything
// that asks — or anything else inside the network this server happens to sit
// in. So the origin is founder-set and the agent passes only a path, and the
// tests below are mostly about that boundary holding under the inputs that
// look like paths and are not.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertProbeableUrl, probeEndpoint } from '../execute/probe.js';

const APPROVED = 'https://circadian-api.up.railway.app';

let originalFetch;

before(() => {
  originalFetch = global.fetch;
});

after(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  // Any test that reaches the real network is a broken test, so the default
  // stub fails loudly rather than quietly succeeding.
  global.fetch = async () => {
    throw new Error('a test tried to make a real request');
  };
});

test('a public https origin is accepted and normalised', () => {
  assert.equal(assertProbeableUrl(`${APPROVED}/health?x=1`), APPROVED);
  assert.equal(assertProbeableUrl(`${APPROVED}  `), APPROVED);
});

// Each of these is a way a URL reaches something that is not the product.
// 169.254.169.254 is the one that matters most: on most cloud platforms it
// serves instance credentials to any process that asks.
test('anything that is not a public https host is refused, with the reason', () => {
  const refused = [
    'http://circadian-api.up.railway.app',
    'https://localhost/health',
    'https://127.0.0.1/health',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/health',
    'https://metadata.google.internal/',
    'https://backend.internal/health',
    'https://api',
    'https://user:secret@circadian-api.up.railway.app',
    'circadian-api.up.railway.app',
    '',
  ];
  for (const url of refused) {
    assert.throws(() => assertProbeableUrl(url), Error, `${url} should not be probeable`);
  }
});

test('the refusal explains the specific problem, since the founder reads it on a phone', () => {
  assert.throws(() => assertProbeableUrl('http://x.com'), /https/);
  assert.throws(() => assertProbeableUrl('https://169.254.169.254'), /IP address/);
  assert.throws(() => assertProbeableUrl('https://api'), /no domain/);
  assert.throws(() => assertProbeableUrl('https://u:p@x.com'), /credentials/i);
});

// The whole point of the design: the agent supplies a path, and no path can
// move the request to another host.
test('a path cannot escape the approved origin', async () => {
  for (const path of ['//evil.com/', 'https://evil.com/', 'http://evil.com/', '/\\/evil.com']) {
    await assert.rejects(
      () => probeEndpoint({ origin: APPROVED, path }),
      /points outside|not a URL/,
      `"${path}" must not leave ${APPROVED}`
    );
  }
});

test('traversal resolves inside the origin rather than escaping it', async () => {
  let requested = '';
  global.fetch = async (url) => {
    requested = String(url);
    return { status: 200, headers: new Map(), text: async () => 'ok' };
  };

  await probeEndpoint({ origin: APPROVED, path: '../../../etc/passwd' });
  assert.ok(requested.startsWith(`${APPROVED}/`), `stayed on the origin: ${requested}`);
});

function response({ status, body = '', headers = {} }) {
  return async () => ({
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  });
}

test('a 2xx reports ok, with the body', async () => {
  global.fetch = response({ status: 200, body: '{"status":"healthy"}', headers: { 'content-type': 'application/json' } });

  const result = await probeEndpoint({ origin: APPROVED, path: '/health' });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.body, '{"status":"healthy"}');
  assert.equal(result.url, `${APPROVED}/health`);
});

// The distinction the whole tool turns on. A 500 and a dead host are both
// "it is broken" and they are broken in different places — one is deployed
// code, one is the deployment. Collapsing them sends an agent to read code
// over a missing environment variable.
test('a 500 is a successful probe with a bad result, not an unreachable service', async () => {
  global.fetch = response({ status: 500, body: 'KeyError: TZ' });

  const result = await probeEndpoint({ origin: APPROVED, path: '/v1/schedules' });
  assert.equal(result.status, 500);
  assert.equal(result.ok, false);
  assert.notEqual(result.unreachable, true, 'something answered — that is the finding');
  assert.match(result.body, /KeyError/);
});

test('nothing listening is reported as unreachable, distinctly', async () => {
  global.fetch = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' });
  };

  const result = await probeEndpoint({ origin: APPROVED, path: '/health' });
  assert.equal(result.unreachable, true);
  assert.equal(result.status, 0);
  assert.match(result.reason, /ENOTFOUND/);
});

test('a timeout is reported as no response rather than as a bad one', async () => {
  global.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });

  const result = await probeEndpoint({ origin: APPROVED, path: '/slow', timeoutMs: 1000 });
  assert.equal(result.unreachable, true);
  assert.match(result.reason, /no response within/);
});

// Following a redirect could leave the approved origin, and "this path 301s
// somewhere else" is usually the finding rather than a detail to follow past.
test('a redirect is reported, not followed', async () => {
  let passedRedirect;
  global.fetch = async (_url, options) => {
    passedRedirect = options.redirect;
    return { status: 301, headers: { get: (n) => (n.toLowerCase() === 'location' ? '/v2/health' : null) }, text: async () => '' };
  };

  const result = await probeEndpoint({ origin: APPROVED, path: '/health' });
  assert.equal(passedRedirect, 'manual');
  assert.equal(result.status, 301);
  assert.equal(result.location, '/v2/health');
  assert.equal(result.ok, false);
});

test('only GET is ever sent', async () => {
  let method;
  global.fetch = async (_url, options) => {
    method = options.method;
    return { status: 200, headers: { get: () => null }, text: async () => '' };
  };
  await probeEndpoint({ origin: APPROVED });
  assert.equal(method, 'GET');
});

test('a large body is truncated, so a health check cannot become a bandwidth bill', async () => {
  global.fetch = response({ status: 200, body: 'x'.repeat(50_000) });

  const result = await probeEndpoint({ origin: APPROVED, path: '/' });
  assert.ok(result.body.length < 5_000, `truncated, got ${result.body.length}`);
  assert.equal(result.truncated, true);
});
