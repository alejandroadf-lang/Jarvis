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
export async function createCheckoutLink({ venture, amount, currency, description, customerEmail, kind = 'one_time', agentId }) {
  if (!isPaymentsConfigured()) throw new Error('Payments are not configured (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET).');
  const major = Number(amount);
  if (!Number.isFinite(major) || major <= 0) throw new Error('amount must be a positive number in major units, e.g. 149.00');
  const code = String(currency || 'eur').toLowerCase();
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
