// MCP servers as agent tools.
//
// This app has hand-written clients for GitHub, email, OpenRouter, OpenAI,
// Gemini, Honcho and WhatsApp — seven, each with its own auth, its own error
// shape, its own tests. Every new service is another one. MCP is how that
// stops: a server exposes its tools, Anthropic calls them, and this codebase
// carries a URL and a name instead of a client.
//
// Two halves are required and one alone is rejected: `mcp_servers` declares
// the connection, and an `mcp_toolset` entry in `tools` says an agent may use
// it. Both carry the same name.
//
// Scoping is per agent and deliberate. A server available to every agent is a
// tool surface nobody chose — the CFO does not need a deploy tool, and the
// point of the org chart is that capability follows role.

const BETA = 'mcp-client-2025-11-20';

export function isMcpConfigured() {
  return mcpServers().length > 0;
}

/**
 * Servers from MCP_SERVERS, as `name=url` pairs separated by commas.
 *
 *   MCP_SERVERS=stripe=https://mcp.stripe.com,linear=https://mcp.linear.app/sse
 *
 * A flat env var rather than a config file because it is deployment
 * configuration, sits beside every other credential in Railway, and a
 * malformed entry should be visible where it is set.
 */
export function mcpServers() {
  return (process.env.MCP_SERVERS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('=');
      if (at < 1) {
        console.warn(`Ignoring malformed MCP server "${entry}" — expected name=url.`);
        return null;
      }
      const name = entry.slice(0, at).trim();
      const url = entry.slice(at + 1).trim();
      if (!/^https?:\/\//.test(url)) {
        console.warn(`Ignoring MCP server "${name}" — "${url}" is not an http(s) URL.`);
        return null;
      }
      return { type: 'url', url, name };
    })
    .filter(Boolean);
}

/**
 * Which servers an agent may use, from its `mcpServers` field.
 *
 * Omitted means none. Not "all" — a tool surface nobody chose is how an agent
 * ends up with a capability its role never implied, and the whole point of
 * the org chart is that capability follows role.
 */
export function serversForAgent(agent) {
  const wanted = agent?.mcpServers;
  if (!Array.isArray(wanted) || !wanted.length) return [];

  const available = mcpServers();
  return wanted
    .map((name) => {
      const server = available.find((candidate) => candidate.name === name);
      if (!server) {
        // Named in the roster, absent from the environment. Worth saying:
        // silence here looks identical to an agent that simply never used it.
        console.warn(`Agent "${agent.id}" wants MCP server "${name}", which is not in MCP_SERVERS.`);
        return null;
      }
      return server;
    })
    .filter(Boolean);
}

/**
 * The request fields an agent's MCP servers add: the connection half, the
 * toolset half, and the beta flag. Empty when the agent has none, so the
 * request is byte-identical to before and nothing is cached differently.
 */
export function mcpRequestFields(agent) {
  const servers = serversForAgent(agent);
  if (!servers.length) return {};

  return {
    mcp_servers: servers,
    mcpTools: servers.map((server) => ({ type: 'mcp_toolset', mcp_server_name: server.name })),
    betas: [BETA],
  };
}

export function describeMcpForAgent(agent) {
  const servers = serversForAgent(agent);
  if (!servers.length) return '';
  return (
    `Connected services you can use directly: ${servers.map((s) => s.name).join(', ')}. ` +
    'Their tools appear alongside your own — prefer them to asking someone to do it by hand.'
  );
}
