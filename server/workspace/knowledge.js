// Memory that compiles.
//
// Karpathy's argument: treat knowledge as something the model maintains over
// time, like code, rather than something retrieved on demand. This company
// had the raw sources — fifty daily reports, forty capped notes per venture, a
// reflection a week — and nothing that turned them into "what we know". So
// month six would have started from month two's confusion.
//
// Once a week, after the reflection, the CEO rewrites one page per active
// venture: what the product is, who the customers are, what was tried and
// what happened, what is currently believed and on what evidence, and what
// contradicts what. The page is published to the vault (Obsidian, VS Code)
// and kept locally so the next turn's context actually contains it — a wiki
// nobody reads is a diary.

import { readJson, writeJson } from '../store.js';
import { runAgent } from '../agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from '../agents/orgChart.js';
import { listVentures, listVentureNotes, listObjectives, pipelineSummary, listPayments, describePricing } from '../finance/ventures.js';
import { listDailyReports } from '../dailyReports.js';
import { usageSummary } from '../ventureUsage.js';
import { publishKnowledge } from './vault.js';

const FILE = 'knowledge.json';
// What of each page reaches the shared context. The page can be long; the
// context should not be.
const CONTEXT_CHARS = 1800;

function load() {
  return readJson(FILE, { pages: {} });
}

export function getKnowledgePage(ventureId) {
  return load().pages[ventureId] || null;
}

// A roster where the CEO has no reports, so the rewrite is one call and not a
// committee. Same shape as dailyMeeting's soloRoster.
function alone(agents, rootId) {
  return { ...agents, [rootId]: { ...agents[rootId], reports: [] } };
}

function material(venture) {
  const notes = listVentureNotes(venture.id).slice(-25).map((n) => `- ${n.at.slice(0, 10)}${n.agentId ? ` (${n.agentId})` : ''}: ${n.note}`);
  const reports = listDailyReports()
    .slice(-7)
    .map((r) => `### ${r.date}\n${String(r.leadership?.reply || '').slice(0, 1200)}`);
  const objectives = listObjectives(venture.id).map((o) => `- ${o.key}: ${o.target}${o.by ? ` by ${o.by}` : ''}`);
  const pipeline = pipelineSummary(venture.id);
  const payments = listPayments(venture.id).slice(0, 10).map((p) => `- ${p.paidAt.slice(0, 10)}: ${p.currency} ${p.amount} ${p.kind}${p.customerEmail ? ` from ${p.customerEmail}` : ''}`);
  const usage = usageSummary(venture.id, { days: 30 });

  return [
    `# Venture record`,
    `Title: ${venture.title}`,
    `One-liner: ${venture.oneLiner || ''}`,
    `Problem: ${venture.problem || ''}`,
    `Customer: ${venture.targetCustomer || ''}`,
    `Model: ${venture.businessModel || ''}`,
    `Price on record: ${describePricing(venture)}`,
    `Milestones: ${(venture.milestones || []).map((m) => `${m.title || m} [${m.status || 'pending'}]`).join('; ') || 'none'}`,
    `Objectives:\n${objectives.join('\n') || 'none'}`,
    `Pipeline: ${pipeline.contacts} contacts, open ${pipeline.pipelineMonthly}/mo, paying ${pipeline.payingMonthly}/mo`,
    `Payments:\n${payments.join('\n') || 'none'}`,
    `Usage (30d): ${usage.known ? `${usage.calls} calls, ${usage.errors} errors, ${usage.callers} callers${usage.outcomes ? `, ${usage.outcomes} outcomes` : ''}` : 'not reporting'}`,
    '',
    `# Notes (most recent 25)`,
    notes.join('\n') || 'none',
    '',
    `# Daily leadership syncs (last 7)`,
    reports.join('\n\n') || 'none',
  ].join('\n');
}

function kickoff(venture, existing) {
  return `Rewrite the knowledge page for "${venture.title}" [${venture.id}].

This page is the company's compiled memory for this venture: not a log, a
current understanding. Sections, in this order, each short:

1. What it is — the product and who it is for, in the words a customer uses.
2. Where it stands — customers, pipeline, revenue, usage, with dates.
3. What we have learned — decisions and their reasons, things tried and what
   happened. Each item names its evidence (a date, a report, a reply).
4. What we currently believe, and on what — assumptions that have not yet
   been tested, marked as such.
5. Contradictions — where two sources disagree, say so; do not resolve them
   by picking one.
6. Open questions.

Keep everything from the existing page that is still true; update what
changed; delete only what is contradicted by newer evidence, and say what
replaced it. Write in plain prose. No preamble. Under 900 words.

${existing ? `## Existing page\n\n${existing}\n\n` : '## Existing page\n\n(none — this is the first)\n\n'}## This week's material

${material(venture)}`;
}

/**
 * Compiles a page for every active venture. Returns what was written.
 */
export async function compileKnowledge({ anthropic, runAgentImpl = runAgent, publishImpl = publishKnowledge } = {}) {
  const active = listVentures().filter((v) => v.status === 'active');
  const written = [];
  for (const venture of active) {
    const existing = getKnowledgePage(venture.id)?.markdown || '';
    let markdown;
    try {
      const result = await runAgentImpl({
        anthropic,
        agents: alone(COMPANY_AGENTS, COMPANY_ROOT),
        agentId: COMPANY_ROOT,
        messages: [{ role: 'user', content: kickoff(venture, existing) }],
        actionHandlers: {},
        extraContext: '',
      });
      markdown = (result.text || '').trim();
    } catch (err) {
      console.error(`Knowledge compile failed for ${venture.title}:`, err.message);
      continue;
    }
    if (!markdown) continue;

    const data = load();
    data.pages[venture.id] = { title: venture.title, markdown, updatedAt: new Date().toISOString() };
    writeJson(FILE, data);
    // Best effort: the vault may be unconfigured or halted; the local copy is
    // what the agents read either way.
    Promise.resolve(publishImpl(venture, markdown)).catch((err) =>
      console.error('Knowledge publish failed:', err.message),
    );
    written.push({ ventureId: venture.id, chars: markdown.length });
  }
  return written;
}

/** The compiled pages, trimmed, for the shared context. */
export function buildKnowledgeContext() {
  const pages = load().pages;
  const active = listVentures().filter((v) => v.status === 'active' && pages[v.id]);
  if (!active.length) return '';
  const sections = active.map((v) => {
    const page = pages[v.id];
    const body = page.markdown.length > CONTEXT_CHARS ? `${page.markdown.slice(0, CONTEXT_CHARS)}\n[…]` : page.markdown;
    return `"${v.title}" [id: ${v.id}] — compiled ${page.updatedAt.slice(0, 10)}:\n${body}`;
  });
  return `What this company has learned so far, compiled weekly from every report and note.
Read it before deciding anything the page already decided:
${sections.join('\n\n')}`;
}
