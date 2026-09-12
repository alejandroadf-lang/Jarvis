// The founder's controls exist to bound agents. Making them agent tools
// would have been the obvious way to put them on WhatsApp and would have
// destroyed the thing they protect — an allowlist an agent can widen bounds
// nothing. So they are parsed deterministically from the founder's own
// message, and these tests are mostly about the boundary: what counts as a
// command, and more importantly what doesn't.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let commands;
let ventures;
let killSwitch;
const saved = {};
const KEYS = ['REAL_ACTIONS_DISABLED', 'DAILY_SPEND_CAP_USD'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-founder-cmd-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.REAL_ACTIONS_DISABLED;
  commands = await import('../channels/founderCommands.js');
  ventures = await import('../finance/ventures.js');
  killSwitch = await import('../killSwitch.js');
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
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
  fs.rmSync(path.join(tmpDir, 'killSwitch.json'), { force: true });
});

function newVenture() {
  return ventures.createVenture({ title: 'Burnout Scorer', milestones: ['ship'] });
}

test('an ordinary message is not a command', () => {
  // This is the test that matters most. Every false positive here is the
  // founder saying something and the company doing something else.
  const notCommands = [
    'we should halt the acme rollout until legal signs off',
    'can you stop by the outreach numbers tomorrow',
    'what did we spend on the deploy',
    'resume the conversation about pricing',
    'deploy on friday if CI is green',
    'help the CTO think through the schema',
  ];
  for (const text of notCommands) {
    assert.equal(commands.parseFounderCommand(text), null, `"${text}" must reach the team, not the switchboard`);
  }
});

test('a bare command is a command', () => {
  assert.deepEqual(commands.parseFounderCommand('HALT'), { kind: 'halt', reason: null });
  assert.deepEqual(commands.parseFounderCommand('  resume '), { kind: 'resume' });
  assert.deepEqual(commands.parseFounderCommand('ventures'), { kind: 'ventures' });
  assert.deepEqual(commands.parseFounderCommand('Spend'), { kind: 'spend' });
});

test('HALT carries the reason the founder gave', async () => {
  const parsed = commands.parseFounderCommand('HALT the CTO is looping on the same commit');
  assert.equal(parsed.reason, 'the CTO is looping on the same commit');
  const reply = await commands.runFounderCommand(parsed);
  assert.match(reply, /looping on the same commit/);
  assert.equal(killSwitch.getKillSwitch().halted, true);
});

test('HALT actually stops real actions, and RESUME lifts it', async () => {
  await commands.runFounderCommand({ kind: 'halt', reason: 'testing' });
  assert.throws(() => killSwitch.assertRealActionsAllowed(), /testing/);

  await commands.runFounderCommand({ kind: 'resume' });
  assert.doesNotThrow(() => killSwitch.assertRealActionsAllowed());
});

test('granting outreach sets the allowlist and turns it on in one message', async () => {
  const v = newVenture();
  const parsed = commands.parseFounderCommand(`outreach ${v.id} @acme.com, someone@corp.com`);
  assert.deepEqual(parsed.recipients, ['@acme.com', 'someone@corp.com']);

  await commands.runFounderCommand(parsed);
  const after = ventures.getVenture(v.id);
  assert.equal(after.outreach.enabled, true);
  assert.deepEqual(after.outreach.allowedRecipients, ['@acme.com', 'someone@corp.com']);
  // The grant is the whole point: a send outside it is still refused.
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'stranger@elsewhere.com' }), /outside the allowed/);
  assert.doesNotThrow(() => ventures.authorizeOutreach(v.id, { to: 'anyone@acme.com' }));
});

test('OUTREACH OFF revokes without losing the allowlist', async () => {
  const v = newVenture();
  await commands.runFounderCommand(commands.parseFounderCommand(`outreach ${v.id} @acme.com`));
  await commands.runFounderCommand(commands.parseFounderCommand(`outreach off ${v.id}`));

  const off = ventures.getVenture(v.id);
  assert.equal(off.outreach.enabled, false);
  assert.deepEqual(off.outreach.allowedRecipients, ['@acme.com'], 'revoking is not forgetting');

  await commands.runFounderCommand(commands.parseFounderCommand(`outreach on ${v.id}`));
  assert.equal(ventures.getVenture(v.id).outreach.enabled, true);
});

test('DEPLOY OFF stops commits without unlinking the repo', async () => {
  const v = newVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'burnout', allowedPaths: ['src/'] });
  ventures.setDeploymentEnabled(v.id, true);

  await commands.runFounderCommand(commands.parseFounderCommand(`deploy off ${v.id}`));
  const off = ventures.getVenture(v.id);
  assert.equal(off.repo.enabled, false);
  assert.equal(off.repo.name, 'burnout', 'the link survives so DEPLOY ON is enough to undo this');
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'src/a.ts' }), /not enabled/);
});

test('an outreach grant with no recipients is not treated as a grant', () => {
  // Creating an empty allowlist would read as success and block every send.
  assert.equal(commands.parseFounderCommand('outreach v_123   '), null);
});

test('VENTURES answers the question that blocked everything: what is the id', async () => {
  const v = newVenture();
  ventures.linkRepo(v.id, { owner: 'acme', name: 'burnout', allowedPaths: ['src/'] });
  const reply = await commands.runFounderCommand({ kind: 'ventures' });
  assert.match(reply, new RegExp(v.id), 'the id must be in the reply, verbatim and copyable');
  assert.match(reply, /acme\/burnout/);
  assert.match(reply, /deploy off/i, 'and what it is currently allowed to do');
});

test('HELP lists the controls, including the ones that revoke', async () => {
  const reply = await commands.runFounderCommand({ kind: 'help' });
  for (const expected of ['HALT', 'RESUME', 'VENTURES', 'OUTREACH OFF', 'DEPLOY OFF', 'SPEND']) {
    assert.ok(reply.includes(expected), `HELP must mention ${expected}`);
  }
});

test('a command against a venture that does not exist says so', async () => {
  await assert.rejects(
    async () => commands.runFounderCommand({ kind: 'deploy_off', ventureId: 'v_nope' }),
    /not found/i
  );
});
