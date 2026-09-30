// A weekly check that the notebook is still true.
//
// A vault that agents write to and read from rots in ways nobody notices:
// links to notes that were never made, pages nothing points to, lessons whose
// evidence is a season old, a rule that was due for a re-read last month, a
// decision nobody answered. And the failure the research warns about most: two
// notes that quietly disagree, each of which gets read as fact. Most of this is
// mechanical, so it is code and costs nothing; only the contradiction check
// needs a model, and it reads titles and summaries of the trusted lessons only,
// in one call. What it finds is a page the founder can read, not something the
// team fixes on its own: a lint that edits is one more writer.

import { runAgent } from '../agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from '../agents/orgChart.js';
import { alone } from './knowledge.js';
import { loadNotes, invalidateIndex } from './vaultIndex.js';
import { wikilinks } from './frontmatter.js';
import { syncLessons, allLessons } from './lessons.js';
import { isWorkspaceConfigured, publishServerPage, AGENT_ZONES } from './vault.js';

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const stem = (p) => p.split('/').pop().replace(/\.md$/, '');
const cap = (rows, n = 12) => (rows.length ? rows.slice(0, n).map((r) => `- ${r}`).join('\n') + (rows.length > n ? `\n- …and ${rows.length - n} more` : '') : '_None._');

/** The mechanical findings, from the notes alone. Pure. */
export function lintNotes(notes, { now = new Date() } = {}) {
  const today = day(now);
  const names = new Set(notes.map((n) => stem(n.path)));
  const inbound = new Map();
  const broken = [];
  for (const n of notes) {
    for (const target of wikilinks(n.text)) {
      if (names.has(target)) inbound.set(target, (inbound.get(target) || 0) + 1);
      else if (n.path.startsWith('Company/') && !n.path.startsWith('Company/Daily Reports/')) broken.push(`${stem(n.path)} → [[${target}]]`);
    }
  }
  const inZone = notes.filter((n) => AGENT_ZONES.some((z) => n.path.startsWith(z)));
  const orphans = inZone.filter((n) => !inbound.get(stem(n.path))).map((n) => stem(n.path));
  const noFrontmatter = notes.filter((n) => (inZone.includes(n) || n.path.startsWith('Company/Lessons/')) && !n.fm.type).map((n) => n.path);

  const lessons = notes.filter((n) => n.fm.type === 'lesson');
  const expired = lessons.filter((n) => n.fm.expires && n.fm.expires < today && n.fm.status !== 'quarantined').map((n) => `${stem(n.path)} (expired ${n.fm.expires})`);
  const disputed = lessons.filter((n) => n.fm.status === 'disputed').map((n) => stem(n.path));
  const staleCandidates = lessons
    .filter((n) => n.fm.status === 'candidate' && n.fm.created && Date.parse(today) - Date.parse(n.fm.created) > 30 * 86_400_000)
    .map((n) => `${stem(n.path)} (unconfirmed since ${n.fm.created})`);
  const rulesLate = notes.filter((n) => n.fm.type === 'rule' && n.fm.review_by && n.fm.review_by < today).map((n) => `${stem(n.path)} (review was due ${n.fm.review_by})`);
  const decisionsLate = notes.filter((n) => n.fm.type === 'decision-request' && n.fm.decision === 'pending' && n.fm.expires && n.fm.expires <= day(new Date(now.getTime() + 3 * 86_400_000))).map((n) => `${stem(n.path)} (expires ${n.fm.expires})`);
  const prospectsLate = notes.filter((n) => n.fm.type === 'prospect' && n.fm.next_action_due && n.fm.next_action_due < today && !['closed', 'lost', 'paying'].includes(n.fm.status)).map((n) => stem(n.path));

  return { broken, orphans, noFrontmatter, expired, disputed, staleCandidates, rulesLate, decisionsLate, prospectsLate };
}

export function formatLint(found, { model, now = new Date() } = {}) {
  const s = (title, rows) => `## ${title}\n\n${cap(rows)}\n`;
  return [
    `---\ntype: lint\ndate: ${day(now)}\ntags: [company/lint]\n---\n`,
    `# Vault check — ${day(now)}`,
    '',
    '_What is stale, broken or in doubt. Nothing here has been changed; the team does not edit on its own findings._',
    '',
    s('Disputed lessons (two notes disagree; resolve or expire one)', found.disputed),
    s('Unconfirmed for over 30 days (confirm, or let them expire)', found.staleCandidates),
    s('Expired lessons', found.expired),
    s('Rules due for a re-read', found.rulesLate),
    s('Decisions about to expire as a no', found.decisionsLate),
    s('Prospects with an overdue next step', found.prospectsLate),
    s('Broken links', found.broken),
    s('Pages nothing links to', found.orphans),
    s('Pages missing their properties', found.noFrontmatter),
    `## Possible contradictions among trusted lessons (model, unverified)\n\n${model || '_Not run (fewer than three trusted lessons)._'}\n`,
  ].join('\n');
}

async function contradictionCheck({ anthropic, runAgentImpl }) {
  const trusted = allLessons().filter((l) => l.status === 'trusted');
  if (trusted.length < 3) return null;
  const list = trusted.slice(-40).map((l) => `- [[${l.title}]] (${l.created}): ${l.summary}`).join('\n');
  try {
    const result = await runAgentImpl({
      anthropic,
      agents: alone(COMPANY_AGENTS, COMPANY_ROOT),
      agentId: COMPANY_ROOT,
      messages: [{
        role: 'user',
        content: `Below are the lessons the team has confirmed. List any pairs that contradict each other, and any that describe something likely to have changed since it was written. Name each by its [[wikilink]] and say in one line why. If there are none, say "None found." Do not invent conflicts; do not propose fixes.\n\n${list}`,
      }],
      actionHandlers: {},
      extraContext: '',
    });
    return (result.text || '').trim().slice(0, 1500) || null;
  } catch (err) {
    console.error('Vault lint: contradiction check failed:', err.message);
    return null;
  }
}

export async function runVaultLint({ anthropic, runAgentImpl = runAgent, now = new Date() } = {}) {
  if (!isWorkspaceConfigured()) return null;
  try {
    invalidateIndex();
    await syncLessons();
    const notes = await loadNotes({});
    const found = lintNotes(notes, { now });
    const model = await contradictionCheck({ anthropic, runAgentImpl });
    await publishServerPage(`Company/Lint/${day(now)}.md`, formatLint(found, { model, now }), `Vault check — ${day(now)}`);
    return found;
  } catch (err) {
    console.error('Vault lint failed:', err.message);
    return null;
  }
}
