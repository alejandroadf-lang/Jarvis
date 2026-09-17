// The privacy gate is what this file is mostly about.
//
// IMAP credentials open the founder's entire mailbox. The company has no
// business in most of it, and "the system prompt says not to look" is not a
// control — it is a hope. So fetchReplies() is built so that the founder's
// outreach allowlist, which already decides who the company may write to,
// is also the only door to who it may hear from. These tests pin that shut.
//
// The rest covers the MIME handling, which exists because a sales reply
// arrives base64'd inside a multipart body more often than not, and an agent
// handed "PGRpdj5IaSE8L2Rpdj4=" learns nothing.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isInboxConfigured,
  normalizeAddress,
  stripQuotedHistory,
  extractPlainText,
  stripHtml,
  fetchReplies,
} from '../inbox.js';
import {
  createVenture,
  linkOutreachScope,
  setOutreachEnabled,
  recordOutreach,
  outreachRecipients,
  ventureForRecipient,
  recordReply,
  listReplies,
  markRepliesRead,
  unreadReplyCount,
} from '../finance/ventures.js';
import { formatReplyAlertEmail } from '../email.js';

let tmpDir;
const savedEnv = {};
const IMAP_KEYS = ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'];

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-inbox-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const key of IMAP_KEYS) savedEnv[key] = process.env[key];
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const key of IMAP_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of IMAP_KEYS) delete process.env[key];
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
});

function ventureWithOutreach(recipients) {
  const venture = createVenture({
    title: 'Test Venture',
    oneLiner: 'A venture for testing',
    proposedBy: 'venture_partner',
  });
  linkOutreachScope(venture.id, { allowedRecipients: recipients, maxPerWeek: 10 });
  setOutreachEnabled(venture.id, true);
  return venture;
}

// --- The gate -----------------------------------------------------------------

test('inbound is inert until all three IMAP vars are set', () => {
  assert.equal(isInboxConfigured(), false);
  process.env.IMAP_HOST = 'imap.example.com';
  assert.equal(isInboxConfigured(), false, 'a host alone is not a configured mailbox');
  process.env.IMAP_USER = 'company@example.com';
  assert.equal(isInboxConfigured(), false);
  process.env.IMAP_PASS = 'secret';
  assert.equal(isInboxConfigured(), true);
});

test('an unconfigured mailbox reports a reason instead of throwing', async () => {
  const result = await fetchReplies({ isKnownSender: () => true });
  assert.equal(result.configured, false);
  assert.deepEqual(result.messages, []);
  assert.match(result.reason, /IMAP_HOST/);
});

test('fetchReplies refuses to run without a sender filter', async () => {
  for (const key of IMAP_KEYS) process.env[key] = 'x';
  await assert.rejects(() => fetchReplies({}), /isKnownSender/);
  await assert.rejects(() => fetchReplies({ isKnownSender: 'everyone' }), /isKnownSender/);
});

test('known senders come from what was actually sent, not from the allowlist', () => {
  // The distinction matters: "@acme.com" on the allowlist would otherwise make
  // every person at Acme readable the moment the founder granted the scope.
  const venture = ventureWithOutreach(['@acme.com']);
  assert.equal(outreachRecipients().size, 0, 'a granted scope alone opens nobody');

  recordOutreach(venture.id, { to: 'ada@acme.com', subject: 'Hello', body: 'Hi' });
  const known = outreachRecipients();
  assert.equal(known.has('ada@acme.com'), true);
  assert.equal(known.has('someone-else@acme.com'), false, 'a colleague we never wrote to is still private');
  assert.equal(known.has('bank@founders-bank.com'), false);
});

test('address matching survives the shapes a From header actually arrives in', () => {
  assert.equal(normalizeAddress('Ada Lovelace <ada@acme.com>'), 'ada@acme.com');
  assert.equal(normalizeAddress('<ada@acme.com>'), 'ada@acme.com');
  assert.equal(normalizeAddress('  ADA@Acme.com '), 'ada@acme.com');
  assert.equal(normalizeAddress(null), '');
});

// --- Filing -------------------------------------------------------------------

test('a reply files against the venture that last wrote to that person', () => {
  const first = ventureWithOutreach(['ada@acme.com']);
  const second = ventureWithOutreach(['ada@acme.com']);
  recordOutreach(first.id, { to: 'ada@acme.com', subject: 'One', body: 'x' });
  recordOutreach(second.id, { to: 'ada@acme.com', subject: 'Two', body: 'y' });

  assert.equal(ventureForRecipient('ada@acme.com').id, second.id);
  assert.equal(ventureForRecipient('ADA@ACME.COM').id, second.id);
  assert.equal(ventureForRecipient('nobody@acme.com'), null);
});

test('the same message is never filed twice', () => {
  // The daily cycle runs every morning over the same lookback window, so this
  // is the normal case, not an edge one. Filing twice would have the Sales
  // Manager answer the same prospect twice.
  const venture = ventureWithOutreach(['ada@acme.com']);
  const message = {
    messageId: '<abc@mail.acme.com>',
    from: 'ada@acme.com',
    subject: 'Re: Hello',
    body: 'Sounds good.',
    receivedAt: '2026-09-16T10:00:00.000Z',
  };
  const first = recordReply(venture.id, message);
  assert.equal(first.duplicate, false);
  const second = recordReply(venture.id, message);
  assert.equal(second.duplicate, true);
  assert.equal(second.entry, null);
  assert.equal(listReplies(venture.id).length, 1);
});

test('a reply stays unread until something actually reads it', () => {
  const venture = ventureWithOutreach(['ada@acme.com']);
  recordReply(venture.id, { messageId: '<1@x>', from: 'ada@acme.com', subject: 'a', body: 'b' });
  recordReply(venture.id, { messageId: '<2@x>', from: 'ada@acme.com', subject: 'c', body: 'd' });

  assert.equal(listReplies(venture.id, { unreadOnly: true }).length, 2);
  assert.equal(unreadReplyCount(), 2);

  assert.equal(markRepliesRead(venture.id, ['<1@x>']), 1);
  assert.equal(listReplies(venture.id, { unreadOnly: true }).length, 1);
  assert.equal(unreadReplyCount(), 1);

  // Idempotent: re-marking an already-read message is not a second read.
  assert.equal(markRepliesRead(venture.id, ['<1@x>']), 0);
});

test('replies come back newest first', () => {
  const venture = ventureWithOutreach(['ada@acme.com']);
  recordReply(venture.id, { messageId: '<old@x>', from: 'ada@acme.com', body: 'first', receivedAt: '2026-09-01T00:00:00.000Z' });
  recordReply(venture.id, { messageId: '<new@x>', from: 'ada@acme.com', body: 'latest', receivedAt: '2026-09-16T00:00:00.000Z' });
  // If a prospect wrote three times, the last one says what they now want.
  assert.equal(listReplies(venture.id)[0].body, 'latest');
});

// --- Reading the mail ---------------------------------------------------------

test('quoted history is cut, because the agent already knows what it sent', () => {
  const body = [
    'Yes, send pricing.',
    '',
    'On Tue, 15 Sep 2026 at 09:14, Sales <sales@us.com> wrote:',
    '> Hi Ada, following up on our note about the pilot.',
    '> Let me know if this is worth a call.',
  ].join('\n');
  assert.equal(stripQuotedHistory(body), 'Yes, send pricing.');
});

test('a reply with no quoted history is left alone', () => {
  assert.equal(stripQuotedHistory('Sure — Thursday works.'), 'Sure — Thursday works.');
});

test('the plain-text part wins over the HTML one', () => {
  const source = [
    'From: ada@acme.com',
    'Content-Type: multipart/alternative; boundary="B1"',
    '',
    '--B1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Happy to talk Thursday.',
    '--B1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div>Happy to talk <b>Thursday</b>.</div>',
    '--B1--',
  ].join('\r\n');
  assert.equal(extractPlainText(source), 'Happy to talk Thursday.');
});

test('an HTML-only reply is read rather than handed over as markup', () => {
  const source = [
    'From: ada@acme.com',
    'Content-Type: multipart/alternative; boundary="B2"',
    '',
    '--B2',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Interested.</p><p>What does it cost?</p>',
    '--B2--',
  ].join('\r\n');
  assert.match(extractPlainText(source), /Interested\./);
  assert.match(extractPlainText(source), /What does it cost\?/);
  assert.doesNotMatch(extractPlainText(source), /<p>/);
});

test('base64 bodies are decoded, not handed over as base64', () => {
  const source = [
    'From: ada@acme.com',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('Send the contract.').toString('base64'),
  ].join('\r\n');
  assert.equal(extractPlainText(source), 'Send the contract.');
});

test('quoted-printable bodies are decoded too', () => {
  const source = [
    'From: ada@acme.com',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Caf=C3=A9 on Thursday=3F',
  ].join('\r\n');
  assert.equal(extractPlainText(source), 'Café on Thursday?');
});

test('stripHtml drops scripts and styles rather than reading them aloud', () => {
  const html = '<style>p{color:red}</style><script>alert(1)</script><p>Hello &amp; welcome</p>';
  const text = stripHtml(html);
  assert.doesNotMatch(text, /color:red|alert/);
  assert.match(text, /Hello & welcome/);
});

// --- The founder's copy --------------------------------------------------------

test('the reply alert names who answered and which venture', () => {
  const { subject, text } = formatReplyAlertEmail(
    { title: 'Pilot Program' },
    { from: 'ada@acme.com', subject: 'Re: Hello', triggeredBy: 'daily_cycle' },
  );
  assert.match(subject, /ada@acme\.com/);
  assert.match(subject, /Pilot Program/);
  assert.match(text, /Re: Hello/);
});
