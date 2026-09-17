// The company as a graph, and the short-lived links that let a phone open it.
//
// Two things are worth testing here and they are not the drawing. The drawing
// is judged by looking at it; what a test can hold is that the model tells the
// truth about the running company, and that the link mechanism does not quietly
// become a permanent credential sitting in a chat log.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let graph;
let viewToken;
const saved = {};
const KEYS = ['APP_ACCESS_TOKEN', 'PUBLIC_URL', 'RAILWAY_PUBLIC_DOMAIN', 'VIEW_TOKEN_TTL_MINUTES', 'AGENT_MODEL_TIERS', 'GEMINI_API_KEY'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-graph-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  graph = await import('../graph.js');
  viewToken = await import('../viewToken.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.APP_ACCESS_TOKEN = 'app-secret';
});

// --- The model --------------------------------------------------------------

test('every agent is a node and every reporting link is an edge', async () => {
  const { AGENTS } = await import('../agents/orgChart.js');
  const g = graph.buildGraph();

  assert.equal(g.nodes.length, Object.keys(AGENTS).length);
  // A tree: every agent except the root has exactly one manager.
  assert.equal(g.edges.length, g.nodes.length - 1);
  assert.equal(g.nodes.filter((n) => n.isRoot).length, 1);

  const ids = new Set(g.nodes.map((n) => n.id));
  for (const edge of g.edges) {
    assert.ok(ids.has(edge.source), `${edge.source} is an edge end with no node`);
    assert.ok(ids.has(edge.target), `${edge.target} is an edge end with no node`);
  }
});

// An agent that has never run is the finding, not a gap to tidy away. A roster
// of twenty-two where six are never consulted is worth seeing, and dropping
// them would hide exactly that.
test('agents that have never run are present and marked idle, not omitted', () => {
  const g = graph.buildGraph();
  assert.equal(g.meta.ranCount, 0, 'no report yet, so nothing has run');
  assert.equal(g.meta.idleCount, g.nodes.length);
  assert.ok(g.nodes.every((n) => n.ranTimes === 0));
});

test('a node carries the model it would actually run on right now', () => {
  const g = graph.buildGraph();
  const ceo = g.nodes.find((n) => n.id === 'ceo');
  assert.equal(ceo.provider, 'anthropic');
  assert.equal(ceo.frontier, true);
});

// The picture's whole point is being current. Reading a stale field would make
// it lie in the one way nobody would check.
test('moving an agent to another provider changes what the graph reports', () => {
  process.env.GEMINI_API_KEY = 'g';
  process.env.AGENT_MODEL_TIERS = 'ceo:analyst';

  const ceo = graph.buildGraph().nodes.find((n) => n.id === 'ceo');
  assert.equal(ceo.provider, 'gemini');
  assert.equal(ceo.frontier, false);
});

// Answers the first question the picture prompts: why is that one still
// expensive. Shown as a ring rather than a sixth hue, so it is legible
// alongside the department colours.
test('agents pinned to Anthropic by a server tool are flagged', () => {
  const g = graph.buildGraph();
  const pinned = g.nodes.filter((n) => n.pinnedToAnthropic).map((n) => n.id).sort();
  assert.deepEqual(pinned, ['seo_specialist', 'solutions_architect']);
});

test('the latest report lights up the agents that actually ran', async () => {
  const { saveDailyReport } = await import('../dailyReports.js');
  saveDailyReport({
    date: '2026-09-15',
    generatedAt: new Date().toISOString(),
    leadership: { reply: 'x', trace: [{ id: 'cto', title: 'CTO', depth: 1, ms: 4200 }] },
    studio: { reply: 'y', trace: [] },
  });

  const g = graph.buildGraph();
  const cto = g.nodes.find((n) => n.id === 'cto');
  assert.equal(cto.ranTimes, 1);
  assert.equal(cto.ranMs, 4200);
  assert.equal(g.meta.ranCount, 1);
  assert.equal(g.meta.idleCount, g.nodes.length - 1);

  // The edge the question actually travelled, so the picture shows the path
  // taken rather than only the paths available.
  const edge = g.edges.find((e) => e.target === 'cto');
  assert.equal(edge.active, true);
  assert.equal(g.edges.find((e) => e.target === 'cfo').active, false);
});

test('an agent consulted twice in one turn is summed, not overwritten', async () => {
  const { saveDailyReport } = await import('../dailyReports.js');
  saveDailyReport({
    date: '2026-09-16',
    generatedAt: new Date().toISOString(),
    leadership: {
      reply: 'x',
      trace: [
        { id: 'cto', title: 'CTO', depth: 1, ms: 1000 },
        { id: 'cto', title: 'CTO', depth: 1, ms: 1500 },
      ],
    },
    studio: { reply: 'y', trace: [] },
  });

  const cto = graph.buildGraph().nodes.find((n) => n.id === 'cto');
  assert.equal(cto.ranTimes, 2);
  assert.equal(cto.ranMs, 2500);
});

// --- View tokens ------------------------------------------------------------

test('a fresh view token verifies, and a tampered one does not', () => {
  const token = viewToken.mintViewToken();
  assert.equal(viewToken.verifyViewToken(token).valid, true);

  assert.equal(viewToken.verifyViewToken(token.slice(0, -2) + 'xx').reason, 'bad signature');
  assert.equal(viewToken.verifyViewToken('nonsense').reason, 'malformed');
  assert.equal(viewToken.verifyViewToken('').reason, 'malformed');
  assert.equal(viewToken.verifyViewToken(undefined).reason, 'malformed');
});

// The property that makes this safe to send over WhatsApp at all. A message is
// forwarded, screenshotted and backed up; a link that grants access forever is
// a credential in a chat log.
test('a view token expires', () => {
  const token = viewToken.mintViewToken({ ttlMs: 1000, now: 0 });
  assert.equal(viewToken.verifyViewToken(token, { now: 500 }).valid, true);
  assert.equal(viewToken.verifyViewToken(token, { now: 1001 }).reason, 'expired');
});

// A leaked view link must not become a key to the mutating API. Derived rather
// than reused, so presenting one where the app token is expected fails.
test('a view token is not the app token', () => {
  const token = viewToken.mintViewToken();
  assert.notEqual(token, process.env.APP_ACCESS_TOKEN);
  assert.ok(!token.includes(process.env.APP_ACCESS_TOKEN));
});

// Rotating the app secret must invalidate every link already in a chat log.
test('changing the app token invalidates existing view links', () => {
  const token = viewToken.mintViewToken();
  process.env.APP_ACCESS_TOKEN = 'rotated';
  assert.equal(viewToken.verifyViewToken(token).valid, false);
});

// Nothing is protected in this state and requireAccess already says so loudly.
// Pretending a view token means something here would be theatre.
test('with no app token set, view tokens are not pretended to be meaningful', () => {
  delete process.env.APP_ACCESS_TOKEN;
  const verdict = viewToken.verifyViewToken('anything at all');
  assert.equal(verdict.valid, true);
  assert.match(verdict.reason, /nothing is protected/);
});

// The whole reason for the fragment. A query string is logged by the web
// server, the proxy, the CDN and every error tracker in between — which this
// codebase's own api-authentication skill spends a paragraph on.
test('the link carries the token in the fragment, never the query string', () => {
  process.env.PUBLIC_URL = 'https://jarvis.example.com';
  const link = viewToken.graphLink();

  assert.ok(link.startsWith('https://jarvis.example.com/graph#t='), link);
  assert.ok(!link.includes('?'), 'a token in a query string lands in access logs');

  // And it is a real token, not a placeholder.
  const token = new URL(link).hash.replace('#t=', '');
  assert.equal(viewToken.verifyViewToken(token).valid, true);
});

test('the base URL comes from PUBLIC_URL, or Railway, or is honestly absent', () => {
  assert.equal(viewToken.publicBaseUrl(), '');

  process.env.RAILWAY_PUBLIC_DOMAIN = 'jarvis-production.up.railway.app';
  assert.equal(viewToken.publicBaseUrl(), 'https://jarvis-production.up.railway.app');

  // An explicit setting wins over the platform's guess.
  process.env.PUBLIC_URL = 'https://company.example.com/';
  assert.equal(viewToken.publicBaseUrl(), 'https://company.example.com', 'trailing slash trimmed');
});
