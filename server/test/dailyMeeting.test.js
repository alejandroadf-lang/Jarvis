// Proves the specific, deliberate boundary described in dailyMeeting.js's
// file header: deploy_code and send_customer_email actually fire during the
// unattended leadership sync when a venture's scope is granted and enabled,
// while every other treasury/venture action (log_revenue, etc.) still
// isn't wired in at all. Uses a scripted fake Anthropic client (same
// pattern as agentRunner.test.js) so this never makes a real model call,
// plus a mocked global.fetch (deploy/github.js) so a "real" deploy never
// hits the real GitHub API.

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';

let tmpDir;
let dailyMeeting;
let ventures;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dailymeeting-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  dailyMeeting = await import('../dailyMeeting.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function textResponse(text) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 20, output_tokens: 10 } };
}

function toolUseResponse(toolName, input) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `tu_${toolName}`, name: toolName, input }],
    usage: { input_tokens: 40, output_tokens: 10 },
  };
}

// Scripted client: returns each response in `responses` in call order,
// shared across every recursive runAgent invocation (leadership's whole
// delegation tree, then the studio phase) since they all share one client.
function scriptedClient(responses) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        if (i >= responses.length) throw new Error(`scriptedClient ran out of responses at call ${i}`);
        return responses[i++];
      },
    },
  };
}

function makeActiveVenture(overrides = {}) {
  const v = ventures.createVenture({
    title: 'Widget Landing Co',
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

test('deploy_code actually fires during the unattended leadership sync for a venture with deployment enabled', async () => {
  const savedToken = process.env.GITHUB_TOKEN;
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

    // ceo -> consult_cto -> cto -> consult_engineering_lead -> engineering_lead -> deploy_code -> ... -> studio phase
    const anthropic = scriptedClient([
      toolUseResponse('consult_cto', { task: 'check on engineering' }),
      toolUseResponse('consult_engineering_lead', { task: 'anything ready to ship?' }),
      toolUseResponse('deploy_code', {
        ventureId: v.id,
        path: 'content/home.md',
        content: '# Updated homepage',
        message: 'update homepage copy',
        rationale: 'daily sync judged this ready',
      }),
      textResponse('Deployed the homepage update.'),
      textResponse('CTO: engineering shipped a real update today.'),
      textResponse('Leadership sync complete: nothing else notable.'),
      textResponse('Nothing clears the bar for a new venture today.'),
    ]);

    const report = await dailyMeeting.runDailyMeeting({ anthropic });

    assert.equal(report.leadership.reply, 'Leadership sync complete: nothing else notable.');
    assert.equal(report.studio.reply, 'Nothing clears the bar for a new venture today.');

    const updated = ventures.getVenture(v.id);
    assert.equal(updated.deployments.length, 1);
    assert.equal(updated.deployments[0].commitSha, 'sha1');
  } finally {
    global.fetch = originalFetch;
    if (savedToken !== undefined) process.env.GITHUB_TOKEN = savedToken;
    else delete process.env.GITHUB_TOKEN;
  }
});

test('send_customer_email actually fires during the unattended leadership sync for a venture with outreach enabled', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'founder@example.com';
  const mockedTransport = mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {},
  }));

  try {
    const v = makeActiveVenture({ title: 'Outreach Co' });
    ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });
    ventures.setOutreachEnabled(v.id, true);

    // ceo -> consult_coo -> coo -> consult_sales_commercial_manager -> send_customer_email -> ... -> studio phase
    const anthropic = scriptedClient([
      toolUseResponse('consult_coo', { task: 'check on sales' }),
      toolUseResponse('consult_sales_commercial_manager', { task: 'any follow-ups ready to send?' }),
      toolUseResponse('send_customer_email', {
        ventureId: v.id,
        to: 'jane@acme.com',
        subject: 'Following up',
        body: 'Here is the proposal we discussed.',
      }),
      textResponse('Sent the follow-up.'),
      textResponse('COO: sales sent a real follow-up today.'),
      textResponse('Leadership sync complete.'),
      textResponse('Nothing clears the bar for a new venture today.'),
    ]);

    const report = await dailyMeeting.runDailyMeeting({ anthropic });

    assert.equal(report.leadership.reply, 'Leadership sync complete.');

    const updated = ventures.getVenture(v.id);
    assert.equal(updated.sentEmails.length, 1);
    assert.equal(updated.sentEmails[0].to, 'jane@acme.com');
  } finally {
    mockedTransport.mock.restore();
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    else delete process.env.SMTP_HOST;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
    else delete process.env.REPORT_EMAIL_TO;
  }
});

test('log_revenue is still not wired into the leadership sync — it resolves as an unknown tool', async () => {
  // ceo -> consult_cfo -> cfo -> consult_finance_manager -> finance_manager tries log_revenue
  const anthropic = scriptedClient([
    toolUseResponse('consult_cfo', { task: 'check on finance' }),
    toolUseResponse('consult_finance_manager', { task: 'log something' }),
    toolUseResponse('log_revenue', { amount: 50, description: 'made up revenue' }),
    textResponse('Finance manager: could not log it.'),
    textResponse('CFO summary.'),
    textResponse('Leadership sync complete.'),
    textResponse('Nothing clears the bar for a new venture today.'),
  ]);

  const report = await dailyMeeting.runDailyMeeting({ anthropic });
  assert.equal(report.leadership.reply, 'Leadership sync complete.');
  // Confirmed indirectly: the finance_manager's own trace/text isn't asserted
  // here since it's synthesized away by the CFO, but the ledger must be
  // untouched — the real proof that log_revenue never actually ran.
  const ledger = (await import('../finance/ledger.js')).getLedger();
  assert.equal(ledger.transactions.some((t) => t.description === 'made up revenue'), false);
});
