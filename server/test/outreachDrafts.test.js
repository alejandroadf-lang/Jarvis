// Outreach written before it can be sent.
//
// The company could build a prospect list and could not email anyone, because
// SMTP and the allowlist are founder configuration. That left the commercial
// side with nothing to do but wait — which is how a week produces a report full
// of recommendations and no work.
//
// The property these tests exist to protect is the one that would be easiest
// to lose: **founder approval is an extra gate, never a substitute for one.**
// A queue where saying yes skipped the allowlist would be a way around the
// allowlist wearing a helpful face. Several tests below come at that from
// different angles for exactly that reason.

import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';

let tmpDir;
let drafts;
let handlers;
let ventures;
let commands;
const saved = {};
const KEYS = ['SMTP_HOST', 'REPORT_EMAIL_TO', 'REAL_ACTIONS_DISABLED', 'CEO_REVIEW'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drafts-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const key of KEYS) saved[key] = process.env[key];
  delete process.env.REAL_ACTIONS_DISABLED;
  delete process.env.CEO_REVIEW;
  drafts = await import('../outreachDrafts.js');
  handlers = await import('../actionHandlers.js');
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
  for (const file of ['ventures.json', 'outreachDrafts.json', 'killSwitch.json']) {
    fs.rmSync(path.join(tmpDir, file), { force: true });
  }
  mock.restoreAll();
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;
});

function sendableVenture() {
  const venture = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
  ventures.linkOutreachScope(venture.id, { allowedRecipients: ['@acme.com'] });
  ventures.setOutreachEnabled(venture.id, true);
  return venture;
}

function smtpUp() {
  process.env.SMTP_HOST = 'smtp.test';
  process.env.REPORT_EMAIL_TO = 'founder@example.com';
  const sent = [];
  mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async (opts) => {
      sent.push(opts);
    },
  }));
  return sent;
}

// --- Drafting reaches nobody ---------------------------------------------------------

test('a draft can be written with no mailbox and no outreach scope at all', () => {
  const venture = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
  const reply = handlers.handleDraftCustomerEmail(
    { ventureId: venture.id, to: 'alice@acme.com', subject: 'Your jet-lag script', body: 'Hi Alice,', why: 'wrote her own shift script in issue #12' },
    { agentId: 'sales_commercial_manager' }
  );
  assert.match(reply, /Draft d1 saved/);
  assert.match(reply, /Nothing has been sent/);
  // And it says why it could not go out, at drafting time rather than at
  // approval time.
  assert.match(reply, /gates? shut/);
});

test('drafting spends no cap and logs no outreach', () => {
  const venture = sendableVenture();
  for (let i = 0; i < 5; i += 1) {
    handlers.handleDraftCustomerEmail(
      { ventureId: venture.id, to: `p${i}@acme.com`, subject: 's', body: 'b', why: 'w' },
      { agentId: 'sales_commercial_manager' }
    );
  }
  const after = ventures.getVenture(venture.id);
  assert.deepEqual(after.sentEmails ?? [], []);
  assert.equal(ventures.outreachHeadroom(after).today, 0);
  assert.equal(drafts.pendingDrafts().length, 5);
});

test('a draft with every gate open says so', () => {
  const venture = sendableVenture();
  smtpUp();
  const reply = handlers.handleDraftCustomerEmail(
    { ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' },
    { agentId: 'sales_commercial_manager' }
  );
  assert.match(reply, /Every gate is open/);
});

test('a handle is not enough to draft to', () => {
  const venture = sendableVenture();
  const reply = handlers.handleDraftCustomerEmail(
    { ventureId: venture.id, to: 'gh:alice', subject: 's', body: 'b', why: 'w' },
    { agentId: 'sales_commercial_manager' }
  );
  assert.match(reply, /Could not draft/);
  assert.match(reply, /pipeline with a handle/, 'and says where that lead does belong');
});

// --- Approval is an extra gate, never a substitute --------------------------------------

test('approving a draft does not widen the allowlist', async () => {
  const venture = sendableVenture(); // only @acme.com allowed
  const sent = smtpUp();
  const draft = drafts.createDraft({ ventureId: venture.id, to: 'ada@elsewhere.com', subject: 's', body: 'b', why: 'w' });

  drafts.approveDraft(draft.id);
  const { ok, message } = await handlers.releaseDraft(draft.id);

  assert.equal(ok, false);
  assert.match(message, /outside the allowed recipients/);
  assert.equal(sent.length, 0, 'nothing left the building');
  assert.equal(drafts.getDraft(draft.id).status, 'approved', 'and it stays queued rather than being marked sent');
});

test('approving a draft does not lift the kill switch', async () => {
  const venture = sendableVenture();
  const sent = smtpUp();
  const killSwitch = await import('../killSwitch.js');
  const draft = drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });

  killSwitch.haltRealActions('testing');
  try {
    drafts.approveDraft(draft.id);
    const { ok, message } = await handlers.releaseDraft(draft.id);
    assert.equal(ok, false);
    assert.match(message, /halted/i);
    assert.equal(sent.length, 0);
  } finally {
    killSwitch.resumeRealActions();
  }
});

test('a released draft carries the compliance footer like any other send', async () => {
  const venture = sendableVenture();
  const sent = smtpUp();
  const draft = drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'No footer here.', why: 'w' });

  drafts.approveDraft(draft.id);
  const { ok } = await handlers.releaseDraft(draft.id);

  assert.equal(ok, true);
  assert.equal(sent[0].to, 'alice@acme.com');
  assert.match(sent[0].text, /written and sent by an AI system/);
  assert.match(sent[0].text, /unsubscribe/);
});

test('a released draft spends the cap, because it is a real send', async () => {
  const venture = sendableVenture();
  smtpUp();
  const draft = drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });
  drafts.approveDraft(draft.id);
  await handlers.releaseDraft(draft.id);

  const after = ventures.getVenture(venture.id);
  assert.equal(after.sentEmails.length, 1);
  assert.equal(ventures.outreachHeadroom(after).today, 1);
  assert.equal(drafts.getDraft(draft.id).status, 'sent');
});

// --- The queue survives the config gap ---------------------------------------------------

// The usual reason a draft is stuck is that the mailbox was not configured when
// the founder said yes. That is a fact about the world, not a verdict on the
// message, so it must not fall out of the queue.
test('a refused send keeps the draft approved and records why', async () => {
  const venture = sendableVenture();
  // No SMTP configured at all.
  const draft = drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });
  drafts.approveDraft(draft.id);

  const { ok } = await handlers.releaseDraft(draft.id);
  assert.equal(ok, false);

  const after = drafts.getDraft(draft.id);
  assert.equal(after.status, 'approved', 'still queued');
  assert.match(after.lastError, /email delivery/i);
});

test('the sweep sends what it can and leaves the rest queued', async () => {
  const venture = sendableVenture();
  const sent = smtpUp();
  const good = drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });
  const bad = drafts.createDraft({ ventureId: venture.id, to: 'ada@elsewhere.com', subject: 's', body: 'b', why: 'w' });
  const unapproved = drafts.createDraft({ ventureId: venture.id, to: 'bob@acme.com', subject: 's', body: 'b', why: 'w' });
  drafts.approveDraft(good.id);
  drafts.approveDraft(bad.id);

  const result = await handlers.releaseApprovedDrafts();

  assert.equal(result.considered, 2, 'the unapproved one is not touched');
  assert.deepEqual(result.sent.map((d) => d.id), [good.id]);
  assert.equal(result.stuck.length, 1);
  assert.equal(drafts.getDraft(unapproved.id).status, 'pending');
  // Counted by recipient, not in total: a real send also copies the founder,
  // so a bare length here would be asserting the alert as well as the email.
  assert.deepEqual(sent.filter((m) => m.to === 'alice@acme.com').length, 1);
  assert.equal(sent.filter((m) => m.to === 'ada@elsewhere.com').length, 0, 'the refused one reached nobody');
});

test('a binned draft is never sent by the sweep', async () => {
  const venture = sendableVenture();
  const sent = smtpUp();
  const draft = drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });
  drafts.rejectDraft(draft.id, 'too pushy');

  const result = await handlers.releaseApprovedDrafts();
  assert.equal(result.considered, 0);
  assert.equal(sent.length, 0);
  assert.throws(() => drafts.approveDraft(draft.id), /was rejected/);
});

test('a sent draft cannot be re-sent or un-sent', async () => {
  const venture = sendableVenture();
  smtpUp();
  const draft = drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });
  drafts.approveDraft(draft.id);
  await handlers.releaseDraft(draft.id);

  assert.throws(() => drafts.approveDraft(draft.id), /already been sent/);
  assert.throws(() => drafts.rejectDraft(draft.id, 'oops'), /cannot be un-sent/);
  const again = await handlers.releaseDraft(draft.id);
  assert.equal(again.ok, false);
  assert.match(again.message, /already sent/);
});

// --- The founder's side ------------------------------------------------------------------

test('DRAFTS shows what is waiting, with the reason each person was chosen', async () => {
  const venture = sendableVenture();
  drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 'Your jet-lag script', body: 'b', why: 'filed issue #12 asking for exactly this' });

  const reply = await commands.runFounderCommand({ kind: 'drafts' }, {});
  assert.match(reply, /d1 → alice@acme\.com/);
  assert.match(reply, /issue #12/);
  assert.match(reply, /SEND d1/);
});

test('DRAFT d1 shows the message and says the footer is added later', async () => {
  const venture = sendableVenture();
  drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 'Subject here', body: 'The whole body.', why: 'w' });

  const reply = await commands.runFounderCommand({ kind: 'draft_show', draftId: 'd1' }, {});
  assert.match(reply, /The whole body\./);
  assert.match(reply, /added on send/);
});

test('SEND that cannot go out says so without reading as a rejection', async () => {
  const venture = sendableVenture();
  drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });

  const reply = await commands.runFounderCommand(
    { kind: 'draft_send', draftId: 'd1' },
    { releaseDraft: (id) => handlers.releaseDraft(id) }
  );
  assert.match(reply, /approved but did not go out/);
  assert.match(reply, /do not need to approve it again/);
  assert.equal(drafts.getDraft('d1').status, 'approved');
});

test('BIN records the reason and refuses to be approved afterwards', async () => {
  const venture = sendableVenture();
  drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 's', body: 'b', why: 'w' });

  const reply = await commands.runFounderCommand({ kind: 'draft_bin', draftId: 'd1', reason: 'too pushy' }, {});
  assert.match(reply, /Binned d1: too pushy/);
  assert.equal(drafts.getDraft('d1').reason, 'too pushy');
});

test('an unknown draft id says how to find the real ones', async () => {
  const reply = await commands.runFounderCommand({ kind: 'draft_show', draftId: 'd99' }, {});
  assert.match(reply, /No draft "d99"/);
  assert.match(reply, /DRAFTS/);
});

test('the help text lists the draft commands', () => {
  assert.match(commands.__helpForTests, /DRAFTS —/);
  assert.match(commands.__helpForTests, /SEND d1/);
});

// --- Agents are told what is queued ---------------------------------------------------------

test('the team is told what is already queued so it does not redraft', () => {
  const venture = sendableVenture();
  drafts.createDraft({ ventureId: venture.id, to: 'alice@acme.com', subject: 'Hello', body: 'b', why: 'w' });
  const text = drafts.describeDraftsForAgents();
  assert.match(text, /alice@acme\.com/);
  assert.match(text, /Do not redraft/);
});

test('with nothing queued the agents are told nothing at all', () => {
  assert.equal(drafts.describeDraftsForAgents(), '');
});
