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
  // Reports accumulate, and getLatestDailyReport returns the newest — so a test
  // that saves a later date silently changes what every following test reads.
  for (const f of ['dailyReports.json', 'tasks.json', 'ventures.json', 'spend.json']) {
    fs.rmSync(path.join(tmpDir, f), { force: true });
  }
});

// --- The model --------------------------------------------------------------

// The bug this replaced: the graph drew only the Executive Team and reported
// "22 agents", which is not the company. The Venture Studio is six more, it runs
// every morning in the second phase of the sync, and its trace was read and then
// silently discarded because none of its ids matched a node.
test('both teams are drawn — the company is not one roster', async () => {
  const { AGENTS: COMPANY } = await import('../agents/orgChart.js');
  const { AGENTS: STUDIO } = await import('../agents/ideationTeam.js');
  const g = graph.buildGraph();

  assert.equal(g.nodes.length, Object.keys(COMPANY).length + Object.keys(STUDIO).length);
  assert.equal(g.meta.teamCounts.executive, Object.keys(COMPANY).length);
  assert.equal(g.meta.teamCounts.studio, Object.keys(STUDIO).length);

  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(ids.has('venture_partner'), 'the Studio root is on the graph');
  assert.ok(ids.has('validation_critic'), 'and so are its leaves');
});

// A count in prose goes stale silently — "27 agents" sat in validate.js from
// before the Devil's Advocate was added, and the number a founder reads off the
// picture has to be the number the company actually has. This is the one place
// that pins it.
test('the company is 28 agents across two teams, and the graph says so', () => {
  const g = graph.buildGraph();
  assert.equal(g.nodes.length, 28, 'update this deliberately when the roster changes');
  assert.equal(g.meta.agentCount, 28);
  assert.deepEqual(g.meta.roots.map((r) => r.id), ['ceo', 'venture_partner']);
});

test('every reporting link is an edge, and both teams are trees', () => {
  const g = graph.buildGraph();

  // Two roots, two trees: each team has exactly one agent with no manager, and
  // edges = nodes - 1 per team.
  assert.equal(g.nodes.filter((n) => n.isRoot).length, 2);
  assert.equal(g.edges.length, g.nodes.length - 2);

  const ids = new Set(g.nodes.map((n) => n.id));
  for (const edge of g.edges) {
    assert.ok(ids.has(edge.source), `${edge.source} is an edge end with no node`);
    assert.ok(ids.has(edge.target), `${edge.target} is an edge end with no node`);
  }
});

// The two teams never consult each other mid-turn: the Studio proposes
// ventures, the Executive Team builds them. An edge between them would mean the
// org chart had changed, not that the drawing had.
test('no edge crosses between the teams', () => {
  const g = graph.buildGraph();
  const team = new Map(g.nodes.map((n) => [n.id, n.team]));
  const crossing = g.edges.filter((e) => team.get(e.source) !== team.get(e.target));
  assert.deepEqual(crossing, []);
});

test('the Studio has its own department, so it gets its own hue', () => {
  const g = graph.buildGraph();
  const studioDepts = [...new Set(g.nodes.filter((n) => n.team === 'studio').map((n) => n.department))];
  assert.deepEqual(studioDepts, ['Studio']);
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

// The Studio's trace was being read and thrown away, because buildGraph looked
// up ids that were never in the node list. Nothing errored; the team simply
// never lit up.
test("the Studio's own trace lights up Studio agents", async () => {
  const { saveDailyReport } = await import('../dailyReports.js');
  saveDailyReport({
    date: '2026-09-18',
    generatedAt: new Date().toISOString(),
    leadership: { reply: 'x', trace: [] },
    studio: { reply: 'y', trace: [{ id: 'validation_critic', title: 'Validation Critic', depth: 1, ms: 900 }] },
  });

  const critic = graph.buildGraph().nodes.find((n) => n.id === 'validation_critic');
  assert.equal(critic.ranTimes, 1);
  assert.equal(critic.ranMs, 900);
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
test('agents pinned to Anthropic by a server tool are flagged, across both teams', () => {
  const g = graph.buildGraph();
  const pinned = g.nodes.filter((n) => n.pinnedToAnthropic).map((n) => n.id).sort();
  // Four, not two: the Studio's researchers ground themselves with live web
  // search as well, and web_search executes inside Anthropic's infrastructure
  // so none of them can be moved to another provider however the tiers are set.
  assert.deepEqual(pinned, ['market_researcher', 'scale_strategist', 'seo_specialist', 'solutions_architect']);
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

// --- The board ---------------------------------------------------------------
//
// The office view has wall space the graph does not, so the payload carries
// company-level state alongside the per-agent state: what is queued, what is
// running, what today has cost. Same request, because the two views are two
// projections of one company rather than two features.

test('the payload carries the company state the office view puts on the wall', async () => {
  const { enqueueTask, startTask, completeTask } = await import('../tasks.js');

  const a = enqueueTask({ ventureId: 'v_1', title: 'Write auth', queuedBy: 'cto' });
  enqueueTask({ ventureId: 'v_1', title: 'Write docs', queuedBy: 'cto' });
  startTask(a.id);
  completeTask(a.id, 'done');

  const meta = graph.buildGraph().meta;
  assert.equal(meta.tasks.done, 1);
  assert.equal(meta.tasks.queued, 1);
  assert.equal(meta.tasks.running, 0);
  assert.equal(meta.tasks.failed, 0);

  // The cap is the founder's setting, so it travels with the spend rather than
  // leaving the page to guess what "a lot" means.
  assert.ok(Number.isFinite(meta.spend.spentUsd));
  assert.ok(meta.spend.capUsd > 0);
  assert.equal(meta.spend.overCap, false);
});

test('venture counts distinguish active from merely existing', async () => {
  const ventures = await import('../finance/ventures.js');
  const v = ventures.createVenture({
    title: 'CircadianAPI', oneLiner: 'x', problem: 'y', targetCustomer: 'z',
    businessModel: 'API', marketSize: 'big', pathToMillions: 'scale', milestones: ['ship'],
  });
  ventures.killVenture(v.id, 'test');

  const meta = graph.buildGraph().meta;
  assert.equal(meta.ventures.total, 1);
  assert.equal(meta.ventures.active, 0, 'a killed venture still exists and is not active');
});
