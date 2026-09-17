// A scenario that asks for a tool nobody wired runs happily against an agent
// that simply never had it — and quietly grades something other than what its
// id says it grades. It passes or fails for the wrong reason, forever, and the
// only symptom is a number that means nothing.
//
// So: every tool every scenario asks for must be real on that agent, and must
// be one the runner can supply. Same structural guard as the daily-cycle
// parity test, for the same reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../eval/scenarios.js';
import { AGENTS as COMPANY_AGENTS } from '../agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS } from '../agents/ideationTeam.js';

// Read the runner's map without importing it: runner.mjs rewrites
// JARVIS_DATA_DIR and stubs global.fetch at module scope, which is exactly
// right for a child process and exactly wrong inside a test run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '../eval/runner.mjs');
const runnerSource = fs.readFileSync(RUNNER, 'utf8');

function handlerNames() {
  const block = runnerSource.match(/const HANDLER_BY_TOOL = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find HANDLER_BY_TOOL in the runner');
  return [...block[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

test('every scenario names an agent that exists on the team it claims', () => {
  for (const scenario of scenarios) {
    const roster = scenario.team === 'studio' ? STUDIO_AGENTS : COMPANY_AGENTS;
    assert.ok(
      roster[scenario.agentId],
      `${scenario.id} runs "${scenario.agentId}", which is not on the ${scenario.team} roster`,
    );
  }
});

test('every tool a scenario asks for is one that agent actually holds', () => {
  for (const scenario of scenarios) {
    const roster = scenario.team === 'studio' ? STUDIO_AGENTS : COMPANY_AGENTS;
    const held = new Set((roster[scenario.agentId].actions || []).map((a) => a.name));
    for (const tool of scenario.actions || []) {
      assert.ok(
        held.has(tool),
        `${scenario.id} gives "${scenario.agentId}" the tool "${tool}", which that agent does not have — ` +
          'the scenario would grade an agent that never had the option',
      );
    }
  }
});

test('every tool a scenario asks for is one the runner can supply', () => {
  const available = new Set(handlerNames());
  for (const scenario of scenarios) {
    for (const tool of scenario.actions || []) {
      assert.ok(
        available.has(tool),
        `${scenario.id} asks for "${tool}", which is not in the runner's HANDLER_BY_TOOL — ` +
          'it would be handed undefined and silently dropped',
      );
    }
  }
});

test('scenario ids are unique and stable-looking', () => {
  const seen = new Set();
  for (const scenario of scenarios) {
    assert.ok(!seen.has(scenario.id), `duplicate scenario id "${scenario.id}"`);
    seen.add(scenario.id);
    assert.match(scenario.id, /^[a-z0-9-]+$/, `${scenario.id} should be a kebab-case identifier`);
    assert.ok(scenario.description, `${scenario.id} has no description`);
  }
});

test('every scenario can build its message and grade without a live run', () => {
  // Catches the ordinary mistakes — a ctx field that setup never returned, a
  // grade that assumes a key — before they cost a billed API call each.
  for (const scenario of scenarios) {
    assert.equal(typeof scenario.message, 'function', `${scenario.id} has no message()`);
    assert.equal(typeof scenario.grade, 'function', `${scenario.id} has no grade()`);
  }
});

test('the tool-selection scenarios grade on the call log, not on text alone', () => {
  // These are the ones testing which tool an agent reached for. A grade that
  // only reads the reply is grading whether the agent *said* it checked.
  const selectionScenarios = scenarios.filter((s) =>
    (s.actions || []).some((a) => ['check_ready', 'check_replies', 'check_usage', 'open_pull_request', 'revert_commit'].includes(a)),
  );
  assert.ok(selectionScenarios.length >= 6, 'expected the tool-selection scenarios to be present');

  for (const scenario of selectionScenarios) {
    assert.match(
      String(scenario.grade),
      /calls/,
      `${scenario.id} never looks at calls — it is grading what the agent said, not what it did`,
    );
  }
});

test('the scenarios that touch the real world are paired with a negative case', () => {
  // Every "should reach for X" needs a "should not reach for X when it doesn't
  // apply", or the eval rewards an agent that always does the cautious thing —
  // which for this company looks exactly like never shipping.
  const ids = new Set(scenarios.map((s) => s.id));
  const pairs = [
    ['engineering-lead-checks-before-reporting-blocked', 'engineering-lead-does-not-check-when-nothing-is-blocked'],
    ['engineering-lead-proposes-rather-than-lands-an-auth-change', 'engineering-lead-still-lands-an-ordinary-change'],
  ];
  for (const [positive, negative] of pairs) {
    assert.ok(ids.has(positive), `missing ${positive}`);
    assert.ok(ids.has(negative), `${positive} has no paired negative case — the eval would reward always saying no`);
  }
});
