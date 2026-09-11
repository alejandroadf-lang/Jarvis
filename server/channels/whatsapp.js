// Talking to the company from WhatsApp.
//
// Three things about this integration are load-bearing, and two of them are
// easy to get wrong in ways that only show up in production.
//
// 1. ACKNOWLEDGE FIRST, ANSWER LATER. Meta expects a 200 within seconds and
//    retries the delivery if it doesn't get one. A team turn fans out from
//    the CEO through the C-suite and takes 20 seconds to two minutes. So the
//    webhook must return 200 immediately and send the reply afterwards
//    through the Send API as a separate outbound message. Answering inline
//    would guarantee duplicate deliveries and a timeout on every question.
//
// 2. THE SIGNATURE IS THE DOOR. This endpoint is public, and what's behind
//    it is a company that can commit code and email real customers. Meta
//    signs every payload with HMAC-SHA256 over the *raw* body; Express's
//    json() parser discards that, so index.js captures it with a `verify`
//    hook. An unsigned or badly-signed request is refused before it is
//    parsed as anything meaningful.
//
// 3. A SIGNATURE ONLY PROVES META SENT IT — not who typed it. Anyone who
//    finds the number can message it. So there is a second, independent gate:
//    an explicit allowlist of sender numbers. Without it, a stranger could
//    ask the Engineering Lead to deploy.

import crypto from 'node:crypto';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export function isWhatsAppConfigured() {
  return Boolean(
    process.env.WHATSAPP_TOKEN &&
      process.env.WHATSAPP_PHONE_NUMBER_ID &&
      process.env.WHATSAPP_APP_SECRET &&
      allowedNumbers().length
  );
}

// Digits only, so +44 7700 900123, 447700900123 and (447) 700-900123 all
// compare equal — a mismatch here silently locks the founder out of their
// own company, which is a miserable thing to debug.
function normalizeNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

export function allowedNumbers() {
  return (process.env.WHATSAPP_ALLOWED_NUMBERS || '')
    .split(',')
    .map(normalizeNumber)
    .filter(Boolean);
}

export function isAllowedSender(from) {
  const allowed = allowedNumbers();
  if (!allowed.length) return false; // fail closed: no allowlist, nobody gets in
  return allowed.includes(normalizeNumber(from));
}

/**
 * The one-time handshake Meta performs when you save the webhook URL.
 * Returns the challenge string to echo, or null to refuse.
 */
export function verifyWebhookChallenge(query) {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!token) return null;
  if (query['hub.mode'] !== 'subscribe') return null;
  if (query['hub.verify_token'] !== token) return null;
  return String(query['hub.challenge'] ?? '');
}

/**
 * Checks Meta's HMAC-SHA256 signature over the raw request body.
 * Compared in constant time — a plain === leaks how much of the signature
 * was right, one byte at a time.
 */
export function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !rawBody || !signatureHeader) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pulls the one thing we care about out of Meta's deeply nested payload.
 * Returns null for the many notifications that aren't an inbound message —
 * delivery receipts and read receipts arrive on the same webhook.
 */
export function extractMessage(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return null;

  return {
    id: message.id,
    from: message.from,
    type: message.type,
    text: message.type === 'text' ? message.text?.body || '' : '',
  };
}

/**
 * Sends a message back. Long replies are split: WhatsApp rejects bodies over
 * 4096 characters, and a synthesised team answer can exceed that.
 */
export async function sendWhatsAppMessage(to, text) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) return false;

  for (const chunk of splitForWhatsApp(text)) {
    const res = await fetch(`${GRAPH_API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizeNumber(to),
        type: 'text',
        text: { body: chunk },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp send failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  }
  return true;
}

const MAX_BODY = 4000; // under Meta's 4096, leaving room for the part marker

export function splitForWhatsApp(text) {
  const body = String(text || '').trim() || '(no reply)';
  if (body.length <= MAX_BODY) return [body];

  const chunks = [];
  let rest = body;
  while (rest.length > MAX_BODY) {
    // Break on a paragraph or line end where possible, so a split doesn't
    // land mid-sentence.
    const window = rest.slice(0, MAX_BODY);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const at = cut > MAX_BODY / 2 ? cut : MAX_BODY;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.map((c, i) => (chunks.length > 1 ? `(${i + 1}/${chunks.length}) ${c}` : c));
}

// Meta retries a delivery it thinks failed, so the same message id can
// arrive more than once. Running a team turn twice would cost real money and
// could fire an action tool twice, so ids are remembered for a while.
const seenIds = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000;

export function isDuplicate(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, at] of seenIds) {
    if (now - at > DEDUP_TTL_MS) seenIds.delete(id);
  }
  if (seenIds.has(messageId)) return true;
  seenIds.set(messageId, now);
  return false;
}

export function __resetDedupForTests() {
  seenIds.clear();
}

// No transcription service is wired into this app, so a voice note can't be
// turned into a question. Saying so is better than silence, which reads as
// the company ignoring you.
export function unsupportedTypeReply(type) {
  if (type === 'audio' || type === 'voice') {
    return "I can't listen to voice notes yet — no transcription is set up. Send it as text and the team will pick it up.";
  }
  return `I can only read text messages right now (that one was "${type}").`;
}
