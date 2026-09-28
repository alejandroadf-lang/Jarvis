// The law around sending email to a stranger in Europe, as code.
//
// The company is built to write to real people, and until now the only thing
// governing that was an allowlist: who may be written to. Nothing governed how.
// Four things every outbound message needs before it goes to a European
// address, and none of them can be left to a prompt, because a prompt is a
// request and the fine is up to €20M or 4% of turnover:
//
//   1. A documented legitimate-interest assessment (GDPR art. 6(1)(f)). That
//      is a document the founder signs — see LEGITIMATE_INTEREST_ASSESSMENT.md
//      at the repo root — not something this file can do for them.
//   2. An easy opt-out on every message, honoured automatically. A reply that
//      says "unsubscribe" must end the relationship without a human noticing.
//   3. A plain statement that the sender is an AI system. EU AI Act art. 50,
//      in force since 2 August 2026: people must be told when they are
//      interacting with an AI.
//   4. A country gate. B2B outreach under legitimate interest is accepted
//      practice in most of the EU; Germany and Italy require prior consent in
//      practice. The company cannot know a person's jurisdiction from an email
//      address, but a national TLD is a strong enough signal to refuse on and
//      cheap enough to override with a recorded consent.
//
// And one for the United States, CAN-SPAM (15 U.S.C. 7704), which applies to
// any commercial email, B2B included, at up to $53,088 per message:
//
//   5. Who sent it, that it is a commercial message, and a valid postal
//      address, in every message. The address cannot be invented by an agent,
//      so without COMPANY_POSTAL_ADDRESS nothing is sent at all.
//   6. A working opt-out, honoured within ten business days. The reply
//      "unsubscribe" above is one; the List-Unsubscribe header (see email.js)
//      puts the same thing behind the mail client's own unsubscribe button.
//
// This is not legal advice, and the country list is the commonly cited one
// rather than an exhaustive survey. What it is: a floor below which the code
// will not go, whatever an agent is asked.

// Jurisdictions where B2B cold email needs prior consent in practice. Matched
// on the address's top-level domain only — a .com address at a German company
// passes, which is a known limit and why the founder can also BLOCK by hand.
export const CONSENT_REQUIRED_TLDS = new Set(['de', 'it']);

export function topLevelDomain(email) {
  const address = String(email || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  const host = address.slice(at + 1);
  const dot = host.lastIndexOf('.');
  return dot < 0 ? '' : host.slice(dot + 1);
}

export function requiresConsent(email) {
  return CONSENT_REQUIRED_TLDS.has(topLevelDomain(email));
}

// Wide on purpose. The cost of over-matching is that a prospect who wrote
// "please don't unsubscribe me from the newsletter!" is blocked and the founder
// unblocks them; the cost of under-matching is a regulator.
const UNSUBSCRIBE = [
  /\bunsubscribe\b/i,
  /\bopt[- ]?out\b/i,
  /\bstop (emailing|contacting|messaging)\b/i,
  /\bremove me\b/i,
  /\bdo not (contact|email) me\b/i,
  /\bnicht mehr kontaktieren\b/i,
  /\bne plus me contacter\b/i,
  /\bno me contacten\b/i,
];

/**
 * Who the company is, for the footer. The name falls back to the venture's;
 * the postal address has no fallback, because a made-up one is the violation.
 */
export function senderIdentity(venture) {
  return {
    name: (process.env.COMPANY_NAME || '').trim() || venture?.title || '',
    postalAddress: (process.env.COMPANY_POSTAL_ADDRESS || '').trim().replace(/\s*\n\s*/g, ', '),
  };
}

/** Why a commercial email cannot go out yet, or null when it can. */
export function outreachRefusal() {
  if ((process.env.COMPANY_POSTAL_ADDRESS || '').trim()) return null;
  return (
    'every commercial email must carry a valid postal address (CAN-SPAM), and none is set. ' +
    'The founder needs to set COMPANY_POSTAL_ADDRESS in Railway: a street address, or a PO box or ' +
    'private mailbox registered with the postal service.'
  );
}

export function isUnsubscribe(text) {
  const body = String(text || '');
  return UNSUBSCRIBE.some((re) => re.test(body));
}

/**
 * The lines every outbound customer email ends with. Appended by the handler,
 * never by the agent, so that no draft — however it was written — leaves
 * without them.
 */
export function complianceFooter(venture) {
  const name = venture?.title ? `"${venture.title}"` : 'this company';
  const sender = senderIdentity(venture);
  return [
    '',
    '—',
    `This message was written and sent by an AI system working for ${name}. ` +
      'A person reads every reply.',
    "If you would rather not hear from us, reply with the word \"unsubscribe\" and you won't.",
    ...(sender.postalAddress
      ? [`This is a commercial message from ${sender.name || name}, ${sender.postalAddress}.`]
      : []),
  ].join('\n');
}

export function withComplianceFooter(body, venture) {
  const text = String(body || '').replace(/\s+$/, '');
  if (text.includes('reply with the word "unsubscribe"')) return text; // already there
  return `${text}\n${complianceFooter(venture)}`;
}
