// Does every tool an agent has actually work in the unattended cycle?
//
// Nothing connected the org chart to the daily cycle's handler map, so the two
// drifted apart silently until the map served five handlers against a roster of
// twenty-one. The Engineering Lead had twelve tools and one of them worked: it
// could commit code every morning and could not read the repo, claim a task,
// run the checks, or see whether the deployed service answered. Every other
// call came back "Unknown tool".
//
// The cost was not the outage. It was that the failure looked like an
// environment fault from inside: the CTO reported "repo/task tools are erroring
// on every call" and recommended retrying next turn, which would have produced
// the identical failure every morning forever. An absent capability read as a
// transient one — the same shape as every other confident wrong diagnosis this
// company has made, except this time nothing could have told it otherwise.
//
// So this test is the missing link. A tool added to an agent must be either
// wired into the cycle or named in BARRED_UNATTENDED with a reason. Doing
// neither fails here, at the moment the tool is added, rather than at 08:00 six
// weeks later.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS as COMPANY_AGENTS } from '../agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS } from '../agents/ideationTeam.js';
import { dailyCycleActionHandlers, studioActionHandlers, BARRED_UNATTENDED } from '../dailyMeeting.js';

function toolsOf(agents) {
  const names = new Set();
  for (const agent of Object.values(agents)) {
    for (const action of agent.actions || []) names.add(action.name);
  }
  return names;
}

test('every Executive Team tool is either wired into the daily cycle or explicitly barred', () => {
  const wired = new Set(Object.keys(dailyCycleActionHandlers()));
  const unaccounted = [...toolsOf(COMPANY_AGENTS)].filter(
    (name) => !wired.has(name) && !BARRED_UNATTENDED.has(name)
  );

  assert.deepEqual(
    unaccounted,
    [],
    `These tools exist on an agent but do nothing in the unattended cycle — they return "Unknown tool" ` +
      `every morning. Wire them in dailyCycleActionHandlers(), or add them to BARRED_UNATTENDED with the ` +
      `reason they need a founder: ${unaccounted.join(', ')}`
  );
});

test('the Venture Studio phase covers its own roster the same way', () => {
  // This pinned the literal ['propose_venture'], which checked the roster of
  // the day rather than the property. The property is the same one the company
  // side asserts: a tool on a studio agent must be served by the studio's
  // handler map, or it returns "Unknown tool" at 08:00 and reads as an
  // environment fault from the inside.
  const wired = new Set(Object.keys(studioActionHandlers()));
  const unaccounted = [...toolsOf(STUDIO_AGENTS)].filter((name) => !wired.has(name));

  assert.deepEqual(
    unaccounted,
    [],
    `These tools exist on a Studio agent and are not wired into studioActionHandlers(): ${unaccounted.join(', ')}`
  );
});

// The other half of the same property: a handler nobody can call is dead
// weight that reads as capability from the outside.
test('the Studio serves no handler that no Studio agent holds', () => {
  const held = toolsOf(STUDIO_AGENTS);
  const orphaned = Object.keys(studioActionHandlers()).filter((name) => !held.has(name));
  assert.deepEqual(orphaned, [], `Handlers wired for tools no agent has: ${orphaned.join(', ')}`);
});

// The specific regression. Named individually because a count is easy to
// satisfy by accident and these are the ones whose absence stalled a build.
test('the Engineering Lead can read, queue and verify — not only deploy', () => {
  const wired = new Set(Object.keys(dailyCycleActionHandlers()));

  for (const tool of ['read_repo_file', 'list_repo_files', 'list_checks']) {
    assert.ok(wired.has(tool), `${tool} is read-only; withholding it means committing blind`);
  }
  for (const tool of ['queue_work', 'next_task', 'start_task', 'complete_task', 'fail_task']) {
    assert.ok(wired.has(tool), `${tool} is internal book-keeping and is how a build survives a short turn`);
  }
  // Allowing the deploy and withholding the evidence it worked is what produces
  // a confident wrong status report — which is the failure reporting-status
  // exists for, made structurally unavoidable.
  assert.ok(wired.has('deploy_code'));
  assert.ok(wired.has('run_checks'), 'a cycle that may deploy must be able to verify');
  assert.ok(wired.has('check_service'), 'green CI is not evidence the service answers');
});

// The other half of the rule. These are refused on purpose, and a future edit
// that "fixes" the parity test by wiring everything would quietly hand an
// unattended cycle the founder's own decisions.
test('the tools that need a founder stay refused, with a stated reason', () => {
  const wired = new Set(Object.keys(dailyCycleActionHandlers()));

  for (const tool of ['log_revenue', 'log_expense', 'report_milestone_progress', 'kill_venture', 'link_venture_repo']) {
    assert.ok(!wired.has(tool), `${tool} must not run unattended`);
    assert.ok(BARRED_UNATTENDED.has(tool));
    assert.ok(BARRED_UNATTENDED.get(tool).length > 20, `${tool} needs a reason someone can read, not a bare entry`);
  }
});

test('nothing is both wired and barred', () => {
  const wired = new Set(Object.keys(dailyCycleActionHandlers()));
  const both = [...BARRED_UNATTENDED.keys()].filter((name) => wired.has(name));
  assert.deepEqual(both, [], `contradictory: ${both.join(', ')}`);
});

// A barred entry for a tool nobody has is dead weight that makes the list read
// as more considered than it is.
test('every barred tool is one some agent actually has', () => {
  const all = new Set([...toolsOf(COMPANY_AGENTS), ...toolsOf(STUDIO_AGENTS)]);
  const stale = [...BARRED_UNATTENDED.keys()].filter((name) => !all.has(name));
  assert.deepEqual(stale, [], `barred but on no agent: ${stale.join(', ')}`);
});
