// Taking money.
//
// The ledger has had a revenue column since the first week and no way for a
// customer to fill it. In Anthropic's Project Vend, the single tool that did
// most to turn the shop profitable was one that created payment links so it
// could collect before committing. This is that tool.
//
// Stripe over plain fetch rather than the SDK, for the same reason the GitHub
// client is: one dependency fewer to keep current, and the two calls this
// company needs — create a Checkout Session, verify a webhook — are small
// enough to see in full.
//
// Opt-in via STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Both go into the
// deployment environment; nothing here ever prints or returns either.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSecret, hasSecret } from './env.js';
import { readJson, writeJson } from './store.js';
import { publicBaseUrl } from './viewToken.js';

const STRIPE_API = 'https://api.stripe.com';
const FILE = 'payments.json';

export function isPaymentsConfigured() {
  return hasSecret('STRIPE_SECRET_KEY') && hasSecret('STRIPE_WEBHOOK_SECRET');
}

function load() {
  return readJson(FILE, { processedEvents: [], links: [] });
}

function save(data) {
  writeJson(FILE, data);
}

// Stripe takes application/x-www-form-urlencoded with bracketed keys.
function form(params, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => out.push(form(typeof item === 'object' ? item : { '': item }, `${name}[${i}]`)));
    } else if (typeof value === 'object') {
      out.push(form(value, name));
    } else {
      out.push(`${encodeURIComponent(name.replace(/\[\]$/, ''))}=${encodeURIComponent(String(value))}`);
    }
  }
  return out.filter(Boolean).join('&');
}

async function stripe(path, params) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${readSecret('STRIPE_SECRET_KEY')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Stripe ${path} failed: ${res.status} ${body?.error?.message || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * A hosted checkout page for one venture, one customer, one amount.
 *
 * `kind` is 'one_time' or 'monthly'. The amount is in major units (149.00),
 * converted to minor units here because a tool that takes cents will be
 * handed 149 and charge €1.49.
 *
 * @returns {Promise<{url: string, sessionId: string, amount: number, currency: string, kind: string}>}
 */
// --- automatic renewal --------------------------------------------------------------
//
// A monthly plan renews until the customer stops it, and California's
// automatic renewal law (Bus. & Prof. Code 17600-17606) treats anything
// charged without its conditions met as an unconditional gift the customer
// can keep while asking for the money back. The conditions, and where each
// is met here:
//
//   - The terms stated clearly *in visual proximity to* the request for
//     consent: the text beside Stripe's pay button (custom_text.submit), set
//     on every monthly checkout. There is no separate terms page to miss.
//   - An acknowledgment after purchase with the terms and how to cancel: the
//     confirmation email sent on the first payment (see index.js).
//   - A way to cancel online, at least as easy as signing up: the cancel link
//     in that email, one button, no login (see /billing/cancel).
//
// A monthly link is refused without a contact address, because the terms
// must say how to reach someone and an invented one is worse than none.

/** Who a customer writes to. COMPANY_CONTACT_EMAIL, else the address mail is sent from. */
export function contactEmail() {
  const configured = (process.env.COMPANY_CONTACT_EMAIL || '').trim();
  if (configured) return configured;
  const from = (process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER || '').trim();
  const address = (from.match(/<([^>]+)>/)?.[1] || from).trim();
  return address.includes('@') ? address : '';
}

function money(amount, currency) {
  return `${String(currency).toUpperCase()} ${Number(amount).toFixed(2)}`;
}

/** The words beside the pay button, and at the top of the confirmation email. */
export function renewalTerms({ amount, currency, contact = contactEmail() }) {
  return (
    `This is a subscription. You will be charged ${money(amount, currency)} today and again every month ` +
    'until you cancel. Cancel at any time with the link in your confirmation email' +
    (contact ? ` or by writing to ${contact}` : '') +
    '; it stops the next charge, and you keep what you have paid for until the end of that month.'
  );
}

export async function createCheckoutLink({ venture, amount, currency, description, customerEmail, kind = 'one_time', agentId }) {
  if (!isPaymentsConfigured()) throw new Error('Payments are not configured (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET).');
  const major = Number(amount);
  if (!Number.isFinite(major) || major <= 0) throw new Error('amount must be a positive number in major units, e.g. 149.00');
  const code = String(currency || 'eur').toLowerCase();
  if (kind === 'monthly' && !contactEmail()) {
    throw new Error(
      'A monthly plan must tell the customer how to cancel, and there is no contact address to name. ' +
        'Set COMPANY_CONTACT_EMAIL (or REPORT_EMAIL_FROM) in Railway.'
    );
  }
  const unitAmount = Math.round(major * 100);
  const base = publicBaseUrl();

  const priceData = {
    currency: code,
    unit_amount: unitAmount,
    product_data: { name: description || `${venture.title} — ${kind === 'monthly' ? 'monthly plan' : 'payment'}` },
    ...(kind === 'monthly' ? { recurring: { interval: 'month' } } : {}),
  };

  const session = await stripe('/v1/checkout/sessions', {
    mode: kind === 'monthly' ? 'subscription' : 'payment',
    line_items: [{ price_data: priceData, quantity: 1 }],
    success_url: `${base}/paid?venture=${encodeURIComponent(venture.id)}`,
    cancel_url: `${base}/paid?venture=${encodeURIComponent(venture.id)}&cancelled=1`,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    metadata: { ventureId: venture.id, agentId: agentId || '', kind },
    // Beside the pay button, where the renewal law wants it.
    ...(kind === 'monthly' ? { custom_text: { submit: { message: renewalTerms({ amount: major, currency: code }) } } } : {}),
    // So a later invoice (a renewal) can still be tied to its venture.
    ...(kind === 'monthly' ? { subscription_data: { metadata: { ventureId: venture.id, agentId: agentId || '' } } } : {}),
  });

  const data = load();
  data.links.push({
    sessionId: session.id,
    ventureId: venture.id,
    amount: major,
    currency: code,
    kind,
    customerEmail: customerEmail || null,
    agentId: agentId || null,
    createdAt: new Date().toISOString(),
  });
  save(data);

  return { url: session.url, sessionId: session.id, amount: major, currency: code, kind };
}

/**
 * Stripe's webhook signature: header "t=<unix>,v1=<hex>[,v1=...]", signed
 * payload "<t>.<rawBody>", HMAC-SHA256 with the endpoint secret. Verified on
 * the raw bytes, which is why index.js keeps req.rawBody.
 */
export function verifyStripeSignature(rawBody, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!hasSecret('STRIPE_WEBHOOK_SECRET') || !header || !rawBody) return false;
  const parts = Object.create(null);
  for (const pair of String(header).split(',')) {
    const [k, v] = pair.split('=');
    if (!k || !v) continue;
    (parts[k.trim()] ||= []).push(v.trim());
  }
  const t = Number(parts.t?.[0]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', readSecret('STRIPE_WEBHOOK_SECRET'))
    .update(`${t}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected);
  return (parts.v1 || []).some((sig) => {
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Turns a verified Stripe event into what the company needs to know, or null
 * when the event is not a payment. Idempotent on event id: Stripe retries, and
 * booking the same payment twice is worse than missing it once.
 */
export function interpretEvent(event) {
  const data = load();
  if (data.processedEvents.includes(event.id)) return { duplicate: true };

  let paid = null;
  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed' && obj.payment_status === 'paid') {
    paid = {
      amount: (obj.amount_total || 0) / 100,
      currency: String(obj.currency || 'eur').toUpperCase(),
      customerEmail: obj.customer_details?.email || obj.customer_email || null,
      ventureId: obj.metadata?.ventureId || null,
      agentId: obj.metadata?.agentId || null,
      kind: obj.metadata?.kind || 'one_time',
      reference: obj.id,
      // The first payment of a monthly plan: the moment the customer is owed
      // the acknowledgment with the terms and a way to cancel.
      subscriptionId: typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id || null,
      firstPayment: true,
    };
  } else if (event.type === 'invoice.paid') {
    // Subsequent months of a subscription arrive here, not as a checkout.
    paid = {
      amount: (obj.amount_paid || 0) / 100,
      currency: String(obj.currency || 'eur').toUpperCase(),
      customerEmail: obj.customer_email || null,
      ventureId: obj.subscription_details?.metadata?.ventureId || obj.metadata?.ventureId || null,
      agentId: obj.subscription_details?.metadata?.agentId || null,
      kind: 'monthly',
      reference: obj.id,
    };
  }

  data.processedEvents.push(event.id);
  // Stripe only retries for a few days; a thousand ids is months of history.
  if (data.processedEvents.length > 1000) data.processedEvents = data.processedEvents.slice(-1000);
  save(data);

  return paid ? { duplicate: false, paid } : { duplicate: false, paid: null };
}

export function listPaymentLinks(ventureId) {
  return load().links.filter((l) => !ventureId || l.ventureId === ventureId);
}

// --- cancelling ------------------------------------------------------------------------

// Signed with a key derived from the webhook secret: always present when
// payments are on, never shown to anyone, and separate from the app's own
// access token, so a customer's cancel link opens nothing else.
function cancelKey() {
  return createHmac('sha256', readSecret('STRIPE_WEBHOOK_SECRET') || '').update('jarvis:cancel-subscription:v1').digest();
}

/** A link token naming one subscription. It does not expire: a customer may cancel in month twelve. */
export function cancelToken(subscriptionId) {
  const id = String(subscriptionId || '');
  const mac = createHmac('sha256', cancelKey()).update(id).digest('base64url');
  return `${Buffer.from(id).toString('base64url')}.${mac}`;
}

/** The subscription id a token names, or null when it is not one this server signed. */
export function verifyCancelToken(token) {
  if (!hasSecret('STRIPE_WEBHOOK_SECRET') || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, mac] = token.split('.', 2);
  const id = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!/^sub_[A-Za-z0-9]+$/.test(id)) return null;
  const expected = createHmac('sha256', cancelKey()).update(id).digest('base64url');
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return id;
}

export function cancelLink(subscriptionId) {
  return `${publicBaseUrl()}/billing/cancel?t=${encodeURIComponent(cancelToken(subscriptionId))}`;
}

/**
 * Stops the next charge. At period end rather than now: the customer paid
 * for this month, and ending it early would be taking something back.
 * @returns {Promise<{endsAt: string|null, metadata: object}>}
 */
export async function cancelSubscription(subscriptionId) {
  const sub = await stripe(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { cancel_at_period_end: 'true' });
  const end = sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || sub?.cancel_at;
  return { endsAt: end ? new Date(end * 1000).toISOString() : null, metadata: sub?.metadata || {} };
}
