// Emails the daily report once it's generated (see dailyMeeting.js). Opt-in
// via env vars: without SMTP_HOST and REPORT_EMAIL_TO both set, this is a
// silent no-op — not everyone running this app wants, or has configured,
// outbound email. Nothing here decides *whether* to run the daily meeting
// or *what* it says; it only delivers a report that already exists.

import nodemailer from 'nodemailer';

function buildTransport() {
  if (!process.env.SMTP_HOST || !process.env.REPORT_EMAIL_TO) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

export function formatReportEmail(report) {
  const subject = `Daily Company Report — ${report.date}`;
  const lines = [
    `Treasury: $${report.treasury.balance.toFixed(2)} / $${report.treasury.startingCapital} starting seed`,
    '',
    '=== Leadership Sync (Executive Team) ===',
    report.leadership.reply,
    '',
    '=== Opportunity Review (Venture Studio) ===',
    report.studio.reply,
  ];
  if (report.proposedVentureIds.length > 0) {
    lines.push(
      '',
      `New venture proposal${report.proposedVentureIds.length > 1 ? 's' : ''} logged today: ${report.proposedVentureIds.join(', ')} — review and greenlight from the Ventures panel.`
    );
  }
  return { subject, text: lines.join('\n') };
}

export async function sendDailyReportEmail(report) {
  const transport = buildTransport();
  if (!transport) {
    console.log('Daily report email skipped: set SMTP_HOST and REPORT_EMAIL_TO to enable it.');
    return false;
  }

  const { subject, text } = formatReportEmail(report);
  await transport.sendMail({
    from: process.env.REPORT_EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.REPORT_EMAIL_TO,
    subject,
    text,
  });
  console.log(`Daily report emailed to ${process.env.REPORT_EMAIL_TO}.`);
  return true;
}
