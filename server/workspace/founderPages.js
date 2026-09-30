// What the founder reads, and what they answer, in the vault.
//
// A phone reads a page in three minutes or not at all, so the vault opens on
// one: Today.md, regenerated every morning by code (no model call, no cost)
// from what the company already knows: money per venture, what needs a
// decision, what is overdue, which outside rule is due for a re-read, what the
// day has cost. The decisions are the other half. A lead files a yes/no in
// Inbox/Decisions; the founder answers by editing one property; the answer
// comes back into the team's context. An unanswered request expires as a no,
// so silence never approves anything.
//
// Everything here is fail-quiet: it runs after the daily report, which has
// already done its real work.

import { readJson, writeJson } from '../store.js';
import { listVentures, pipelineSummary } from '../finance/ventures.js';
import { getPlan } from '../dailyPlan.js';
import { pendingDrafts } from '../outreachDrafts.js';
import { getSpendToday, dailyCapUsd } from '../spend.js';
import { setFields } from './frontmatter.js';
import { loadNotes, invalidateIndex } from './vaultIndex.js';
import { syncLessons, lessonMetrics } from './lessons.js';
import {
  isWorkspaceConfigured,
  noteName,
  publishServerPage,
  writeVaultNote,
  recentVaultWrites,
  DECISIONS_FOLDER,
  SKILL_PROPOSALS_FOLDER,
  workspaceConfig,
} from './vault.js';
import { readFileMeta } from '../deploy/github.js';
import { seedRulesRegister } from './rulesRegister.js';

const DECISIONS_FILE = 'decisions.json';
const TODAY_CHARS = 1500;
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const plusDays = (n, from = new Date()) => day(new Date(from.getTime() + n * 86_400_000));

// --- decisions ---------------------------------------------------------------

/**
 * Reads the inbox: closes what has expired as a no, and remembers what the
 * founder answered so the next session's context can say so.
 */
export async function syncDecisions(notes, { now = new Date() } = {}) {
  const inbox = notes.filter((n) => n.path.startsWith(`${DECISIONS_FOLDER}/`) && n.fm.type === 'decision-request');
  const { owner, repo, branch } = workspaceConfig();
  const today = day(now);
  const seen = [];
  for (const n of inbox) {
    let state = String(n.fm.decision || 'pending').toLowerCase();
    if (state === 'pending' && n.fm.expires && n.fm.expires < today) {
      // Default-deny. Written through the conditional path, so a founder edit
      // made in the same minute wins over the expiry.
      const res = await writeVaultNote({ path: n.path, content: setFields(n.text, { decision: 'expired' }), message: `Decision expired — ${noteName(n.path.split('/').pop())}`, expectedSha: n.sha });
      if (res.ok) state = 'expired';
    }
    seen.push({ path: n.path, title: n.path.split('/').pop().replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2} /, ''), decision: state, venture: n.fm.venture || null, created: n.fm.created || null, expires: n.fm.expires || null });
  }
  writeJson(DECISIONS_FILE, { items: seen, syncedAt: now.toISOString() });
  return seen;
}

/** What the founder has decided lately, and what is still open, for the shared context. */
export function buildDecisionsContext() {
  const items = readJson(DECISIONS_FILE, { items: [] }).items;
  if (!items.length) return '';
  const cutoff = plusDays(-14);
  const answered = items.filter((i) => ['approved', 'rejected', 'expired'].includes(i.decision) && (i.created || '') >= cutoff);
  const open = items.filter((i) => i.decision === 'pending');
  const line = (i) => `- ${i.decision.toUpperCase()}: ${i.title}${i.venture ? ` (${i.venture})` : ''}`;
  const parts = [];
  if (answered.length) parts.push(`The founder's answers to your decision requests (an expired request is a no):\n${answered.slice(-8).map(line).join('\n')}`);
  if (open.length) parts.push(`Still waiting on the founder, so treat as no for now:\n${open.slice(0, 6).map(line).join('\n')}`);
  return parts.join('\n\n');
}

// --- Today.md ----------------------------------------------------------------

function overdue(notes, today) {
  const rows = [];
  for (const n of notes) {
    if (n.fm.type === 'prospect' && n.fm.next_action_due && n.fm.next_action_due < today && !['closed', 'lost', 'paying'].includes(n.fm.status)) {
      rows.push(`[[${n.path.split('/').pop().replace(/\.md$/, '')}]] (was due ${n.fm.next_action_due})`);
    }
  }
  return rows;
}

function supportClock(notes, now) {
  const rows = [];
  for (const n of notes) {
    if (n.fm.type !== 'support' || String(n.fm.status).toLowerCase() === 'closed') continue;
    const opened = Date.parse(n.fm.opened);
    if (!Number.isFinite(opened)) continue;
    // A critical ticket has a day; the clock is in the partner's local time
    // (the founder's, Bangkok), which is why it is shown as hours left.
    if (String(n.fm.priority).toLowerCase() !== 'critical') continue;
    const left = Math.round((opened + 24 * 3_600_000 - now.getTime()) / 3_600_000);
    rows.push(`[[${n.path.split('/').pop().replace(/\.md$/, '')}]] (${left >= 0 ? `${left}h left` : `${-left}h OVERDUE`})`);
  }
  return rows;
}

function rulesDue(notes, today) {
  const soon = plusDays(14);
  return notes
    .filter((n) => n.fm.type === 'rule' && ((n.fm.review_by && n.fm.review_by <= soon) || String(n.fm.status).includes('needs-legal-read')))
    .map((n) => `[[${n.path.split('/').pop().replace(/\.md$/, '')}]] (${n.fm.status}${n.fm.review_by ? `, review by ${n.fm.review_by}` : ''})`);
}

/** The page, from records. Pure, so it can be read and tested without a vault. */
export function buildToday({ notes = [], decisions = [], now = new Date() } = {}) {
  const today = day(now);
  const lines = [`# Today — ${today}`, ''];

  const cap = dailyCapUsd();
  const spent = getSpendToday();
  lines.push(`Model spend today $${spent.toFixed(2)} of $${cap} cap.`, '');

  const ventures = listVentures().filter((v) => v.status === 'active');
  if (ventures.length) {
    lines.push('## Money');
    for (const v of ventures) {
      const p = pipelineSummary(v.id);
      lines.push(`- ${noteName(v.title)}: paying $${p.payingMonthly}/mo, open pipeline $${p.pipelineMonthly}/mo, ${p.contacts} contacts`);
    }
    lines.push('');
  }

  const needs = [];
  const plan = getPlan();
  if (plan?.status === 'pending') needs.push('A plan is waiting for APPROVE or REJECT (WhatsApp).');
  const drafts = pendingDrafts().length;
  if (drafts) needs.push(`${drafts} outreach draft${drafts === 1 ? '' : 's'} to release or drop (DRAFTS).`);
  for (const d of decisions.filter((x) => x.decision === 'pending')) needs.push(`Decide: ${d.title} (by ${d.expires || 'no date'}).`);
  for (const n of notes.filter((x) => x.path.startsWith(`${SKILL_PROPOSALS_FOLDER}/`) && String(x.fm.status) === 'pending')) needs.push(`Skill to approve: ${n.fm.skill_name || n.path}.`);
  lines.push('## Needs you');
  lines.push(...(needs.length ? needs.slice(0, 5).map((x) => `- ${x}`) : ['- Nothing.']), '');

  const late = [...overdue(notes, today), ...supportClock(notes, now)];
  if (late.length) lines.push('## Overdue', ...late.slice(0, 5).map((x) => `- ${x}`), '');

  const risks = rulesDue(notes, today);
  if (risks.length) lines.push('## Rules to re-read', ...risks.slice(0, 4).map((x) => `- ${x}`), '');

  const m = lessonMetrics();
  lines.push(`Notebook: ${m.trusted} trusted, ${m.candidate} unconfirmed, ${m.disputed} disputed lessons; ${m.totalReads} reads, ${m.neverRead} never read.`);
  return lines.join('\n').slice(0, TODAY_CHARS);
}

// --- Index and log ------------------------------------------------------------

export function buildIndex(notes, now = new Date()) {
  const groups = {};
  for (const n of notes) {
    const folder = n.path.split('/').slice(0, 2).join('/');
    (groups[folder] ||= []).push(n);
  }
  const lines = [`# Index`, '', `_Rebuilt ${day(now)}. The map of the vault, for people and for agents._`, ''];
  for (const [folder, list] of Object.entries(groups).sort()) {
    lines.push(`## ${folder} (${list.length})`);
    for (const n of list.slice(0, 40)) lines.push(`- [[${n.path.split('/').pop().replace(/\.md$/, '')}]]${n.fm.status ? ` · ${n.fm.status}` : ''}`);
    if (list.length > 40) lines.push(`- …and ${list.length - 40} more`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildVaultLog() {
  const rows = recentVaultWrites(100).map((w) => `- ${w.at.slice(0, 16).replace('T', ' ')} · ${w.path} · ${w.message}`);
  return `# Vault log\n\n_What the team wrote here lately, newest first._\n\n${rows.join('\n') || '_Nothing yet._'}\n`;
}

// --- Dashboards (Bases) -------------------------------------------------------
//
// Core Bases needs no plugin: a .base file is YAML over the notes' properties.
// Written once and never again, so the founder can change a view and keep it.

function base(folder, name, columns, sort) {
  return `filters:
  and:
    - file.inFolder("${folder}")
views:
  - type: table
    name: ${name}
    order:
${columns.map((c) => `      - ${c}`).join('\n')}
    sort:
      - property: ${sort}
        direction: ASC
`;
}

export const DASHBOARDS = {
  'Dashboards/Lessons.base': base('Company/Lessons', 'Lessons', ['file.name', 'status', 'agent', 'venture', 'evidence', 'expires'], 'expires'),
  'Dashboards/Decisions.base': base('Inbox/Decisions', 'Decisions', ['file.name', 'decision', 'venture', 'expires'], 'expires'),
  'Dashboards/Pipeline.base': base('Company/Pipeline', 'Prospects', ['file.name', 'venture', 'status', 'contact_source', 'next_action_due'], 'next_action_due'),
  'Dashboards/Rules.base': base('Company/Rules', 'Rules', ['file.name', 'status', 'review_by', 'date_read'], 'review_by'),
  'Dashboards/Support.base': base('Company/Support', 'Tickets', ['file.name', 'venture', 'priority', 'status', 'opened'], 'opened'),
};

async function createIfMissing(path, content, message) {
  const { owner, repo, branch } = workspaceConfig();
  if (await readFileMeta({ owner, repo, branch, path })) return false;
  return (await writeVaultNote({ path, content, message, expectedSha: null })).ok;
}

// --- the daily refresh ---------------------------------------------------------

/**
 * Everything the founder-facing pages need, once a day. Never throws.
 */
export async function refreshFounderPages({ now = new Date(), seedRules = seedRulesRegister } = {}) {
  if (!isWorkspaceConfigured()) return { skipped: 'vault not configured' };
  const done = [];
  try {
    invalidateIndex();
    await syncLessons();
    const notes = await loadNotes({});
    const decisions = await syncDecisions(notes, { now });
    await publishServerPage('Today.md', `${buildToday({ notes, decisions, now })}\n`, `Today — ${day(now)}`);
    done.push('Today');
    await publishServerPage('Index.md', `${buildIndex(notes, now)}\n`, `Index — ${day(now)}`);
    await publishServerPage('Company/Vault Log.md', buildVaultLog(), `Vault log — ${day(now)}`);
    for (const [path, content] of Object.entries(DASHBOARDS)) await createIfMissing(path, content, `Dashboard — ${path.split('/').pop()}`);
    if (seedRules) await seedRules({ createIfMissing, now });
    done.push('Index', 'Vault Log', 'Dashboards');
  } catch (err) {
    console.error('Founder pages failed:', err.message);
  }
  return { done };
}

