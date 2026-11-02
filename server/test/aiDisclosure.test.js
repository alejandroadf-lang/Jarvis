// A caller is told they are talking to an AI, in the first sentence.
//
// EU AI Act Article 50 (applicable from 2 August 2026) requires people to be told when they
// interact with an AI system, unless it is obvious. A customer ringing a company's support or
// sales desk is not in the position where it is obvious. Both greetings used to instruct the
// opposite, "do not say you are an AI unless they ask", which is the behaviour the rule exists to
// stop. The founder's own line (callBrief) is exempt: the owner knows what they rang.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportGreeting } from '../realtime/supportDesk.js';
import { deskGreeting } from '../realtime/deskBrief.js';
import { callGreeting } from '../realtime/callBrief.js';

const venture = { id: 'v1', title: 'CircadianAPI' };

test('the support desk and the sales desk both say they are an AI in the opening, and never instruct concealment', () => {
  for (const greeting of [supportGreeting(), deskGreeting(venture)]) {
    assert.match(greeting, /say plainly that you are an automated AI assistant/i);
    assert.doesNotMatch(greeting, /do not say you are an AI/i);
    assert.doesNotMatch(greeting, /unless they ask/i);
  }
});

test('asked whether they are speaking to a person, the desk says no and offers a human', () => {
  assert.match(supportGreeting(), /say plainly that you are not, and offer to log a request for a human/i);
  assert.match(deskGreeting(venture), /say plainly that you are not, and offer to arrange for a human/i);
});

test('the founder\'s own line is unchanged: the owner knows what they called', () => {
  assert.doesNotMatch(callGreeting(), /automated AI assistant/i);
});
