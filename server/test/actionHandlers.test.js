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
let savedGithubToken;
let originalFetch;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-actionhandlers-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  // Email is opt-in; make sure these tests exercise the actual no-SMTP path
  // regardless of what's set in the ambient environment.
  savedSmtpHost = process.env.SMTP_HOST;
  savedReportTo = process.env.REPORT_EMAIL_TO;
  savedGithubToken = process.env.GITHUB_TOKEN;
  originalFetch = global.fetch;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  actionHandlers = await import('../actionHandlers.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedSmtpHost !== undefined) process.env.SMTP_HOST = savedSmtpHost;
  if (savedReportTo !== undefined) process.env.REPORT_EMAIL_TO = savedReportTo;
  if (savedGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedGithubToken;
  global.fetch = originalFetch;
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

function makeActiveVenture(overrides = {}) {
  const v = ventures.createVenture({
    title: 'Deployable Venture',
    oneLiner: 'x',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    budgetRequested: 10,
    milestones: ['ship it'],
    ...overrides,
  });
  ventures.activateVenture(v.id);
  return v;
}

test('handleDeployCode refuses when GITHUB_TOKEN is not configured', async () => {
  const savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const v = makeActiveVenture();
    const result = await actionHandlers.handleDeployCode({
      ventureId: v.id,
      path: 'content/home.md',
      content: '# hi',
      message: 'update',
    });
    assert.match(result, /no GITHUB_TOKEN configured/);
  } finally {
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
  }
});

test('handleDeployCode validates path and content are present', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  const v = makeActiveVenture();
  assert.match(await actionHandlers.handleDeployCode({ ventureId: v.id, content: 'x', message: 'm' }), /path is required/);
  assert.match(await actionHandlers.handleDeployCode({ ventureId: v.id, path: 'a.md', message: 'm' }), /content is required/);
});

test('handleDeployCode surfaces the scope violation when the venture has no repo linked', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  const v = makeActiveVenture();
  const result = await actionHandlers.handleDeployCode({
    ventureId: v.id,
    path: 'content/home.md',
    content: '# hi',
    message: 'update',
  });
  assert.match(result, /No repo linked/);
});

test('handleDeployCode commits within scope and records the deployment', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (options?.method === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, json: async () => ({ commit: { sha: 'sha1', html_url: 'https://github.com/acme/landing/commit/sha1' } }) };
  };

  try {
    const v = makeActiveVenture();
    ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });
    ventures.setDeploymentEnabled(v.id, true);

    const result = await actionHandlers.handleDeployCode({
      ventureId: v.id,
      path: 'content/home.md',
      content: '# New homepage',
      message: 'update homepage copy',
      rationale: 'founder asked for it',
    });

    assert.match(result, /Deployed a real commit/);
    assert.match(result, /content\/home\.md/);
    const updated = ventures.getVenture(v.id);
    assert.equal(updated.deployments.length, 1);
    assert.equal(updated.deployments[0].commitSha, 'sha1');
  } finally {
    global.fetch = originalFetch;
  }
});
