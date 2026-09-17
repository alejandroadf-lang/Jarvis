# Legitimate Interest Assessment — B2B outreach

**Status:** template. This document is only an assessment once the founder has
completed the bracketed sections, signed and dated it, and can produce it on
request. Until then the company's outreach has no documented lawful basis and
the code will still send. The code does not know the difference; you do.

This is not legal advice. It follows the three-part test regulators expect
under GDPR Article 6(1)(f) — purpose, necessity, balancing — and records the
safeguards the software enforces (see `server/outreachCompliance.js`).

---

## 1. Controller

- Legal entity: **[company name, registration number, country]**
- Contact for data-protection matters: **[email]**
- Date of this assessment: **[YYYY-MM-DD]** · Review by: **[YYYY-MM-DD, at most 12 months later]**

## 2. Purpose test — what is the interest, and is it legitimate?

The company contacts named professionals at businesses, by email, to introduce
a product relevant to their role: **[one sentence — what the venture sells and
to whom, e.g. "document-extraction API for operations teams processing
scanned PDFs"]**.

The interest is commercial: finding the first customers for a new product.
Direct marketing is recognised as a legitimate interest (GDPR Recital 47).

## 3. Necessity test — is the processing necessary for that purpose?

The data processed is: name, professional email address, employer, role, and
the content of any reply. Nothing more is collected or inferred. The company
cannot introduce the product to the person without contacting them; there is
no less intrusive way to reach a business decision-maker who has not yet heard
of the company.

Source of addresses: **[where the list comes from — a public company website,
a professional network profile, a referral. Purchased lists are out of scope
of this assessment.]**

## 4. Balancing test — do the person's interests override ours?

Factors weighed:

- **Reasonable expectation.** A professional listed publicly in a business role
  can reasonably expect occasional relevant business contact at their work
  address. The company does not contact personal addresses.
- **Nature of the data.** Business contact details only; no special-category
  data; no profiling beyond role relevance.
- **Impact.** One unsolicited email, with an immediate and honoured opt-out.
  Follow-ups are capped per venture per day and per week in the software.
- **Automated sending.** Messages are drafted and sent by an AI system. Every
  message says so (EU AI Act Article 50) and every reply is read by a person.

Conclusion: the company's interest is not overridden **[confirm or amend after
reading the above honestly for your own case]**.

## 5. Safeguards — enforced in software, not only promised

| Safeguard | Where |
|---|---|
| Recipient allowlist per venture, set by the founder | `authorizeOutreach` |
| Opt-out line on every message, appended by the handler, never by the agent | `withComplianceFooter` |
| "Unsubscribe" in any reply blocks the address before an agent reads it | `handleCheckReplies` → `blockContact` |
| A blocked address cannot be emailed by any agent; only the founder can lift it | `authorizeOutreach`, `UNBLOCK` |
| AI-authorship disclosure on every message | `complianceFooter` |
| Addresses in jurisdictions requiring prior consent (`.de`, `.it`) refused unless consent is recorded | `requiresConsent`, `CONSENT` |
| Daily and weekly send caps, and a cooldown between sends | `enforceRateLimits` |
| A global halt the founder can trigger from a phone | `HALT` |

Known limit: jurisdiction is inferred from the address's top-level domain. A
`.com` address at a German company is not caught automatically. The founder
records consent or blocks by hand for those.

## 6. Retention

Sent emails and replies are kept on the venture record for as long as the
venture is active, then **[state your retention period]**. A blocked address
is kept indefinitely so that the block is honoured.

## 7. Rights

Requests to access, correct or erase data, or to object, are sent to the
contact in §1 and answered within one month. Objection to direct marketing is
honoured immediately and without reasons (GDPR Article 21(2)).

---

Signed: ______________________  Date: ____________
