// The case: what the advisor still knows once the transcript has been
// trimmed, what it deliberately does not keep, and when it goes.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ctx;
const saved = {};
const KEYS = ['ANTHROPIC_API_KEY', 'DAILY_SPEND_CAP_USD'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-context-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  ctx = await import('../travelVoice/context.js');
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
  process.env.DAILY_SPEND_CAP_USD = '100';
  ctx.__resetContextForTests();
});

test('codes are sorted by how sure the signal is, not by their shape', () => {
  const found = ctx.classifyCodes('el localizador X7K2PQ en IB3402 de MAD a CDG, billete 075-1234567890, no valora con FXP');
  assert.deepEqual(found.locators, ['X7K2PQ']);
  assert.deepEqual(found.tickets, ['075-1234567890']);
  assert.deepEqual(found.carriers, ['IB'], 'IB3402 is a flight, not a locator');
  assert.deepEqual(found.airports, ['MAD', 'CDG']);
  assert.deepEqual(found.entries, ['FXP'], 'FXP is an entry, not an airport');

  // An all-letter locator is only one when the words say so.
  assert.deepEqual(ctx.classifyCodes('dossier ABCDEF sur AF1234').locators, ['ABCDEF']);
  assert.deepEqual(ctx.classifyCodes('MADRID es la ciudad').locators, [], 'a six-letter word is not a locator');
  // An entry with a number on it keeps its stem.
  assert.deepEqual(ctx.classifyCodes('use FQN1*16 and XE2').entries, ['FQN', 'XE']);
  // Words that look like codes are not codes.
  assert.deepEqual(ctx.classifyCodes('OK URGENTE, el PNR y el TST'), { locators: [], tickets: [], carriers: [], airports: [], entries: [] });
});

test('the topic is recognised in all three languages', () => {
  assert.deepEqual(ctx.topicsIn('el cliente quiere el reembolso'), ['refund']);
  assert.deepEqual(ctx.topicsIn('le client veut un remboursement'), ['refund']);
  assert.deepEqual(ctx.topicsIn('the client wants a refund'), ['refund']);
  assert.ok(ctx.topicsIn('reclamo este ADM y pido indemnisation').includes('adm'));
  assert.ok(ctx.topicsIn('reclamo este ADM y pido indemnisation').includes('eu261'));
  assert.deepEqual(ctx.topicsIn('buenos días'), []);
});

test('a case accumulates across turns and keeps the newest when it fills', () => {
  const id = 'whatsapp-34600111222';
  assert.equal(ctx.caseFor(id), null);
  ctx.rememberTurn(id, { text: 'el localizador X7K2PQ de IB3402 no valora', reply: 'Valore con FXP.', language: 'es' });
  ctx.rememberTurn(id, { text: 'sigue sin valorar', reply: 'Pruebe FXB y revise el TST con TQT.', language: 'es' });
  const c = ctx.caseFor(id);
  assert.deepEqual(c.locators, ['X7K2PQ']);
  assert.deepEqual(c.carriers, ['IB']);
  assert.deepEqual(c.entries, ['FXP', 'FXB', 'TQT'], 'only what the advisor suggested');
  assert.deepEqual(c.topics, ['pricing']);
  assert.equal(c.turns, 2);
  assert.equal(c.language, 'es');

  // Seven locators, six kept, oldest out.
  for (let i = 0; i < 7; i++) ctx.rememberTurn(id, { text: `localizador AAA00${i}`, reply: 'ok' });
  const full = ctx.caseFor(id);
  assert.equal(full.locators.length, 6);
  assert.equal(full.locators.at(-1), 'AAA006');
  assert.ok(!full.locators.includes('X7K2PQ'), 'the oldest was pushed out');
});

test('what the advisor is told is terse, marked as already known, and never money', () => {
  const id = 'whatsapp-1';
  ctx.rememberTurn(id, { text: 'el localizador X7K2PQ de IB3402 MAD CDG, el cliente quiere reembolso', reply: 'Use TRF.', language: 'es' });
  const prompt = ctx.contextPrompt(ctx.caseFor(id));
  assert.match(prompt, /WHAT YOU ALREADY KNOW ABOUT THIS CALLER/);
  assert.match(prompt, /do not ask them to repeat it/);
  assert.match(prompt, /what they say now wins/, 'the present beats the record');
  assert.match(prompt, /Record locator\(s\) in play: X7K2PQ\./);
  assert.match(prompt, /Carrier\(s\): IB\./);
  assert.match(prompt, /about a refund/);
  assert.match(prompt, /Already suggested to them: TRF/);
  assert.match(prompt, /No amount of money is ever carried here/);
  assert.equal(ctx.contextPrompt(null), null);
  assert.equal(ctx.contextPrompt(ctx.caseFor('whatsapp-nobody')), null, 'nothing known, nothing carried');
});

test('a remembered note can never carry a price, whatever the model writes', () => {
  assert.equal(ctx.stripAmounts('The change fee is 150 euros plus €20 tax.'), 'The change fee is an amount to re-check plus an amount to re-check tax.');
  assert.equal(ctx.stripAmounts('Quoted 1.234,50 € and 35 GBP and $99.'), 'Quoted an amount to re-check and an amount to re-check and an amount to re-check.');
  assert.equal(ctx.stripAmounts('Category 16 and flight IB3402 on 25DEC'), 'Category 16 and flight IB3402 on 25DEC', 'numbers that are not money survive');
});

test('the note is written by the brain, stripped of amounts, and a failure leaves the facts', async () => {
  const id = 'whatsapp-2';
  ctx.rememberTurn(id, { text: 'localizador X7K2PQ', reply: 'Use FXP.', language: 'es' });
  const seen = [];
  const brain = {
    id: 'stub',
    model: () => 'stub-1',
    priceSpec: () => ({ inputPricePerMTok: 1, outputPricePerMTok: 1 }),
    create: async (request) => {
      seen.push(request);
      return { content: [{ type: 'text', text: 'Madrid agency working locator X7K2PQ on IB; the advisor suggested FXP; the change fee of 150 euros is still to confirm.' }], usage: { input_tokens: 50, output_tokens: 20 } };
    },
  };
  const history = [
    { role: 'user', content: 'el localizador X7K2PQ no valora' },
    { role: 'assistant', content: [{ type: 'text', text: 'Valore con FXP.' }] },
  ];
  await ctx.summarizeCase(id, { brain, history, previous: null, through: 2 });
  assert.match(seen[0].system[0].text, /NEVER include a fare, fee, penalty or any amount of money/);
  assert.match(seen[0].messages[0].content, /Caller: el localizador X7K2PQ no valora/);
  assert.match(seen[0].messages[0].content, /Advisor: Valore con FXP\./);
  const c = ctx.caseFor(id);
  assert.match(c.summary, /^Madrid agency working locator X7K2PQ on IB/);
  assert.match(c.summary, /an amount to re-check is still to confirm/, 'the price never lands');
  assert.ok(!/150/.test(c.summary));
  assert.equal(c.summaryThrough, 2);
  assert.match(ctx.contextPrompt(c), /Madrid agency working locator X7K2PQ/);

  // An earlier note is handed back so it is updated rather than repeated.
  seen.length = 0;
  await ctx.summarizeCase(id, { brain, history, previous: c.summary, through: 4 });
  assert.match(seen[0].messages[0].content, /^Earlier note:\nMadrid agency/);

  // A brain that throws leaves the facts alone.
  const broken = { ...brain, create: async () => { throw new Error('cap reached'); } };
  await ctx.summarizeCase(id, { brain: broken, history, through: 6 });
  assert.match(ctx.caseFor(id).summary, /Madrid agency/, 'the old note survives');
  assert.deepEqual(ctx.caseFor(id).locators, ['X7K2PQ'], 'and so do the facts');
  assert.equal(await ctx.summarizeCase(id, { brain, history: [] }), null, 'nothing to summarise, no call');
});

test('a case is forgotten on request and swept with the transcript', () => {
  ctx.rememberTurn('whatsapp-a', { text: 'localizador AAA111', reply: 'ok' });
  ctx.rememberTurn('whatsapp-b', { text: 'localizador BBB222', reply: 'ok' });
  assert.equal(ctx.listCases().length, 2);
  assert.equal(ctx.forgetCase('whatsapp-a'), true);
  assert.equal(ctx.caseFor('whatsapp-a'), null);
  assert.equal(ctx.forgetCase('whatsapp-a'), false, 'twice is not an error');

  assert.equal(ctx.sweepCases(Date.now() - 1000), 0, 'a fresh case stays');
  assert.equal(ctx.sweepCases(Date.now() + 1000), 1, 'an old one goes');
  assert.equal(ctx.listCases().length, 0);
});

test('the founder’s view of a case reads as a handover note', () => {
  const id = 'whatsapp-3';
  ctx.rememberTurn(id, { text: 'dossier ABCDEF sur AF1234 ORY BCN, remboursement', reply: 'Utilisez TRF.', language: 'fr' });
  const text = ctx.describeCase(ctx.caseFor(id));
  assert.match(text, /locators ABCDEF/);
  assert.match(text, /carriers AF/);
  assert.match(text, /airports ORY, BCN/);
  assert.match(text, /about a refund/);
  assert.match(text, /already suggested TRF/);
  assert.match(text, /1 turn, fr, since \d{4}-\d{2}-\d{2}\./);
  assert.equal(ctx.describeCase(null), 'Nothing remembered about this conversation yet.');
});
