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
