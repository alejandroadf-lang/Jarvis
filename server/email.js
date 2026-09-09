// Emails the daily report (see dailyMeeting.js) and, separately, a
// decision-needed nudge the moment one comes up (see actionHandlers.js) —
// a new tranche request or venture proposal, rather than only surfacing in
// the next daily digest. Opt-in via env vars: without SMTP_HOST and
// REPORT_EMAIL_TO both set, every send here is a silent no-op — not
// everyone running this app wants, or has configured, outbound email.
// Nothing here decides *whether* something happened or *what* it says;
// it only delivers what's already true.

import nodemailer from 'nodemailer';
import { formatUsd } from './usage.js';

function buildTransport() {
  if (!process.env.SMTP_HOST || !process.env.REPORT_EMAIL_TO) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function sendEmail(subject, text) {
  const transport = buildTransport();
  if (!transport) {
    console.log(`Email skipped ("${subject}"): set SMTP_HOST and REPORT_EMAIL_TO to enable it.`);
    return false;
  }

  await transport.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.REPORT_EMAIL_TO,
    subject,
    text,
  });
  console.log(`Email sent: ${subject}`);
  return true;
}

export function formatReportEmail(report) {
  const subject = `Daily Company Report — ${report.date}`;
  const lines = [`Treasury: $${report.treasury.balance.toFixed(2)} / $${report.treasury.startingCapital} starting seed`];
  // Older/synthetic reports may predate usage tracking — skip the line
  // rather than printing "undefined".
  if (report.usage && typeof report.costUsd === 'number' && typeof report.durationMs === 'number') {
    lines.push(
      `Ran in ${(report.durationMs / 1000).toFixed(1)}s · ${formatUsd(report.costUsd)} · ${report.usage.inputTokens.toLocaleString()} in / ${report.usage.outputTokens.toLocaleString()} out tokens`
    );
  }
  lines.push(
    '',
    '=== Leadership Sync (Executive Team) ===',
    report.leadership.reply,
    '',
    '=== Opportunity Review (Venture Studio) ===',
    report.studio.reply
  );
  if (report.proposedVentureIds.length > 0) {
    lines.push(
      '',
      `New venture proposal${report.proposedVentureIds.length > 1 ? 's' : ''} logged today: ${report.proposedVentureIds.join(', ')} — review and greenlight from the Ventures panel.`
    );
  }
  return { subject, text: lines.join('\n') };
}

export async function sendDailyReportEmail(report) {
  const { subject, text } = formatReportEmail(report);
  return sendEmail(subject, text);
}

export function formatTrancheRequestEmail(venture) {
  const pending = venture.pendingTranche;
  const subject = `Action needed: tranche request for "${venture.title}"`;
  const text = [
    `The CFO requested a follow-on tranche for "${venture.title}".`,
    '',
    `Amount: $${pending.amount}`,
    `For: ${pending.description || '(no description given)'}`,
    '',
    'Approve or deny it from the Ventures panel.',
  ].join('\n');
  return { subject, text };
}

export async function sendTrancheRequestEmail(venture) {
  const { subject, text } = formatTrancheRequestEmail(venture);
  return sendEmail(subject, text);
}

export function formatVentureProposedEmail(venture) {
  const subject = `New venture proposal: "${venture.title}"`;
  const text = [
    `A new venture was proposed: "${venture.title}".`,
    venture.oneLiner ? venture.oneLiner : null,
    '',
    `Asking $${venture.budgetRequested} to fund the first milestone.`,
    '',
    'Review and greenlight it from the Ventures panel if it looks worth funding.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  return { subject, text };
}

export async function sendVentureProposedEmail(venture) {
  const { subject, text } = formatVentureProposedEmail(venture);
  return sendEmail(subject, text);
}

export function formatWeeklyReflectionEmail(reflection) {
  const subject = `Weekly Reflection — week ending ${reflection.weekEnding}`;
  const lines = [`Based on ${reflection.reportsConsidered} daily report(s) this week.`];
  if (typeof reflection.costUsd === 'number' && typeof reflection.durationMs === 'number') {
    lines.push(`Ran in ${(reflection.durationMs / 1000).toFixed(1)}s · ${formatUsd(reflection.costUsd)}`);
  }
  lines.push('', reflection.reflection);
  return { subject, text: lines.join('\n') };
}

export async function sendWeeklyReflectionEmail(reflection) {
  const { subject, text } = formatWeeklyReflectionEmail(reflection);
  return sendEmail(subject, text);
}
