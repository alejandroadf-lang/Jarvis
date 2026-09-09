import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { formatReportEmail, sendDailyReportEmail } from '../email.js';

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
