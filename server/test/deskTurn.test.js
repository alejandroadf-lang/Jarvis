// The help desk on WhatsApp.
//
// The desk exists as a realtime speech model on the Talk tab. On WhatsApp it
// is one ordinary agent turn, and the thing most likely to be wrong is the
// thing that was wrong with the pitch for weeks: a handler with no tool
// behind it. So these tests assert on what runAgent is handed — the agent,
// its action list, the messages, the context — not on what the handlers
// would do if reached.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let desk;
const KEYS = ['SUPPORT_MODE', 'SUPPORT_DESK_NAME', 'DESK_LANGUAGE', 'REPLY_LANGUAGE', 'OPENAI_API_KEY', 'VOICE_REPLIES', 'SMTP_HOST'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-desk-turn-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  desk = await import('../channels/deskTurn.js');
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
  fs.rmSync(path.join(tmpDir, 'support.json'), { force: true });
  fs.rmSync(path.join(tmpDir, 'tickets.json'), { force: true });
});

// A runAgent stand-in that records what it was given and answers.
function recorder(reply = 'Understood. What is the booking reference?') {
  const seen = {};
  const fake = async (opts) => {
    Object.assign(seen, opts);
    return { text: reply, trace: [], usage: {} };
  };
  fake.seen = seen;
  return fake;
}

test('the desk is handed to the runner with its two tools in the action list, and nothing else', async () => {
  const run = recorder();
  await desk.runDeskTurn({ anthropic: {}, from: '+34600000000', text: 'hola', runAgentImpl: run });

  const agent = run.seen.agents[run.seen.agentId];
  assert.equal(run.seen.agentId, 'travel_desk');
  assert.deepEqual(agent.actions.map((a) => a.name), ['lookup_issue', 'open_ticket'], 'exactly the desk\'s tools');
  assert.ok(agent.actions.every((a) => a.input_schema && a.input_schema.type === 'object'), 'in the runner\'s shape, not the realtime one');
  assert.deepEqual(agent.reports, [], 'nobody to delegate to');
  assert.ok(!agent.actions.some((a) => a.name === 'ask_the_team'), 'a customer cannot make the company do work');
});

test('the desk\'s brief holds no company state, on this transport as on the others', async () => {
  const run = recorder();
  await desk.runDeskTurn({ anthropic: {}, from: '+1', text: 'hi', runAgentImpl: run });
  const prompt = run.seen.agents.travel_desk.systemPrompt;
  assert.match(prompt, /travel help desk/);
  assert.match(prompt, /cannot change, cancel, refund, rebook or pay/);
  for (const leak of ['COMPANY STATE', 'Revenue', 'pipeline', 'Treasury']) {
    assert.doesNotMatch(prompt, new RegExp(leak, 'i'));
  }
  assert.equal(run.seen.perAgentContext, undefined, 'no per-agent company context is passed');
});

test('the conversation continues: history goes in first and is not mutated', async () => {
  const run = recorder();
  const history = [
    { role: 'user', content: 'My booking never arrived.' },
    { role: 'assistant', content: 'What surname is it under?' },
  ];
  const snapshot = JSON.stringify(history);
  await desk.runDeskTurn({ anthropic: {}, from: '+1', text: 'García', history, runAgentImpl: run });

  assert.equal(run.seen.messages.length, 3);
  assert.deepEqual(run.seen.messages[2], { role: 'user', content: 'García' });
  assert.equal(JSON.stringify(history), snapshot, 'the caller\'s history is not modified in place');
});

test('a Spanish voice note is answered in Spanish, with the answer put first', async () => {
  process.env.OPENAI_API_KEY = 'k';
  const run = recorder();
  await desk.runDeskTurn({
    anthropic: {}, from: '+34', text: 'quiero cancelar mi viaje', spokenIn: 'spanish', arrivedAsVoice: true, runAgentImpl: run,
  });
  assert.match(run.seen.extraContext, /Reply in Spanish/);
  assert.match(run.seen.extraContext, /voice note/i, 'and it knows it was spoken to');
  assert.match(run.seen.extraContext, /opening sentences/i, 'so the conclusion is what gets read aloud');
  delete process.env.OPENAI_API_KEY;
});

test('a typed English message adds no language or voice instruction at all', async () => {
  const run = recorder();
  await desk.runDeskTurn({ anthropic: {}, from: '+1', text: 'hello', runAgentImpl: run });
  assert.equal(run.seen.extraContext, '', 'tokens are not spent on an instruction that changes nothing');
});

test('lookup_issue reaches the agency procedures', async () => {
  const run = recorder();
  await desk.runDeskTurn({ anthropic: {}, from: '+1', text: 'x', runAgentImpl: run });
  const out = await run.seen.actionHandlers.lookup_issue({ problem: 'I want to cancel my trip and get my money back' });
  assert.match(out, /Cancel a booking or ask for a refund/);
  assert.match(out, /cannot process a cancellation or promise a refund on this call/);
});

test('open_ticket carries the caller\'s number and the language of the call even if the model forgot them', async () => {
  const run = recorder();
  await desk.runDeskTurn({ anthropic: {}, from: '+34600000000', text: 'x', spokenIn: 'spanish', runAgentImpl: run });
  const out = await run.seen.actionHandlers.open_ticket({ summary: 'Refund for booking ABC123', callerName: 'Ana' });
  assert.match(out, /Ticket #1 is open/);

  const { listTickets } = await import('../realtime/supportDesk.js');
  const [ticket] = listTickets();
  assert.equal(ticket.from, '+34600000000');
  assert.equal(ticket.language, 'spanish');
  assert.equal(ticket.callerName, 'Ana');
});

test('a turn that produced no words says so rather than inventing a reply', async () => {
  const run = recorder('   ');
  const { reply } = await desk.runDeskTurn({ anthropic: {}, from: '+1', text: 'x', runAgentImpl: run });
  assert.match(reply, /Could you say that again/);
});

test('the deadline is passed through, so a desk turn cannot outlive the chat window', async () => {
  const run = recorder();
  await desk.runDeskTurn({ anthropic: {}, from: '+1', text: 'x', deadlineAt: 1234, runAgentImpl: run });
  assert.equal(run.seen.deadlineAt, 1234);
});
