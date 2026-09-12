// This app hand-wrote clients for GitHub, email, OpenRouter, OpenAI, Gemini,
// Honcho and WhatsApp — seven, each with its own auth, error shape and tests.
// MCP is how that stops. What's worth testing is the scoping, because an MCP
// server is a tool surface and the org chart's whole premise is that
// capability follows role.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpServers, serversForAgent, mcpRequestFields, isMcpConfigured, describeMcpForAgent } from '../agents/mcp.js';
import { runAgent } from '../agents/agentRunner.js';

let saved;
let tmpDir;

before(() => {
  saved = process.env.MCP_SERVERS;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
});

after(() => {
  if (saved === undefined) delete process.env.MCP_SERVERS;
  else process.env.MCP_SERVERS = saved;
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.MCP_SERVERS = 'stripe=https://mcp.stripe.com,linear=https://mcp.linear.app/sse';
});

test('servers are parsed from name=url pairs', () => {
  assert.deepEqual(mcpServers(), [
    { type: 'url', url: 'https://mcp.stripe.com', name: 'stripe' },
    { type: 'url', url: 'https://mcp.linear.app/sse', name: 'linear' },
  ]);
  assert.equal(isMcpConfigured(), true);
});

test('a malformed entry is skipped, not fatal', () => {
  process.env.MCP_SERVERS = 'good=https://ok.example, broken, bad=notaurl';
  assert.deepEqual(mcpServers().map((s) => s.name), ['good']);
});

test('unset means no servers and no beta flag', () => {
  delete process.env.MCP_SERVERS;
  assert.deepEqual(mcpServers(), []);
  assert.equal(isMcpConfigured(), false);
  assert.deepEqual(mcpRequestFields({ id: 'cfo', mcpServers: ['stripe'] }), {});
});

test('an agent gets only the servers its role names', () => {
  const cfo = { id: 'cfo', mcpServers: ['stripe'] };
  assert.deepEqual(serversForAgent(cfo).map((s) => s.name), ['stripe']);
});

test('an agent with none listed gets none — not all', () => {
  // A tool surface nobody chose is how an agent ends up with a capability its
  // role never implied.
  assert.deepEqual(serversForAgent({ id: 'intern' }), []);
  assert.deepEqual(serversForAgent({ id: 'intern', mcpServers: [] }), []);
});

test('a server named in the roster but absent from the environment is skipped', () => {
  const agent = { id: 'cfo', mcpServers: ['stripe', 'quickbooks'] };
  assert.deepEqual(serversForAgent(agent).map((s) => s.name), ['stripe']);
});

test('both halves are produced, because one alone is rejected by the API', () => {
  const fields = mcpRequestFields({ id: 'cfo', mcpServers: ['stripe'] });

  assert.deepEqual(fields.mcp_servers, [{ type: 'url', url: 'https://mcp.stripe.com', name: 'stripe' }]);
  assert.deepEqual(fields.mcpTools, [{ type: 'mcp_toolset', mcp_server_name: 'stripe' }]);
  assert.ok(fields.betas.includes('mcp-client-2025-11-20'));
});

test('the toolset name matches the server name exactly', () => {
  const fields = mcpRequestFields({ id: 'cfo', mcpServers: ['stripe', 'linear'] });
  assert.deepEqual(
    fields.mcpTools.map((t) => t.mcp_server_name),
    fields.mcp_servers.map((s) => s.name)
  );
});

// --- Through the runner -----------------------------------------------------

function stubAnthropic(capture) {
  const reply = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  return {
    messages: { create: async (params) => { capture.push({ beta: false, params }); return reply; } },
    beta: { messages: { create: async (params) => { capture.push({ beta: true, params }); return reply; } } },
  };
}

test('an agent with servers goes through the beta endpoint carrying both halves', async () => {
  const calls = [];
  const agents = {
    cfo: { id: 'cfo', title: 'CFO', department: 'F', reportsTo: null, reports: [], systemPrompt: 'x', mcpServers: ['stripe'] },
  };

  await runAgent({ anthropic: stubAnthropic(calls), agents, agentId: 'cfo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(calls[0].beta, true, 'MCP requires the beta endpoint');
  assert.deepEqual(calls[0].params.mcp_servers.map((s) => s.name), ['stripe']);
  assert.ok(calls[0].params.tools.some((t) => t.type === 'mcp_toolset'));
});

test('an agent without servers stays on the stable endpoint', async () => {
  // A company with no MCP servers must be unaffected by the beta entirely.
  const calls = [];
  const agents = {
    solo: { id: 'solo', title: 'Solo', department: 'T', reportsTo: null, reports: [], systemPrompt: 'x' },
  };

  await runAgent({ anthropic: stubAnthropic(calls), agents, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(calls[0].beta, false);
  assert.equal(calls[0].params.mcp_servers, undefined);
  assert.equal(calls[0].params.betas, undefined);
});

test('the agent is told which services it has', () => {
  const note = describeMcpForAgent({ id: 'cfo', mcpServers: ['stripe'] });
  assert.match(note, /stripe/);
  assert.equal(describeMcpForAgent({ id: 'solo' }), '', 'no servers, no note');
});
