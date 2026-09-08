// Generic helpers over an agent map (`{ id: agentDefinition }`), shared by
// every org chart / team (the operating company, the venture studio, and
// whatever gets added next) so agentRunner.js doesn't need to know which
// one it's driving.

export function getAgent(agents, id) {
  const agent = agents[id];
  if (!agent) throw new Error(`Unknown agent id: ${id}`);
  return agent;
}

// Sanitized view for the frontend (no system prompts).
export function listAgents(agents) {
  return Object.values(agents).map(({ id, title, department, reportsTo, reports, mission }) => ({
    id,
    title,
    department,
    reportsTo,
    reports,
    mission,
  }));
}
