// The Executive Team's one structural source of dissent.
//
// The CEO's turn is a synthesis of four reports from four leads who each
// have a reason to want their own department to look good. Nothing in that
// shape produces "this won't work" — so it was added as an agent rather
// than as a sentence in the CEO's prompt, for the same reason the Studio has
// a Validation Critic: a paragraph asking you to be skeptical about your own
// plan loses to the plan, every time.
//
// What is testable about an arguing agent is not the quality of its
// arguments. It is the three properties that decide whether it gets heard at
// all, and whether it can do damage when it is wrong:
//
//   - It is reachable from the CEO, because a critic nobody can consult is
//     the most expensive kind of decoration.
//   - It is a leaf with no actions, so it argues and cannot act. That is
//     also what lets it run on a cheap tier (see models.js).
//   - Its prompt keeps the clauses that separate a useful critic from one
//     that gets ignored within a week.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, ROOT_AGENT_ID } from '../agents/orgChart.js';
import { canUseAlternativeModel, CHEAP_TIER, resolveModelForAgent, MODELS, DEFAULT_TIER } from '../agents/models.js';

const ADVOCATE_ID = 'devils_advocate';

test("the Devil's Advocate is on the roster and reports to the CEO", () => {
  const advocate = AGENTS[ADVOCATE_ID];
  assert.ok(advocate, "the Devil's Advocate is not defined");
  assert.equal(advocate.reportsTo, ROOT_AGENT_ID);
  assert.equal(advocate.department, 'Executive');
});

// Reciprocity is what makes it consultable: delegation tools are built from
// the *manager's* reports array (agentRunner builds consult_<id> from it), so
// an agent that names its manager without being named back exists and can
// never be called. validateOrgChart catches that at boot; this asserts the
// specific link, so a future edit that trims the CEO's reports fails here
// with the reason rather than somewhere downstream.
test('the CEO lists it, so a consult_devils_advocate tool exists', () => {
  assert.ok(AGENTS[ROOT_AGENT_ID].reports.includes(ADVOCATE_ID));
});

// A critic with action tools is a critic that can be wrong expensively. It
// is also the condition models.js enforces before an agent may leave the
// frontier model, so this one assertion carries both properties.
test('it is a leaf: no reports, no actions, no server tools', () => {
  const advocate = AGENTS[ADVOCATE_ID];
  assert.deepEqual(advocate.reports, []);
  assert.deepEqual(advocate.actions || [], []);
  assert.deepEqual(advocate.serverTools || [], []);
  assert.equal(canUseAlternativeModel(advocate), true);
});

test('it is tagged for the cheap tier, and routes there once a provider is configured', () => {
  const advocate = AGENTS[ADVOCATE_ID];
  assert.equal(advocate.modelTier, CHEAP_TIER);
  assert.equal(resolveModelForAgent(advocate, true), MODELS[CHEAP_TIER]);
  // And falls back rather than failing when nothing is configured — the same
  // opt-in rule every other tiered agent follows.
  assert.equal(resolveModelForAgent(advocate, false), MODELS[DEFAULT_TIER]);
});

// The three clauses below are the difference between a critic that is read
// and one that is routed around. Each has a specific failure it prevents:
// a critic who objects to everything gets ignored (which is worse than
// having none, because it looks like scrutiny); a critic who names a
// complaint instead of a test creates work for nobody; a critic who cannot
// say "nothing to add" has no credibility left on the day it matters.
test('its prompt keeps the clauses that stop it becoming noise', () => {
  const prompt = AGENTS[ADVOCATE_ID].systemPrompt;
  assert.match(prompt, /not a pessimist/i);
  assert.match(prompt, /cheapest way to find out/i);
  assert.match(prompt, /nothing to add/i);
  // Attack the plan, not the author: the clause that keeps the next report
  // to it honest rather than defensive.
  assert.match(prompt, /never the agent/i);
});

// The observation the whole agent exists to make. Named here because it is
// also the failure this codebase keeps hitting from the other direction —
// an absent observation getting promoted to a cause.
test('it is pointed at assumptions being treated as facts', () => {
  assert.match(AGENTS[ADVOCATE_ID].systemPrompt, /assumption everyone is treating\s+as a fact/i);
});
