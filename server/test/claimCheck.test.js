// An agent reported "deploying auth.py" with no tool call behind it. A person
// caught it before it reached the founder as fact — which is luck with a good
// habit attached, not a control.
//
// The reporting-status skill already asks agents not to do this. An
// instruction in a prompt is a request. These tests are about the rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedClaims, describeUnsupportedClaims } from '../claimCheck.js';

const didDeploy = [{ kind: 'action', tool: 'deploy_code', ok: true }];
const triedAndFailed = [{ kind: 'action', tool: 'deploy_code', ok: false }];

test('a claimed commit with no action behind it is flagged', () => {
  const found = unsupportedClaims({ text: 'I have deployed auth.py to the repo.', trace: [] });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'a commit');
  assert.match(found[0].sentence, /deployed auth\.py/);
});

test('a claimed commit with a real commit behind it is not flagged', () => {
  assert.deepEqual(unsupportedClaims({ text: 'I have deployed auth.py to the repo.', trace: didDeploy }), []);
});

test('an action that was attempted and refused does not vouch for the claim', () => {
  // The exact shape of the incident: the agent tried, the cap refused it, and
  // the summary said it had shipped.
  const found = unsupportedClaims({ text: 'auth.py has been deployed.', trace: triedAndFailed });
  assert.equal(found.length, 1);
});

test('an honest refusal is not a claim', () => {
  for (const text of [
    'I could not deploy auth.py — the weekly cap is spent.',
    'I was unable to commit the file.',
    'Blocked on the deployment cap; nothing landed.',
    'I did not send the email.',
    'Not yet deployed.',
  ]) {
    assert.deepEqual(unsupportedClaims({ text, trace: [] }), [], `flagged an honest report: "${text}"`);
  }
});

test('a plan is not a claim', () => {
  for (const text of [
    'I will deploy auth.py next turn.',
    'We are going to send her the pricing tomorrow.',
    'I plan to commit the contract file.',
  ]) {
    assert.deepEqual(unsupportedClaims({ text, trace: [] }), [], `flagged an intention: "${text}"`);
  }
});

test('each kind of real-world act is checked against its own tools', () => {
  assert.equal(unsupportedClaims({ text: 'I have sent Ada the pricing.', trace: [] })[0].kind, 'an email to a real person');
  assert.equal(unsupportedClaims({ text: 'I created a payment link for her.', trace: [] })[0].kind, 'a payment link');
  assert.equal(unsupportedClaims({ text: 'I ran the checks and they passed.', trace: [] })[0].kind, 'a check run');
  // A deploy does not vouch for an email.
  const mixed = unsupportedClaims({ text: 'I have deployed the fix. The email is sent.', trace: didDeploy });
  assert.deepEqual(mixed.map((c) => c.kind), ['an email to a real person']);
});

test('one successful action vouches for a summary of several', () => {
  // An accurate summary of three commits must not read as three separate lies.
  const text = 'I deployed auth.py. The change has been pushed. The commit is live.';
  assert.deepEqual(unsupportedClaims({ text, trace: didDeploy }), []);
});

test('a report with nothing to flag says nothing', () => {
  assert.equal(describeUnsupportedClaims([]), null);
  assert.equal(describeUnsupportedClaims(undefined), null);
});

test('the warning names the claim and what was missing', () => {
  const text = describeUnsupportedClaims(unsupportedClaims({ text: 'I have deployed auth.py.', trace: [] }));
  assert.match(text, /not backed by anything the team actually did/);
  assert.match(text, /deploy_code/);
  assert.match(text, /Everything else in the report stands/);
});

test('delegation entries in the trace do not vouch for anything', () => {
  // Consulting six specialists about a deploy is not a deploy.
  const consulted = [{ id: 'cto', title: 'CTO', depth: 1 }, { id: 'qa_engineer', title: 'QA', depth: 1 }];
  assert.equal(unsupportedClaims({ text: 'I have deployed auth.py.', trace: consulted }).length, 1);
});
