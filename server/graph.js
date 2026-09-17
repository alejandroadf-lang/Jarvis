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
// roster where half have never once been consulted is a finding, and dropping
// them from the picture would hide exactly that.
//
// ## Both teams, not one
//
// The first version drew only the Executive Team and reported "22 agents",
// which is not the company: the Venture Studio is six more, it runs every
// morning in the second phase of the daily sync, and its trace was being read
// and then silently discarded because none of its ids matched a node. For a
// picture whose whole job is "which parts of the company moved this morning",
// omitting a team that ran is the failure it exists to prevent.
//
// So the graph has two roots — the CEO and the Venture Partner — and draws two
// constellations with no edge between them, which is exactly how the company
// works: the Studio proposes ventures, the Executive Team builds them, and they
// never consult each other mid-turn.

import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from './agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS, ROOT_AGENT_ID as STUDIO_ROOT } from './agents/ideationTeam.js';
import { resolveModelForAgent } from './agents/models.js';
import { isOpenRouterConfigured } from './agents/openrouter.js';
import { getLatestDailyReport } from './dailyReports.js';
import { getProfitShare } from './finance/profitShare.js';
import { listTasks } from './tasks.js';
import { getSpendSummary } from './spend.js';
import { listVentures } from './finance/ventures.js';

/**
 * @returns {{nodes: Array, edges: Array, meta: object}}
 */
const TEAMS = [
  { key: 'executive', label: 'Executive Team', agents: COMPANY_AGENTS, root: COMPANY_ROOT },
  { key: 'studio', label: 'Venture Studio', agents: STUDIO_AGENTS, root: STUDIO_ROOT },
];

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

  const nodes = TEAMS.flatMap(({ key, agents, root }) => Object.values(agents).map((agent) => {
    const spec = resolveModelForAgent(agent, alternativeAvailable);
    const ran = activity.get(agent.id) || null;
    const paid = earnings.get(agent.id) || null;

    return {
      id: agent.id,
      title: agent.title,
      department: agent.department,
      team: key,
      reportsTo: agent.reportsTo || null,
      isRoot: agent.id === root,
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
  }));

  const byId = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const { agents } of TEAMS) {
    for (const agent of Object.values(agents)) {
      for (const reportId of agent.reports || []) {
        if (!byId.has(reportId)) continue;
        edges.push({
          source: agent.id,
          target: reportId,
          // An edge the latest sync actually travelled, so the picture shows
          // the path a question took rather than only the paths it could have.
          active: Boolean(activity.get(reportId)),
        });
      }
    }
  }

  const ranCount = nodes.filter((n) => n.ranTimes > 0).length;

  // The board on the office wall. Company-level rather than per-agent, because
  // "what is the company doing" is a different question from "who ran", and the
  // office view has room to answer both at once where the graph does not.
  const tasks = listTasks({ limit: 500 });
  const spend = getSpendSummary();
  const ventures = listVentures();

  return {
    nodes,
    edges,
    meta: {
      // Both roots, because there are two. A single `root` field was the shape
      // that made it easy to forget the second team existed.
      roots: TEAMS.map((t) => ({ id: t.root, team: t.key, label: t.label })),
      agentCount: nodes.length,
      teamCounts: Object.fromEntries(
        TEAMS.map((t) => [t.key, nodes.filter((n) => n.team === t.key).length])
      ),
      ranCount,
      // Named rather than derived in the page: "six agents have never been
      // consulted" is the finding, and a viewer should not have to count dots.
      idleCount: nodes.length - ranCount,
      frontierCount: nodes.filter((n) => n.frontier).length,
      tasks: {
        done: tasks.filter((t) => t.status === 'done').length,
        running: tasks.filter((t) => t.status === 'running').length,
        queued: tasks.filter((t) => t.status === 'queued').length,
        failed: tasks.filter((t) => t.status === 'failed').length,
      },
      spend: { spentUsd: spend.spentUsd, capUsd: spend.capUsd, overCap: spend.overCap },
      ventures: {
        active: ventures.filter((v) => v.status === 'active').length,
        total: ventures.length,
      },
      reportDate: report?.date || null,
      reportScope: report?.scope?.full === false ? 'narrow' : report?.scope ? 'full' : null,
      generatedAt: new Date().toISOString(),
    },
  };
}
