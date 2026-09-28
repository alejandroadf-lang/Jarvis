// What commerce.test.js does not already pin about taking money: the months
// after the first (a subscription renews through invoice.paid, not a
// checkout), a signing secret mid-rotation (Stripe sends one v1 per active
// secret), and the unit conversion on the way out. That last one is the bug
// the module's own comment names: a tool that takes cents is handed 149 and
// charges €1.49.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

let tmpDir;
let payments;
let savedEnv;
let originalFetch;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-payments-'));
  savedEnv = { ...process.env };
  originalFetch = global.fetch;
  process.env.JARVIS_DATA_DIR = tmpDir;
  payments = await import('../payments.js');
});

after(() => {
  process.env = savedEnv;
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_new';
  process.env.PUBLIC_URL = 'https://jarvis.example.com/';
  process.env.COMPANY_CONTACT_EMAIL = 'help@acme.example';
  global.fetch = originalFetch;
});

test('a subscription\'s later months are booked from invoice.paid, once, as monthly', () => {
  const event = {
    id: 'evt_inv_1',
    type: 'invoice.paid',
    data: { object: { id: 'in_1', amount_paid: 14900, currency: 'usd', customer_email: 'ada@acme.com',
      subscription_details: { metadata: { ventureId: 'v_9', agentId: 'sales_commercial_manager' } } } },
  };
  const first = payments.interpretEvent(event);
  assert.deepEqual(first.paid, {
    amount: 149, currency: 'USD', customerEmail: 'ada@acme.com', ventureId: 'v_9',
    agentId: 'sales_commercial_manager', kind: 'monthly', reference: 'in_1',
  });
  assert.equal(payments.interpretEvent(event).duplicate, true);
});

test('during a secret rotation, a delivery signed with either secret is accepted', () => {
  const body = '{"id":"evt_rot"}';
  const t = Math.floor(Date.now() / 1000);
  const v1 = (secret) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  // Stripe sends one v1 per active secret; this server knows only the new one.
  const header = `t=${t},v1=${v1('whsec_old')},v1=${v1('whsec_new')}`;
  assert.equal(payments.verifyStripeSignature(Buffer.from(body), header), true);
  assert.equal(payments.verifyStripeSignature(Buffer.from(body), `t=${t},v1=${v1('whsec_old')}`), false);
});

test('a checkout link charges the amount asked, in minor units, and remembers who made it', async () => {
  let sentBody = '';
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(init.headers.Authorization, 'Bearer sk_test_x');
    sentBody = init.body;
    return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' }), { status: 200 });
  };
  const venture = { id: 'v_7', title: 'Acme Audit' };
  const out = await payments.createCheckoutLink({ venture, amount: '149', currency: 'EUR', kind: 'monthly', agentId: 'sales_commercial_manager' });

  const form = new URLSearchParams(sentBody);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '14900', '149 means €149.00, not €1.49');
  assert.equal(form.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(form.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(form.get('mode'), 'subscription');
  assert.equal(form.get('metadata[ventureId]'), 'v_7');
  assert.equal(form.get('metadata[agentId]'), 'sales_commercial_manager');
  assert.equal(form.get('success_url'), 'https://jarvis.example.com/paid?venture=v_7', 'no double slash from a trailing one');
  // The renewal terms sit beside the pay button, where the renewal law wants them.
  const terms = form.get('custom_text[submit][message]');
  assert.match(terms, /EUR 149\.00 today and again every month until you cancel/);
  assert.match(terms, /help@acme\.example/);
  assert.equal(form.get('subscription_data[metadata][ventureId]'), 'v_7', 'renewals stay tied to the venture');
  assert.deepEqual(out, { url: 'https://checkout.stripe.com/c/cs_test_1', sessionId: 'cs_test_1', amount: 149, currency: 'eur', kind: 'monthly' });
  assert.equal(payments.listPaymentLinks('v_7')[0].agentId, 'sales_commercial_manager');
});

test('a zero, negative or non-numeric amount is refused before Stripe is called', async () => {
  global.fetch = async () => { throw new Error('Stripe must not be called'); };
  for (const amount of [0, -5, 'lots', undefined]) {
    await assert.rejects(payments.createCheckoutLink({ venture: { id: 'v', title: 't' }, amount }), /positive number in major units/);
  }
});

test('without both secrets, no link is made', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  await assert.rejects(payments.createCheckoutLink({ venture: { id: 'v', title: 't' }, amount: 10 }), /STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/);
});
