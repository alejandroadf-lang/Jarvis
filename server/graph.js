// The company as a graph, from live data.
//
// The org chart has always been a tree in a JS object and a list in a sidebar.
// Neither shows the thing a founder actually wants to see at a glance: which
// parts of the company moved this morning, which are expensive, and which have
// never done anything at all. A list sorts by name; a graph sorts by structure,
// and structure is the question — "who did the CEO actually talk to" is one
// look at a picture and a paragraph of text.
//
// Every field here comes from something already recorded. Nothing is computed
// for display that isn't true of the running company:
//
//   - edges are the reportsTo links validate.js already enforces
//   - `ran` and `ms` come from the latest daily report's delegation trace
//   - `provider` is what resolveModelForAgent would actually pick right now,
//     which is the only honest answer given AGENT_MODEL_TIERS can change it
//     without a deploy
//   - `earnedUsd` and `contributions` come from the profit-share ledger
//
// An agent that has never run shows as unlit rather than being left out. A
// roster of twenty-two where six have never once been consulted is a finding,
// and dropping them from the picture would hide exactly that.

import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID } from './agents/orgChart.js';
import { resolveModelForAgent } from './agents/models.js';
import { isOpenRouterConfigured } from './agents/openrouter.js';
import { getLatestDailyReport } from './dailyReports.js';
import { getProfitShare } from './finance/profitShare.js';

/**
 * @returns {{nodes: Array, edges: Array, meta: object}}
 */
export function buildGraph() {
  const report = getLatestDailyReport();
  const trace = [...(report?.leadership?.trace || []), ...(report?.studio?.trace || [])];

  // An agent can appear more than once in a trace — consulted twice in one
  // turn — so the map keeps the total time rather than the last one.
  const activity = new Map();
  for (const entry of trace) {
    if (!entry?.id) continue;
    const prior = activity.get(entry.id) || { times: 0, ms: 0, depth: entry.depth ?? null };
    activity.set(entry.id, {
      times: prior.times + 1,
      ms: prior.ms + (Number(entry.ms) || 0),
      depth: prior.depth ?? entry.depth ?? null,
    });
  }

  const earnings = new Map();
  for (const row of getProfitShare()?.agents || []) {
    earnings.set(row.agentId, row);
  }

  const alternativeAvailable = isOpenRouterConfigured();

  const nodes = Object.values(COMPANY_AGENTS).map((agent) => {
    const spec = resolveModelForAgent(agent, alternativeAvailable);
    const ran = activity.get(agent.id) || null;
    const paid = earnings.get(agent.id) || null;

    return {
      id: agent.id,
      title: agent.title,
      department: agent.department,
      reportsTo: agent.reportsTo || null,
      isRoot: agent.id === ROOT_AGENT_ID,
      // How many agents sit under it, so the layout can size a manager by the
      // weight of what it actually carries rather than by name length.
      reportCount: (agent.reports || []).length,
      toolCount: (agent.actions || []).length,
      provider: spec.provider,
      model: spec.model,
      // The distinction that matters for the bill: frontier or not.
      frontier: spec.provider === 'anthropic',
      // web_search cannot leave Anthropic, and "why is this one still
      // expensive" is the first question the picture will prompt.
      pinnedToAnthropic: (agent.serverTools || []).length > 0,
      ranTimes: ran?.times || 0,
      ranMs: ran?.ms || 0,
      earnedUsd: paid?.earnedUsd ?? 0,
      contributions: paid?.contributions ?? 0,
    };
  });

  const byId = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const agent of Object.values(COMPANY_AGENTS)) {
    for (const reportId of agent.reports || []) {
      if (!byId.has(reportId)) continue;
      edges.push({
        source: agent.id,
        target: reportId,
        // An edge the latest sync actually travelled, so the picture shows the
        // path a question took rather than only the paths it could have.
        active: Boolean(activity.get(reportId)),
      });
    }
  }

  const ranCount = nodes.filter((n) => n.ranTimes > 0).length;

  return {
    nodes,
    edges,
    meta: {
      root: ROOT_AGENT_ID,
      agentCount: nodes.length,
      ranCount,
      // Named rather than derived in the page: "six agents have never been
      // consulted" is the finding, and a viewer should not have to count dots.
      idleCount: nodes.length - ranCount,
      frontierCount: nodes.filter((n) => n.frontier).length,
      reportDate: report?.date || null,
      reportScope: report?.scope?.full === false ? 'narrow' : report?.scope ? 'full' : null,
      generatedAt: new Date().toISOString(),
    },
  };
}
