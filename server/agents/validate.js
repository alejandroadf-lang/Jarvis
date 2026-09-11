// Structural checks on an org chart, run at import time.
//
// At 27 agents you notice a broken link because the company is small enough
// to hold in your head. At 150 you don't — and every one of these faults is
// silent at runtime rather than loud:
//
//   - A typo'd `reportsTo` leaves an agent with no manager. It exists, it
//     costs nothing, and it can never be consulted, because delegation tools
//     are built from the *manager's* `reports` array.
//   - A one-way link (in `reports` but not `reportsTo`, or vice versa) half
//     works: consultable but misfiled, or filed but unreachable.
//   - An unreachable agent is the structural version of the problem the
//     Agent Operations Engineer reports behaviourally. Better to catch it
//     before it ever runs than to discover it in a week of trace data.
//   - A cycle makes runAgent recurse until MAX_ROUNDS saves it, burning real
//     money on every level.
//
// So this throws at boot. A server that won't start is a much better outcome
// than one that quietly runs a company with three agents nobody can reach.

export function validateOrgChart(agents, rootId, label = 'org chart') {
  const problems = [];
  const ids = Object.keys(agents);

  if (!agents[rootId]) {
    throw new Error(`${label}: root agent "${rootId}" is not defined`);
  }

  for (const id of ids) {
    const agent = agents[id];

    if (agent.id !== id) {
      problems.push(`"${id}" has mismatched id field "${agent.id}" — the key and the id must agree`);
    }
    if (!agent.title) problems.push(`"${id}" has no title`);
    if (!agent.systemPrompt) problems.push(`"${id}" has no systemPrompt`);
    if (!agent.toolDescription && id !== rootId) {
      // Managers build their delegation tools from this; without it a report
      // is callable but the manager is told nothing about when to call it.
      problems.push(`"${id}" has no toolDescription, so no manager can be told when to consult it`);
    }

    // Reciprocity, checked both ways.
    const manager = agent.reportsTo;
    if (manager === null || manager === undefined) {
      if (id !== rootId) problems.push(`"${id}" has no manager but is not the root`);
    } else if (!agents[manager]) {
      problems.push(`"${id}" reports to "${manager}", which does not exist`);
    } else if (!(agents[manager].reports || []).includes(id)) {
      problems.push(`"${id}" reports to "${manager}", but "${manager}" does not list it — it can never be consulted`);
    }

    for (const reportId of agent.reports || []) {
      if (!agents[reportId]) {
        problems.push(`"${id}" lists report "${reportId}", which does not exist`);
      } else if (agents[reportId].reportsTo !== id) {
        problems.push(`"${id}" lists report "${reportId}", but that agent reports to "${agents[reportId].reportsTo}"`);
      }
    }
  }

  // Reachability and cycles in one walk down from the root.
  const seen = new Set();
  const walk = (id, path) => {
    if (path.includes(id)) {
      problems.push(`cycle in the chart: ${[...path, id].join(' -> ')}`);
      return;
    }
    seen.add(id);
    for (const reportId of agents[id]?.reports || []) {
      if (agents[reportId]) walk(reportId, [...path, id]);
    }
  };
  walk(rootId, []);

  const unreachable = ids.filter((id) => !seen.has(id));
  if (unreachable.length) {
    problems.push(`unreachable from "${rootId}": ${unreachable.join(', ')} — defined, but no path of delegation leads there`);
  }

  if (problems.length) {
    throw new Error(`${label} is invalid:\n  - ${problems.join('\n  - ')}`);
  }

  return { agentCount: ids.length, reachable: seen.size };
}
