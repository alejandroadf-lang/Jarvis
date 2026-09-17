// The rehearsal.
//
// Everything on the outreach path is now gated, footnoted, capped and
// reviewed — and none of it has ever run. The first time the whole chain
// executes end to end would otherwise be the moment a real prospect gets a
// real email, which is the worst possible moment to discover that SMTP is
// misconfigured, the footer renders badly, or the CEO vetoes every draft.
//
// So: run the real pipeline against the real recipient, and deliver the
// result to the founder instead of to the prospect.
//
// Three properties make this a rehearsal rather than a demo:
//
//   1. The gates are the *same* gates. outreachGates() is the list
//      authorizeOutreach() throws from — not a copy, because a copy would
//      rehearse the wrong code. The only difference is that a send stops at
//      the first shut gate and this reports all of them, which is the whole
//      point: the founder should learn about six problems once, not six times.
//   2. Nothing is consumed. No cap is spent, no contact history is written,
//      no profit share is credited. A rehearsal that used up the week's sends
//      would be a strange kind of rehearsal.
//   3. The prospect's address is evaluated and never delivered to. The
//      function that sends takes no recipient at all — it goes to the
//      founder's own address or nowhere. That is structural rather than
//      careful: there is no argument to get wrong.

import { outreachGates, outreachHeadroom, getVenture } from './finance/ventures.js';
import { withComplianceFooter } from './outreachCompliance.js';
import { reviewOutbound, isCeoReviewEnabled } from './review.js';
import { isEmailConfigured, sendOutreachDryRunEmail } from './email.js';

// What a first email to a design partner actually looks like, so the founder
// can rehearse without composing one. Deliberately plain: the thing under
// test is the pipeline, and a clever sample would only make the CEO review
// harder to read.
export function sampleDraft(venture) {
  const title = venture?.title || 'the product';
  return {
    subject: `Quick question about ${title}`,
    body: [
      'Hi,',
      '',
      `I'm getting in touch about ${title}. We're looking for a small number of design partners before we open it up more widely, and your team came to mind.`,
      '',
      'Would a short call next week be useful? If it is easier, just reply here and I can send over what we have so far.',
      '',
      'Best,',
      'The team',
    ].join('\n'),
  };
}

/**
 * One rehearsal. Never sends to `to`; the rendered message goes to the founder.
 *
 * @returns {Promise<{wouldSend: boolean, text: string, delivered: boolean}>}
 */
export async function dryRunOutreach({ ventureId, to, subject, body, anthropic } = {}) {
  const recipient = String(to || '').trim();
  if (!recipient.includes('@')) {
    return { wouldSend: false, delivered: false, text: 'A dry run needs a recipient address to evaluate against.' };
  }

  const venture = getVenture(ventureId);
  const gates = outreachGates(ventureId, { to: recipient });
  const shut = gates.filter((gate) => !gate.open);

  // The draft, rendered exactly as a real send would render it — the footer
  // is appended by the same function, so what the founder reads is what a
  // prospect would have read.
  const sample = sampleDraft(venture);
  const draftSubject = String(subject || '').trim() || sample.subject;
  const draftBody = String(body || '').trim() || sample.body;
  const finalBody = withComplianceFooter(draftBody, venture);

  // The veto runs for real. It is the one gate whose answer cannot be
  // predicted from the venture record, which makes it the one most worth
  // rehearsing — and it costs one cheap call.
  let review = { approved: true, reason: '', reviewed: false };
  if (venture) {
    review = await reviewOutbound({ anthropic, venture, action: 'send_customer_email', summary: `To: ${recipient}\nSubject: ${draftSubject}\n\n${finalBody}` });
  }

  const wouldSend = shut.length === 0 && review.approved;
  const text = formatDryRun({
    venture,
    ventureId,
    to: recipient,
    subject: draftSubject,
    finalBody,
    gates,
    review,
    headroom: outreachHeadroom(venture),
    usedSample: !String(body || '').trim(),
    wouldSend,
  });

  // To the founder, or nowhere. There is no branch here that reaches the
  // prospect, and sendOutreachDryRunEmail has no parameter that could.
  let delivered = false;
  if (isEmailConfigured()) {
    delivered = await sendOutreachDryRunEmail(venture, { to: recipient, subject: draftSubject, text });
  }

  return { wouldSend, delivered, text };
}

function formatDryRun({ venture, ventureId, to, subject, finalBody, gates, review, headroom, usedSample, wouldSend }) {
  const lines = [];

  lines.push(
    wouldSend
      ? `DRY RUN — this would have been sent to ${to}. Nothing was.`
      : `DRY RUN — this would NOT have been sent to ${to}. Nothing was.`
  );
  lines.push('');
  lines.push(`Venture: ${venture ? `"${venture.title}" (${venture.id})` : `${quotedId(ventureId)} — not found`}`);
  lines.push('');

  lines.push('GATES');
  for (const gate of gates) {
    const mark = gate.open ? 'open  ' : gate.reached ? 'SHUT  ' : '  ?   ';
    lines.push(`  ${mark} ${gate.name}`);
    if (!gate.open) lines.push(`         ${gate.reason}`);
  }

  if (headroom) {
    lines.push('');
    lines.push(
      `  Caps: ${headroom.today} of ${headroom.maxPerDay} used today, ` +
        `${headroom.thisWeek} of ${headroom.maxPerWeek} this week. This rehearsal spent none of them.`
    );
  }

  lines.push('');
  lines.push('CEO REVIEW');
  if (!isCeoReviewEnabled()) {
    lines.push('  Off. Set CEO_REVIEW=true to have the CEO read outbound mail before it leaves.');
  } else if (!review.reviewed) {
    lines.push('  Did not run — the reviewer was unreachable, so a real send would have gone ahead.');
  } else if (review.approved) {
    lines.push('  Approved.');
  } else {
    lines.push(`  VETOED: ${review.reason}`);
  }

  lines.push('');
  lines.push(`THE MESSAGE${usedSample ? ' (sample draft — send your own with "| subject | body")' : ''}`);
  lines.push(`  To:      ${to}`);
  lines.push(`  Subject: ${subject}`);
  lines.push('');
  lines.push(finalBody.split('\n').map((line) => `  ${line}`).join('\n'));

  return lines.join('\n');
}

function quotedId(ventureId) {
  return ventureId ? `"${ventureId}"` : '(none given)';
}
