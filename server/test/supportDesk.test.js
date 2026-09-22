// A support desk for users of somebody else's software.
//
// The conversation half existed. What a call centre needs on top is the thing
// no model has — the procedures — and the discipline to say "I don't have
// that one" instead of inventing a step that costs the caller an hour. These
// tests are about the knowledge base, the two boundaries (it is not the
// vendor; it holds no company state), and the ticket that catches everything
// the procedures do not.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let desk;
const KEYS = ['SUPPORT_PRODUCT', 'SUPPORT_DESK_NAME', 'SUPPORT_MODE', 'WHATSAPP_DESK', 'DESK_LANGUAGE', 'REPLY_LANGUAGE', 'SMTP_HOST'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-support-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  desk = await import('../realtime/supportDesk.js');
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
  fs.rmSync(path.join(tmpDir, 'support.json'), { force: true });
  fs.rmSync(path.join(tmpDir, 'tickets.json'), { force: true });
});

// --- The knowledge base -----------------------------------------------------------------

test('the desk is not mute on day one, and every starting procedure is marked as an example', () => {
  const issues = desk.listIssues();
  assert.ok(issues.length >= 4, 'seeded');
  assert.ok(issues.every((i) => i.example === true), 'so the founder replaces them rather than trusting them');
});

test('deleting every example is a valid state and does not resurrect them', () => {
  for (const issue of desk.listIssues()) desk.removeIssue(issue.id);
  assert.deepEqual(desk.listIssues(), []);
  assert.deepEqual(desk.listIssues(), [], 'a second load does not re-seed');
});

test('a caller describing symptoms finds the procedure, without knowing its title', (t) => {
  process.env.SUPPORT_MODE = 'vendor';
  t.after(() => delete process.env.SUPPORT_MODE);
  const [best] = desk.findIssues('my password keeps getting rejected and now it says the account is locked');
  assert.ok(best, 'something matched');
  assert.equal(best.issue.title, 'Cannot sign in');
});

test('an added procedure outranks the examples when it fits better', () => {
  desk.addIssue({
    title: 'Seat map will not load',
    symptoms: 'seat map blank, seat selection greyed out, cannot pick seats, seatmap error',
    steps: 'Check the segment is confirmed (HK). If it is, close and reopen the seat map. If still blank, open a ticket with the flight number.',
  });
  const [best] = desk.findIssues('the seat map is completely blank and I cannot pick seats');
  assert.equal(best.issue.title, 'Seat map will not load');
  assert.equal(best.issue.example, false);
});

test('a problem with nothing on record matches nothing, rather than the least-unrelated thing', () => {
  assert.deepEqual(desk.findIssues('my office coffee machine is broken'), []);
});

test('an issue needs all three parts, because a procedure without steps is a title', () => {
  assert.throws(() => desk.addIssue({ title: 'x', symptoms: 'y', steps: '' }), /title, the symptoms.*and the steps/);
});

// --- The tools ----------------------------------------------------------------------------

test('lookup_issue with no match tells the model not to improvise', async () => {
  const out = await desk.runSupportTool('lookup_issue', { problem: 'coffee machine broken' });
  assert.match(out, /No procedure on record/);
  assert.match(out, /Do not improvise steps/);
  assert.match(out, /open a ticket/);
});

test('lookup_issue returns the steps, closest first', async (t) => {
  process.env.SUPPORT_MODE = 'vendor';
  t.after(() => delete process.env.SUPPORT_MODE);
  const out = await desk.runSupportTool('lookup_issue', { problem: 'the application is frozen and my colleagues have the same thing' });
  assert.match(out, /1\. Application slow, frozen or disconnecting/);
  assert.match(out, /Steps:/);
});

test('open_ticket saves the ticket and returns a number to read back', async () => {
  const out = await desk.runSupportTool(
    'open_ticket',
    { summary: 'ER rejected with an unknown code', callerName: 'Ana', contact: 'ana@agency.example', language: 'Spanish' },
    { from: '+34600000000' }
  );
  assert.match(out, /Ticket #1 is open/);
  assert.match(out, /ana@agency\.example/);
  const [ticket] = desk.listTickets();
  assert.equal(ticket.callerName, 'Ana');
  assert.equal(ticket.from, '+34600000000');
  assert.equal(ticket.status, 'open');
});

test('a ticket needs a summary, since an empty ticket helps nobody follow up', async () => {
  await assert.rejects(() => desk.runSupportTool('open_ticket', {}), /needs a summary/);
});

test('a tool the desk does not have is refused by name', async () => {
  assert.match(await desk.runSupportTool('ask_the_team', {}), /no tool called "ask_the_team"/);
});

// --- The boundaries -----------------------------------------------------------------------

test('the desk never introduces itself as the vendor', (t) => {
  process.env.SUPPORT_MODE = 'vendor';
  t.after(() => delete process.env.SUPPORT_MODE);
  const brief = desk.buildSupportInstructions();
  assert.match(brief, /independent support desk for people who use Amadeus/);
  assert.match(brief, /You are not Amadeus, you do not work for Amadeus/);
  assert.match(brief, /say plainly that this is an independent desk/);
});

test('the desk brief holds no company state', () => {
  const brief = desk.buildSupportInstructions();
  for (const leak of ['COMPANY STATE', 'Revenue', 'pipeline', 'Treasury', 'venture']) {
    assert.doesNotMatch(brief, new RegExp(leak, 'i'), `a caller must not be told about ${leak}`);
  }
});

test('the desk is told to give only steps that came back from the lookup', () => {
  const brief = desk.buildSupportInstructions();
  assert.match(brief, /Never give a step that did not come back from lookup_issue/);
  assert.match(brief, /an invented one is not/);
  assert.match(brief, /one at a time/i, 'and to pace them');
});

test('the desk refuses passwords and card numbers, and never promises the vendor will act', (t) => {
  process.env.SUPPORT_MODE = 'vendor';
  t.after(() => delete process.env.SUPPORT_MODE);
  const brief = desk.buildSupportInstructions();
  assert.match(brief, /Never ask for a password, a full card number/);
  assert.match(brief, /Never promise a fix, a time, or that Amadeus will do anything/);
});

test('the product and the name are configurable, so this is not only an Amadeus desk', (t) => {
  process.env.SUPPORT_MODE = 'vendor';
  t.after(() => delete process.env.SUPPORT_MODE);
  process.env.SUPPORT_PRODUCT = 'Sabre';
  process.env.SUPPORT_DESK_NAME = 'the GDS help line';
  t.after(() => { delete process.env.SUPPORT_PRODUCT; delete process.env.SUPPORT_DESK_NAME; });
  assert.match(desk.buildSupportInstructions(), /You are not Sabre/);
  assert.match(desk.supportGreeting(), /the GDS help line/);
});

test('it opens in DESK_LANGUAGE and is told to follow the caller without comment', (t) => {
  process.env.DESK_LANGUAGE = 'es';
  t.after(() => delete process.env.DESK_LANGUAGE);
  const brief = desk.buildSupportInstructions();
  assert.match(brief, /Open in Spanish/);
  assert.match(brief, /Never comment on which language is in use/);
  assert.match(desk.supportGreeting(), /in Spanish/);
});

test('describeSupportDesk counts the examples still to be replaced', () => {
  assert.match(desk.describeSupportDesk(), /still the starting examples — replace them with ISSUE/);
  for (const issue of desk.listIssues()) desk.removeIssue(issue.id);
  desk.addIssue({ title: 'a', symptoms: 'b c d', steps: 'e' });
  assert.doesNotMatch(desk.describeSupportDesk(), /starting examples/);
});

// --- The ticket email ---------------------------------------------------------------------

test('the ticket email carries what a person needs to follow up, and how to make it not recur', async () => {
  const { formatTicketEmail } = await import('../email.js');
  const { subject, text } = formatTicketEmail({
    id: 7, product: 'Amadeus', summary: 'Queue 12 shows 40 records but none display', callerName: 'Luc',
    contact: '+33600000000', language: 'French', from: '+33600000000', at: '2026-09-22T06:00:00.000Z',
  });
  assert.match(subject, /Support ticket #7: Queue 12/);
  assert.match(text, /Caller: Luc/);
  assert.match(text, /Language of the call: French/);
  assert.match(text, /add the procedure with ISSUE/, 'the fix for the next caller is named');
});


// --- The agency's own desk, which is the default --------------------------------------------
//
// The founder dropped the vendor case: "just make a travel agency help desk".
// The caller is now the agency's customer, and the one thing that changes in
// the brief is what the desk may promise — nothing. It can look up and log; a
// person changes, cancels, refunds and pays.

test('the default desk is the agency\'s own, not a vendor\'s', () => {
  assert.equal(desk.supportMode(), 'agency');
  assert.equal(desk.supportDeskName(), 'the travel help desk');
  assert.doesNotMatch(desk.buildSupportInstructions(), /You are not /, 'the "not the vendor" line belongs to the other persona');
  assert.doesNotMatch(desk.buildSupportInstructions(), /Amadeus/);
});

test('the agency desk cannot change, cancel, refund or pay, and is told to say so', () => {
  const brief = desk.buildSupportInstructions();
  assert.match(brief, /cannot change, cancel, refund, rebook or pay for anything on this call/);
  assert.match(brief, /Never say a change, cancellation or refund is done, approved or guaranteed/);
  assert.match(brief, /Never quote a price, a fee or a refund amount you were not given/);
  assert.match(brief, /full passport number/, 'a passport number is as sensitive as a card number here');
});

test('the agency desk starts with the calls a travel agency actually gets', () => {
  const titles = desk.listIssues().map((i) => i.title);
  assert.ok(titles.includes('Booking confirmation never arrived'));
  assert.ok(titles.includes('Cancel a booking or ask for a refund'));
  assert.ok(titles.includes('Missed a flight or a flight was cancelled'));
  assert.ok(desk.listIssues().every((i) => i.example), 'all still examples');
});

test('a customer describing a refund in their own words finds the refund procedure', () => {
  const [best] = desk.findIssues('I want to cancel my trip and get my money back');
  assert.equal(best.issue.title, 'Cancel a booking or ask for a refund');
  assert.match(best.issue.steps, /cannot process a cancellation or promise a refund on this call/);
});

test('the WhatsApp desk is off unless switched on', (t) => {
  assert.equal(desk.isWhatsAppDeskEnabled(), false);
  process.env.WHATSAPP_DESK = 'true';
  t.after(() => delete process.env.WHATSAPP_DESK);
  assert.equal(desk.isWhatsAppDeskEnabled(), true);
});

test('describeSupportDesk says whose desk it is', (t) => {
  assert.match(desk.describeSupportDesk(), /the agency's own help desk/);
  process.env.SUPPORT_MODE = 'vendor';
  t.after(() => delete process.env.SUPPORT_MODE);
  assert.match(desk.describeSupportDesk(), /an independent desk for Amadeus users/);
});
