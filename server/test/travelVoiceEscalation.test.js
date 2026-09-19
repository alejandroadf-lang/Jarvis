// A person, when a person is wanted: recognising the request in three
// languages, the record of the handoff, and the words on both sides.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let esc;
const saved = {};
const KEYS = ['TRAVEL_VOICE_ESCALATION_NUMBERS', 'WHATSAPP_ALLOWED_NUMBERS'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-escalation-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  esc = await import('../travelVoice/escalation.js');
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  esc.__resetEscalationsForTests();
});

test('asking for a person is recognised in the words people use, and not in ordinary questions', () => {
  for (const ask of [
    'AGENTE', 'agente.', 'Conseiller', 'agent', 'humano', 'persona',
    'quiero hablar con una persona', 'Puede pasarme con un agente?', 'necesito un humano',
    "je veux parler à un conseiller", "passez-moi quelqu'un", "j'aimerais un agent",
    'can I talk to a real person', 'I want a human', 'transfer me to an agent', 'you are not a person',
  ]) assert.equal(esc.isHandoffRequest(ask), true, ask);
  for (const question of [
    '¿Qué comisión cobra el agente de viajes?', 'el agente IATA necesita', 'the agent must enter FXP',
    "l'agence doit émettre", 'how does a travel agent void a ticket', 'persona jurídica en el PNR',
  ]) assert.equal(esc.isHandoffRequest(question), false, question);
  assert.equal(esc.isHandoffRequest(''), false);
});

test('the escalation list is its own variable, and the founder line otherwise', () => {
  assert.deepEqual(esc.escalationNumbers(), []);
  process.env.WHATSAPP_ALLOWED_NUMBERS = '+44 7700 900123';
  assert.deepEqual(esc.escalationNumbers(), ['447700900123']);
  process.env.TRAVEL_VOICE_ESCALATION_NUMBERS = '+34 600 000 001, 34600000002';
  assert.deepEqual(esc.escalationNumbers(), ['34600000001', '34600000002']);
});

test('a handoff is opened once, records what is forwarded and said, and closes with a log', () => {
  assert.equal(esc.isEscalated('34600111222'), false);
  const opened = esc.openHandoffFor('+34 600 111 222', { by: 'caller', reason: 'asked', language: 'es', transcript: 'quiero una persona' });
  assert.equal(opened.number, '34600111222');
  assert.equal(esc.isEscalated('34600111222'), true);
  esc.openHandoffFor('34600111222', { by: 'advisor', reason: 'dispute' });
  assert.equal(esc.listOpenHandoffs().length, 1, 'a second request does not open a second handoff');
  assert.equal(esc.openHandoff('34600111222').reason, 'dispute');
  assert.equal(esc.openHandoff('34600111222').by, 'caller', 'who opened it is kept');

  esc.recordForwarded('34600111222', { text: 'sigo esperando', voice: false });
  esc.recordSaid('34600111222', { text: 'Le llamo en cinco minutos.', by: '447700900123' });
  const entry = esc.openHandoff('34600111222');
  assert.equal(entry.forwarded.length, 1);
  assert.equal(entry.said[0].by, '…0123', 'who said it is masked in the record');

  const closed = esc.closeHandoff('34600111222', { by: '447700900123' });
  assert.equal(closed.number, '34600111222');
  assert.equal(esc.isEscalated('34600111222'), false);
  assert.equal(esc.closeHandoff('34600111222'), null);
  const kinds = esc.recentHandoffEvents().map((e) => e.kind);
  assert.deepEqual(kinds, ['handoff_closed', 'human_said', 'handoff_repeated', 'handoff_opened']);
  assert.ok(esc.recentHandoffEvents().every((e) => !String(e.number).includes('34600111222')), 'the log masks numbers');
});

test('the person on the list is told the number, the reason and how to answer', () => {
  const entry = esc.openHandoffFor('34600111222', { by: 'advisor', reason: 'Caller disputes an ADM.', language: 'es', transcript: 'no estoy de acuerdo con el ADM' });
  const note = esc.notificationFor(entry);
  assert.match(note, /Caller: \+34600111222 \(Spanish\)/);
  assert.match(note, /Asked by: the advisor — Caller disputes an ADM\./);
  assert.match(note, /Last message: "no estoy de acuerdo con el ADM"/);
  assert.match(note, /TRAVEL SAY \+34600111222/);
  assert.match(note, /TRAVEL RESUME \+34600111222/);
  assert.match(esc.handoffText('opened', 'fr'), /transmets votre conversation à une personne/);
  assert.match(esc.handoffText('waiting', 'en'), /reached the person/);
  assert.match(esc.handoffText('resumed', 'es'), /Escribe AGENTE/);
});
