// The four Happy Company roles.
//
// What is testable about an agent is not the quality of its answers but what
// it can reach and what it can do when it is wrong. For a product whose whole
// promise is privacy, those are the properties that matter:
//
//   - each is consultable, because a role nobody can reach is decoration;
//   - the two reviewers (privacy, research) can read, search and write notes,
//     and cannot change code or reach anyone outside the company;
//   - the pilot manager drafts outreach and cannot send it;
//   - the engineer ships through pull requests, like the Engineering Lead;
//   - shared tools are the same objects as the originals, so a cap or a
//     description fixed in one place is fixed for everyone;
//   - the prompts keep the clauses that hold the privacy promises in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS } from '../agents/orgChart.js';
import { RESEARCH_TOOLS } from '../agents/serverTools.js';

const ROLES = { forge_engineer: 'cto', privacy_officer: 'cto', health_researcher: 'cto', pilot_manager: 'coo' };
const names = (id) => (AGENTS[id].actions || []).map((a) => a.name);
const WRITES_CODE = ['deploy_code', 'deploy_changes', 'open_pull_request', 'revert_commit', 'link_venture_repo'];
const REACHES_OUT = ['send_customer_email', 'create_payment_link'];

test('each is on the roster, reports where it should, and its manager can consult it', () => {
  for (const [id, manager] of Object.entries(ROLES)) {
    assert.ok(AGENTS[id], `${id} is missing`);
    assert.equal(AGENTS[id].reportsTo, manager);
    assert.ok(AGENTS[manager].reports.includes(id), `${manager} does not list ${id}, so it can never be consulted`);
    assert.deepEqual(AGENTS[id].reports, []);
  }
});

test('the privacy officer and the researcher read and advise; they cannot change code or reach anyone', () => {
  for (const id of ['privacy_officer', 'health_researcher']) {
    const held = names(id);
    assert.ok(held.includes('read_repo_file') && held.includes('log_venture_note'));
    for (const forbidden of [...WRITES_CODE, ...REACHES_OUT, 'draft_customer_email']) assert.ok(!held.includes(forbidden), `${id} holds ${forbidden}`);
  }
});

test('the pilot manager drafts and never sends', () => {
  const held = names('pilot_manager');
  assert.ok(held.includes('draft_customer_email'));
  assert.ok(held.includes('check_replies'));
  for (const forbidden of [...REACHES_OUT, ...WRITES_CODE]) assert.ok(!held.includes(forbidden), `pilot_manager holds ${forbidden}`);
});

// deploy_code, deploy_changes and revert_commit all write to the venture's
// deploy branch directly (actionHandlers.js); only open_pull_request works
// on a branch of its own. So the engineer holds that one and none of the
// others, which is what makes "the founder merges" true.
test('the engineer ships only through pull requests, verifies with checks, and reaches no one', () => {
  const held = names('forge_engineer');
  for (const needed of ['open_pull_request', 'run_checks', 'list_checks', 'read_repo_file', 'queue_work', 'check_ready']) {
    assert.ok(held.includes(needed), `forge_engineer lacks ${needed}`);
  }
  for (const forbidden of [...REACHES_OUT, 'link_venture_repo', 'deploy_code', 'deploy_changes', 'revert_commit']) {
    assert.ok(!held.includes(forbidden), `forge_engineer holds ${forbidden}, which commits straight to the deploy branch`);
  }
});

test('shared tools are the originals, not copies that can drift', () => {
  const source = (agentId, name) => AGENTS[agentId].actions.find((a) => a.name === name);
  assert.equal(AGENTS.forge_engineer.actions.find((a) => a.name === 'open_pull_request'), source('engineering_lead', 'open_pull_request'));
  assert.equal(AGENTS.privacy_officer.actions.find((a) => a.name === 'read_repo_file'), source('engineering_lead', 'read_repo_file'));
  assert.equal(AGENTS.pilot_manager.actions.find((a) => a.name === 'draft_customer_email'), source('sales_commercial_manager', 'draft_customer_email'));
});

test('all four can research, hold the shared pair, and say they can fetch', () => {
  for (const id of Object.keys(ROLES)) {
    assert.equal(AGENTS[id].serverTools, RESEARCH_TOOLS);
    assert.match(AGENTS[id].systemPrompt, /web\s+fetch/);
  }
});

test('the prompts keep the promises and the gates', () => {
  for (const id of ['forge_engineer', 'privacy_officer']) {
    const p = AGENTS[id].systemPrompt;
    assert.match(p, /fewer than 5 active people/);
    assert.match(p, /deleted after 21 days/);
    assert.match(p, /nothing leaves Atlassian/);
  }
  assert.match(AGENTS.forge_engineer.systemPrompt, /the founder merges/);
  assert.match(AGENTS.forge_engineer.systemPrompt, /goes to the Privacy & Works-Council Officer/);
  assert.match(AGENTS.privacy_officer.systemPrompt, /STOP/);
  assert.match(AGENTS.privacy_officer.systemPrompt, /never\s+soften a real STOP/);
  assert.match(AGENTS.health_researcher.systemPrompt, /Give the source for every claim/);
  assert.match(AGENTS.pilot_manager.systemPrompt, /You do not send/);
  // The CTO is told to route privacy-touching changes through the officer.
  assert.match(AGENTS.cto.systemPrompt, /Privacy & Works-Council Officer/);
});
