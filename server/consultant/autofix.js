// The consultant starts fixing what it found, without asking first.
//
// The founder wants a briefing that acts: not "here is what to improve" and then
// a wait for a yes on each item, but the corrections starting on their own. That is
// a real grant of autonomy, so how it is bounded matters more than that it exists.
//
// What it may start (enforced in code, not in the prompt):
//   - pull requests in repos already linked to a venture, within that repo's
//     allowed paths and its review-only setting, never merged;
//   - the durable task queue, objectives, pipeline records that carry a source,
//     draft emails (a draft reaches nobody until the founder releases it), notes;
//   - a decision request in the founder's inbox for anything that needs them.
// What it cannot do, because those handlers are not in the set it is given:
// commit to a main branch, deploy, revert, send an email, create a payment link,
// change a price, spend money, change a setting or a credential, or touch this
// company's own platform code (the repo the company runs from), where the
// guardrails themselves live and where a change stays a human's.
//
// The list of things to correct is computed by code from the scorecard, the
// competitor benchmark and the code review, from our own rubric labels, so no
// text from a web page can put an instruction into it. One bounded session runs a
// day, with a dollar ceiling, after the briefing has gone out. Each correction is
// recorded with its outcome, is not retried for a week, and is given up on after
// three attempts and left for the founder. The next briefing says what was done.
// `AUTOFIX OFF` from WhatsApp stops it; so does the kill switch, the daily spend
// cap, and CONSULTANT_AUTOFIX_DISABLED.

import { readJson, writeJson } from '../store.js';
import { runAgent } from '../agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from '../agents/orgChart.js';
import { buildCompanyContext } from '../finance/context.js';
import { listVentures, isPathAllowed } from '../finance/ventures.js';
import { withSpendContext, getSpendToday, dailyCapUsd } from '../spend.js';
import { getKillSwitch } from '../killSwitch.js';
import { listActivity } from '../activityLog.js';
import { dailyCycleActionHandlers } from '../dailyMeeting.js';
import { gapsAgainstBest } from './competitors.js';

const FILE = 'consultant-fixes.json';
const DAY = 86_400_000;
const RETRY_AFTER_DAYS = 7;
const GIVE_UP_AFTER = 3;

// The only tools the correction session is given. An allowlist, so a tool added
// to the unattended cycle later is not silently added here.
export const AUTOFIX_TOOLS = [
  'check_ready', 'check_usage', 'open_pull_request', 'queue_work', 'next_task', 'start_task', 'complete_task', 'fail_task',
  'update_pipeline', 'set_objective', 'draft_customer_email', 'list_drafts', 'read_repo_file', 'list_repo_files',
  'list_approved_repos', 'list_checks', 'check_service', 'log_venture_note', 'log_contact_note',
];

export function autofixHandlers() {
  const all = dailyCycleActionHandlers();
  return Object.fromEntries(AUTOFIX_TOOLS.filter((t) => all[t]).map((t) => [t, all[t]]));
}

const load = () => readJson(FILE, { enabled: true, lastRunDate: null, runs: [], attempts: {} });

export function autofixOn() {
  return process.env.CONSULTANT_AUTOFIX_DISABLED !== 'true' && load().enabled !== false && perDay() > 0;
}

export function setAutofix(on) {
  const state = load();
  state.enabled = Boolean(on);
  writeJson(FILE, state);
  return state.enabled;
}

export function perDay() {
  const n = Number.parseInt(process.env.CONSULTANT_AUTOFIX_PER_DAY, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 6) : 3;
}

export function autofixBudgetUsd() {
  const n = Number(process.env.CONSULTANT_AUTOFIX_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
}

// --- what to correct ----------------------------------------------------------

// Rubric labels (siteProbe.js) to the correction each one calls for. Matching on
// our own labels is deliberate: nothing from a competitor's page reaches here.
const BENCH_FIXES = [
  [/llms\.txt/i, 'llms', 'pr', 'Add a /llms.txt file to the public site: a short description of the product and links to the docs and the API description, written for AI agents.'],
  [/OpenAPI/i, 'openapi', 'pr', 'Publish an OpenAPI description of the public API at /openapi.json, generated from the code if the framework can do it.'],
  [/HSTS|security headers/i, 'headers', 'pr', 'Add security headers to responses: Strict-Transport-Security, X-Content-Type-Options: nosniff, Referrer-Policy, and a Content-Security-Policy (start it in report-only mode).'],
  [/documentation/i, 'docs', 'pr', 'Add a public documentation page at /docs: what the product does, how to authenticate, and one working example.'],
  [/changelog/i, 'changelog', 'pr', 'Add a dated public changelog page with an entry for each user-visible change since the last release.'],
  [/MCP/i, 'mcp', 'task', 'Scope an MCP server for the product: list which endpoints an AI agent would call, then queue the build as small tasks.'],
  [/SDK/i, 'sdk', 'task', 'Scope a small SDK for the public API: the three calls most users need, with an install command, then queue the build as small tasks.'],
  [/status page/i, 'status', 'decision', 'Whether to add a public status page: it needs a hosted service, which means an account and possibly a cost. Recommend one and say what it costs.'],
];

const LADDER_FIXES = {
  price: ['decision', 'No price is set. Recommend a price with the reasoning (competitors, the value to the buyer, the customers needed for the goal). The founder sets it; the team cannot.'],
  product: ['task', 'There is no shipped product. Queue the smallest end-to-end slice a customer could try, and start it as a pull request.'],
  used: ['task', 'Nobody is using it, or usage is not measured. Check whether usage is reported (check_usage); if it is not, open a pull request that reports it. If it is, say what stands between the product and a first user.'],
  buyers: ['task', 'Fewer than ten buyers are identified. Find and record buyers with update_pipeline, each with a source link; a contact without a source does not count.'],
  talking: ['draft', 'No conversations have started. Draft the first outreach to the sourced contacts with draft_customer_email. A draft reaches nobody; the founder releases it.'],
};

// What the code review found missing in a venture's own repo, and the pull request that fixes it.
const REPO_FIXES = {
  agentDocs: 'Add a CLAUDE.md: how to run and test the repo, the rules that matter, the mistakes to avoid. Under 150 lines.',
  tests: 'Add a first test suite around the code that changes most, so a later change that breaks it fails loudly.',
  ci: 'Add a CI workflow that installs the dependencies and runs the tests on every push and pull request.',
  envTemplate: 'Add a .env.example listing every setting the app reads, with one line on what breaks without it. No real values.',
  security: 'Add a SECURITY.md saying how to report a vulnerability.',
  updates: 'Add a .github/dependabot.yml so dependency updates arrive as pull requests.',
};

// Where each of those files lives. A repo link only lets the team write inside its
// allowed paths, and these sit at the repo root or under .github, which a link
// made for "src/" does not cover; a pull request for them would be refused.
const REPO_FIX_PATHS = { agentDocs: 'CLAUDE.md', envTemplate: '.env.example', security: 'SECURITY.md', updates: '.github/dependabot.yml', ci: '.github/workflows/ci.yml' };

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);

/**
 * The corrections worth starting, in priority order: the closest venture's next
 * rung first, then the gaps a competitor has over it, then what its repo is
 * missing. Pure.
 */
export function buildCandidates({ scorecard, benchmark, engineering, ventures = listVentures() }) {
  const out = [];
  const byId = Object.fromEntries(ventures.map((v) => [v.id, v]));
  const order = [...scorecard.ventures].sort((a, b) => b.reached - a.reached);

  const push = (v, key, kind, title, instruction, why) => {
    if (kind === 'pr' && !byId[v.id]?.repo) {
      const k = `decision:${v.id}:link-repo`;
      if (!out.some((c) => c.key === k)) out.push({ key: k, ventureId: v.id, venture: v.title, kind: 'decision', title: `No repo is linked for ${v.title}`, instruction: `The team wants to open pull requests for ${v.title} (${title}) but no repo is linked. File a decision request asking the founder to link one (LINK <id> <owner/repo> <paths>), and say which change is waiting.`, why });
      return;
    }
    out.push({ key, ventureId: v.id, venture: v.title, kind, title, instruction, why });
  };

  for (const v of order) {
    const rung = v.next;
    if (rung && LADDER_FIXES[rung.key]) {
      const [kind, text] = LADDER_FIXES[rung.key];
      push(v, `ladder:${v.id}:${rung.key}`, kind, `${v.title}: ${rung.label}`, text, rung.evidence);
    }
    const bv = benchmark?.ventures?.find((b) => b.id === v.id);
    if (bv) {
      const gaps = [...gapsAgainstBest(bv, 'quality'), ...gapsAgainstBest(bv, 'innovation')];
      const seen = new Set();
      for (const label of gaps) {
        const fix = BENCH_FIXES.find(([re]) => re.test(label));
        if (!fix || seen.has(fix[1])) continue;
        seen.add(fix[1]);
        push(v, `bench:${v.id}:${fix[1]}`, fix[2], `${v.title}: ${label}`, fix[3], `a competitor was seen to have this and ${v.title} was not: "${label}"`);
      }
    }
    const repo = engineering?.repos?.find((r) => !r.error && byId[v.id]?.repo && r.owner.toLowerCase() === byId[v.id].repo.owner.toLowerCase() && r.name.toLowerCase() === byId[v.id].repo.name.toLowerCase());
    if (repo) {
      const link = byId[v.id].repo;
      const outside = [];
      for (const c of repo.checklist.filter((c) => !c.present && REPO_FIXES[c.key])) {
        const target = REPO_FIX_PATHS[c.key];
        if (target && !isPathAllowed(link, target)) {
          outside.push(target);
          continue;
        }
        push(v, `repo:${v.id}:${c.key}`, 'pr', `${v.title}'s repo is missing: ${c.label}`, REPO_FIXES[c.key], `the code review found this missing in ${repo.owner}/${repo.name}`);
      }
      // One request for all of them, instead of pull requests the scope would refuse.
      if (outside.length) {
        const paths = [...new Set(outside)];
        push(v, `decision:${v.id}:paths:${paths.join('+')}`, 'decision', `${v.title}: the team may not write ${paths.join(', ')} in ${repo.owner}/${repo.name}`, `The code review found ${paths.join(', ')} missing in ${repo.owner}/${repo.name}, but this venture's repo link only allows ${link.allowedPaths.join(', ') || 'no paths'}, so a pull request for them would be refused. File a decision request asking the founder to widen the scope by sending LINK ${v.id} ${repo.owner}/${repo.name} ${[...link.allowedPaths, ...paths].join(' ')} (keeping every path already allowed), and say what each file would contain.`, `the code review found these missing in ${repo.owner}/${repo.name}, outside the allowed paths`);
      }
    }
  }
  return out;
}

/**
 * Today's corrections: what was not tried in the last week, not given up on, up
 * to the daily limit. Pure over the state passed in.
 */
export function selectCandidates(candidates, { now = new Date(), attempts = load().attempts, limit = perDay() } = {}) {
  const fresh = candidates.filter((c) => {
    const a = attempts[c.key];
    if (!a) return true;
    if (a.count >= GIVE_UP_AFTER) return false;
    return now.getTime() - Date.parse(a.last) >= RETRY_AFTER_DAYS * DAY;
  });
  return fresh.slice(0, limit).map((c, i) => ({ ...c, id: `F${i + 1}` }));
}

export function kickoff(selected, date) {
  const list = selected.map((c) => `${c.id}. [${c.kind}] ${c.title}\n   What to do: ${c.instruction}\n   Why: ${c.why}`).join('\n');
  return `It's ${date}. The consultant's review chose these corrections and the founder has given the team standing authority to start them without asking first, inside limits that are enforced in code.

You may: open pull requests in repos already linked to a venture (within that repo's allowed paths; never merge, the founder or CI decides), queue and work tasks, set objectives, record pipeline contacts that carry a source, draft emails (a draft reaches nobody until the founder releases it), write notes, and file a decision request for anything that needs the founder.
You may not, and cannot: commit to a main branch, deploy, revert, send an email, create a payment link, change a price, spend money, change a setting or a credential, or change this company's own platform code.

For each correction below: do it, or file a request_decision if it needs the founder (a price, a service to sign up for, a credential, a repo to link), or say exactly what stopped you. Do not widen the work beyond the correction. Delegate code to the CTO and growth work to the COO; read the repo before you change it, and keep each pull request small.

${list}

Finish with exactly one line per correction, in this form: "F1: done — <the pull request URL or what was recorded>", "F1: asked — <the decision you filed>", or "F1: blocked — <why>".`;
}

/** Reads the closing lines into an outcome per correction. Pure. */
export function parseOutcomes(text, selected) {
  const found = {};
  // Bullets and bold around the id are how models format a list: "- **F1:** done — …".
  for (const m of String(text || '').matchAll(/^[\s>*•\-]*\**F(\d+)\**\s*[:.\-]\s*\**\s*(done|asked|blocked)\b\**\s*[—:\-–]*\s*(.*)$/gim)) found[`F${m[1]}`] = { status: m[2].toLowerCase(), note: m[3].replace(/\*+/g, '').trim().slice(0, 300) };
  return selected.map((c) => ({ id: c.id, key: c.key, title: c.title, kind: c.kind, ...(found[c.id] || { status: 'unknown', note: 'the session did not report on this one' }) }));
}

const pullRequests = () => listVentures().flatMap((v) => (v.pullRequests || []).map((p) => ({ venture: v.title, url: p.url, title: p.title })));

/**
 * Runs today's corrections. Never throws. Resolves to { ran, reason? } or the
 * record of the run.
 */
export async function runAutofix({ anthropic, selected, now = new Date(), force = false, run = runAgent }) {
  if (!autofixOn()) return { ran: false, reason: process.env.CONSULTANT_AUTOFIX_DISABLED === 'true' ? 'CONSULTANT_AUTOFIX_DISABLED is true' : 'automatic corrections are off (AUTOFIX ON turns them on)' };
  if (getKillSwitch().halted) return { ran: false, reason: 'real actions are halted (RESUME lifts it)' };
  if (getSpendToday() >= dailyCapUsd()) return { ran: false, reason: 'the daily model spend cap is reached' };
  if (!selected?.length) return { ran: false, reason: 'there is nothing new to correct today' };
  const date = now.toISOString().slice(0, 10);
  const state = load();
  if (!force && state.lastRunDate === date) return { ran: false, reason: 'corrections already ran today' };

  const before = new Set(pullRequests().map((p) => p.url));
  const startedAt = new Date().toISOString();
  const record = { date, at: startedAt, corrections: selected.map(({ id, key, title, kind }) => ({ id, key, title, kind })), outcomes: [], prs: [], actions: {}, summary: '', error: null, usd: 0 };
  try {
    const result = await withSpendContext({ source: 'autofix' }, () =>
      run({
        anthropic,
        agents: COMPANY_AGENTS,
        agentId: COMPANY_ROOT,
        messages: [{ role: 'user', content: kickoff(selected, date) }],
        actionHandlers: autofixHandlers(),
        extraContext: buildCompanyContext(),
        budgetUsd: autofixBudgetUsd(),
      }),
    );
    // The closing lines are the last thing the session writes, so they are read from
    // the whole reply and only then is it cut for storage, keeping the END: cutting
    // first, as this once did, threw away exactly the lines that report the outcome.
    const text = String(result?.text ?? result ?? '');
    record.outcomes = parseOutcomes(text, selected);
    record.summary = text.length > 1500 ? `…${text.slice(-1500)}` : text;
    record.usd = result?.usage?.costUsd || 0;
  } catch (err) {
    record.error = String(err?.message || err).slice(0, 300);
    record.outcomes = parseOutcomes('', selected).map((o) => ({ ...o, status: 'blocked', note: `the session failed: ${record.error}` }));
  }
  record.prs = pullRequests().filter((p) => !before.has(p.url));
  for (const e of listActivity({ since: startedAt }).filter((x) => x.kind === 'action')) {
    const t = (record.actions[e.tool] ||= { ok: 0, refused: 0 });
    e.ok ? (t.ok += 1) : (t.refused += 1);
  }

  const next = load();
  for (const c of selected) next.attempts[c.key] = { count: (next.attempts[c.key]?.count || 0) + 1, last: now.toISOString() };
  next.lastRunDate = date;
  next.runs = [...next.runs, record].slice(-30);
  writeJson(FILE, next);
  return { ran: true, ...record };
}

export const lastFixRun = () => load().runs.slice(-1)[0] || null;

export function autofixStatus() {
  const state = load();
  const last = state.runs.slice(-1)[0];
  const given = Object.entries(state.attempts).filter(([, a]) => a.count >= GIVE_UP_AFTER).length;
  return [
    `Automatic corrections are ${autofixOn() ? 'ON' : 'OFF'}${process.env.CONSULTANT_AUTOFIX_DISABLED === 'true' ? ' (CONSULTANT_AUTOFIX_DISABLED is set on the server)' : ''}: up to ${perDay()} a day, $${autofixBudgetUsd()} a day at most.`,
    last ? `Last ran ${last.date}: ${last.outcomes.filter((o) => o.status === 'done').length} done, ${last.outcomes.filter((o) => o.status === 'asked').length} asked, ${last.outcomes.filter((o) => o.status === 'blocked' || o.status === 'unknown').length} blocked; ${last.prs.length} pull requests opened.` : 'It has not run yet.',
    given ? `${given} correction${given === 1 ? '' : 's'} given up on after ${GIVE_UP_AFTER} tries and left for you.` : '',
    'It can open pull requests (never merged), queue tasks, record sourced contacts, draft emails and file decisions. It cannot merge, deploy, send, revert, change a price or spend money. AUTOFIX OFF stops it.',
  ].filter(Boolean).join('\n');
}

/** The email section: what is about to start, and what the last run did. Pure. */
export function renderFixes({ planned = [], last = null, on = true }) {
  const lines = [];
  if (!on) lines.push('Automatic corrections are OFF (AUTOFIX ON turns them on), so nothing below is being started.');
  if (last) {
    lines.push(`What the last run (${last.date}) did:`);
    for (const o of last.outcomes) lines.push(`  ${o.id}  ${o.status.toUpperCase()}  ${o.title}${o.note ? ` — ${o.note}` : ''}`);
    if (last.prs.length) lines.push('  Pull requests opened (never merged; you or CI decide):', ...last.prs.map((p) => `    - ${p.venture}: ${p.title} ${p.url}`));
    if (last.error) lines.push(`  The session failed: ${last.error}`);
    // What actually happened, from the activity log rather than from the session's own account.
    const used = Object.entries(last.actions || {});
    lines.push(used.length ? `  What the session did, from the activity log: ${used.map(([t, n]) => `${t} ${n.ok} done${n.refused ? `, ${n.refused} refused` : ''}`).join('; ')}.` : '  The activity log shows the session took no action with any tool.');
    if (last.outcomes.some((o) => o.status === 'unknown') && last.summary) lines.push('  It gave no closing line for some corrections. The end of what it said:', ...String(last.summary).slice(-600).split('\n').map((l) => `    | ${l}`));
    lines.push(`  Cost: $${(last.usd || 0).toFixed(3)}.`, '');
  } else if (on) {
    lines.push('No correction has run yet.', '');
  }
  if (on && planned.length) {
    lines.push('Starting now, after this email (the team has standing authority for these, inside the limits below):');
    for (const c of planned) lines.push(`  ${c.id}  [${c.kind}]  ${c.title}`, `        why: ${c.why}`);
  } else if (on) {
    lines.push('Nothing new to correct today: every gap is either closed, tried in the last week, or given up on and left for you.');
  }
  lines.push('', 'The limits, enforced in code: pull requests only, never merged; no deploys, reverts, sent email, price changes or spending; no change to this company\'s own platform code; a decision request for anything that needs you. AUTOFIX OFF stops all of it.');
  return lines.join('\n');
}
