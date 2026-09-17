// The rehearsal.
//
// Two properties carry this file. The first is a safety property and is
// tested more than once, from more than one angle: a dry run must never
// deliver anything to the prospect whose address it evaluates. The second is
// what makes it a rehearsal rather than a demo — the gates it reports are the
// same gates a real send passes, so a shut gate here means a shut gate there.

import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';

let tmpDir;
let dryRun;
let ventures;
let commands;
const saved = {};
const KEYS = ['SMTP_HOST', 'REPORT_EMAIL_TO', 'CEO_REVIEW', 'REAL_ACTIONS_DISABLED', 'PLAN_REQUIRED'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dryrun-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const key of KEYS) saved[key] = process.env[key];
  delete process.env.REAL_ACTIONS_DISABLED;
  delete process.env.CEO_REVIEW;
  process.env.SMTP_HOST = 'smtp.test';
  process.env.REPORT_EMAIL_TO = 'founder@example.com';

  dryRun = await import('../outreachDryRun.js');
  ventures = await import('../finance/ventures.js');
  commands = await import('../channels/founderCommands.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
  fs.rmSync(path.join(tmpDir, 'killSwitch.json'), { force: true });
  mock.restoreAll();
});

// A venture with every gate open, so a test that expects a refusal has to
// close one deliberately rather than inherit it.
function readyVenture() {
  const venture = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
  ventures.linkOutreachScope(venture.id, { allowedRecipients: ['@acme.com'] });
  ventures.setOutreachEnabled(venture.id, true);
  return venture;
}

function captureMail() {
  const sent = [];
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (opts) => {
      sent.push(opts);
    },
  }));
  return sent;
}

// --- It never reaches the prospect ----------------------------------------------

test('the prospect receives nothing, even when every gate is open', async () => {
  const sent = captureMail();
  const venture = readyVenture();

  const result = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });

  assert.equal(result.wouldSend, true, 'the gates were open');
  assert.equal(sent.length, 1, 'exactly one email left the building');
  assert.equal(sent[0].to, 'founder@example.com', 'and it went to the founder');
  assert.doesNotMatch(String(sent[0].to), /acme\.com/);
});

test('the rendered message is in the founder copy, addressed to the prospect only as text', async () => {
  const sent = captureMail();
  const venture = readyVenture();

  await dryRun.dryRunOutreach({
    ventureId: venture.id,
    to: 'ada@acme.com',
    subject: 'A real subject',
    body: 'A real body.',
  });

  assert.match(sent[0].text, /A real subject/);
  assert.match(sent[0].text, /A real body\./);
  assert.match(sent[0].text, /ada@acme\.com/, 'the founder can see who it would have gone to');
  assert.equal(sent[0].to, 'founder@example.com');
});

// The module that sends to customers is the one module this one must never
// reach for. Cheaper to assert than to hope.
test('the module never imports the customer send path', () => {
  const source = fs.readFileSync(new URL('../outreachDryRun.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sendCustomerEmail/);
  assert.doesNotMatch(source, /recordOutreach/);
});

// --- It consumes nothing ----------------------------------------------------------

test('no cap is spent and no contact history is written', async () => {
  captureMail();
  const venture = readyVenture();

  await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });
  await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });
  await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });

  const after = ventures.getVenture(venture.id);
  assert.deepEqual(after.sentEmails, [], 'nothing was logged as sent');
  const headroom = ventures.outreachHeadroom(after);
  assert.equal(headroom.today, 0);
  assert.equal(headroom.thisWeek, 0);
});

// The cooldown is the gate most likely to be tripped by a rehearsal that
// recorded itself — three dry runs in a row would lock the founder out of a
// real send for a minute each time.
test('a rehearsal does not trip the cooldown for the next one', async () => {
  captureMail();
  const venture = readyVenture();

  const first = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });
  const second = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });

  assert.equal(first.wouldSend, true);
  assert.equal(second.wouldSend, true);
});

// --- It reports every shut gate, not just the first ---------------------------------

test('all the shut gates are reported at once', async () => {
  captureMail();
  const venture = ventures.createVenture({ title: 'Unready', milestones: ['ship'] });
  // No outreach scope, and the company is halted: two problems, one report.
  const killSwitch = await import('../killSwitch.js');
  killSwitch.haltRealActions('testing');
  try {
    const result = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });
    assert.equal(result.wouldSend, false);
    assert.match(result.text, /halted/i, 'the kill switch is named');
    assert.match(result.text, /No outreach scope/i, 'and so is the missing scope');
  } finally {
    killSwitch.resumeRealActions();
  }
});

// A gate that could not be evaluated must not read as one that passed.
test('gates behind a missing venture say they were not checked', async () => {
  captureMail();
  const result = await dryRun.dryRunOutreach({ ventureId: 'v_nope', to: 'ada@acme.com' });
  assert.equal(result.wouldSend, false);
  assert.match(result.text, /Not checked/);
  assert.match(result.text, /not found/i);
});

test('a recipient outside the allowlist is refused by name', async () => {
  captureMail();
  const venture = readyVenture();
  const result = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@elsewhere.com' });
  assert.equal(result.wouldSend, false);
  assert.match(result.text, /outside the allowed recipients/);
});

// The consent gate is the one with a fine attached, so it gets its own test.
test('a German address without recorded consent is refused', async () => {
  captureMail();
  const venture = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
  ventures.linkOutreachScope(venture.id, { allowedRecipients: ['@acme.de'] });
  ventures.setOutreachEnabled(venture.id, true);

  const result = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.de' });
  assert.equal(result.wouldSend, false);
  assert.match(result.text, /prior consent/);

  ventures.recordConsent(venture.id, 'ada@acme.de');
  const after = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.de' });
  assert.equal(after.wouldSend, true, 'and allowed once consent is on file');
});

// --- The gates are the same gates ---------------------------------------------------

// The whole value of the rehearsal rests on this. If outreachGates and
// authorizeOutreach could ever disagree, a green dry run would mean nothing.
test('a dry run that passes means authorizeOutreach passes, and vice versa', () => {
  const venture = readyVenture();

  const open = ventures.outreachGates(venture.id, { to: 'ada@acme.com' });
  assert.ok(open.every((gate) => gate.open));
  assert.doesNotThrow(() => ventures.authorizeOutreach(venture.id, { to: 'ada@acme.com' }));

  const shut = ventures.outreachGates(venture.id, { to: 'ada@elsewhere.com' });
  const firstShut = shut.find((gate) => !gate.open);
  assert.ok(firstShut);
  assert.throws(
    () => ventures.authorizeOutreach(venture.id, { to: 'ada@elsewhere.com' }),
    (err) => err.message === firstShut.reason,
    'the thrown message is the first shut gate, word for word'
  );
});

// --- The footer and the veto -----------------------------------------------------------

test('the compliance footer is on the rehearsed message', async () => {
  captureMail();
  const venture = readyVenture();
  const result = await dryRun.dryRunOutreach({
    ventureId: venture.id,
    to: 'ada@acme.com',
    subject: 'Hello',
    body: 'No footer here.',
  });
  assert.match(result.text, /written and sent by an AI system/);
  assert.match(result.text, /unsubscribe/);
});

test('a veto shows up as a refusal, and nothing is sent to the prospect either way', async () => {
  const sent = captureMail();
  process.env.CEO_REVIEW = 'true';
  process.env.OPENROUTER_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: 'VETO — it promises a discount nobody approved.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  });
  try {
    const venture = readyVenture();
    const result = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com', anthropic: {} });
    assert.equal(result.wouldSend, false);
    assert.match(result.text, /VETOED/);
    assert.match(result.text, /discount nobody approved/);
    assert.equal(sent[0].to, 'founder@example.com');
  } finally {
    global.fetch = originalFetch;
    delete process.env.CEO_REVIEW;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('with the review off the report says so rather than implying approval', async () => {
  captureMail();
  const venture = readyVenture();
  const result = await dryRun.dryRunOutreach({ ventureId: venture.id, to: 'ada@acme.com' });
  assert.match(result.text, /CEO_REVIEW=true/);
});

// --- The command ---------------------------------------------------------------------

test('DRYRUN parses, with and without the founder\'s own words', () => {
  const bare = commands.parseFounderCommand('DRYRUN v_123 ada@acme.com');
  assert.equal(bare.kind, 'dryrun');
  assert.equal(bare.to, 'ada@acme.com');
  assert.equal(bare.body, '');

  const full = commands.parseFounderCommand('dry run v_123 ada@acme.com | Quick question | Hi Ada, are you free?');
  assert.equal(full.subject, 'Quick question');
  assert.equal(full.body, 'Hi Ada, are you free?');
});

test('talking about a dry run is not a command', () => {
  for (const text of ['should we dry run the outreach first', 'dryrun sounds sensible', 'dry run it on my address']) {
    assert.equal(commands.parseFounderCommand(text), null, `"${text}" should not parse`);
  }
});

test('the reply names the outcome and where the detail went', async () => {
  const venture = readyVenture();
  const reply = await commands.runFounderCommand(
    { kind: 'dryrun', ventureId: venture.id, to: 'ada@acme.com', subject: '', body: '' },
    {
      dryRunOutreach: async () => ({ wouldSend: true, delivered: true, text: 'GATES\n  open   everything' }),
    }
  );
  assert.match(reply, /Dry run passed/);
  assert.match(reply, /Nothing was sent/);
  assert.match(reply, /inbox/);
});

test('a refusal reply carries the shut gate, so the founder need not open email', async () => {
  const reply = await commands.runFounderCommand(
    { kind: 'dryrun', ventureId: 'v_1', to: 'ada@acme.com', subject: '', body: '' },
    {
      dryRunOutreach: async () => ({
        wouldSend: false,
        delivered: true,
        text: 'GATES\n  SHUT   Outreach is switched on\n         The founder needs to turn it on.',
      }),
    }
  );
  assert.match(reply, /Dry run stopped/);
  assert.match(reply, /Outreach is switched on/);
});

test('the help text lists it', () => {
  assert.match(commands.__helpForTests, /DRYRUN <ventureId>/);
});

test('a dry run without a usable address says so instead of guessing', async () => {
  const result = await dryRun.dryRunOutreach({ ventureId: 'v_1', to: 'not-an-address' });
  assert.equal(result.wouldSend, false);
  assert.match(result.text, /recipient address/);
});
