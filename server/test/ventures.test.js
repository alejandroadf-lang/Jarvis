import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ventures-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeVenture(overrides = {}) {
  return ventures.createVenture({
    title: 'Test Venture',
    oneLiner: 'Does a thing',
    problem: 'A problem',
    targetCustomer: 'Someone',
    businessModel: 'Subscription',
    marketSize: 'Big',
    pathToMillions: 'Scale it',
    budgetRequested: 20,
    milestones: ['Ship an MVP', 'Get first customer'],
    ...overrides,
  });
}

test('createVenture normalizes string milestones and starts proposed', () => {
  const v = makeVenture();
  assert.equal(v.status, 'proposed');
  assert.equal(v.milestones.length, 2);
  assert.deepEqual(v.milestones[0], { title: 'Ship an MVP', status: 'pending' });
  assert.equal(v.pendingTranche, null);
  assert.deepEqual(v.tranches, []);
});

test('activateVenture flips status and rejects a second activation', () => {
  const v = makeVenture();
  const activated = ventures.activateVenture(v.id);
  assert.equal(activated.status, 'active');
  assert.throws(() => ventures.activateVenture(v.id), /already active/);
});

test('setMilestoneStatus updates the right milestone and validates status', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  const updated = ventures.setMilestoneStatus(v.id, 0, 'done', 'shipped it');
  assert.equal(updated.milestones[0].status, 'done');
  assert.equal(updated.milestones[0].note, 'shipped it');
  assert.equal(updated.milestones[1].status, 'pending');
  assert.throws(() => ventures.setMilestoneStatus(v.id, 0, 'bogus'), /Invalid milestone status/);
  assert.throws(() => ventures.setMilestoneStatus(v.id, 99, 'done'), /No milestone at index/);
});

test('tranche lifecycle: request requires active status and blocks concurrent requests', () => {
  const v = makeVenture();
  assert.throws(
    () => ventures.requestTranche(v.id, { amount: 10, description: 'next step' }),
    /must be active/
  );

  ventures.activateVenture(v.id);
  const withPending = ventures.requestTranche(v.id, { amount: 10, description: 'next step' });
  assert.ok(withPending.pendingTranche);
  assert.equal(withPending.pendingTranche.amount, 10);

  assert.throws(
    () => ventures.requestTranche(v.id, { amount: 5, description: 'another' }),
    /already pending/
  );
});

test('approveTranche clears the pending request and records history', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.requestTranche(v.id, { amount: 15, description: 'next step' });

  const { venture, tranche } = ventures.approveTranche(v.id);
  assert.equal(venture.pendingTranche, null);
  assert.equal(venture.tranches.length, 1);
  assert.equal(tranche.amount, 15);
  assert.ok(tranche.approvedAt);

  assert.throws(() => ventures.approveTranche(v.id), /No pending tranche/);
});

test('denyTranche clears the pending request without recording history', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.requestTranche(v.id, { amount: 15, description: 'next step' });

  const denied = ventures.denyTranche(v.id);
  assert.equal(denied.pendingTranche, null);
  assert.equal(denied.tranches.length, 0);

  assert.throws(() => ventures.denyTranche(v.id), /No pending tranche/);
});

test('killVenture sets status, reason, and clears any pending tranche', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.requestTranche(v.id, { amount: 15, description: 'next step' });

  const killed = ventures.killVenture(v.id, 'market did not want this');
  assert.equal(killed.status, 'killed');
  assert.equal(killed.killReason, 'market did not want this');
  assert.equal(killed.pendingTranche, null);

  assert.throws(() => ventures.killVenture(v.id, 'again'), /already killed/);
});

test('getVenture returns null for an unknown id, findOrThrow paths error clearly', () => {
  assert.equal(ventures.getVenture('nope'), null);
  assert.throws(() => ventures.activateVenture('nope'), /Venture not found/);
});

test('authorizeDeployment refuses an inactive venture, an unlinked repo, and a disabled scope', () => {
  const v = makeVenture();
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/home.md' }), /must be active/);

  ventures.activateVenture(v.id);
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/home.md' }), /No repo linked/);

  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/home.md' }), /not enabled/);
});

test('authorizeDeployment enforces the path allowlist once enabled', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/', 'config.json'] });
  ventures.setDeploymentEnabled(v.id, true);

  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'content/home.md' }));
  assert.doesNotThrow(() => ventures.authorizeDeployment(v.id, { path: 'config.json' }));
  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'server/index.js' }), /outside the allowed scope/);
});

test('authorizeDeployment enforces the weekly cap from recordDeployment history', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'], maxPerWeek: 2 });
  ventures.setDeploymentEnabled(v.id, true);

  ventures.recordDeployment(v.id, { path: 'content/a.md', message: 'a', commitSha: 's1', commitUrl: 'u1' });
  ventures.recordDeployment(v.id, { path: 'content/b.md', message: 'b', commitSha: 's2', commitUrl: 'u2' });

  assert.throws(() => ventures.authorizeDeployment(v.id, { path: 'content/c.md' }), /Weekly deployment cap reached/);
});

test('setDeploymentEnabled requires a linked repo first', () => {
  const v = makeVenture();
  assert.throws(() => ventures.setDeploymentEnabled(v.id, true), /Link a repo before/);
});

test('recordDeployment appends to the deployment log with a timestamp', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });

  const { venture, entry } = ventures.recordDeployment(v.id, {
    path: 'content/home.md',
    message: 'update copy',
    commitSha: 'abc123',
    commitUrl: 'https://github.com/acme/landing/commit/abc123',
    rationale: 'founder asked for new headline',
  });
  assert.equal(venture.deployments.length, 1);
  assert.equal(entry.path, 'content/home.md');
  assert.equal(entry.commitSha, 'abc123');
  assert.ok(entry.deployedAt);
  assert.equal(entry.triggeredBy, 'interactive'); // default when not specified
});

test('recordDeployment records triggeredBy as daily_cycle when told to, and normalizes anything else to interactive', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });

  const daily = ventures.recordDeployment(v.id, { path: 'content/a.md', triggeredBy: 'daily_cycle' });
  assert.equal(daily.entry.triggeredBy, 'daily_cycle');

  const bogus = ventures.recordDeployment(v.id, { path: 'content/b.md', triggeredBy: 'something_else' });
  assert.equal(bogus.entry.triggeredBy, 'interactive');
});

test('authorizeOutreach refuses an inactive venture, an unset scope, and a disabled scope', () => {
  const v = makeVenture();
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'x@acme.com' }), /must be active/);

  ventures.activateVenture(v.id);
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'x@acme.com' }), /No outreach scope/);

  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'x@acme.com' }), /not enabled/);
});

test('authorizeOutreach enforces the recipient allowlist, matching exact addresses and whole domains', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['jane@acme.com', '@partner.com'] });
  ventures.setOutreachEnabled(v.id, true);

  assert.doesNotThrow(() => ventures.authorizeOutreach(v.id, { to: 'jane@acme.com' }));
  assert.doesNotThrow(() => ventures.authorizeOutreach(v.id, { to: 'anyone@partner.com' }));
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'someoneelse@acme.com' }), /outside the allowed recipients/);
  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'random@nowhere.com' }), /outside the allowed recipients/);
});

test('authorizeOutreach enforces the weekly cap from recordOutreach history', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'], maxPerWeek: 2 });
  ventures.setOutreachEnabled(v.id, true);

  ventures.recordOutreach(v.id, { to: 'a@acme.com', subject: 'a', body: 'x' });
  ventures.recordOutreach(v.id, { to: 'b@acme.com', subject: 'b', body: 'x' });

  assert.throws(() => ventures.authorizeOutreach(v.id, { to: 'c@acme.com' }), /Weekly outreach cap reached/);
});

test('setOutreachEnabled requires a scope to already be set up', () => {
  const v = makeVenture();
  assert.throws(() => ventures.setOutreachEnabled(v.id, true), /Set up an outreach scope before/);
});

test('recordOutreach appends to the sent-email log with a timestamp', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });

  const { venture, entry } = ventures.recordOutreach(v.id, {
    to: 'jane@acme.com',
    subject: 'Following up',
    body: 'Here is the proposal we discussed.',
  });
  assert.equal(venture.sentEmails.length, 1);
  assert.equal(entry.to, 'jane@acme.com');
  assert.equal(entry.subject, 'Following up');
  assert.ok(entry.sentAt);
  assert.equal(entry.triggeredBy, 'interactive'); // default when not specified
});

test('recordOutreach records triggeredBy as daily_cycle when told to, and normalizes anything else to interactive', () => {
  const v = makeVenture();
  ventures.activateVenture(v.id);
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });

  const daily = ventures.recordOutreach(v.id, { to: 'a@acme.com', triggeredBy: 'daily_cycle' });
  assert.equal(daily.entry.triggeredBy, 'daily_cycle');

  const bogus = ventures.recordOutreach(v.id, { to: 'b@acme.com', triggeredBy: 'something_else' });
  assert.equal(bogus.entry.triggeredBy, 'interactive');
});
