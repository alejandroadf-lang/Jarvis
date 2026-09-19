// Automatic translation, on the cascade that was already there.
//
// The load-bearing tests here are about what must NOT happen. A translator
// that answers the question it was handed has destroyed it, and a translator
// that renders MAD as Madrid or drops a record locator has produced something
// actively dangerous: an agent acts on a booking reference that no longer
// exists. So the prompt is checked for those rules and the output is checked
// for the codes that went missing.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let tr;
let tv;
let originalFetch;
const saved = {};
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'TRAVEL_VOICE_PHONE_NUMBER_ID'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-tr-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  tr = await import('../travelVoice/translate.js');
  tv = await import('../travelVoice/index.js');
});

after(() => {
  global.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = 'an';
  process.env.WHATSAPP_TOKEN = 'wa';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '111';
  process.env.TRAVEL_VOICE_PHONE_NUMBER_ID = '222';
  tr.__resetTranslateForTests();
  tv.__resetTravelVoiceForTests();
  global.fetch = originalFetch;
});

const parse = (t) => tr.parseTranslateCommand(t);

// --- the command, in three languages ----------------------------------------

test('translation is asked for in whichever language the person already speaks', () => {
  assert.deepEqual(parse('translate en'), { kind: 'to', to: 'en' });
  assert.deepEqual(parse('TRADUCIR INGLES'), { kind: 'to', to: 'en' });
  assert.deepEqual(parse('traduire anglais'), { kind: 'to', to: 'en' });
  assert.deepEqual(parse('translate into french'), { kind: 'to', to: 'fr' });
  assert.deepEqual(parse('traducir al español'), { kind: 'to', to: 'es' });
});

test('two languages means a channel between them, written any of the usual ways', () => {
  for (const form of ['translate es en', 'translate es>en', 'translate es/en', 'translate es and en', 'traducir es a en']) {
    assert.deepEqual(parse(form), { kind: 'pair', pair: ['es', 'en'] }, form);
  }
});

test('off and status are their own commands, and a sentence is neither', () => {
  assert.deepEqual(parse('translate off'), { kind: 'off' });
  assert.deepEqual(parse('TRADUIRE ARRET'), { kind: 'off' });
  assert.deepEqual(parse('translate'), { kind: 'status' });

  assert.equal(parse('can you translate this for my client'), null);
  assert.equal(parse('the translation was wrong'), null);
  assert.equal(parse('translate klingon'), null);
});

test('the same language twice is caught rather than set up as a pointless channel', () => {
  assert.deepEqual(parse('translate es es'), { kind: 'same', language: 'es' });
});

// --- which way a message goes -----------------------------------------------

test('a one-way mode always lands on its target; a pair returns the other side', () => {
  assert.equal(tr.targetFor({ to: 'en' }, 'es'), 'en');
  assert.equal(tr.targetFor({ to: 'en' }, 'en'), 'en', 'even when it is already there');

  const pair = { pair: ['es', 'fr'] };
  assert.equal(tr.targetFor(pair, 'es'), 'fr');
  assert.equal(tr.targetFor(pair, 'fr'), 'es');
  // A third language in a two-language channel goes to the first side, so
  // the agent hears their own language rather than nothing.
  assert.equal(tr.targetFor(pair, 'en'), 'es');
  assert.equal(tr.targetFor(null, 'es'), null);
});

test('a mode belongs to one conversation and survives a restart', () => {
  assert.equal(tr.modeFor('whatsapp-34600111222'), null);
  tr.setMode('whatsapp-34600111222', { pair: ['es', 'fr'] });
  assert.deepEqual(tr.modeFor('whatsapp-34600111222'), { pair: ['es', 'fr'] });
  assert.equal(tr.modeFor('whatsapp-33600000000'), null, 'and only that one');
  tr.clearMode('whatsapp-34600111222');
  assert.equal(tr.modeFor('whatsapp-34600111222'), null);
});

// --- the prompt -------------------------------------------------------------

test('the prompt forbids the two things that ruin a travel translation', () => {
  const p = tr.translationPrompt('Spanish', 'en');
  assert.match(p, /You are NOT an advisor/, 'it must not answer the question it is given');
  assert.match(p, /Do not answer it/);
  assert.match(p, /MAD stays MAD; it never becomes Madrid/);
  for (const token of ['FXP', 'ONNAZ', 'locator', 'dates', 'prices']) {
    assert.ok(p.toLowerCase().includes(token.toLowerCase()), `should protect ${token}`);
  }
  assert.match(p, /read aloud/, 'the output is spoken, not printed');
});

// --- the codes that must survive --------------------------------------------

test('codes and references are recognised, ordinary shouting is not', () => {
  const found = tr.codesIn('Reserva ABC123 en IB3402 MAD CDG, tarifa ONNAZ, usa FXP. OK? GRACIAS');
  for (const code of ['ABC123', 'IB3402', 'ONNAZ', 'FXP']) {
    assert.ok(found.includes(code), `should find ${code}`);
  }
  for (const word of ['OK', 'GRACIAS']) {
    assert.ok(!found.includes(word), `${word} is not a code`);
  }
});

test('a code that went in and did not come out is reported', () => {
  const original = 'El localizador es ABC123 y el vuelo IB3402 sale de MAD.';
  const good = 'The record locator is ABC123 and flight IB3402 departs from MAD.';
  assert.deepEqual(tr.droppedCodes(original, good), []);

  // The failure that matters: a locator quietly lost in translation.
  const bad = 'The record locator is the one we discussed and the flight departs from Madrid.';
  const dropped = tr.droppedCodes(original, bad);
  assert.ok(dropped.includes('ABC123'));
  assert.ok(dropped.includes('IB3402'));
});

// --- a whole turn -----------------------------------------------------------

function stubBrainTurn(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return { content: [{ type: 'text', text: reply }], usage: { input_tokens: 40, output_tokens: 20 } };
      },
    },
  };
}

test('a translation turn renders the text and never carries conversation history', async () => {
  const anthropic = stubBrainTurn('The record locator is ABC123. Use FXP to price it.');
  const out = await tv.runTranslateTurn({
    anthropic,
    sessionId: 'web-t',
    text: 'El localizador es ABC123. Usa FXP para valorarlo.',
    mode: { to: 'en' },
  });

  assert.equal(out.language, 'en');
  assert.equal(out.source, 'es');
  assert.equal(out.translated, true);
  assert.deepEqual(out.dropped, [], 'both codes survived');
  assert.equal(anthropic.calls[0].messages.length, 1, 'one message, no history — a translation is not a conversation');
  assert.match(anthropic.calls[0].system[0].text, /You are NOT an advisor/);
  assert.ok(out.costUsd > 0, 'metered like every other model call');
});

test('a pair turn sends a French message back as Spanish without being told', async () => {
  const anthropic = stubBrainTurn('El cliente quiere cambiar el vuelo.');
  const out = await tv.runTranslateTurn({
    anthropic,
    sessionId: 'web-p',
    text: 'Le client veut changer le vol pour demain matin.',
    mode: { pair: ['es', 'fr'] },
  });
  assert.equal(out.source, 'fr');
  assert.equal(out.language, 'es');
});

test('a dropped locator comes back as a warning on the turn', async () => {
  const anthropic = stubBrainTurn('The locator is the one we discussed.');
  const out = await tv.runTranslateTurn({
    anthropic,
    sessionId: 'web-d',
    text: 'El localizador es ABC123 para el vuelo IB3402.',
    mode: { to: 'en' },
  });
  assert.ok(out.dropped.includes('ABC123'));
  assert.ok(out.dropped.includes('IB3402'));
});

// --- end to end on WhatsApp -------------------------------------------------

function stubOutside(translated) {
  const sent = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/graph\.facebook\.com\/v[\d.]+\/media-1$/.test(u)) return { ok: true, json: async () => ({ url: 'https://look/blob', mime_type: 'audio/ogg' }) };
    if (u === 'https://look/blob') return { ok: true, arrayBuffer: async () => new TextEncoder().encode('opus').buffer };
    if (u.includes('/audio/transcriptions')) return { ok: true, json: async () => ({ text: 'El localizador es ABC123.', language: 'spanish', duration: 3 }) };
    if (u.includes('/audio/speech')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('OggS').buffer };
    if (/\/media$/.test(u)) return { ok: true, json: async () => ({ id: 'up-1' }) };
    if (/\/messages$/.test(u)) { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error(`unexpected fetch ${u}`);
  };
  void translated;
  return sent;
}

test('turning it on, speaking Spanish, and getting English voice plus text', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  const sent = stubOutside();
  const anthropic = stubBrainTurn('The record locator is ABC123.');
  const msg = (id, text, media = null) => ({
    id, from: '34600111222', type: media ? 'audio' : 'text', text, mediaId: media, phoneNumberId: '222',
  });

  const on = await tv.handleTravelVoiceMessage(msg('m1', 'TRADUCIR EN'), { anthropic, phoneNumberId: '222' });
  assert.equal(on.stage, 'translate_mode');
  assert.match(sent[0].text.body, /English/, 'told in the language they were already being served in');
  assert.equal(anthropic.calls.length, 0, 'setting a mode asks no model');

  sent.length = 0;
  const out = await tv.handleTravelVoiceMessage(msg('m2', '', 'media-1'), { anthropic, phoneNumberId: '222' });

  assert.equal(out.stage, 'translated');
  assert.equal(out.language, 'en');
  assert.equal(out.source, 'es');
  assert.equal(out.spoke, true, 'the translation is spoken');
  assert.equal(sent.find((m) => m.type === 'text').text.body, 'The record locator is ABC123.');
  assert.equal(tv.recentTravelVoiceTurns()[0].stage, 'translated');
});

test('the text always goes with a translation, because it exists to be forwarded', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.TRAVEL_VOICE_TEXT_TOO = 'false'; // off for the advisor
  const sent = stubOutside();
  const anthropic = stubBrainTurn('The locator is ABC123.');
  tr.setMode('whatsapp-34600111222', { to: 'en' });

  await tv.handleTravelVoiceMessage(
    { id: 'm3', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.ok(sent.some((m) => m.type === 'text'), 'you cannot forward a sentence you only heard');
  assert.ok(sent.some((m) => m.type === 'audio'));
  delete process.env.TRAVEL_VOICE_TEXT_TOO;
});

test('turning it off hands the conversation back to the advisor', async () => {
  const sent = stubOutside();
  const anthropic = stubBrainTurn('x');
  tr.setMode('whatsapp-34600111222', { to: 'en' });

  const off = await tv.handleTravelVoiceMessage(
    { id: 'm4', from: '34600111222', type: 'text', text: 'translate off', mediaId: null, phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  assert.equal(off.stage, 'translate_mode');
  assert.equal(tr.modeFor('whatsapp-34600111222'), null);
  assert.match(sent[0].text.body, /advisor|asesor|conseiller/);
});

test('a dropped code reaches the caller as a warning they can act on', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  const sent = stubOutside();
  const anthropic = stubBrainTurn('The locator is the one we discussed.');
  tr.setMode('whatsapp-34600111222', { to: 'en' });

  await tv.handleTravelVoiceMessage(
    { id: 'm5', from: '34600111222', type: 'audio', text: '', mediaId: 'media-1', phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );
  const warning = sent.map((m) => m.text?.body).find((b) => b && b.includes('ABC123'));
  assert.ok(warning, 'the caller is told which reference went missing');
  assert.match(warning, /before you send it on/);
});
