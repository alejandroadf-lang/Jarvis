// The WhatsApp webhook, driven directly. Until it moved out of index.js none
// of this could be exercised without booting the whole server, and it is the
// route that can commit code and email customers on the founder's word. What
// is pinned here is who gets to do what: a stranger never reaches the company
// or the founder's commands, a redelivery never runs a turn twice, a failure
// always reaches the phone with its reason, and a turn that runs out of time
// says so and queues the real answer.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FOUNDER = '447700900123';
const STRANGER = '15550001111';
const SECRET = 'app-secret-for-tests';

let tmpDir;
let inbound;
let whatsapp;
let log;
let killSwitch;
let deepDives;
let savedEnv;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-wa-inbound-'));
  savedEnv = { ...process.env };
  process.env.JARVIS_DATA_DIR = tmpDir;
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_ALLOWED_NUMBERS = `+${FOUNDER}`;
  process.env.WHATSAPP_ACK_DISABLED = 'false';
  delete process.env.OPENAI_API_KEY;
  inbound = await import('../channels/whatsappInbound.js');
  whatsapp = await import('../channels/whatsapp.js');
  log = await import('../channels/whatsappLog.js');
  killSwitch = await import('../killSwitch.js');
  deepDives = await import('../deepDives.js');
});

after(() => {
  process.env = savedEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let sent;
let turns;
let deskTurns;
let drained;
let turnImpl;
let wa;

beforeEach(() => {
  whatsapp.__resetDedupForTests();
  delete process.env.WHATSAPP_DESK;
  sent = [];
  turns = [];
  deskTurns = [];
  drained = 0;
  turnImpl = async () => ({ reply: 'The team says: ship it.', ranOutOfTime: false });
  wa = inbound.createWhatsAppInbound({
    anthropic: {},
    runCompanyTurn: async (sessionId, text, options) => {
      turns.push({ sessionId, text, options });
      return turnImpl();
    },
    drainDeepDives: () => { drained += 1; },
    deskSessions: new Map(),
    turnDeadlineMs: 120000,
    io: {
      sendWhatsAppMessage: async (to, text) => { sent.push({ to, text }); },
      sendWhatsAppAudio: async () => { throw new Error('no audio in these tests'); },
      downloadMedia: async () => ({ buffer: Buffer.from('ogg'), filename: 'note.ogg', mimeType: 'audio/ogg' }),
      transcribeAudio: async () => ({ text: '', language: 'english' }),
      isOpenAIConfigured: () => false,
      isSpeechConfigured: () => false,
      runDeskTurn: async ({ from, text }) => { deskTurns.push({ from, text }); return { reply: 'Desk here: try restarting it.' }; },
    },
  });
});

let seq = 0;
function textMessage(from, body, id = `wamid.${++seq}`) {
  return { entry: [{ changes: [{ field: 'messages', value: { messages: [{ id, from, type: 'text', text: { body } }] } }] }] };
}

function signed(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  return { raw, sig, body };
}

// Calls the handler the way Express would, and waits for the work it starts
// after answering (Meta has had its 200 by then).
async function deliver(body, { signature } = {}) {
  const s = signed(body);
  const req = { rawBody: s.raw, body: s.body, get: (h) => (h === 'x-hub-signature-256' ? (signature ?? s.sig) : undefined) };
  const res = { status: null, sendStatus(code) { this.status = code; return this; } };
  await wa.webhook(req, res);
  return res.status;
}

const lastStage = () => log.recentInbound(1).events[0]?.stage;

test('a delivery with a wrong signature is refused before anything is read', async () => {
  const status = await deliver(textMessage(FOUNDER, 'HALT'), { signature: 'sha256=' + '0'.repeat(64) });
  assert.equal(status, 403);
  assert.equal(lastStage(), log.STAGES.BAD_SIGNATURE);
  assert.equal(killSwitch.getKillSwitch().halted, false, 'a forged HALT does nothing');
  assert.deepEqual(sent, []);
});

test('a receipt is acknowledged and counted, and nothing is sent', async () => {
  const before = log.recentInbound().receipts;
  const status = await deliver({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] }] });
  assert.equal(status, 200);
  assert.notDeepEqual(log.recentInbound().receipts, before);
  assert.deepEqual(sent, []);
});

test('a stranger is dropped when the help desk is off', async () => {
  const status = await deliver(textMessage(STRANGER, 'hello?'));
  assert.equal(status, 200);
  assert.equal(lastStage(), log.STAGES.NOT_ALLOWLISTED);
  assert.equal(turns.length, 0);
  assert.deepEqual(sent, []);
});

test('with the help desk on, a stranger reaches the desk and never the founder\'s commands', async () => {
  process.env.WHATSAPP_DESK = 'true';
  await deliver(textMessage(STRANGER, 'HALT'));
  assert.equal(killSwitch.getKillSwitch().halted, false, 'a customer saying halt is not the founder');
  assert.equal(turns.length, 0, 'the company turn never runs for a stranger');
  assert.deepEqual(deskTurns, [{ from: STRANGER, text: 'HALT' }]);
  assert.deepEqual(sent, [{ to: STRANGER, text: 'Desk here: try restarting it.' }]);
  assert.equal(lastStage(), log.STAGES.ANSWERED);
});

test('the founder is acknowledged, then answered from the company turn', async () => {
  await deliver(textMessage(FOUNDER, 'How are the ventures doing?'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, `whatsapp-${FOUNDER}`);
  assert.equal(turns[0].text, 'How are the ventures doing?');
  assert.ok(turns[0].options.deadlineAt > Date.now(), 'the turn is given a deadline');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /^On it/, 'the acknowledgement goes first');
  assert.equal(sent[1].text, 'The team says: ship it.');
  assert.equal(lastStage(), log.STAGES.ANSWERED);
});

test('a redelivered message does not run the turn twice', async () => {
  const body = textMessage(FOUNDER, 'Once only', 'wamid.same');
  await deliver(body);
  await deliver(body);
  assert.equal(turns.length, 1);
  assert.equal(lastStage(), log.STAGES.DUPLICATE);
});

test('when the turn fails, the reason reaches the phone and the log', async () => {
  turnImpl = async () => { throw new Error('Daily spend cap of $5.00 reached'); };
  await deliver(textMessage(FOUNDER, 'Plan the week'));
  const apology = sent.at(-1).text;
  assert.match(apology, /couldn't answer that — Daily spend cap of \$5\.00 reached/);
  assert.match(apology, /Failed after \d+s/);
  const event = log.recentInbound(1).events[0];
  assert.equal(event.stage, log.STAGES.FAILED);
  assert.equal(event.detail, 'Daily spend cap of $5.00 reached');
});

test('a turn that runs out of time sends the quick read and queues the full answer', async () => {
  turnImpl = async () => ({ reply: 'Short version: yes.', ranOutOfTime: true });
  await deliver(textMessage(FOUNDER, 'Should we enter the German market?'));
  assert.match(sent.at(-1).text, /^Short version: yes\.\n\n— That's the quick read/);
  const dive = deepDives.listDeepDives(1)[0];
  assert.equal(dive.question, 'Should we enter the German market?');
  assert.equal(dive.deliverTo, FOUNDER);
  assert.equal(drained, 1, 'the queue is started, not left for the next boot');
});

test('the founder\'s HALT is decided here, without the company turn', async () => {
  await deliver(textMessage(FOUNDER, 'HALT: checking the outreach copy'));
  assert.equal(killSwitch.getKillSwitch().halted, true);
  assert.equal(turns.length, 0, 'no agent interprets the founder\'s controls');
  assert.equal(sent.length, 1);
  assert.equal(lastStage(), log.STAGES.ANSWERED);
  killSwitch.resumeRealActions();
});

test('a voice note with no speech in it gets an honest reply and no turn', async () => {
  wa = inbound.createWhatsAppInbound({
    anthropic: {},
    runCompanyTurn: async () => { turns.push('ran'); return { reply: '', ranOutOfTime: false }; },
    drainDeepDives: () => {},
    deskSessions: new Map(),
    turnDeadlineMs: 120000,
    io: {
      sendWhatsAppMessage: async (to, text) => { sent.push({ to, text }); },
      downloadMedia: async () => ({ buffer: Buffer.from('ogg'), filename: 'note.ogg' }),
      transcribeAudio: async () => ({ text: '   ', language: 'english' }),
      isOpenAIConfigured: () => true,
      isSpeechConfigured: () => false,
    },
  });
  const body = { entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.voice', from: FOUNDER, type: 'audio', audio: { id: 'media-1' } }] } }] }] };
  await deliver(body);
  assert.deepEqual(turns, []);
  assert.deepEqual(sent, [{ to: FOUNDER, text: "I couldn't make out any words in that one — try again?" }]);
  assert.equal(lastStage(), log.STAGES.UNSUPPORTED_TYPE);
});
