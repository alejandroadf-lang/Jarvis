// The desk, for a voice bot that is not ours.
//
// Two properties carry the weight. The surface is closed without its key and
// refuses a wrong one in constant time — it opens tickets that email the
// founder, so unlike the Twilio line there is no other guard. And it is
// forgiving in what it accepts and always says something a bot can read out,
// because it was written without reading the bot's side.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let api;
let auth;
const KEYS = ['DESK_API_KEY', 'APP_ACCESS_TOKEN', 'SUPPORT_MODE', 'SMTP_HOST'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-desk-api-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  api = await import('../realtime/deskApi.js');
  auth = await import('../auth.js');
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

function req({ headers = {}, query = {}, path: p = '/api/desk/lookup' } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()], query, path: p };
}

// --- The key ------------------------------------------------------------------------------

test('with no key configured nothing verifies, so the surface is closed rather than open', () => {
  assert.equal(api.isDeskApiConfigured(), false);
  assert.equal(api.verifyDeskKey(req({ headers: { authorization: 'Bearer anything' } })), false);
});

test('the key is accepted as a bearer header, a custom header, or on the URL', (t) => {
  process.env.DESK_API_KEY = 'desk-secret';
  t.after(() => delete process.env.DESK_API_KEY);
  assert.equal(api.verifyDeskKey(req({ headers: { authorization: 'Bearer desk-secret' } })), true);
  assert.equal(api.verifyDeskKey(req({ headers: { 'x-desk-key': 'desk-secret' } })), true);
  assert.equal(api.verifyDeskKey(req({ query: { key: 'desk-secret' } })), true, 'for a bot that can only be given a URL');
});

test('a wrong, partial or missing key is refused, never thrown', (t) => {
  process.env.DESK_API_KEY = 'desk-secret';
  t.after(() => delete process.env.DESK_API_KEY);
  assert.equal(api.verifyDeskKey(req({ headers: { authorization: 'Bearer desk-secre' } })), false, 'length mismatch');
  assert.equal(api.verifyDeskKey(req({ headers: { authorization: 'Bearer desk-secreT' } })), false);
  assert.equal(api.verifyDeskKey(req()), false);
});

test('the app-token middleware steps aside for the desk paths, which check their own key', (t) => {
  // Otherwise the bot would need the founder's app token — the credential
  // that can disable the kill switch — to look up a procedure.
  process.env.APP_ACCESS_TOKEN = 'founder-token';
  t.after(() => delete process.env.APP_ACCESS_TOKEN);
  for (const p of ['/api/desk/ping', '/api/desk/lookup', '/api/desk/ticket']) {
    let passed = false;
    auth.requireAccess(req({ path: p }), { status: () => ({ json: () => {} }) }, () => { passed = true; });
    assert.equal(passed, true, `${p} reaches its handler without the app token`);
  }
  // And a path that is not the desk still needs it.
  let passed = false;
  const res = { status: (code) => ({ json: () => { res.code = code; } }) };
  auth.requireAccess(req({ path: '/api/ventures' }), res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.code, 401);
});

// --- Lookup -------------------------------------------------------------------------------

test('a lookup returns the procedure and a sentence the bot can read out', () => {
  const out = api.deskLookup({ problem: 'I want to cancel my trip and get my money back' });
  assert.ok(out.found >= 1);
  assert.equal(out.matches[0].title, 'Cancel a booking or ask for a refund');
  assert.equal(out.spoken, out.matches[0].steps, 'spoken is the closest procedure\'s steps');
});

test('the problem is accepted under the names a no-code integration is likely to use', () => {
  for (const field of ['problem', 'question', 'query', 'text', 'message', 'input', 'utterance']) {
    const out = api.deskLookup({ [field]: 'my booking confirmation never arrived' });
    assert.ok(out.found >= 1, `field "${field}"`);
  }
});

test('no match still yields something to say, and offers the ticket', () => {
  const out = api.deskLookup({ problem: 'my office coffee machine is broken' });
  assert.equal(out.found, 0);
  assert.match(out.spoken, /don't have a procedure for that one/);
  assert.match(out.spoken, /log it/);
});

test('an empty lookup asks the question rather than failing', () => {
  const out = api.deskLookup({});
  assert.equal(out.found, 0);
  assert.match(out.spoken, /what the problem is/);
  assert.ok(out.error);
});

// --- Ticket -------------------------------------------------------------------------------

test('a ticket is opened from forgiving field names and the number is spoken back', async () => {
  const out = await api.deskTicket(
    { description: 'Refund for booking XY12Z', name: 'Luc', phone: '+33600000000', lang: 'French' },
    { from: '+33600000000' }
  );
  assert.equal(out.ticketId, 1);
  assert.match(out.spoken, /ticket number 1/);
  assert.match(out.spoken, /\+33600000000/);

  const { listTickets } = await import('../realtime/supportDesk.js');
  const [ticket] = listTickets();
  assert.equal(ticket.callerName, 'Luc');
  assert.equal(ticket.language, 'French');
  assert.equal(ticket.from, '+33600000000');
});

test('a ticket without a summary is refused with a reason', async () => {
  await assert.rejects(() => api.deskTicket({ name: 'Luc' }), /needs a summary/);
});

// --- What the founder sees ----------------------------------------------------------------

test('describeDeskApi names the missing variable, then the endpoints once it is set', (t) => {
  assert.match(api.describeDeskApi(), /Set DESK_API_KEY/);
  process.env.DESK_API_KEY = 'k';
  t.after(() => delete process.env.DESK_API_KEY);
  assert.match(api.describeDeskApi(), /\/api\/desk\/lookup and \/api\/desk\/ticket/);
  assert.match(api.describeDeskApi(), /the travel help desk/);
});

test('the ticket response tells the bot whether the team was actually notified', async () => {
  // No SMTP here, so the truthful answer is no — and the spoken line says so,
  // rather than promising a follow-up nobody has been told about.
  const out = await api.deskTicket({ summary: 'Lost e-ticket for booking AB1', name: 'Ana' });
  assert.equal(out.emailed, false);
  assert.match(out.spoken, /hasn't been notified yet/);
  assert.match(out.spoken, /ticket number 1/);
});
