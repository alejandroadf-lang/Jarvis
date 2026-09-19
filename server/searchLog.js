// What the team searched for, not just what it found.
//
// The measured confirmation bias in research agents is not in how evidence is
// interpreted — it is in which evidence gets *selected*. Across eleven models,
// agents propose searches that confirm rather than falsify. That is why
// reviewing the output cannot catch it: every citation shown genuinely
// supports the claim, because the disconfirming sources were never retrieved.
// The bias is invisible by construction.
//
// The only thing that makes it visible is the query log. Ten searches that all
// begin "benefits of" is a different research pass from five that do and five
// that begin "why did ... fail", and the finished write-up reads identically
// either way.
//
// Captured in the runner rather than reported by the agent, for the same
// reason contributions are: a self-reported search history is a claim, and the
// point of this file is to have something that is not.

import { readJson, writeJson } from './store.js';

const FILE = 'searchLog.json';
const MAX_KEPT = 500;

// Openings that go looking for a reason this is wrong. Deliberately crude: the
// number is a prompt for the founder's attention, never a score anybody is
// judged on — a clever agent could satisfy a regex without changing what it
// looked for, and the day this becomes a target is the day it stops measuring.
const DISCONFIRMING = [
  /\bwhy\s+(did|do|does|is|are|was|were)\b.*\b(fail|failed|not work|dead|shut down|sunset)\b/i,
  /\b(fail|failed|failure|failing)\b/i,
  /\b(problem|problems|issue|issues|complaint|complaints|downside|drawback)\b/i,
  /\b(alternative|alternatives|competitor|competitors|instead of|vs\b)/i,
  /\b(criticism|critique|risk|risks|lawsuit|regulation|banned|illegal)\b/i,
  /\b(already|existing|prior art|who else)\b/i,
];

export function looksDisconfirming(query) {
  return DISCONFIRMING.some((pattern) => pattern.test(String(query || '')));
}

export function recordSearch({ agentId, query, at = new Date().toISOString() }) {
  const text = String(query || '').trim();
  if (!text) return null;

  const data = readJson(FILE, { searches: [] });
  const entry = {
    agentId: agentId ? String(agentId) : null,
    query: text.slice(0, 300),
    disconfirming: looksDisconfirming(text),
    at,
  };
  data.searches.push(entry);
  if (data.searches.length > MAX_KEPT) data.searches = data.searches.slice(-MAX_KEPT);
  writeJson(FILE, data);
  return entry;
}

/**
 * Pulls every hosted-search query out of one model response.
 *
 * The hosted web_search tool runs inside Anthropic's infrastructure and reports
 * itself back as a `server_tool_use` block, which is the only place the query
 * text exists — the agent never writes it into its own answer, and nothing else
 * in this codebase was looking at those blocks.
 */
export function recordSearchesFrom(content, agentId) {
  const blocks = Array.isArray(content) ? content : [];
  const recorded = [];
  for (const block of blocks) {
    if (block?.type !== 'server_tool_use' || block.name !== 'web_search') continue;
    const query = block.input?.query;
    if (!query) continue;
    const entry = recordSearch({ agentId, query });
    if (entry) recorded.push(entry);
  }
  return recorded;
}

export function listSearches({ agentId = null, since = null, limit = 50 } = {}) {
  const { searches } = readJson(FILE, { searches: [] });
  return searches
    .filter((s) => (!agentId || s.agentId === agentId) && (!since || s.at >= since))
    .slice(-limit);
}

/**
 * The shape of a research pass, in one line.
 *
 * Reports the ratio rather than a verdict. There is no correct percentage —
 * a pass that is entirely disconfirming is a pass that never checked whether
 * the thing works — so this hands the founder the split and stays out of it.
 */
export function searchBalance({ since = null } = {}) {
  const searches = listSearches({ since, limit: MAX_KEPT });
  if (!searches.length) return { total: 0, disconfirming: 0, agents: {} };

  const agents = {};
  let disconfirming = 0;
  for (const search of searches) {
    const id = search.agentId || 'unknown';
    agents[id] = agents[id] || { total: 0, disconfirming: 0 };
    agents[id].total += 1;
    if (search.disconfirming) {
      agents[id].disconfirming += 1;
      disconfirming += 1;
    }
  }
  return { total: searches.length, disconfirming, agents };
}

/** For the daily report: said only when there is something to say. */
export function describeSearchBalance({ since = null } = {}) {
  const { total, disconfirming } = searchBalance({ since });
  if (!total) return '';
  const share = Math.round((disconfirming / total) * 100);
  const lines = [`Searches run: ${total}, of which ${disconfirming} (${share}%) looked for a reason this would not work.`];
  if (disconfirming === 0) {
    // The case worth naming out loud. A research pass with no disconfirming
    // query produces a page of supportive citations whether the idea is good
    // or not, so the output cannot tell you which happened.
    lines.push(
      'None of them went looking for the counter-case, which means the citations would read the same way if the idea were bad. Worth asking for the other half.'
    );
  }
  return lines.join(' ');
}
