// What each agent actually did, for the founder's AGENTS command.
//
// The profit-share ledger (finance/profitShare.js) looked like the place to
// read this from, and is not: it keeps only the kinds of work that earn
// credit, so opening a pull request, finishing a task or drafting an email
// is silently dropped there. A performance view built on it would report the
// Forge Engineer idle on a day it opened three pull requests.
//
// So the runner records every consultation and every action here, the ones
// that succeeded and the ones a gate refused, in one place: agentRunner.js,
// where the acting agent is known for a fact rather than claimed. Refusals
// are kept on purpose. "Tried five times and was blocked five times" is a
// different problem from "did nothing", and the answer to it is READY, not a
// better prompt.
//
// Only what, who, when and whether it worked: no inputs, no outputs, no
// message text. Kept KEEP_DAYS and at most MAX_ENTRIES, whichever is less.

import { updateJson, readJson } from './store.js';
import { AGENTS as COMPANY_AGENTS } from './agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS } from './agents/ideationTeam.js';

const FILE = 'activityLog.json';
export const KEEP_DAYS = 30;
const MAX_ENTRIES = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Which gate refused an action, as a category and never as the message:
// refusal texts can name a recipient, and the capacity recommendations only
// need to know which door was shut. Order matters: "spend cap" is spend, not
// a commit cap.
const GATES = [
  ['spend', /spend|budget/i],
  ['halt', /\bhalt|kill switch|real actions are (off|disabled|stopped)/i],
  ['plan', /\bplan\b/i],
  ['cooldown', /too soon|cooldown/i],
  ['cap', /\bcap\b|caps\b|limit reached/i],
  ['scope', /outside the allowed|allowed scope|allowedpaths/i],
  // A missing server key before "repo": "Could not link a repo: this server
  // has no GITHUB_TOKEN" is a key the founder sets, not a repo to link.
  ['config', /has no [A-Z_]{4,}|no [A-Z_]{4,} configured/],
  ['repo', /no repo|link a repo|not enabled|repo writes/i],
  ['outreach', /outreach|recipient|allowlist|consent|blocked contact/i],
];

export function classifyRefusal(text) {
  const t = String(text || '');
  return (GATES.find(([, re]) => re.test(t)) || ['other'])[0];
}

/** @param {{agentId: string, kind: 'consulted'|'action'|'led', tool?: string, ok?: boolean, ventureId?: string|null, ms?: number|null, refusal?: string|null}} entry */
export function recordActivity({ agentId, kind, tool = null, ok = true, ventureId = null, ms = null, refusal = null }, now = new Date()) {
  if (!agentId || !kind) return null;
  const entry = { agentId, kind, tool, ok: Boolean(ok), ventureId: ventureId ? String(ventureId) : null, ms: Number.isFinite(ms) ? ms : null, at: now.toISOString() };
  if (!entry.ok && kind === 'action') entry.gate = classifyRefusal(refusal);
  const oldest = new Date(now.getTime() - KEEP_DAYS * DAY_MS).toISOString();
  updateJson(FILE, { entries: [] }, (data) => {
    data.entries = [...data.entries.filter((e) => e.at >= oldest), entry].slice(-MAX_ENTRIES);
  });
  return entry;
}

export function listActivity({ since = '', agentId = null } = {}) {
  return readJson(FILE, { entries: [] }).entries.filter((e) => e.at >= since && (!agentId || e.agentId === agentId));
}

const ALL_AGENTS = () => ({ ...STUDIO_AGENTS, ...COMPANY_AGENTS });

/** Per-agent counts over the last `days`, and who did nothing at all. */
export function agentPerformance({ days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const byAgent = {};
  for (const e of listActivity({ since })) {
    const a = (byAgent[e.agentId] ||= { agentId: e.agentId, led: 0, consulted: 0, failedConsults: 0, done: 0, refused: 0, tools: {}, lastAt: null, ventures: new Set() });
    if (e.kind === 'led') a.led += 1;
    else if (e.kind === 'consulted') e.ok ? (a.consulted += 1) : (a.failedConsults += 1);
    else if (e.kind === 'action') {
      e.ok ? (a.done += 1) : (a.refused += 1);
      const t = (a.tools[e.tool] ||= { ok: 0, refused: 0 });
      e.ok ? (t.ok += 1) : (t.refused += 1);
    }
    if (e.ventureId) a.ventures.add(e.ventureId);
    if (!a.lastAt || e.at > a.lastAt) a.lastAt = e.at;
  }
  const agents = Object.values(byAgent).map((a) => ({ ...a, ventures: [...a.ventures] }));
  const idle = Object.keys(ALL_AGENTS()).filter((id) => !byAgent[id]);
  return { days, since, agents, idle };
}

function ago(iso, now) {
  const mins = Math.round((now.getTime() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const toolList = (tools) =>
  Object.entries(tools)
    .sort((a, b) => b[1].ok + b[1].refused - (a[1].ok + a[1].refused))
    .map(([tool, c]) => `${tool} ${c.ok}${c.refused ? ` (+${c.refused} refused)` : ''}`)
    .join(', ');

/** The AGENTS reply: who did real work, who only advised, who did nothing. */
export function describePerformance({ days = 7, now = new Date(), extra = [] } = {}) {
  const { agents, idle } = agentPerformance({ days, now });
  const titles = ALL_AGENTS();
  const name = (id) => `${titles[id]?.title || id} (${id})`;
  const working = agents.filter((a) => a.done > 0).sort((a, b) => b.done - a.done);
  const advising = agents.filter((a) => a.done === 0 && (a.consulted > 0 || a.led > 0)).sort((a, b) => b.consulted + b.led - (a.consulted + a.led));
  const onlyRefused = agents.filter((a) => a.done === 0 && a.refused > 0);
  const refusedTotal = agents.reduce((n, a) => n + a.refused, 0);
  const total = Object.keys(titles).length;
  const lines = [`Agents, last ${days} day${days === 1 ? '' : 's'}: ${agents.length} of ${total} did anything.`];
  if (!agents.length) {
    lines.push('', 'Nothing recorded. The team has not run in this window: no daily cycle and no message has reached it. Send REPORT to see when it last ran.');
    lines.push(...extra);
    return lines.join('\n');
  }
  lines.push('', `Did real work (${working.length}):`);
  if (working.length) for (const a of working) lines.push(`• ${name(a.agentId)}: ${toolList(a.tools)} · ${ago(a.lastAt, now)}`);
  else lines.push('• nobody: every real action was refused or none was tried');
  if (onlyRefused.length) {
    lines.push('', 'Tried, but every action was refused:');
    for (const a of onlyRefused) lines.push(`• ${name(a.agentId)}: ${toolList(a.tools)}`);
  }
  lines.push('', `Advised only (${advising.length}): ${advising.map((a) => `${a.agentId} ${a.consulted + a.led}`).join(', ') || 'none'}`);
  lines.push('', `Idle, never asked (${idle.length}): ${idle.join(', ') || 'none'}`);
  if (refusedTotal) lines.push('', `${refusedTotal} action${refusedTotal === 1 ? ' was' : 's were'} refused by a gate. READY <ventureId> says which gate and what opens it.`);
  lines.push(...extra);
  lines.push('', 'AGENT <id> for one agent. AGENTS 30 for the last 30 days.');
  return lines.join('\n');
}

/** The AGENT <id> reply. */
export function describeAgent(agentId, { days = 7, now = new Date(), ventureTitle = (id) => id } = {}) {
  const titles = ALL_AGENTS();
  if (!titles[agentId]) {
    const close = Object.keys(titles).filter((id) => id.includes(agentId) || agentId.includes(id)).slice(0, 5);
    return `No agent called "${agentId}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ' Send AGENTS for the ids.'}`;
  }
  const a = agentPerformance({ days, now }).agents.find((x) => x.agentId === agentId);
  const head = `${titles[agentId].title} (${agentId}), last ${days} day${days === 1 ? '' : 's'}:`;
  if (!a) return `${head}\nNothing. Not consulted, no action tried.`;
  const recent = listActivity({ since: new Date(now.getTime() - days * DAY_MS).toISOString(), agentId }).slice(-8).reverse();
  return [
    head,
    `Consulted ${a.consulted} time${a.consulted === 1 ? '' : 's'}${a.failedConsults ? ` (${a.failedConsults} failed)` : ''}${a.led ? `; led ${a.led} turn${a.led === 1 ? '' : 's'}` : ''}.`,
    `Actions: ${a.done} done, ${a.refused} refused${Object.keys(a.tools).length ? ` (${toolList(a.tools)})` : ''}.`,
    a.ventures.length ? `Ventures: ${a.ventures.map(ventureTitle).join(', ')}.` : 'No venture-specific work.',
    '',
    'Latest:',
    ...recent.map((e) => `• ${ago(e.at, now)} ${e.kind === 'action' ? `${e.ok ? '✓' : '✗ refused'} ${e.tool}` : e.kind === 'led' ? 'led a turn' : e.ok ? 'consulted' : 'consult failed'}${e.ventureId ? ` · ${ventureTitle(e.ventureId)}` : ''}`),
  ].join('\n');
}
