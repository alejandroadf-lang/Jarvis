// The four agents that were given live web search are the four that research
// something for a living. For a long time they could only search — find a page
// and read the snippet — which is how the CFO ended up with an open question
// about a fee split whose answer was one click away on a page no agent could
// open. This test pins the pair together: an agent that can search can fetch.
//
// It also pins the second property, which is easier to break by accident: a
// server tool executes inside Anthropic's infrastructure, so an agent holding
// one cannot be routed to Gemini or DeepSeek however AGENT_MODEL_TIERS is set.
// Adding a research tool to an agent must therefore also pin that agent to the
// frontier model, and models.js already enforces it — this asserts it stays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS } from '../agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS } from '../agents/ideationTeam.js';
import { RESEARCH_TOOLS, WEB_SEARCH, WEB_FETCH } from '../agents/serverTools.js';
import { canUseAlternativeModel } from '../agents/models.js';

const ALL = { ...AGENTS, ...STUDIO_AGENTS };

const RESEARCHERS = ['solutions_architect', 'seo_specialist', 'market_researcher', 'scale_strategist'];

test('the research pair is search plus fetch, in that order', () => {
  assert.deepEqual(RESEARCH_TOOLS, [WEB_SEARCH, WEB_FETCH]);
  assert.equal(WEB_SEARCH.name, 'web_search');
  assert.equal(WEB_FETCH.name, 'web_fetch');
});

test('every agent with web search also has web fetch', () => {
  for (const [id, agent] of Object.entries(ALL)) {
    const names = (agent.serverTools || []).map((t) => t.name);
    if (!names.includes('web_search')) continue;
    assert.ok(
      names.includes('web_fetch'),
      `${id} can search but not fetch — it can find a page it cannot open`,
    );
  }
});

test('the four researchers hold the shared pair, not a private copy', () => {
  for (const id of RESEARCHERS) {
    assert.ok(ALL[id], `${id} is missing from the roster`);
    assert.equal(
      ALL[id].serverTools,
      RESEARCH_TOOLS,
      `${id} declares its own server tools — version strings will drift`,
    );
  }
});

test('holding a server tool keeps an agent on the frontier model', () => {
  for (const id of RESEARCHERS) {
    assert.equal(
      canUseAlternativeModel(ALL[id]),
      false,
      `${id} could be routed off Anthropic, where its server tools do not exist`,
    );
  }
});

test('the four researchers say they can fetch, not only search', () => {
  for (const id of RESEARCHERS) {
    assert.match(
      ALL[id].systemPrompt,
      /web\s+fetch/,
      `${id} holds web_fetch but its prompt never mentions it`,
    );
  }
});
