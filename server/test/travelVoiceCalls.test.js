// The calling API's signalling half. Pinned: a business may only ring a
// number that said yes, and that permission expires; without a media
// bridge an incoming call is declined and explained rather than left to
// ring; with one it is answered. And the webhook shapes — a call event is
// not a message, and a permission reply is a message.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let calls;
let whatsapp;
let originalFetch;
const saved = {};
const KEYS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-calls-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  calls = await import('../travelVoice/calls.js');
  whatsapp = await import('../channels/whatsapp.js');
});

after(() => {
  global.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.__resetCallsForTests();
  process.env.WHATSAPP_TOKEN = 'wa-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '111';
  global.fetch = originalFetch;
});

function callWebhook(call, metadata = { phone_number_id: '222' }) {
  return { entry: [{ changes: [{ field: 'calls', value: { metadata, calls: [call] } }] }] };
}

function messageWebhook(message, metadata = { phone_number_id: '222' }) {
  return { entry: [{ changes: [{ field: 'messages', value: { metadata, messages: [message] } }] }] };
}

test('a call event is extracted with its SDP and number; a message is not a call event', () => {
  const event = calls.extractCallEvent(
    callWebhook({ id: 'wacid.1', from: '34600111222', to: '222', event: 'connect', direction: 'USER_INITIATED', timestamp: '1', session: { sdp_type: 'offer', sdp: 'v=0...' } })
  );
  assert.equal(event.id, 'wacid.1');
  assert.equal(event.event, 'connect');
  assert.equal(event.direction, 'USER_INITIATED');
  assert.equal(event.sdp, 'v=0...');
  assert.equal(event.phoneNumberId, '222');

  assert.equal(calls.extractCallEvent(messageWebhook({ id: 'wamid.1', from: '1', type: 'text', text: { body: 'hi' } })), null);
  assert.equal(calls.extractCallEvent({}), null);
});

test('a message carries the business number it arrived on, and a permission reply is surfaced', () => {
  const plain = whatsapp.extractMessage(messageWebhook({ id: 'w1', from: '1', type: 'text', text: { body: 'hi' } }));
  assert.equal(plain.phoneNumberId, '222');
  assert.equal(plain.callPermission, null);

  const reply = whatsapp.extractMessage(
    messageWebhook({
      id: 'w2',
      from: '34600111222',
      type: 'interactive',
      interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', expiration_timestamp: 1_900_000_000, is_permanent: false } },
    })
  );
  assert.deepEqual(reply.callPermission, { response: 'accept', expiresAt: 1_900_000_000, permanent: false });
});

test('permission is remembered, expires, and a rejection is not a permission', () => {
  assert.equal(calls.hasCallPermission('+34 600 111 222'), false, 'nothing recorded yet');

  calls.recordCallPermission('34600111222', { response: 'accept', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(calls.hasCallPermission('+34 600 111 222'), true, 'formatting is ignored');

  calls.recordCallPermission('34600111222', { response: 'accept', expiresAt: Math.floor(Date.now() / 1000) - 10 });
  assert.equal(calls.hasCallPermission('34600111222'), false, 'expired');

  calls.recordCallPermission('34600111222', { response: 'accept', expiresAt: 1, permanent: true });
  assert.equal(calls.hasCallPermission('34600111222'), true, 'a permanent grant ignores the timestamp');

  calls.recordCallPermission('34600111222', { response: 'reject' });
  assert.equal(calls.hasCallPermission('34600111222'), false);
});

test('the permission request is an interactive message sent from the advisor’s number', async () => {
  let seen;
  global.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.x' }] }) };
  };
  await calls.requestCallPermission('+34 600 111 222', { phoneNumberId: '222' });
  assert.match(seen.url, /\/222\/messages$/);
  assert.equal(seen.body.to, '34600111222');
  assert.equal(seen.body.type, 'interactive');
  assert.equal(seen.body.interactive.type, 'call_permission_request');
});

test('starting a call refuses without permission, and without a media bridge', async () => {
  await assert.rejects(() => calls.startCall('34600111222', { phoneNumberId: '222' }), /not granted call permission/);

  calls.recordCallPermission('34600111222', { response: 'accept', permanent: true });
  await assert.rejects(() => calls.startCall('34600111222', { phoneNumberId: '222' }), /No media bridge/);
});

test('with permission and a bridge, a call is placed with the bridge’s offer', async () => {
  calls.recordCallPermission('34600111222', { response: 'accept', permanent: true });
  calls.setMediaBridge({
    createOffer: async () => 'v=0 offer',
    acceptAnswer: async () => {},
    answerOffer: async () => 'v=0 answer',
    close: async () => {},
  });
  let seen;
  global.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ calls: [{ id: 'wacid.9' }] }) };
  };

  const { callId } = await calls.startCall('34600111222', { phoneNumberId: '222' });
  assert.equal(callId, 'wacid.9');
  assert.match(seen.url, /\/222\/calls$/);
  assert.equal(seen.body.action, 'connect');
  assert.deepEqual(seen.body.session, { sdp_type: 'offer', sdp: 'v=0 offer' });
  assert.equal(calls.recentCallEvents()[0].kind, 'call_started');
});

test('without a bridge an incoming call is rejected and the caller is told', async () => {
  const sent = [];
  global.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({}) };
  };
  let declined = null;
  const event = calls.extractCallEvent(
    callWebhook({ id: 'wacid.2', from: '34600111222', event: 'connect', direction: 'USER_INITIATED', session: { sdp_type: 'offer', sdp: 'v=0' } })
  );

  const outcome = await calls.handleCallEvent(event, { phoneNumberId: '222', onDeclined: async (e) => (declined = e) });

  assert.equal(outcome.action, 'declined_no_bridge');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, { messaging_product: 'whatsapp', call_id: 'wacid.2', action: 'reject' });
  assert.equal(declined.from, '34600111222', 'the caller gets an explanation');
});

test('with a bridge an incoming call is answered with the bridge’s SDP answer', async () => {
  const closed = [];
  calls.setMediaBridge({
    createOffer: async () => 'offer',
    acceptAnswer: async () => {},
    answerOffer: async (callId, sdp) => {
      assert.equal(sdp, 'v=0 their offer');
      return 'v=0 our answer';
    },
    close: async (callId) => closed.push(callId),
  });
  const sent = [];
  global.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({}) };
  };

  const connect = calls.extractCallEvent(
    callWebhook({ id: 'wacid.3', from: '1', event: 'connect', direction: 'USER_INITIATED', session: { sdp_type: 'offer', sdp: 'v=0 their offer' } })
  );
  const accepted = await calls.handleCallEvent(connect, { phoneNumberId: '222' });
  assert.equal(accepted.action, 'accepted');
  assert.equal(sent[0].action, 'accept');
  assert.deepEqual(sent[0].session, { sdp_type: 'answer', sdp: 'v=0 our answer' });

  const terminate = calls.extractCallEvent(callWebhook({ id: 'wacid.3', from: '1', event: 'terminate' }));
  const closedOutcome = await calls.handleCallEvent(terminate, { phoneNumberId: '222' });
  assert.equal(closedOutcome.action, 'closed');
  assert.deepEqual(closed, ['wacid.3']);
});

test('a refused calls API call names the action and Meta’s reason', async () => {
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Calling is not enabled on this number' } }) });
  await assert.rejects(() => calls.rejectCall('wacid.4', { phoneNumberId: '222' }), /refused reject \(400\): Calling is not enabled/);
});
