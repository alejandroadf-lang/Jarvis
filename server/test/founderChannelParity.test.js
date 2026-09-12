// The founder's primary interface is WhatsApp, and WhatsApp routes to the
// Executive Team (see index.js's runCompanyTurn). So any capability the
// founder needs that the Executive Team lacks is a capability that silently
// requires a browser — which is how this gap was found: the CEO could end a
// venture with kill_venture but had no way to start one, so the one step
// every other step depends on was reachable only from the Venture Studio
// tab.
//
// These tests pin the parity rather than the fix: what matters is that the
// team reachable from a phone can start the work, not that one particular
// tool name is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, ROOT_AGENT_ID } from '../agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS } from '../agents/ideationTeam.js';

const ceo = AGENTS[ROOT_AGENT_ID];
const actionNames = (agent) => (agent.actions || []).map((a) => a.name);

test('the CEO can start a venture, not only end one', () => {
  const names = actionNames(ceo);
  assert.ok(
    names.includes('propose_venture'),
    'without this the founder cannot start a venture from WhatsApp at all'
  );
  assert.ok(names.includes('kill_venture'), 'the asymmetry this fixes is start vs. end');
});

test("the CEO's propose_venture asks for everything createVenture records", () => {
  // A second copy of a schema is a second thing to forget to update. If the
  // studio's proposal captures a field, a CEO-initiated one should too —
  // otherwise a venture started from a phone is a thinner record than the
  // same venture started in a browser, for no reason the founder would guess.
  const studioPartner = Object.values(STUDIO_AGENTS).find((a) =>
    actionNames(a).includes('propose_venture')
  );
  assert.ok(studioPartner, 'the studio is where propose_venture originated');

  const studioRequired = new Set(
    studioPartner.actions.find((a) => a.name === 'propose_venture').input_schema.required
  );
  const ceoAction = ceo.actions.find((a) => a.name === 'propose_venture');

  for (const field of studioRequired) {
    assert.ok(
      ceoAction.input_schema.required.includes(field),
      `"${field}" is required in the studio's proposal but optional in the CEO's`
    );
    assert.ok(
      ceoAction.input_schema.properties[field],
      `"${field}" is required by the CEO's schema but never described`
    );
  }
});

test('starting a venture stays a judgment call, not a free action', () => {
  // The venture model has no budget, so nothing structural stops an agent
  // starting twenty ventures. The only brake is the tool description saying
  // so, which makes that text load-bearing rather than decorative.
  const description = ceo.actions.find((a) => a.name === 'propose_venture').description;
  assert.match(description, /costs nothing/i, 'the agent must be told starting one is free');
  assert.match(
    description,
    /free/i,
    'and told not to treat free as a reason — that is the whole brake'
  );
});

test('a venture the CEO starts gets no reach it was not granted', () => {
  // Safe to wire into a conversation precisely because creating a venture
  // grants nothing: the scope model still stands between it and the world.
  const description = ceo.actions.find((a) => a.name === 'propose_venture').description;
  assert.match(description, /no repo and no outreach list/i);
});
