import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';

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

test('handleProposeVenture starts the venture and returns normally with no SMTP configured', async () => {
  const result = await actionHandlers.handleProposeVenture({
    title: 'Test Venture',
    oneLiner: 'Does a thing',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    milestones: ['ship it'],
  });

  assert.match(result, /Started venture/);
  assert.match(result, /Test Venture/);
  // The reply has to be clear on both halves of the new model: the venture
  // is live without anyone approving it, and being live buys it nothing in
  // the real world until the founder grants it scope.
  assert.match(result, /active now/);
  assert.match(result, /no real-world reach yet/);
  assert.equal(ventures.listVentures().length, 1);
  assert.equal(ventures.listVentures()[0].status, 'active');
});

// request_tranche was the CFO's way to ask the founder for more of the seed.
// With no seed there is nothing to ask for, so the handler is gone rather
// than left as a no-op an agent could still call and believe worked.
test('handleRequestTranche is gone along with the funding model', () => {
  assert.equal(actionHandlers.handleRequestTranche, undefined);
});

function makeActiveVenture(overrides = {}) {
  return ventures.createVenture({
    title: 'Deployable Venture',
    oneLiner: 'x',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    milestones: ['ship it'],
    ...overrides,
  });
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
    assert.equal(updated.deployments[0].triggeredBy, 'interactive'); // default when no second arg is passed
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleDeployCode records triggeredBy as daily_cycle when called with that explicit second argument', async () => {
  process.env.GITHUB_TOKEN = 'test-token';
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (options?.method === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, json: async () => ({ commit: { sha: 'sha2', html_url: 'https://github.com/acme/landing/commit/sha2' } }) };
  };

  try {
    const v = makeActiveVenture();
    ventures.linkRepo(v.id, { owner: 'acme', name: 'landing', allowedPaths: ['content/'] });
    ventures.setDeploymentEnabled(v.id, true);

    await actionHandlers.handleDeployCode(
      { ventureId: v.id, path: 'content/home.md', content: '# hi', message: 'm' },
      'daily_cycle'
    );

    const updated = ventures.getVenture(v.id);
    assert.equal(updated.deployments[0].triggeredBy, 'daily_cycle');
  } finally {
    global.fetch = originalFetch;
  }
});

function withSmtpConfigured(fn) {
  return async () => {
    const savedHost = process.env.SMTP_HOST;
    const savedTo = process.env.REPORT_EMAIL_TO;
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.REPORT_EMAIL_TO = 'founder@example.com';
    try {
      await fn();
    } finally {
      if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
      else delete process.env.SMTP_HOST;
      if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
      else delete process.env.REPORT_EMAIL_TO;
    }
  };
}

test('handleSendCustomerEmail refuses when email delivery is not configured', async () => {
  // No SMTP configured — the top-level before() already cleared it.
  const v = makeActiveVenture();
  const result = await actionHandlers.handleSendCustomerEmail({
    ventureId: v.id,
    to: 'jane@acme.com',
    subject: 'Hi',
    body: 'Body',
  });
  assert.match(result, /no email delivery configured/);
});

test(
  'handleSendCustomerEmail validates to, subject, and body are present',
  withSmtpConfigured(async () => {
    const v = makeActiveVenture();
    assert.match(
      await actionHandlers.handleSendCustomerEmail({ ventureId: v.id, subject: 's', body: 'b' }),
      /to is required/
    );
    assert.match(
      await actionHandlers.handleSendCustomerEmail({ ventureId: v.id, to: 'a@b.com', body: 'b' }),
      /subject is required/
    );
    assert.match(
      await actionHandlers.handleSendCustomerEmail({ ventureId: v.id, to: 'a@b.com', subject: 's' }),
      /body is required/
    );
  })
);

test(
  'handleSendCustomerEmail surfaces the scope violation when no outreach scope is set up',
  withSmtpConfigured(async () => {
    const v = makeActiveVenture();
    const result = await actionHandlers.handleSendCustomerEmail({
      ventureId: v.id,
      to: 'jane@acme.com',
      subject: 'Hi',
      body: 'Body',
    });
    assert.match(result, /No outreach scope/);
  })
);

test(
  'handleSendCustomerEmail sends within scope and records the outreach',
  withSmtpConfigured(async () => {
    const sentMail = [];
    const mockedTransport = mock.method(nodemailer, 'createTransport', () => ({
      sendMail: async (opts) => {
        sentMail.push(opts);
      },
    }));

    try {
      const v = makeActiveVenture();
      ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });
      ventures.setOutreachEnabled(v.id, true);

      const result = await actionHandlers.handleSendCustomerEmail({
        ventureId: v.id,
        to: 'jane@acme.com',
        subject: 'Proposal follow-up',
        body: 'Here is the proposal we discussed.',
      });

      assert.match(result, /Sent a real email to jane@acme\.com/);
      // One send to the real customer, one audit alert back to the founder.
      assert.equal(sentMail.length, 2);
      assert.equal(sentMail[0].to, 'jane@acme.com');
      assert.equal(sentMail[1].to, 'founder@example.com');

      const updated = ventures.getVenture(v.id);
      assert.equal(updated.sentEmails.length, 1);
      assert.equal(updated.sentEmails[0].to, 'jane@acme.com');
      assert.equal(updated.sentEmails[0].triggeredBy, 'interactive'); // default when no second arg is passed
    } finally {
      mockedTransport.mock.restore();
    }
  })
);

test(
  'handleSendCustomerEmail records triggeredBy as daily_cycle when called with that explicit second argument',
  withSmtpConfigured(async () => {
    const mockedTransport = mock.method(nodemailer, 'createTransport', () => ({
      sendMail: async () => {},
    }));

    try {
      const v = makeActiveVenture();
      ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });
      ventures.setOutreachEnabled(v.id, true);

      await actionHandlers.handleSendCustomerEmail(
        { ventureId: v.id, to: 'jane@acme.com', subject: 'Hi', body: 'Body' },
        'daily_cycle'
      );

      const updated = ventures.getVenture(v.id);
      assert.equal(updated.sentEmails[0].triggeredBy, 'daily_cycle');
    } finally {
      mockedTransport.mock.restore();
    }
  })
);
