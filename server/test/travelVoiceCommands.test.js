// Running the demo from a phone, with no browser open.
//
// The load-bearing test in this file is the guest boundary: a number the
// founder invited must reach the travel advisor and absolutely nothing else
// on the company's line. Everything else here is about a command being the
// whole message, so a sentence that merely mentions travel is never mistaken
// for an instruction.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let commands;
let guests;
let prefs;
let registry;
let tv;
let languages;
let settings;
let replyCheck;
let originalFetch;
const saved = {};
const KEYS = [
  'TRAVEL_VOICE_CONSENT',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'DEEPGRAM_API_KEY',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'TRAVEL_VOICE_PHONE_NUMBER_ID',
  'TRAVEL_VOICE_STT_PROVIDER',
  'TRAVEL_VOICE_LLM_PROVIDER',
  'TRAVEL_VOICE_TTS_PROVIDER',
  'TRAVEL_VOICE_SPOKEN_MAX_WORDS',
  'TRAVEL_VOICE_LANGUAGE_RETRY',
  'TRAVEL_VOICE_MAX_TURNS_PER_HOUR',
  'TRAVEL_VOICE_TEXT_TOO',
  'TRAVEL_VOICE_EFFORT',
  'TRAVEL_VOICE_MODEL',
  'ELEVENLABS_VOICE_ID',
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-cmd-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  commands = await import('../travelVoice/commands.js');
  guests = await import('../travelVoice/guests.js');
  prefs = await import('../travelVoice/providerPrefs.js');
  registry = await import('../travelVoice/providers/index.js');
  tv = await import('../travelVoice/index.js');
  languages = await import('../travelVoice/languages.js');
  settings = await import('../travelVoice/settings.js');
  replyCheck = await import('../travelVoice/replyCheck.js');
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
  guests.__resetGuestsForTests();
  prefs.__resetPrefsForTests();
  settings.__resetSettingsForTests();
  tv.__resetTravelVoiceForTests();
  // Consent has its own tests; here the notice would only get in the way.
  process.env.TRAVEL_VOICE_CONSENT = 'off';
  global.fetch = originalFetch;
});

const parse = (text) => commands.parseTravelCommand(text);

// --- parsing ----------------------------------------------------------------

test('a command has to be the whole message', () => {
  assert.deepEqual(parse('travel status'), { kind: 'status' });
  assert.deepEqual(parse('TRAVEL STATUS'), { kind: 'status' });
  assert.deepEqual(parse('  travel   status  '), { kind: 'status' });

  // Sentences about work, not instructions.
  assert.equal(parse('what is the travel status of the Acme booking'), null);
  assert.equal(parse('I want to travel on Monday'), null);
  assert.equal(parse('travel to Paris'), null);
  assert.equal(parse('can you send travel invite emails'), null);
});

test('the bare word is help, and so are the usual ways of asking for it', () => {
  assert.deepEqual(parse('travel'), { kind: 'help' });
  assert.deepEqual(parse('travel help'), { kind: 'help' });
  assert.deepEqual(parse('travel ?'), { kind: 'help' });
});

test('a slot word is a pin, with its synonyms', () => {
  assert.deepEqual(parse('travel voice elevenlabs'), { kind: 'pin', slot: 'tts', word: 'voice', provider: 'elevenlabs' });
  assert.deepEqual(parse('travel ears deepgram'), { kind: 'pin', slot: 'stt', word: 'ears', provider: 'deepgram' });
  assert.deepEqual(parse('travel brain ionos'), { kind: 'pin', slot: 'llm', word: 'brain', provider: 'ionos' });
  assert.deepEqual(parse('travel model openai'), { kind: 'pin', slot: 'llm', word: 'model', provider: 'openai' });
  assert.deepEqual(parse('travel defaults'), { kind: 'unpin' });
});

test('an invite carries the number and, optionally, the language', () => {
  assert.deepEqual(parse('travel invite +34 600 111 222'), { kind: 'invite', number: '+34 600 111 222', language: null });
  assert.deepEqual(parse('travel invite 34600111222 es'), { kind: 'invite', number: '34600111222', language: 'es' });
  assert.deepEqual(parse('travel invite 33600000000 french'), { kind: 'invite', number: '33600000000', language: 'fr' });
  assert.deepEqual(parse('travel remove 34600111222'), { kind: 'guest_remove', number: '34600111222' });
});

// --- the guest list ---------------------------------------------------------

test('a guest is remembered by digits, so formatting never locks them out', () => {
  assert.equal(guests.isGuest('+34 600 111 222'), false);
  guests.addGuest('+34 600 111 222', { language: 'es' });
  assert.equal(guests.isGuest('34600111222'), true);
  assert.equal(guests.isGuest('(34) 600-111-222'), true);
  assert.equal(guests.isGuest('33600000000'), false, 'and only that number');

  guests.addGuest('34600111222', { language: 'fr' });
  assert.equal(guests.listGuests().length, 1, 'inviting twice does not duplicate');
  assert.equal(guests.listGuests()[0].language, 'fr', 'it updates');

  assert.equal(guests.removeGuest('+34 600 111 222'), true);
  assert.equal(guests.isGuest('34600111222'), false);
  assert.equal(guests.removeGuest('34600111222'), false, 'removing twice is not an error');
});

// --- pinning a provider from the phone --------------------------------------

test('pinning changes what the next answer runs on, and defaults puts it back', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  assert.equal(registry.resolveProvider('tts').id, 'openai', 'slot order before anything is pinned');

  const reply = await commands.runTravelCommand(parse('travel voice elevenlabs'), {});
  assert.match(reply, /ElevenLabs/);
  assert.equal(registry.resolveProvider('tts').id, 'elevenlabs');
  assert.equal(registry.providerSource('tts'), 'pinned');

  await commands.runTravelCommand(parse('travel defaults'), {});
  assert.equal(registry.resolveProvider('tts').id, 'openai');
  assert.equal(registry.providerSource('tts'), 'first');
});

test('a turn that names its own provider still beats a pin', () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  prefs.setOverride('tts', 'elevenlabs');
  assert.equal(registry.resolveProvider('tts', 'openai').id, 'openai', 'the tab’s dropdown must keep meaning what it says');
});

test('pinning something with no key is refused rather than breaking the next answer', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  const reply = await commands.runTravelCommand(parse('travel voice elevenlabs'), {});
  assert.match(reply, /no key set/);
  assert.equal(registry.resolveProvider('tts').id, 'openai', 'nothing changed');

  // "ears" names no dial, so an unknown value there is a mistake rather
  // than a second reading. ("voice" and "model" do name one — see the
  // dial tests below for why an unknown value means something there.)
  const unknown = await commands.runTravelCommand(parse('travel ears hal9000'), {});
  assert.match(unknown, /No such provider "hal9000"/);
});

test('a pin whose key is later removed falls through instead of taking the demo down', () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  prefs.setOverride('tts', 'elevenlabs');
  assert.equal(registry.resolveProvider('tts').id, 'elevenlabs');

  delete process.env.ELEVENLABS_API_KEY;
  assert.equal(registry.resolveProvider('tts').id, 'openai', 'the demo keeps answering');
});

// --- the dials --------------------------------------------------------------

test('a dial can be set with or without the word set', () => {
  assert.deepEqual(parse('travel length 90'), { kind: 'set', setting: 'length', value: '90' });
  assert.deepEqual(parse('travel set length 90'), { kind: 'set', setting: 'length', value: '90' });
  assert.deepEqual(parse('travel words 90'), { kind: 'set', setting: 'length', value: '90' }, 'an alias people reach for');
  assert.deepEqual(parse('travel lang fr'), { kind: 'set', setting: 'language', value: 'fr' });
  assert.deepEqual(parse('travel settings'), { kind: 'settings' });
});

test('setting a dial changes what the next answer actually does', async () => {
  assert.equal(replyCheck.spokenMaxWords(), 220);
  await commands.runTravelCommand(parse('travel length 90'), {});
  assert.equal(replyCheck.spokenMaxWords(), 90, 'the spoken cap the advisor is trimmed to');

  assert.equal(tv.maxTurnsPerHour(), 20);
  await commands.runTravelCommand(parse('travel limit 3'), {});
  assert.equal(tv.maxTurnsPerHour(), 3);

  assert.equal(replyCheck.languageRetryEnabled(), true);
  await commands.runTravelCommand(parse('travel retry off'), {});
  assert.equal(replyCheck.languageRetryEnabled(), false);
});

test('a dial set from a phone beats the configured value, and clearing gives it back', async () => {
  process.env.TRAVEL_VOICE_SPOKEN_MAX_WORDS = '150';
  assert.equal(replyCheck.spokenMaxWords(), 150, 'configuration is the base');

  await commands.runTravelCommand(parse('travel length 60'), {});
  assert.equal(replyCheck.spokenMaxWords(), 60, 'the phone overrides it');

  const reply = await commands.runTravelCommand(parse('travel length default'), {});
  assert.match(reply, /back to the configured default/);
  assert.equal(replyCheck.spokenMaxWords(), 150, 'not the built-in default, the configured one');
});

test('a value a dial cannot take is refused with what it does take', async () => {
  const bad = await commands.runTravelCommand(parse('travel length banana'), {});
  assert.match(bad, /needs a whole number/);
  assert.match(bad, /It takes:/);
  assert.equal(replyCheck.spokenMaxWords(), 220, 'nothing changed');

  assert.match(await commands.runTravelCommand(parse('travel effort turbo'), {}), /one of low, medium, high, xhigh, max, off/);
  assert.match(await commands.runTravelCommand(parse('travel length 5'), {}), /between 20 and 2000/);
  assert.match(await commands.runTravelCommand(parse('travel text maybe'), {}), /say on or off/);
  assert.match(await commands.runTravelCommand(parse('travel language klingon'), {}), /one of es, fr, en/);
});

test('on and off are understood in all three languages', async () => {
  for (const yes of ['on', 'yes', 'true', 'sí', 'oui']) {
    settings.__resetSettingsForTests();
    await commands.runTravelCommand(parse(`travel retry ${yes}`), {});
    assert.equal(replyCheck.languageRetryEnabled(), true, yes);
  }
  for (const no of ['off', 'no', 'false', 'non']) {
    settings.__resetSettingsForTests();
    await commands.runTravelCommand(parse(`travel retry ${no}`), {});
    assert.equal(replyCheck.languageRetryEnabled(), false, no);
  }
});

test('"voice" means the provider when the value is one, and the voice when it is not', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';

  await commands.runTravelCommand(parse('travel voice elevenlabs'), {});
  assert.equal(registry.resolveProvider('tts').id, 'elevenlabs', 'a provider id switches the provider');

  const reply = await commands.runTravelCommand(parse('travel voice JBFqnCBsd6RMkjVDRZzb'), {});
  assert.match(reply, /voice for elevenlabs/);
  assert.equal(registry.resolveProvider('tts').voice(), 'JBFqnCBsd6RMkjVDRZzb', 'case survives — a voice id is case-sensitive');
  assert.equal(registry.resolveProvider('tts').id, 'elevenlabs', 'and the provider did not change');
});

test('a voice belongs to its provider, so switching provider does not carry it across', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  await commands.runTravelCommand(parse('travel voice elevenlabs'), {});
  await commands.runTravelCommand(parse('travel voice someElevenId'), {});

  await commands.runTravelCommand(parse('travel voice openai'), {});
  assert.equal(registry.resolveProvider('tts').voice(), 'alloy', "OpenAI keeps its own, not ElevenLabs' id");

  await commands.runTravelCommand(parse('travel voice elevenlabs'), {});
  assert.equal(registry.resolveProvider('tts').voice(), 'someElevenId', 'and switching back remembers');
});

test('a pinned language overrides detection, which is the point when demoing to one agency', async () => {
  const anthropic = {
    calls: [],
    messages: {
      create: async (req) => {
        anthropic.calls.push(req);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Oui.' }], usage: { input_tokens: 5, output_tokens: 2 } };
      },
    },
  };
  await commands.runTravelCommand(parse('travel language fr'), {});
  const result = await tv.runTravelVoiceTurn({ anthropic, sessionId: 'pinned', text: 'Hello, how do I price a booking?' });
  assert.equal(result.language, 'fr', 'answered in French despite an English question');
  assert.match(anthropic.calls[0].system.map((b) => b.text).join(), /Reply entirely in French/);
});

test('the listing says what each dial is on and where that came from', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.TRAVEL_VOICE_MAX_TURNS_PER_HOUR = '50';
  await commands.runTravelCommand(parse('travel length 90'), {});

  const reply = await commands.runTravelCommand(parse('travel settings'), {});
  assert.match(reply, /length: 90 \(set here\)/);
  assert.match(reply, /limit: 50 \(configured\)/);
  assert.match(reply, /effort: low/, 'and the built-in default where nothing was set');
  assert.match(reply, /language: auto/);
  assert.match(reply, /voice: alloy \(openai's default\)/, 'the live provider answers for its own dial');
});

test('defaults puts the dials back as well as the providers', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  await commands.runTravelCommand(parse('travel length 60'), {});
  await commands.runTravelCommand(parse('travel voice elevenlabs'), {});

  await commands.runTravelCommand(parse('travel defaults'), {});
  assert.equal(replyCheck.spokenMaxWords(), 220, 'a dial');
  assert.equal(registry.resolveProvider('tts').id, 'openai', 'and a provider pin');
});

// --- status -----------------------------------------------------------------

test('status names what is live, the spend and the guests, with no browser', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  process.env.ELEVENLABS_API_KEY = 'el';
  guests.addGuest('34600111222', { language: 'es' });

  const reply = await commands.runTravelCommand(parse('travel status'), {});
  assert.match(reply, /ears:\s+openai/);
  assert.match(reply, /brain:\s+anthropic/);
  assert.match(reply, /voice:\s+openai/);
  assert.match(reply, /also ready: elevenlabs/, 'it says what you could switch to');
  assert.match(reply, /spend today: \$/);
  assert.match(reply, /guests invited: 1/);
});

test('help lists the commands someone would need on a phone', async () => {
  const reply = await commands.runTravelCommand(parse('travel'), {});
  for (const expected of ['TRAVEL STATUS', 'TRAVEL INVITE', 'TRAVEL GUESTS', 'TRAVEL LOG', 'TRAVEL DEFAULTS']) {
    assert.ok(reply.includes(expected), `help should mention ${expected}`);
  }
});

test('the log reads back what happened, with a wrong-language answer called out', async () => {
  const empty = await commands.runTravelCommand(parse('travel log'), { recentTurns: () => [] });
  assert.match(empty, /Nothing yet/);

  const reply = await commands.runTravelCommand(parse('travel log'), {
    recentTurns: () => [
      {
        at: '2026-09-19T10:30:00.000Z',
        from: '…1222',
        language: 'es',
        stage: 'answered',
        voice: true,
        providers: { stt: 'elevenlabs', llm: 'anthropic', tts: 'elevenlabs' },
        drift: { detected: 'en', corrected: true },
        transcript: '¿Cómo valoro el PNR?',
      },
    ],
  });
  assert.match(reply, /10:30/);
  assert.match(reply, /…1222 es answered \(voice\)/);
  assert.match(reply, /\[elevenlabs\/anthropic\/elevenlabs\]/);
  assert.match(reply, /wrong language, fixed/);
  assert.match(reply, /¿Cómo valoro el PNR\?/);
});

// --- inviting ---------------------------------------------------------------

test('an invite sends a hello as text and as a voice note in the demo voice', async () => {
  process.env.TRAVEL_VOICE_CONSENT = 'required';
  process.env.OPENAI_API_KEY = 'oa';
  process.env.TRAVEL_VOICE_PHONE_NUMBER_ID = '222';
  const sent = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/audio/speech')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode('OggS').buffer };
    if (/\/media$/.test(u)) return { ok: true, json: async () => ({ id: 'media-1' }) };
    if (/\/messages$/.test(u)) {
      sent.push({ url: u, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };

  const result = await tv.inviteGuest('+34 600 111 222', { language: 'es' });

  assert.deepEqual(result, { number: '34600111222', language: 'es', spoke: true, delivered: true, error: null });
  assert.equal(guests.isGuest('34600111222'), true, 'they can now message the number');
  assert.equal(sent.length, 3);
  assert.equal(sent[0].body.type, 'text');
  assert.equal(sent[0].body.text.body, languages.localized('greeting', 'es'));
  assert.equal(sent[1].body.type, 'audio', 'they hear the product before they read about it');
  assert.equal(sent[2].body.type, 'interactive', 'then the AI notice with its buttons');
  assert.deepEqual(sent[2].body.interactive.action.buttons.map((b) => b.reply.title), ['Acepto', 'No acepto']);
  assert.ok(sent.every((m) => m.url.includes('/222/')), 'sent from the advisor’s number');
});

test('a hello that fails to send still leaves the invitation live, and says so', async () => {
  global.fetch = async () => ({ ok: false, status: 403, text: async () => 'blocked' });
  const reply = await commands.runTravelCommand(parse('travel invite 34600111222 es'), {
    inviteGuest: (n, o) => tv.inviteGuest(n, o),
  });
  assert.equal(guests.isGuest('34600111222'), true, 'they can message the number regardless');
  assert.match(reply, /on the guest list and can message this number now/);
  assert.match(reply, /hello did not go out/, 'so the founder does not invite them twice');
});

test('an invite with no voice provider still invites them, in text', async () => {
  process.env.TRAVEL_VOICE_CONSENT = 'required';
  const sent = [];
  global.fetch = async (url, init = {}) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({}) };
  };
  const result = await tv.inviteGuest('33600000000', { language: 'fr' });
  assert.equal(result.spoke, false);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text.body, /conseiller voyage/);
  assert.equal(sent[1].type, 'interactive', 'the AI notice still goes, in French');
  assert.match(sent[1].interactive.body.text, /^Information : vous parlez/);
  assert.equal(guests.isGuest('33600000000'), true);
});

// --- first contact ----------------------------------------------------------

test('a message that is nothing but a hello is recognised, in all three languages', () => {
  for (const hello of ['hola', 'Hola!', 'buenos días', 'bonjour', 'Salut :)', 'hello', 'hey', 'Good morning']) {
    assert.equal(languages.isBareGreeting(hello), true, hello);
  }
  // A question that merely opens politely is a question.
  for (const question of ['hola, ¿cómo valoro el PNR?', 'bonjour, une question sur FXP', 'hi, what does TTP do?']) {
    assert.equal(languages.isBareGreeting(question), false, question);
  }
  assert.equal(languages.isBareGreeting(''), false);
});

test('a bare hello is greeted in the caller’s language without asking the model', async () => {
  process.env.TRAVEL_VOICE_PHONE_NUMBER_ID = '222';
  const sent = [];
  global.fetch = async (url, init = {}) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({}) };
  };
  const anthropic = { messages: { create: async () => { throw new Error('the model should not be asked'); } } };

  const outcome = await tv.handleTravelVoiceMessage(
    { id: 'w1', from: '34600111222', type: 'text', text: 'Hola!', mediaId: null, phoneNumberId: '222' },
    { anthropic, phoneNumberId: '222' }
  );

  assert.deepEqual(outcome, { stage: 'greeted', language: 'es' });
  assert.equal(sent[0].text.body, languages.localized('greeting', 'es'));
  assert.equal(tv.recentTravelVoiceTurns()[0].stage, 'greeted');
});

test('the handoff commands parse a number and, for SAY, the message after it', () => {
  assert.deepEqual(parse('TRAVEL HANDOFFS'), { kind: 'handoffs' });
  assert.deepEqual(parse('travel humans'), { kind: 'handoffs' });
  assert.deepEqual(parse('TRAVEL SAY +34 600 111 222 Le llamo en cinco minutos'), { kind: 'say', number: '+34 600 111 222', text: 'Le llamo en cinco minutos' });
  assert.deepEqual(parse('travel say 34600111222: ok, un momento'), { kind: 'say', number: '34600111222', text: 'ok, un momento' });
  assert.deepEqual(parse('TRAVEL TAKE +34600111222'), { kind: 'take', number: '+34600111222' });
  assert.deepEqual(parse('TRAVEL RESUME 34600111222'), { kind: 'resume', number: '34600111222' });
  assert.equal(parse('travel say hello there'), null, 'no number, no command');
});

