// This endpoint is public and what sits behind it can commit code and email
// real customers, so most of what's worth testing here is refusal.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  isWhatsAppConfigured,
  isAllowedSender,
  allowedNumbers,
  verifyWebhookChallenge,
  verifySignature,
  extractMessage,
  splitForWhatsApp,
  isDuplicate,
  __resetDedupForTests,
  unsupportedTypeReply,
  sendWhatsAppMessage,
} from '../channels/whatsapp.js';

const KEYS = [
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_ALLOWED_NUMBERS',
];
const saved = {};
let originalFetch;

before(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  global.fetch = originalFetch;
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  __resetDedupForTests();
  global.fetch = originalFetch;
});

function configure() {
  process.env.WHATSAPP_TOKEN = 'tok';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  process.env.WHATSAPP_VERIFY_TOKEN = 'verify-me';
  process.env.WHATSAPP_ALLOWED_NUMBERS = '+44 7700 900123';
}

function sign(body, secret = 'secret') {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('it stays unconfigured until every piece is present, allowlist included', () => {
  assert.equal(isWhatsAppConfigured(), false);
  process.env.WHATSAPP_TOKEN = 'tok';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '12345';
  process.env.WHATSAPP_APP_SECRET = 'secret';
  // Still false: an allowlist is not optional.
  assert.equal(isWhatsAppConfigured(), false);
  process.env.WHATSAPP_ALLOWED_NUMBERS = '+44 7700 900123';
  assert.equal(isWhatsAppConfigured(), true);
});

// The gate that decides whose messages reach a company that can deploy code.
test('with no allowlist configured, nobody is allowed — it fails closed', () => {
  assert.equal(isAllowedSender('447700900123'), false);
  process.env.WHATSAPP_ALLOWED_NUMBERS = '';
  assert.equal(isAllowedSender('447700900123'), false);
});

test('allowlist matching ignores formatting so the founder cannot lock themselves out', () => {
  process.env.WHATSAPP_ALLOWED_NUMBERS = '+44 7700 900123, (555) 010-9999';
  for (const form of ['447700900123', '+447700900123', '+44 7700 900123']) {
    assert.equal(isAllowedSender(form), true, `${form} should match`);
  }
  assert.equal(isAllowedSender('5550109999'), true);
  assert.equal(isAllowedSender('447700900124'), false, 'a different number must not match');
  assert.deepEqual(allowedNumbers(), ['447700900123', '5550109999']);
});

test('the setup handshake only echoes the challenge for the right token', () => {
  configure();
  assert.equal(
    verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' }),
    '42'
  );
  assert.equal(
    verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '42' }),
    null
  );
  assert.equal(verifyWebhookChallenge({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'verify-me' }), null);
});

test('a payload without a valid signature is refused', () => {
  configure();
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));

  assert.equal(verifySignature(body, sign(body)), true);
  assert.equal(verifySignature(body, sign(body, 'a-different-secret')), false);
  assert.equal(verifySignature(body, 'sha256=deadbeef'), false);
  assert.equal(verifySignature(body, undefined), false);
  assert.equal(verifySignature(body, ''), false);
  // Tampering with the body after signing must invalidate it.
  assert.equal(verifySignature(Buffer.from(JSON.stringify({ hello: 'mars' })), sign(body)), false);
});

test('signature checking is impossible without the app secret', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, sign(body)), false, 'no secret configured must not verify');
});

test('an inbound text message is pulled out of the nested payload', () => {
  const message = extractMessage({
    entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '447700900123', type: 'text', text: { body: 'what is our net?' } }] } }] }],
  });
  // mediaId is null for text: only voice notes arrive as an id to fetch.
  assert.deepEqual(message, {
    id: 'wamid.1',
    from: '447700900123',
    type: 'text',
    text: 'what is our net?',
    mediaId: null,
  });
});

// Delivery and read receipts arrive on the same webhook as real messages.
test('a status notification is not mistaken for a message', () => {
  assert.equal(extractMessage({ entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }] }), null);
  assert.equal(extractMessage({}), null);
  assert.equal(extractMessage(null), null);
});

// Meta retries a delivery it thinks failed. Running the turn twice would cost
// real money and could fire an action tool twice.
test('a retried delivery is recognised as a duplicate', () => {
  assert.equal(isDuplicate('wamid.1'), false);
  assert.equal(isDuplicate('wamid.1'), true);
  assert.equal(isDuplicate('wamid.2'), false);
});

test('a voice note gets an explanation rather than silence', () => {
  assert.match(unsupportedTypeReply('audio'), /voice notes/);
  assert.match(unsupportedTypeReply('audio'), /Send it as text/);
  assert.match(unsupportedTypeReply('image'), /only read text/);
});

// A synthesised team answer can run past WhatsApp's 4096-character limit,
// which would otherwise fail the send outright.
test('a long reply is split into parts rather than rejected', () => {
  const long = Array.from({ length: 300 }, (_, i) => `Line ${i} of the answer.`).join('\n');
  const parts = splitForWhatsApp(long);
  assert.ok(parts.length > 1, 'a long reply should split');
  for (const p of parts) assert.ok(p.length <= 4096, `part too long: ${p.length}`);
  assert.match(parts[0], /^\(1\/\d+\)/);
});

test('a short reply is sent as one message with no part marker', () => {
  assert.deepEqual(splitForWhatsApp('All good.'), ['All good.']);
  assert.deepEqual(splitForWhatsApp('   '), ['(no reply)']);
});

test('sending posts to the Graph API with the number normalised', async () => {
  configure();
  let sent;
  global.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body), auth: options.headers.Authorization };
    return { ok: true, json: async () => ({}) };
  };

  await sendWhatsAppMessage('+44 7700 900123', 'Net is $1,500.');
  assert.match(sent.url, /12345\/messages/);
  assert.equal(sent.auth, 'Bearer tok');
  assert.equal(sent.body.to, '447700900123');
  assert.equal(sent.body.text.body, 'Net is $1,500.');
});

test('a rejected send surfaces the reason rather than failing silently', async () => {
  configure();
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad token' });
  await assert.rejects(sendWhatsAppMessage('447700900123', 'hi'), /WhatsApp send failed \(401\)/);
});
