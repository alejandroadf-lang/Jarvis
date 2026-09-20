// The CEO offered the founder a "real pass on Amadeus's developer/partner API"
// by the CTO, "reporting back with actual findings". The CTO cannot see the
// internet. Its Solutions Architect can — so the capability was wired, the
// path existed, and nothing routed it. The likely outcome was the CTO
// answering from training data under a label the founder had been promised
// meant fetched fact.
//
// Same failure as a company that answers a voice note insisting it has no
// voice channel: the tools were right and nobody knew who held them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchRoutingContext } from '../finance/context.js';
import { AGENTS } from '../agents/orgChart.js';

test('an agent that cannot search is told so, and told who can', () => {
  const said = buildResearchRoutingContext('cto');
  assert.match(said, /no web access/i);
  assert.match(said, /Solutions Architect/, 'the report that actually holds the tool');
  assert.match(said, /Never present recall as a finding/i);
});

test('the promise the CEO made is the one barred by name', () => {
  // Not "prefer fetched facts" — the specific act that misled the founder was
  // promising findings it intended to produce from memory.
  const said = buildResearchRoutingContext('cto');
  assert.match(said, /never promise the founder findings you intend to produce from memory/i);
});

test('an agent that can search for itself is told nothing', () => {
  // It needs no routing, and the instruction would be false for it.
  for (const id of ['cmo', 'solutions_architect', 'sales_commercial_manager', 'seo_specialist']) {
    assert.equal(buildResearchRoutingContext(id), '', `${id} holds search itself`);
  }
});

test('a leaf is told nothing, because it has nobody to route to and is not asked to', () => {
  const leaves = Object.values(AGENTS).filter(
    (a) => !(a.reports || []).length && !(a.serverTools || []).length
  );
  assert.ok(leaves.length > 0, 'the roster has leaves to check');
  for (const leaf of leaves) {
    assert.equal(buildResearchRoutingContext(leaf.id), '', `${leaf.id} is a leaf`);
  }
});

test('a manager with nobody to delegate to is told that, not left silent', () => {
  // The CFO was the other name in the CEO's offer. None of its reports can
  // search, so the routing advice does not apply — but silence is how it ends
  // up accepting a task it has no way to carry out.
  const said = buildResearchRoutingContext('cfo');
  assert.match(said, /neither does anyone reporting to you/i);
  assert.match(said, /rather than accepting the task yourself/i);
  assert.match(said, /Never present recall as a finding/i);
});

test('the routing is derived from the org chart, not written into prompts', () => {
  // A sentence in a prompt goes stale the moment search moves. Every agent
  // named as a searcher must actually hold the tool, checked against the
  // roster rather than against a list in this test.
  for (const agent of Object.values(AGENTS)) {
    const said = buildResearchRoutingContext(agent.id);
    if (!said || !said.includes('reports to you')) continue;
    const searchers = (agent.reports || [])
      .map((id) => AGENTS[id])
      .filter((r) => r && (r.serverTools || []).length > 0);
    assert.ok(searchers.length > 0, `${agent.id} names a searcher, so it must have one`);
    for (const searcher of searchers) {
      assert.ok(said.includes(searcher.title), `${agent.id} must name ${searcher.title}`);
    }
  }
});

test('nobody is told they lack web access while holding it', () => {
  // The failure this whole note exists to prevent, inverted: an agent that can
  // search being told it cannot would stop it using the tool it has.
  for (const agent of Object.values(AGENTS)) {
    if (!(agent.serverTools || []).length) continue;
    assert.equal(buildResearchRoutingContext(agent.id), '', `${agent.id} holds search`);
  }
});

test('an unknown agent id is empty rather than a crash', () => {
  assert.equal(buildResearchRoutingContext('not_an_agent'), '');
  assert.equal(buildResearchRoutingContext(undefined), '');
});
