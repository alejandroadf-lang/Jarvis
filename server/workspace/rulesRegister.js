// The outside rules that decide whether a venture is allowed to exist.
//
// The only findings in the research with a concrete revenue consequence were
// not about notes at all: a data provider's terms that may forbid what the
// product sells, a marketplace rule that can cost a listing its badge, a
// privacy regime that treats sleep data as health data. Each is a page in
// Company/Rules/ with the clause, when it was read, and when to read it again,
// so a rule that matters is never a thing someone half-remembers.
//
// These pages are seeded once, from what the research found, and every claim
// on them is marked as read from a summary, not the source. The point of the
// page is the empty "Verbatim clause" section and the `needs-legal-read`
// status: it is a to-do for the founder (and a lawyer) with the exact link,
// not an answer. Agents extend the pages through update_vault_note; the
// founder's own edits are never overwritten (created only if missing).

import { listVentures } from '../finance/ventures.js';
import { serializeNote } from './frontmatter.js';

const RULES = [
  {
    file: 'WHOOP API terms',
    venture: /circadian/i,
    status: 'needs-legal-read',
    sources: ['https://developer.whoop.com/api-terms-of-use/', 'https://developer.whoop.com/docs/developing/rate-limiting/'],
    believed: [
      'Selling or redistributing access to WHOOP API materials is prohibited.',
      'Using WHOOP data to train, fine-tune or improve any LLM or machine-learning model is prohibited.',
      'WHOOP may suspend access without notice.',
      'The default rate limit supports roughly 60 to 80 connected users per app until a limit increase is approved.',
    ],
    means:
      'If the sellable API embeds WHOOP data, or anything is tuned on it, this could be a breach. Until the primary text is read: nothing WHOOP-derived is sold or used for tuning, and no WHOOP readings go in the vault.',
  },
  {
    file: 'Atlassian Marketplace and Forge',
    venture: /happy/i,
    status: 'to-verify',
    sources: [
      'https://developer.atlassian.com/platform/marketplace/runs-on-atlassian/',
      'https://developer.atlassian.com/platform/marketplace/cloud-fortified-apps-program/',
      'https://developer.atlassian.com/platform/marketplace/attracting-new-customers/',
      'https://www.atlassian.com/blog/development/updates-to-marketplace-revenue-share-2026',
    ],
    believed: [
      'Adding remotes, web triggers or egress permissions can cost the app its "Runs on Atlassian" badge.',
      'Cloud Fortified requires answering critical support tickets within a day.',
      'Marketplace search indexes the listing title, description, partner name and release notes.',
      'A blog says Atlassian takes 0% of eligible Forge earnings up to USD 1M lifetime; Atlassian later extended the dates and the extension was not read, so do not quote the dates.',
    ],
    means: 'Any change to the manifest that adds remotes, web triggers or egress is a decision for the founder (the team opens one automatically). Do not quote revenue-share dates until verified.',
  },
  {
    file: 'Health data under GDPR',
    venture: /circadian|duty/i,
    status: 'needs-legal-read',
    sources: ['https://gdprlocal.com/gdpr-for-wearable-technology/'],
    believed: [
      'Sleep and heart data from a wearable counts as special-category health data (GDPR Article 9) according to compliance-vendor blogs.',
      'Git history keeps deleted text, which sits badly with a right to erasure.',
      'Whether the company is controller or processor, whether GitHub is a sub-processor, and Thailand\'s PDPA were not researched.',
    ],
    means: 'No personal or wearable data goes in the vault (the write gate refuses the obvious shapes). A lawyer should settle roles and the need for an impact assessment before real customer data flows.',
  },
  {
    file: 'ISO 31030 travel risk management',
    venture: /duty/i,
    status: 'to-verify',
    sources: ['https://www.workflex.com/hr-glossary/iso-31030-travel-risk-management-standard'],
    believed: ['ISO 31030 is cited as a benchmark in tenders and insurance assessments of employers\' travel risk management.'],
    means: 'A plausible positioning hook for Duty-of-Care: confirm how buyers actually use it before building a message on it.',
  },
  {
    file: 'German B2B cold email',
    venture: /duty/i,
    status: 'needs-legal-read',
    sources: ['https://overloop.com/blog/b2b-cold-email-germany-gdpr-compliance'],
    believed: ['Practitioner blogs say German competition law (UWG section 7) effectively requires consent even for B2B cold email.'],
    means: 'Not legal advice, and not from a legal source. Until read: outreach only to contacts with a recorded source, and none to Germany without the founder\'s say.',
  },
];

/** Creates each rule page that is not already there. Never touches an existing one. */
export async function seedRulesRegister({ createIfMissing, now = new Date() }) {
  const ventures = listVentures();
  const review = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  let made = 0;
  for (const r of RULES) {
    const venture = ventures.find((v) => r.venture.test(v.title));
    const content = serializeNote(
      {
        type: 'rule',
        status: r.status,
        venture: venture?.title,
        review_by: review,
        date_read: 'not yet',
        source_quality: 'search summary, not the source',
        created: now.toISOString().slice(0, 10),
        source: 'server-seeded',
        tags: ['company/rule'],
      },
      `\n# ${r.file}\n\n## What we believe (from summaries, unverified)\n\n${r.believed.map((b) => `- ${b}`).join('\n')}\n\n## Verbatim clause\n\n_Paste the exact wording here after reading the primary source, with the date._\n\n## What it means for us\n\n${r.means}\n\n## Sources\n\n${r.sources.map((s) => `- ${s}`).join('\n')}\n`,
    );
    if (await createIfMissing(`Company/Rules/${r.file}.md`, content, `Rule — ${r.file}`)) made += 1;
  }
  return made;
}
