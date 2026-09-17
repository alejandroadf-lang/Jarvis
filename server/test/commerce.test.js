// Batch one of the €1M gap: price on the record, money in, and the law around
// the emails that ask for it. Most of these pin a refusal — the country gate,
// the blocklist, the studio gate — because each is a line the code will not
// cross whatever an agent is asked, and a test is the only thing that keeps
// it a line rather than a suggestion.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import {
  createVenture,
  linkOutreachScope,
  setOutreachEnabled,
  authorizeOutreach,
  recordOutreach,
  recordReply,
  setPricing,
  describePricing,
  monthlyValue,
  setBookingUrl,
  updatePipeline,
  pipelineSummary,
  setObjective,
  listObjectives,
  recordPayment,
  monthlyRecurringRevenue,
  blockContact,
  unblockContact,
  recordConsent,
  listContacts,
} from '../finance/ventures.js';
import {
  requiresConsent,
  isUnsubscribe,
  withComplianceFooter,
  complianceFooter,
} from '../outreachCompliance.js';
import { verifyStripeSignature, interpretEvent, isPaymentsConfigured } from '../payments.js';
import { studioGate } from '../actionHandlers.js';
import { parseFounderCommand, runFounderCommand } from '../channels/founderCommands.js';
import { buildOutreachContext, buildObjectivesContext } from '../finance/context.js';

let tmpDir;
const saved = {};
const KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STUDIO_MIN_MRR_USD', 'IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'];

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-commerce-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
});
after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of ['ventures.json', 'payments.json', 'ledger.json', 'profitShare.json']) {
    fs.rmSync(path.join(tmpDir, f), { force: true });
  }
  for (const k of KEYS) delete process.env[k];
});

function ventureWithOutreach(recipients) {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  linkOutreachScope(v.id, { allowedRecipients: recipients, maxPerWeek: 10, maxPerDay: 5 });
  setOutreachEnabled(v.id, true);
  return v;
}

// --- Price ------------------------------------------------------------------------

test('a price on the record values a customer at a volume', () => {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  setPricing(v.id, { currency: 'eur', floorMonthly: 149, unit: 'page', perUnit: 0.02 });
  const priced = { ...v, pricing: { currency: 'EUR', floorMonthly: 149, unit: 'page', perUnit: 0.02 } };
  assert.equal(describePricing(priced), 'EUR 149.00/month + EUR 0.02 per page');
  // The prospect who asked about 50k pages a month: the number the CFO could
  // not compute before there was a price.
  assert.equal(monthlyValue(priced, 50000), 1149);
});

test('a per-unit rate without a unit is refused', () => {
  const v = createVenture({ title: 'x', oneLiner: 'x', proposedBy: 'venture_partner' });
  assert.throws(() => setPricing(v.id, { floorMonthly: 0, perUnit: 0.02, unit: '' }), /unit name/);
});

test('PRICE parses floor, rate, unit and currency', () => {
  assert.deepEqual(parseFounderCommand('price v_1_a 149 0.02 page'), {
    kind: 'price', ventureId: 'v_1_a', floorMonthly: 149, perUnit: 0.02, unit: 'page', currency: 'EUR',
  });
  assert.deepEqual(parseFounderCommand('PRICE v_1_a 99 usd'), {
    kind: 'price', ventureId: 'v_1_a', floorMonthly: 99, perUnit: 0, unit: '', currency: 'USD',
  });
  assert.equal(parseFounderCommand('price of freedom'), null);
});

// --- The law -----------------------------------------------------------------------

test('every outbound email ends with the disclosure and the opt-out', () => {
  const v = { title: 'Doc Intel' };
  const out = withComplianceFooter('Hi Ada,\n\nQuick note.', v);
  assert.match(out, /written and sent by an AI system/);
  assert.match(out, /reply with the word "unsubscribe"/);
  // Idempotent: a draft that already carries it does not get it twice.
  assert.equal(withComplianceFooter(out, v), out);
  assert.equal(out.split('unsubscribe').length, 2);
});

test('the footer names the venture the person is hearing from', () => {
  assert.match(complianceFooter({ title: 'Doc Intel' }), /"Doc Intel"/);
});

test('an unsubscribe in a reply blocks the address, and only the founder lifts it', () => {
  const v = ventureWithOutreach(['@acme.com']);
  recordReply(v.id, { messageId: '<u@x>', from: 'ada@acme.com', subject: 're', body: 'Please remove me from your list.' });
  assert.equal(isUnsubscribe('Please remove me from your list.'), true);
  // What handleCheckReplies does on arrival, through the same primitive.
  blockContact(v.id, 'ada@acme.com', 'unsubscribed by reply');
  assert.throws(() => authorizeOutreach(v.id, { to: 'ada@acme.com' }), /asked not to be contacted/);
  unblockContact(v.id, 'ada@acme.com');
  assert.doesNotThrow(() => authorizeOutreach(v.id, { to: 'ada@acme.com' }));
});

test('a German or Italian address is refused without recorded consent', () => {
  assert.equal(requiresConsent('hans@firma.de'), true);
  assert.equal(requiresConsent('giulia@azienda.it'), true);
  assert.equal(requiresConsent('ada@acme.com'), false);
  assert.equal(requiresConsent('ada@acme.co.uk'), false);

  const v = ventureWithOutreach(['@firma.de']);
  assert.throws(() => authorizeOutreach(v.id, { to: 'hans@firma.de' }), /requires prior consent/);
  recordConsent(v.id, 'hans@firma.de');
  assert.doesNotThrow(() => authorizeOutreach(v.id, { to: 'hans@firma.de' }));
});

test('the allowlist does not override a block', () => {
  // Being on the allowlist says the founder permits writing to them. A block
  // says the person refused. The person wins.
  const v = ventureWithOutreach(['ada@acme.com']);
  blockContact(v.id, 'ADA@acme.com', 'unsubscribed');
  assert.throws(() => authorizeOutreach(v.id, { to: 'ada@acme.com' }), /asked not to be contacted/);
});

test('a blocked contact is the first thing said about them in context', () => {
  const v = ventureWithOutreach(['ada@acme.com']);
  recordOutreach(v.id, { to: 'ada@acme.com', subject: 's', body: 'b' });
  blockContact(v.id, 'ada@acme.com', 'unsubscribed');
  assert.match(buildOutreachContext(), /ada@acme\.com: DO NOT CONTACT/);
});

test('BLOCK, UNBLOCK and CONSENT parse with an address and nothing else', () => {
  assert.deepEqual(parseFounderCommand('block v_1_a ada@acme.com she asked'), { kind: 'block', ventureId: 'v_1_a', email: 'ada@acme.com', reason: 'she asked' });
  assert.deepEqual(parseFounderCommand('consent v_1_a hans@firma.de'), { kind: 'consent', ventureId: 'v_1_a', email: 'hans@firma.de' });
  assert.equal(parseFounderCommand('block the calendar'), null);
});

// --- Payments ------------------------------------------------------------------------

test('payments are inert until both Stripe secrets are set', () => {
  assert.equal(isPaymentsConfigured(), false);
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  assert.equal(isPaymentsConfigured(), false);
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  assert.equal(isPaymentsConfigured(), true);
});

function sign(body, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

test('the webhook signature is verified on the raw body with a time window', () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  assert.equal(verifyStripeSignature(Buffer.from(body), sign(body, 'whsec_test')), true);
  assert.equal(verifyStripeSignature(Buffer.from(body + ' '), sign(body, 'whsec_test')), false, 'one byte off is a forgery');
  assert.equal(verifyStripeSignature(Buffer.from(body), sign(body, 'whsec_other')), false);
  const stale = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(verifyStripeSignature(Buffer.from(body), sign(body, 'whsec_test', stale)), false, 'an hour-old signature is a replay');
  assert.equal(verifyStripeSignature(Buffer.from(body), ''), false);
});

test('a completed checkout becomes a payment once, and a retry becomes nothing', () => {
  const event = {
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 114900, currency: 'eur', customer_details: { email: 'Ada@Acme.com' }, metadata: { ventureId: 'v_1', agentId: 'sales_commercial_manager', kind: 'monthly' } } },
  };
  const first = interpretEvent(event);
  assert.equal(first.duplicate, false);
  assert.equal(first.paid.amount, 1149);
  assert.equal(first.paid.currency, 'EUR');
  assert.equal(first.paid.ventureId, 'v_1');
  assert.equal(first.paid.kind, 'monthly');
  // Stripe retries. Booking the same payment twice is worse than missing it once.
  assert.equal(interpretEvent(event).duplicate, true);
});

test('an unpaid checkout and an unrelated event book nothing', () => {
  assert.equal(interpretEvent({ id: 'evt_2', type: 'checkout.session.completed', data: { object: { payment_status: 'unpaid', amount_total: 100 } } }).paid, null);
  assert.equal(interpretEvent({ id: 'evt_3', type: 'customer.created', data: { object: {} } }).paid, null);
});

test('a payment moves the payer to the paying stage and counts toward MRR', () => {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  recordPayment(v.id, { amount: 1149, currency: 'EUR', customerEmail: 'ada@acme.com', kind: 'monthly', reference: 'cs_1' });
  assert.equal(listContacts(v.id).find((c) => c.email === 'ada@acme.com').pipeline.stage, 'paying');
  assert.equal(monthlyRecurringRevenue(), 1149);
  // The same subscriber paying again this month is one subscriber, not two.
  recordPayment(v.id, { amount: 1149, currency: 'EUR', customerEmail: 'ada@acme.com', kind: 'monthly', reference: 'in_2' });
  assert.equal(monthlyRecurringRevenue(), 1149);
  // A one-time payment is revenue, not recurring revenue.
  recordPayment(v.id, { amount: 500, currency: 'EUR', customerEmail: 'bob@x.com', kind: 'one_time', reference: 'cs_2' });
  assert.equal(monthlyRecurringRevenue(), 1149);
});

// --- Pipeline and objectives ------------------------------------------------------------

test('the pipeline totals open and paying value separately', () => {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  updatePipeline(v.id, { email: 'a@x.com', stage: 'replied', dealValueMonthly: 1149, nextAction: 'send pricing' });
  updatePipeline(v.id, { email: 'b@x.com', stage: 'paying', dealValueMonthly: 500 });
  updatePipeline(v.id, { email: 'c@x.com', stage: 'lost', dealValueMonthly: 9000 });
  const s = pipelineSummary(v.id);
  assert.equal(s.contacts, 3);
  assert.equal(s.pipelineMonthly, 1149, 'lost deals are not pipeline');
  assert.equal(s.payingMonthly, 500);
  assert.throws(() => updatePipeline(v.id, { email: 'd@x.com', stage: 'maybe' }), /stage must be one of/);
});

test('setting an objective again replaces it rather than stacking it', () => {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  setObjective(v.id, { key: 'paying_customers', target: '2 by the floor price', by: '2026-10-15', setBy: 'ceo' });
  setObjective(v.id, { key: 'paying_customers', target: '3 by the floor price', by: '2026-10-15', setBy: 'ceo' });
  const open = listObjectives(v.id);
  assert.equal(open.length, 1);
  assert.match(open[0].target, /^3/);
  assert.match(buildObjectivesContext(), /paying_customers: 3 by the floor price/);
});

test('a booking link must be https', () => {
  const v = createVenture({ title: 'x', oneLiner: 'x', proposedBy: 'venture_partner' });
  assert.throws(() => setBookingUrl(v.id, 'http://cal.com/x'), /https/);
  setBookingUrl(v.id, 'https://cal.com/x');
  linkOutreachScope(v.id, { allowedRecipients: ['@x.com'], maxPerWeek: 5 });
  assert.match(buildOutreachContext(), /Booking link.*https:\/\/cal\.com\/x/);
});

// --- The studio gate ----------------------------------------------------------------------

test('the studio refuses a second venture while the first is not paying', () => {
  assert.equal(studioGate(), null, 'no venture at all: the studio is open');
  createVenture({ title: 'First', oneLiner: 'x', proposedBy: 'venture_partner' });
  const gate = studioGate();
  assert.ok(gate, 'one unpaid venture: the studio is paused');
  assert.equal(gate.minimum, 1000);
  assert.equal(gate.mrr, 0);
});

test('the studio reopens at the bar, and the bar can be switched off', () => {
  const v = createVenture({ title: 'First', oneLiner: 'x', proposedBy: 'venture_partner' });
  recordPayment(v.id, { amount: 1200, currency: 'EUR', customerEmail: 'a@x.com', kind: 'monthly', reference: 'in_1' });
  assert.equal(studioGate(), null, 'at 1200 MRR the studio is open');
  process.env.STUDIO_MIN_MRR_USD = '5000';
  assert.ok(studioGate(), 'a higher bar closes it again');
  process.env.STUDIO_MIN_MRR_USD = '0';
  assert.equal(studioGate(), null, 'zero disables the gate');
});

test('PIPELINE reads as one message per venture', async () => {
  const v = createVenture({ title: 'Doc Intel', oneLiner: 'x', proposedBy: 'venture_partner' });
  setPricing(v.id, { currency: 'EUR', floorMonthly: 149, unit: 'page', perUnit: 0.02 });
  updatePipeline(v.id, { email: 'ada@acme.com', stage: 'replied', dealValueMonthly: 1149, nextAction: 'send link' });
  setObjective(v.id, { key: 'paying_customers', target: '2', by: '2026-10-15', setBy: 'ceo' });
  const text = await runFounderCommand(parseFounderCommand('PIPELINE'));
  assert.match(text, /EUR 149\.00\/month \+ EUR 0\.02 per page/);
  assert.match(text, /ada@acme\.com — replied, 1149\/mo — next: send link/);
  assert.match(text, /paying_customers → 2 by 2026-10-15/);
});
