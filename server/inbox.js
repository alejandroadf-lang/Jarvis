// Reading the replies.
//
// email.js has six ways to send and, until now, zero ways to receive. The
// Sales & Commercial Manager could write to a prospect and then never learn
// what they said back. Every outreach was a broadcast into a room the
// company could not hear.
//
// That is not a small gap. It is the difference between a mailing list and a
// conversation, and a company that cannot hear a "yes, tell me more" cannot
// close anything. The founder was manually relaying replies into WhatsApp,
// which is the tell: the loop was already closing, just through a human.
//
// Opt-in the same way sending is: without IMAP_HOST, IMAP_USER and IMAP_PASS
// this module is inert and every read is a no-op with a reason.
//
// The privacy gate is the important part of this file. These credentials open
// the founder's whole mailbox — bank mail, family, everything. No agent has
// any business reading that, and "the prompt says not to" is not a control.
// So fetchReplies() never returns a message the company cannot already
// account for: a message is visible only if its sender is an address this
// company actually sent to, on a venture with an outreach scope. The
// allowlist that governs who the company may write to therefore also governs
// who it may hear from, and the founder sets it once, in one place. Nothing
// an agent can say widens it.

import { ImapFlow } from 'imapflow';

export function isInboxConfigured() {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

// How far back a check looks. A reply older than this is history, not news,
// and pulling a month of mail every cycle to re-reject 99% of it is a slow
// way to learn nothing.
export const LOOKBACK_DAYS = 14;

function lookbackFrom(now = new Date()) {
  return new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

// Addresses arrive as "Ada Lovelace <ada@acme.com>", as "<ada@acme.com>", or
// bare. All three have to reduce to the same key or the allowlist check
// silently fails open on nothing and closed on everything.
export function normalizeAddress(value) {
  const raw = String(value || '').trim();
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim().toLowerCase();
}

// Quoted history is most of a reply by volume and none of it by information —
// the agent already knows what it sent. Cutting it keeps a thread from
// growing quadratically in the context window as it goes back and forth.
const QUOTE_MARKERS = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^On .{10,80}wrote:$/im,
  /^_{10,}$/m,
  /^>{1,}\s/m,
];

export function stripQuotedHistory(text) {
  let body = String(text || '').replace(/\r\n/g, '\n');
  let cut = body.length;
  for (const marker of QUOTE_MARKERS) {
    const found = body.search(marker);
    if (found >= 0 && found < cut) cut = found;
  }
  return body.slice(0, cut).trim();
}

const MAX_BODY_CHARS = 4000;

function truncate(text) {
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n\n[...truncated — ${text.length - MAX_BODY_CHARS} more characters]`;
}

function connection() {
  return new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT) || 993,
    secure: process.env.IMAP_SECURE !== 'false',
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false,
  });
}

// Reads the mailbox and returns only what `isKnownSender` vouches for.
//
// The filter runs here rather than at the call site on purpose: a function
// that returns everything and trusts its caller to discard the private mail
// is one careless caller away from leaking the founder's inbox into a model
// context. The narrow return type is the control.
export async function fetchReplies({ isKnownSender, since = lookbackFrom(), limit = 25 } = {}) {
  if (!isInboxConfigured()) {
    return { configured: false, messages: [], reason: 'No inbound mailbox configured (IMAP_HOST, IMAP_USER, IMAP_PASS).' };
  }
  if (typeof isKnownSender !== 'function') {
    throw new Error('fetchReplies requires isKnownSender — reading the mailbox unfiltered is not a supported mode.');
  }

  const client = connection();
  const messages = [];
  let scanned = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock(process.env.IMAP_MAILBOX || 'INBOX');
    try {
      for await (const message of client.fetch({ since }, { envelope: true, source: true, uid: true })) {
        scanned += 1;
        const envelope = message.envelope || {};
        const from = normalizeAddress(envelope.from?.[0]?.address || '');
        if (!from || !isKnownSender(from)) continue;

        messages.push({
          messageId: envelope.messageId || `uid:${message.uid}`,
          uid: message.uid,
          from,
          fromName: envelope.from?.[0]?.name || '',
          subject: envelope.subject || '',
          receivedAt: (envelope.date || new Date()).toISOString(),
          body: truncate(stripQuotedHistory(extractPlainText(message.source))),
        });
        if (messages.length >= limit) break;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  // Newest first: if a prospect wrote three times, the last one is the one
  // that says what they now want.
  messages.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  return { configured: true, messages, scanned, filtered: scanned - messages.length };
}

// Just enough MIME to get the text out. A full parser is a dependency and an
// attack surface; what a sales reply needs is the text/plain part, and when
// there isn't one, the HTML with its tags stripped. Anything fancier than
// that (inline images, calendar invites) is not what the agent is reading
// this for.
export function extractPlainText(source) {
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source || '');
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  if (split < 0) return normalized.trim();

  const headers = normalized.slice(0, split);
  const boundaryMatch = headers.match(/boundary="?([^";\n]+)"?/i);

  if (!boundaryMatch) {
    return decodeBody(headers, normalized.slice(split + 2));
  }

  const parts = normalized.split(`--${boundaryMatch[1]}`);
  let htmlFallback = '';
  for (const part of parts) {
    const partSplit = part.indexOf('\n\n');
    if (partSplit < 0) continue;
    const partHeaders = part.slice(0, partSplit);
    const partBody = decodeBody(partHeaders, part.slice(partSplit + 2));
    if (/content-type:\s*text\/plain/i.test(partHeaders)) return partBody.trim();
    if (/content-type:\s*text\/html/i.test(partHeaders) && !htmlFallback) htmlFallback = partBody;
  }
  return stripHtml(htmlFallback).trim();
}

function decodeBody(headers, body) {
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/\n/g, ''), 'base64').toString('utf8');
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    // Decoded through a Buffer rather than String.fromCharCode, because a
    // =C3=A9 pair is two bytes of UTF-8, not two characters. Per-character
    // decoding turns "Café" into "CafÃ©" — which is how a prospect's name
    // ends up mangled in a reply the agent then quotes back at them.
    const bytes = [];
    const unfolded = body.replace(/=\n/g, '');
    for (let i = 0; i < unfolded.length; i += 1) {
      const hex = unfolded.slice(i + 1, i + 3);
      if (unfolded[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(...Buffer.from(unfolded[i], 'utf8'));
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return body;
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}
