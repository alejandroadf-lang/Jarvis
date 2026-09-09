import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let actionHandlers;
let ventures;
let savedSmtpHost;
let savedReportTo;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-actionhandlers-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  // Email is opt-in; make sure these tests exercise the actual no-SMTP path
  // regardless of what's set in the ambient environment.
  savedSmtpHost = process.env.SMTP_HOST;
  savedReportTo = process.env.REPORT_EMAIL_TO;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  actionHandlers = await import('../actionHandlers.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedSmtpHost !== undefined) process.env.SMTP_HOST = savedSmtpHost;
  if (savedReportTo !== undefined) process.env.REPORT_EMAIL_TO = savedReportTo;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('handleProposeVenture logs the venture and returns normally with no SMTP configured', async () => {
  const result = await actionHandlers.handleProposeVenture({
    title: 'Test Venture',
    oneLiner: 'Does a thing',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    budgetRequested: 20,
    milestones: ['ship it'],
  });

  assert.match(result, /Logged venture proposal/);
  assert.match(result, /Test Venture/);
  assert.equal(ventures.listVentures().length, 1);
});

test('handleRequestTranche records the request and returns normally with no SMTP configured', async () => {
  const v = ventures.createVenture({
    title: 'Active Venture',
    oneLiner: 'x',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    budgetRequested: 10,
    milestones: ['first step'],
  });
  ventures.activateVenture(v.id);

  const result = await actionHandlers.handleRequestTranche({
    ventureId: v.id,
    amount: 15,
    description: 'second step',
  });

  assert.match(result, /Requested a \$15 tranche/);
  assert.equal(ventures.getVenture(v.id).pendingTranche.amount, 15);
});
