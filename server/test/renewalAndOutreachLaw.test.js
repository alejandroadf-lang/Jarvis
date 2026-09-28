// The rules that carry a fine per message or per charge, pinned where they
// live in code:
//
// - CAN-SPAM: a commercial email names its sender, says it is commercial,
//   carries a postal address and a working opt-out. Without the address
//   nothing is sent.
// - California's automatic renewal law: a monthly plan states its terms
//   beside the pay button, the customer gets them again with a way to
//   cancel, and cancelling online is one button with no login.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let savedEnv;
let originalFetch;
let payments;
let billing;
let outreach;
let email;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-law-'));
  savedEnv = { ...process.env };
  originalFetch = global.fetch;
  process.env.JARVIS_DATA_DIR = tmpDir;
  payments = await import('../payments.js');
  billing = await import('../billingCancel.js');
  outreach = await import('../outreachCompliance.js');
  email = await import('../email.js');
});

after(() => {
  process.env = savedEnv;
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env = { ...savedEnv, JARVIS_DATA_DIR: tmpDir, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_1', PUBLIC_URL: 'https://jarvis.example.com' };
  for (const k of ['COMPANY_NAME', 'COMPANY_POSTAL_ADDRESS', 'COMPANY_CONTACT_EMAIL', 'REPORT_EMAIL_FROM', 'SMTP_USER']) delete process.env[k];
  global.fetch = originalFetch;
});

// --- CAN-SPAM ----------------------------------------------------------------------------

test('without a postal address no commercial email is sent, and the refusal names the variable', () => {
  assert.match(outreach.outreachRefusal(), /COMPANY_POSTAL_ADDRESS/);
  process.env.COMPANY_POSTAL_ADDRESS = '1 Main St\nSpringfield, IL 62701';
  assert.equal(outreach.outreachRefusal(), null);
});

test('the footer names the sender, says it is commercial, and carries the address on one line', () => {
  process.env.COMPANY_POSTAL_ADDRESS = '1 Main St\nSpringfield, IL 62701';
  process.env.COMPANY_NAME = 'Acme Labs LLC';
  const body = outreach.withComplianceFooter('Hi Ada,\n\nQuick question.', { title: 'Acme Audit' });
  assert.match(body, /This is a commercial message from Acme Labs LLC, 1 Main St, Springfield, IL 62701\./);
  assert.match(body, /reply with the word "unsubscribe"/);
  delete process.env.COMPANY_NAME;
  assert.match(outreach.withComplianceFooter('x', { title: 'Acme Audit' }), /commercial message from Acme Audit, 1 Main St/);
});

test('the mail client\'s unsubscribe button reaches the reply watcher', () => {
  assert.equal(email.unsubscribeHeaders(), undefined, 'no sending address, no header');
  process.env.REPORT_EMAIL_FROM = 'Acme <hello@acme.example>';
  assert.deepEqual(email.unsubscribeHeaders(), { 'List-Unsubscribe': '<mailto:hello@acme.example?subject=unsubscribe&body=unsubscribe>' });
  // What that button sends: the subject alone may say it.
  assert.ok(outreach.isUnsubscribe('unsubscribe\n'));
});

// --- automatic renewal -------------------------------------------------------------------

test('a monthly link is refused without a contact to name; a one-off payment needs none', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push(new URLSearchParams(init.body));
    return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' }), { status: 200 });
  };
  const venture = { id: 'v_1', title: 'Acme Audit' };
  await assert.rejects(payments.createCheckoutLink({ venture, amount: 20, kind: 'monthly' }), /COMPANY_CONTACT_EMAIL/);
  assert.equal(calls.length, 0, 'Stripe is not called');
  await payments.createCheckoutLink({ venture, amount: 20, kind: 'one_time' });
  assert.equal(calls[0].get('custom_text[submit][message]'), null, 'no renewal terms on a one-off payment');
  process.env.REPORT_EMAIL_FROM = 'Acme <hello@acme.example>';
  await payments.createCheckoutLink({ venture, amount: 20, kind: 'monthly' });
  assert.match(calls[1].get('custom_text[submit][message]'), /hello@acme\.example/);
});

test('the first payment of a plan carries its subscription, so the customer can be sent the terms', () => {
  const out = payments.interpretEvent({
    id: 'evt_cs_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 2000, currency: 'eur', subscription: 'sub_ABC123',
      customer_details: { email: 'ada@acme.com' }, metadata: { ventureId: 'v_1', kind: 'monthly' } } },
  });
  assert.equal(out.paid.subscriptionId, 'sub_ABC123');
  assert.equal(out.paid.firstPayment, true);
});

test('the confirmation email states the terms and the cancel link', () => {
  process.env.COMPANY_CONTACT_EMAIL = 'help@acme.example';
  const url = payments.cancelLink('sub_ABC123');
  assert.match(url, /^https:\/\/jarvis\.example\.com\/billing\/cancel\?t=/);
  const { subject, text } = email.formatSubscriptionConfirmationEmail({
    productName: 'Acme Audit', terms: payments.renewalTerms({ amount: 20, currency: 'eur' }), cancelUrl: url, contact: 'help@acme.example',
  });
  assert.equal(subject, 'Your subscription: Acme Audit');
  assert.match(text, /EUR 20\.00 today and again every month until you cancel/);
  assert.ok(text.includes(url));
});

test('a cancel link names one subscription and cannot be forged or edited', () => {
  const token = payments.cancelToken('sub_ABC123');
  assert.equal(payments.verifyCancelToken(token), 'sub_ABC123');
  const [, mac] = token.split('.');
  const other = `${Buffer.from('sub_OTHER').toString('base64url')}.${mac}`;
  assert.equal(payments.verifyCancelToken(other), null, 'another subscription id with this signature');
  assert.equal(payments.verifyCancelToken('garbage'), null);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_rotated';
  assert.equal(payments.verifyCancelToken(token), null, 'signed with a different key');
});

function fakeRes() {
  return {
    statusCode: 200, body: '',
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    send(b) { this.body = b; return this; },
  };
}

test('opening the link only shows the button; pressing it cancels at the end of the month', async () => {
  const stripeCalls = [];
  global.fetch = async (url, init) => {
    stripeCalls.push({ url, body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ id: 'sub_ABC123', current_period_end: 1790000000 }), { status: 200 });
  };
  const t = payments.cancelToken('sub_ABC123');

  const shown = fakeRes();
  billing.showCancel({ query: { t } }, shown);
  assert.equal(shown.statusCode, 200);
  assert.match(shown.body, /<form method="post"/);
  assert.equal(stripeCalls.length, 0, 'a mail scanner following the link cancels nothing');

  const done = fakeRes();
  await billing.confirmCancel({ query: { t } }, done);
  assert.equal(done.statusCode, 200);
  assert.match(done.body, /You will not be charged again\. It ends on/);
  assert.equal(stripeCalls[0].url, 'https://api.stripe.com/v1/subscriptions/sub_ABC123');
  assert.equal(stripeCalls[0].body.get('cancel_at_period_end'), 'true');
});

test('a bad link changes nothing and says who to write to; a Stripe failure says try again', async () => {
  process.env.COMPANY_CONTACT_EMAIL = 'help@acme.example';
  global.fetch = async () => { throw new Error('Stripe must not be called'); };
  const bad = fakeRes();
  await billing.confirmCancel({ query: { t: 'nope' } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /Nothing was changed\. Write to help@acme\.example/);

  global.fetch = async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500 });
  const failed = fakeRes();
  await billing.confirmCancel({ query: { t: payments.cancelToken('sub_ABC123') } }, failed);
  assert.equal(failed.statusCode, 502);
  assert.match(failed.body, /nothing changed/);
});

test('the send tool itself refuses before any other check when the address is missing', async () => {
  const { handleSendCustomerEmail } = await import('../actionHandlers.js');
  process.env.SMTP_HOST = 'smtp.test';
  process.env.REPORT_EMAIL_TO = 'founder@acme.example';
  const out = await handleSendCustomerEmail({ ventureId: 'v_1', to: 'ada@acme.com', subject: 'Hi', body: 'Hello' });
  assert.match(out, /^Could not send: every commercial email must carry a valid postal address.*COMPANY_POSTAL_ADDRESS/);
});
