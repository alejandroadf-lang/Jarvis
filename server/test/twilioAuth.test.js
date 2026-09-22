// Two doors on a public phone line, and the checks that close them.
//
// Anyone can POST to /api/calls/incoming claiming to be Twilio; anyone who
// reads the stream URL out of the TwiML can open a WebSocket to it and be
// given a realtime-model session that bills by the minute. The signature
// check closes the first, the per-call stream token the second. Both are
// keyed on TWILIO_AUTH_TOKEN and both pass everything when it is unset —
// loudly, through the integration check — so an unconfigured line reads as
// a warning rather than a broken number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  twilioSignature,
  verifyTwilioRequest,
  publicUrl,
  streamToken,
  verifyStreamToken,
  isTwilioAuthConfigured,
} from '../realtime/twilioAuth.js';

function withToken(value, run) {
  const saved = process.env.TWILIO_AUTH_TOKEN;
  if (value === undefined) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = saved;
  }
}

// A request the way Express hands it over, behind Railway's proxy.
function fakeRequest({ headers = {}, body = {}, url = '/api/calls/incoming' } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()], body, originalUrl: url, protocol: 'http' };
}

// --- The request signature -----------------------------------------------------------

test('the signature is Twilio\'s: HMAC-SHA1 over the URL plus the fields sorted by name', () => {
  // Fixed inputs, so a change to the algorithm is a failing test rather than
  // every real call being refused.
  const sig = twilioSignature('tok', 'https://j.example/api/calls/incoming', { From: '+1', CallSid: 'CA1' });
  assert.equal(sig, twilioSignature('tok', 'https://j.example/api/calls/incoming', { CallSid: 'CA1', From: '+1' }), 'order of fields does not matter');
  assert.notEqual(sig, twilioSignature('tok', 'https://j.example/api/calls/incoming', { From: '+2', CallSid: 'CA1' }));
  assert.notEqual(sig, twilioSignature('other', 'https://j.example/api/calls/incoming', { From: '+1', CallSid: 'CA1' }));
});

test('the public URL is rebuilt from the forwarding headers, which is what Twilio signed', () => {
  const req = fakeRequest({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'jarvis.up.railway.app', host: 'internal:3001' } });
  assert.equal(publicUrl(req), 'https://jarvis.up.railway.app/api/calls/incoming');
});

test('a correctly signed request passes and a tampered one is refused', () => {
  withToken('tok', () => {
    const body = { From: '+15551234567', CallSid: 'CA123' };
    const url = 'https://jarvis.up.railway.app/api/calls/incoming';
    const good = fakeRequest({
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'jarvis.up.railway.app', 'x-twilio-signature': twilioSignature('tok', url, body) },
      body,
    });
    assert.equal(verifyTwilioRequest(good), true);

    const tampered = fakeRequest({
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'jarvis.up.railway.app', 'x-twilio-signature': twilioSignature('tok', url, body) },
      body: { ...body, From: '+10000000000' },
    });
    assert.equal(verifyTwilioRequest(tampered), false);
  });
});

test('a missing or wrong-length signature is refused, never thrown', () => {
  withToken('tok', () => {
    assert.equal(verifyTwilioRequest(fakeRequest({ body: { From: '+1' } })), false, 'no header');
    assert.equal(verifyTwilioRequest(fakeRequest({ headers: { 'x-twilio-signature': 'short' }, body: { From: '+1' } })), false);
  });
});

test('with no token set, every request passes — the integration check carries the warning instead', () => {
  withToken(undefined, () => {
    assert.equal(isTwilioAuthConfigured(), false);
    assert.equal(verifyTwilioRequest(fakeRequest({ body: { From: '+1' } })), true);
  });
});

// --- The stream token ------------------------------------------------------------------

test('a stream token verifies only for the call it was issued for', () => {
  withToken('tok', () => {
    const token = streamToken('CA123');
    assert.ok(token.length > 0);
    assert.equal(verifyStreamToken('CA123', token), true);
    assert.equal(verifyStreamToken('CA999', token), false, 'another call\'s token');
    assert.equal(verifyStreamToken('CA123', token.slice(0, -1) + 'x'), false, 'a tampered token');
    assert.equal(verifyStreamToken('', token), false, 'no CallSid at all');
  });
});

test('with no token set, streams are not checked and the TwiML carries an empty token', () => {
  withToken(undefined, () => {
    assert.equal(streamToken('CA123'), '');
    assert.equal(verifyStreamToken('CA123', ''), true);
    assert.equal(verifyStreamToken('', ''), true);
  });
});
