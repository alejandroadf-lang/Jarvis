import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReportEmail,
  sendDailyReportEmail,
  formatTrancheRequestEmail,
  sendTrancheRequestEmail,
  formatVentureProposedEmail,
  sendVentureProposedEmail,
  formatWeeklyReflectionEmail,
  sendWeeklyReflectionEmail,
  formatDeploymentEmail,
  sendDeploymentEmail,
  isEmailConfigured,
  sendCustomerEmail,
  formatOutreachAlertEmail,
  sendOutreachAlertEmail,
} from '../email.js';

function makeReport(overrides = {}) {
  return {
    date: '2026-03-05',
    generatedAt: '2026-03-05T01:00:00.000Z',
    leadership: { reply: 'CTO: shipping steadily.\nCFO: runway healthy.', trace: [] },
    studio: { reply: 'Nothing clears the bar today.', trace: [] },
    proposedVentureIds: [],
    treasury: { balance: 70, startingCapital: 100 },
    ...overrides,
  };
}

test('formatReportEmail includes the date in the subject', () => {
  const { subject } = formatReportEmail(makeReport());
  assert.match(subject, /2026-03-05/);
});

test('formatReportEmail body includes treasury, leadership, and studio sections', () => {
  const { text } = formatReportEmail(makeReport());
  assert.match(text, /\$70\.00 \/ \$100/);
  assert.match(text, /Leadership Sync/);
  assert.match(text, /CTO: shipping steadily\./);
  assert.match(text, /Opportunity Review/);
  assert.match(text, /Nothing clears the bar today\./);
});

test('formatReportEmail mentions new venture proposals only when there are some', () => {
  const withProposals = formatReportEmail(makeReport({ proposedVentureIds: ['v_1', 'v_2'] }));
  assert.match(withProposals.text, /New venture proposals logged today: v_1, v_2/);

  const without = formatReportEmail(makeReport());
  assert.doesNotMatch(without.text, /New venture proposal/);
});

test('sendDailyReportEmail is a no-op (returns false, does not throw) without SMTP_HOST/REPORT_EMAIL_TO', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  try {
    const sent = await sendDailyReportEmail(makeReport());
    assert.equal(sent, false);
  } finally {
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
  }
});

function makeVenture(overrides = {}) {
  return {
    id: 'v_1',
    title: 'Widget Co',
    oneLiner: 'Widgets for people who need widgets',
    budgetRequested: 25,
    pendingTranche: { amount: 15, description: 'next milestone' },
    ...overrides,
  };
}

test('formatTrancheRequestEmail names the venture, amount, and purpose', () => {
  const { subject, text } = formatTrancheRequestEmail(makeVenture());
  assert.match(subject, /Widget Co/);
  assert.match(subject, /Action needed/);
  assert.match(text, /\$15/);
  assert.match(text, /next milestone/);
});

test('formatVentureProposedEmail names the venture and asking amount', () => {
  const { subject, text } = formatVentureProposedEmail(makeVenture());
  assert.match(subject, /Widget Co/);
  assert.match(text, /Widgets for people who need widgets/);
  assert.match(text, /\$25/);
});

test('sendTrancheRequestEmail and sendVentureProposedEmail are no-ops without SMTP configured', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  try {
    assert.equal(await sendTrancheRequestEmail(makeVenture()), false);
    assert.equal(await sendVentureProposedEmail(makeVenture()), false);
  } finally {
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
  }
});

function makeReflection(overrides = {}) {
  return {
    weekEnding: '2026-01-04',
    generatedAt: '2026-01-04T01:30:00.000Z',
    reportsConsidered: 7,
    reflection: 'Only one flagged opportunity got followed up on this week.',
    trace: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0.001,
    durationMs: 5000,
    ...overrides,
  };
}

test('formatWeeklyReflectionEmail includes the week and the reflection text', () => {
  const { subject, text } = formatWeeklyReflectionEmail(makeReflection());
  assert.match(subject, /2026-01-04/);
  assert.match(text, /7 daily report/);
  assert.match(text, /Only one flagged opportunity/);
});

test('sendWeeklyReflectionEmail is a no-op without SMTP configured', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  try {
    assert.equal(await sendWeeklyReflectionEmail(makeReflection()), false);
  } finally {
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
  }
});

function makeDeployedVenture(overrides = {}) {
  return {
    id: 'v_1',
    title: 'Widget Co',
    repo: { owner: 'acme', name: 'widget-landing', branch: 'main' },
    ...overrides,
  };
}

test('formatDeploymentEmail names the venture, repo, file, and commit', () => {
  const { subject, text } = formatDeploymentEmail(makeDeployedVenture(), {
    path: 'content/home.md',
    commitUrl: 'https://github.com/acme/widget-landing/commit/abc123',
  });
  assert.match(subject, /Widget Co/);
  assert.match(subject, /content\/home\.md/);
  assert.match(text, /acme\/widget-landing \(main\)/);
  assert.match(text, /content\/home\.md/);
  assert.match(text, /https:\/\/github\.com\/acme\/widget-landing\/commit\/abc123/);
});

test('formatDeploymentEmail omits the commit line when no commitUrl is given', () => {
  const { text } = formatDeploymentEmail(makeDeployedVenture(), { path: 'content/home.md', commitUrl: '' });
  assert.doesNotMatch(text, /Commit:/);
});

test('formatDeploymentEmail names the trigger source: a live conversation by default, the unattended daily cycle when told', () => {
  const interactive = formatDeploymentEmail(makeDeployedVenture(), { path: 'content/home.md', commitUrl: '' });
  assert.match(interactive.text, /Triggered by: a live Executive Team conversation/);

  const autonomous = formatDeploymentEmail(makeDeployedVenture(), {
    path: 'content/home.md',
    commitUrl: '',
    triggeredBy: 'daily_cycle',
  });
  assert.match(autonomous.text, /Triggered by: the unattended daily leadership sync/);
});

test('sendDeploymentEmail is a no-op without SMTP configured', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  try {
    assert.equal(
      await sendDeploymentEmail(makeDeployedVenture(), { path: 'content/home.md', commitUrl: 'u' }),
      false
    );
  } finally {
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
  }
});

test('isEmailConfigured reflects whether SMTP_HOST and REPORT_EMAIL_TO are both set', () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;

  try {
    delete process.env.SMTP_HOST;
    delete process.env.REPORT_EMAIL_TO;
    assert.equal(isEmailConfigured(), false);

    process.env.SMTP_HOST = 'smtp.example.com';
    assert.equal(isEmailConfigured(), false); // still missing REPORT_EMAIL_TO

    process.env.REPORT_EMAIL_TO = 'founder@example.com';
    assert.equal(isEmailConfigured(), true);
  } finally {
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    else delete process.env.SMTP_HOST;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
    else delete process.env.REPORT_EMAIL_TO;
  }
});

test('sendCustomerEmail is a no-op without SMTP configured', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  try {
    assert.equal(await sendCustomerEmail('jane@acme.com', 'Hi', 'Body text'), false);
  } finally {
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
  }
});

test('formatOutreachAlertEmail names the venture, recipient, and subject', () => {
  const { subject, text } = formatOutreachAlertEmail(makeDeployedVenture(), {
    to: 'jane@acme.com',
    subject: 'Proposal follow-up',
  });
  assert.match(subject, /Widget Co/);
  assert.match(subject, /jane@acme\.com/);
  assert.match(text, /Sales & Commercial Manager/);
  assert.match(text, /To: jane@acme\.com/);
  assert.match(text, /Subject: Proposal follow-up/);
});

test('formatOutreachAlertEmail names the trigger source: a live conversation by default, the unattended daily cycle when told', () => {
  const interactive = formatOutreachAlertEmail(makeDeployedVenture(), { to: 'jane@acme.com', subject: 'Hi' });
  assert.match(interactive.text, /Triggered by: a live Executive Team conversation/);

  const autonomous = formatOutreachAlertEmail(makeDeployedVenture(), {
    to: 'jane@acme.com',
    subject: 'Hi',
    triggeredBy: 'daily_cycle',
  });
  assert.match(autonomous.text, /Triggered by: the unattended daily leadership sync/);
});

test('sendOutreachAlertEmail is a no-op without SMTP configured', async () => {
  const savedHost = process.env.SMTP_HOST;
  const savedTo = process.env.REPORT_EMAIL_TO;
  delete process.env.SMTP_HOST;
  delete process.env.REPORT_EMAIL_TO;

  try {
    assert.equal(
      await sendOutreachAlertEmail(makeDeployedVenture(), { to: 'jane@acme.com', subject: 'Hi' }),
      false
    );
  } finally {
    if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
    if (savedTo !== undefined) process.env.REPORT_EMAIL_TO = savedTo;
  }
});
