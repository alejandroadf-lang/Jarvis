// Our technology against theirs, on what can be seen from outside.
//
// Once a week, for each active venture that has a live URL: find its closest
// competitors, probe them and the venture with the same fixed checks (see
// siteProbe.js), score both on the two printed rubrics, and rank.
//
// Who the competitors are is a judgement, and two ways of making it are kept:
// the founder's own list wins if one exists (a note in Company/Competitors/ with
// `type: competitor-list`, the venture's title in `venture:`, and the URLs to
// track as bullets under a "## Track" heading), and otherwise a search agent
// proposes up to four. The proposals are unverified for relevance and the email
// says so; every URL still has to be public https and is fetched with the same
// address and redirect checks as everything else that fetches a URL from outside.
//
// This is a comparison of observable signals: it says nothing about whose code
// is better, and a signal not found is "not found here", not "does not exist".

import { readJson, writeJson } from '../store.js';
import { runAgent } from '../agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from '../agents/orgChart.js';
import { WEB_SEARCH } from '../agents/serverTools.js';
import { withSpendContext } from '../spend.js';
import { listVentures, serviceUrl } from '../finance/ventures.js';
import { probeSite, scoreProbe, describeProbe, QUALITY_RUBRIC, INNOVATION_RUBRIC } from './siteProbe.js';

const FILE = 'consultant-benchmark.json';
const MAX_COMPETITORS = 4;
export const BENCHMARK_MAX_AGE_DAYS = 7;

export const getBenchmark = () => readJson(FILE, null);

export function benchmarkIsStale(now = new Date()) {
  const b = getBenchmark();
  return !b?.refreshedAt || now.getTime() - Date.parse(b.refreshedAt) > BENCHMARK_MAX_AGE_DAYS * 86_400_000;
}

const httpsOnly = (u) => typeof u === 'string' && /^https:\/\//i.test(u.trim());
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** URLs the founder asked to track for one venture, from the vault. Pure. */
export function founderCompetitors(notes, venture) {
  const note = (notes || []).find((n) => n.fm?.type === 'competitor-list' && String(n.fm.venture || '').toLowerCase() === venture.title.toLowerCase());
  if (!note) return null;
  const section = note.body.match(/## Track\s*\n([\s\S]*?)(\n## |$)/);
  const urls = section ? [...section[1].matchAll(/^\s*-\s*(https:\/\/\S+)/gim)].map((m) => m[1]) : [];
  return urls.slice(0, MAX_COMPETITORS).map((url) => ({ name: hostOf(url), url, source: 'founder' }));
}

function parseObject(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    const o = JSON.parse(m[0]);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

export function discoveryPrompt(ventures, now = new Date()) {
  const list = ventures.map((v) => `- id ${v.id}: "${v.title}", ${v.oneLiner || 'no one-liner'}. Customer: ${v.targetCustomer || 'unknown'}.`).join('\n');
  return `It's ${now.toISOString().slice(0, 10)}. Use web search to find, for each product below, up to ${MAX_COMPETITORS} direct competitors: products a buyer would actually compare it with, not tangential ones. Give each one's own product website (https).

${list}

Reply with JSON only, an object keyed by the id: {"<id>": [{"name": "…", "url": "https://…"}]}. Nothing else.`;
}

async function defaultDiscover({ ventures, anthropic, budget, now }) {
  const agents = { ...COMPANY_AGENTS, [COMPANY_ROOT]: { ...COMPANY_AGENTS[COMPANY_ROOT], reports: [], actions: [], serverTools: [WEB_SEARCH] } };
  const result = await withSpendContext({ source: 'consultant', agentId: 'competitor-search' }, () =>
    runAgent({ anthropic, agents, agentId: COMPANY_ROOT, messages: [{ role: 'user', content: discoveryPrompt(ventures, now) }], actionHandlers: {}, extraContext: '', budgetUsd: budget ? budget.remaining() : null }),
  );
  budget?.add(result.usage?.costUsd || 0);
  return parseObject(result.text);
}

const cleanList = (raw, ownHost) => {
  const seen = new Set([ownHost]);
  return (Array.isArray(raw) ? raw : [])
    .filter((c) => httpsOnly(c?.url))
    .filter((c) => (seen.has(hostOf(c.url)) ? false : seen.add(hostOf(c.url))))
    .slice(0, MAX_COMPETITORS)
    .map((c) => ({ name: String(c.name || hostOf(c.url)).slice(0, 60), url: c.url.trim(), source: 'search' }));
};

/**
 * Probes and ranks every venture that has a live URL. Never throws. Resolves to
 * the stored benchmark, or null when there was nothing to compare.
 */
export async function refreshBenchmark({ anthropic, budget, now = new Date(), notes = [], discover = defaultDiscover, probe = probeSite } = {}) {
  try {
    const active = listVentures().filter((v) => v.status === 'active');
    if (!active.length) return null;

    // One search call for every venture that has no founder-written list.
    const needSearch = active.filter((v) => !founderCompetitors(notes, v));
    const proposed = needSearch.length ? await discover({ ventures: needSearch, anthropic, budget, now }).catch(() => ({})) : {};

    const ventures = [];
    for (const v of active) {
      const own = serviceUrl(v);
      const ownProbe = own ? await probe(own, { now }) : null;
      const list = founderCompetitors(notes, v) || cleanList(proposed[v.id], hostOf(own));
      const competitors = [];
      for (const c of list) {
        const p = await probe(c.url, { now });
        competitors.push({ ...c, probe: p, scores: scoreProbe(p) });
      }
      const ownScores = ownProbe ? scoreProbe(ownProbe) : null;
      const readable = competitors.filter((c) => c.probe.ok);
      const rank = (key) => (ownScores?.[key] && ownProbe.ok ? { rank: 1 + readable.filter((c) => c.scores[key].score > ownScores[key].score).length, of: readable.length + 1, own: ownScores[key].score, best: Math.max(ownScores[key].score, ...readable.map((c) => c.scores[key].score)) } : null);
      ventures.push({ id: v.id, title: v.title, own: ownProbe ? { url: own, probe: ownProbe, scores: ownScores } : null, competitors, rank: { quality: rank('quality'), innovation: rank('innovation') } });
    }
    const benchmark = { refreshedAt: now.toISOString(), ventures };
    writeJson(FILE, benchmark);
    return benchmark;
  } catch (err) {
    console.error('Benchmark refresh failed:', err.message);
    return null;
  }
}

/** The observations as citable facts. Pure. */
export function benchmarkFacts(b) {
  const out = [];
  for (const v of b?.ventures || []) {
    if (!v.own) {
      out.push(`${v.title}: no live URL is recorded (URL <id> <https://…> sets it), so its technology cannot be compared with ${v.competitors.length} tracked competitors.`);
      continue;
    }
    out.push(describeProbe(`${v.title} (ours)`, v.own.probe));
    for (const c of v.competitors) out.push(describeProbe(`${c.name} (${c.source === 'founder' ? 'listed by the founder' : 'found by search, relevance unverified'})`, c.probe));
    for (const key of ['quality', 'innovation']) {
      const r = v.rank[key];
      if (r) out.push(`${v.title}: tech ${key} on the public-signal rubric: ${r.own}/10, rank ${r.rank} of ${r.of} (best ${r.best}/10).`);
    }
  }
  return out;
}

/** What a competitor has that we do not, by rubric label. Pure. */
export function gapsAgainstBest(v, key) {
  if (!v.own?.probe.ok) return [];
  const readable = v.competitors.filter((c) => c.probe.ok);
  if (!readable.length) return [];
  const best = [...readable].sort((a, b) => b.scores[key].score - a.scores[key].score)[0];
  return v.own.scores[key].items.filter((i, idx) => !i.got && best.scores[key].items[idx].got).map((i) => i.label);
}

export function renderBenchmark(b) {
  if (!b?.ventures?.length) return 'No benchmark yet: it runs weekly, once a venture has a live URL (URL <id> <https://…>) to compare.';
  const lines = ['Public signals only: what a visitor or an AI agent can see from outside. It says nothing about whose code is better, and a signal marked missing was not found on the pages probed.', ''];
  for (const v of b.ventures) {
    if (!v.own) {
      lines.push(`${v.title}: no live URL is set, so it cannot be compared. Send URL ${v.id} https://your-domain to set it.`, '');
      continue;
    }
    lines.push(`${v.title}: ${v.competitors.length} competitors tracked${v.competitors.some((c) => c.source === 'search') ? ' (found by search, relevance unverified; list your own in Company/Competitors to override)' : ''}`);
    const row = (name, probe, s) => (probe.ok ? `  ${name.padEnd(28)} quality ${s.quality.score}/10   innovation ${s.innovation.score}/10` : `  ${name.padEnd(28)} could not be probed: ${probe.reason}`);
    lines.push(row(`${v.title} (you)`, v.own.probe, v.own.scores));
    for (const c of v.competitors) lines.push(row(c.name, c.probe, c.scores));
    for (const key of ['quality', 'innovation']) {
      const r = v.rank[key];
      if (r) lines.push(`  Rank on ${key}: ${r.rank} of ${r.of}${gapsAgainstBest(v, key).length ? `. The best competitor has, and you were not seen to have: ${gapsAgainstBest(v, key).slice(0, 4).join('; ')}` : ''}`);
    }
    lines.push('');
  }
  lines.push('How the scores are made (each signal is worth one point unless marked):');
  lines.push(`  Quality out of 10: ${QUALITY_RUBRIC.map((r) => r[1]).join('; ')}.`);
  lines.push(`  Innovation out of 10: ${INNOVATION_RUBRIC.map((r) => `${r[1]}${r[2] > 1 ? ` (${r[2]})` : ''}`).join('; ')}.`);
  return lines.join('\n').trim();
}

/** KPI rows for the table: one per venture per rubric, where there is something to compare. Pure. */
export function benchmarkKpis(b) {
  const rows = [];
  for (const v of b?.ventures || []) {
    for (const [key, name] of [['quality', 'Technology quality'], ['innovation', 'Technology innovation']]) {
      const r = v.rank[key];
      if (!r || r.of < 2) {
        rows.push({ name: `${name} against competitors (${v.title})`, display: v.own ? 'no competitor could be probed, so there is nothing to compare with' : 'no live URL is set, so it cannot be compared', status: 'unmeasured', rule: 'on track at rank 1, or within 1 point of the best; behind more than 3 points off the best' });
        continue;
      }
      rows.push({
        name: `${name} against competitors (${v.title})`,
        display: `${r.own}/10, rank ${r.rank} of ${r.of} (best ${r.best}/10)`,
        status: r.rank === 1 || r.best - r.own <= 1 ? 'on_track' : r.best - r.own <= 3 ? 'watch' : 'behind',
        rule: 'on track at rank 1 or within 1 point of the best; behind when more than 3 points off',
      });
    }
  }
  return rows;
}
