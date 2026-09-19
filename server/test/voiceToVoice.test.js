// Voice in, voice out, in the founder's own language.
//
// Half of this existed: a WhatsApp voice note was downloaded and transcribed,
// and the words reached the team. The other half did not. The only
// text-to-speech in the codebase lived in the browser client, unreachable from
// a webhook — so somebody who sent a voice note because their hands were full
// got a wall of text back. And nothing handled language at all: a Spanish voice
// note was answered in English, which is a translation nobody asked for,
// happening silently, in the wrong direction.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let speech;
let language;
let whatsapp;
let originalFetch;
const saved = {};
const KEYS = ['OPENAI_API_KEY', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'REPLY_LANGUAGE', 'VOICE_REPLY_MAX_CHARS'];

before(async () => {
  for (const key of KEYS) saved[key] = process.env[key];
  originalFetch = global.fetch;
  speech = await import('../speech.js');
  language = await import('../language.js');
  whatsapp = await import('../channels/whatsapp.js');
});

after(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  global.fetch = originalFetch;
});

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  global.fetch = originalFetch;
});

// --- Speaking -----------------------------------------------------------------------

test('speech is off until there is a key, and it says which one', () => {
  assert.equal(speech.isSpeechConfigured(), false);
  process.env.OPENAI_API_KEY = 'sk-test';
  assert.equal(speech.isSpeechConfigured(), true);
});

test('audio comes back as opus in ogg, which is what WhatsApp plays inline', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let sent;
  global.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('OggS-fake').buffer };
  };

  const result = await speech.synthesize('Two ventures shipped today.');
  assert.match(sent.url, /audio\/speech/);
  assert.equal(sent.body.response_format, 'opus', 'mp3 arrives as a file nobody opens');
  assert.equal(sent.body.input, 'Two ventures shipped today.');
  assert.equal(result.mimeType, 'audio/ogg');
  assert.ok(Buffer.isBuffer(result.buffer));
});

test('a synthesis failure carries its status rather than a generic error', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  await assert.rejects(() => speech.synthesize('hello'), (err) => err.status === 429);
});

test('there is nothing to say about nothing', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  await assert.rejects(() => speech.synthesize('   '), /Nothing to say/);
});

// A status report read aloud is unlistenable, and this company's replies run to
// thousands of characters.
test('a long reply is cut at a sentence, not mid-word', () => {
  const long = 'The first thing happened. The second thing happened too. '.repeat(30);
  const { text, truncated } = speech.spokenExcerpt(long, 120);
  assert.equal(truncated, true);
  assert.ok(text.endsWith('.'), `cut mid-sentence: "${text.slice(-30)}"`);
  assert.ok(text.length <= 120);
});

test('a short reply is spoken whole and not marked truncated', () => {
  const { text, truncated } = speech.spokenExcerpt('Two ventures shipped today.', 120);
  assert.equal(truncated, false);
  assert.equal(text, 'Two ventures shipped today.');
});

// One very long opening sentence would otherwise be cut to almost nothing by a
// strict sentence-boundary rule.
test('a reply with no sentence break still produces something sayable', () => {
  const { text } = speech.spokenExcerpt('word '.repeat(200), 120);
  assert.ok(text.length > 60, `got ${text.length} chars`);
});

test('the spoken length is tunable without a deploy', () => {
  process.env.VOICE_REPLY_MAX_CHARS = '50';
  assert.equal(speech.spokenLimit(), 50);
  process.env.VOICE_REPLY_MAX_CHARS = 'lots';
  assert.equal(speech.spokenLimit(), 700, 'garbage falls back rather than breaking the reply');
});

// --- Sending it -------------------------------------------------------------------------

test('audio is uploaded first, then sent by id, as a voice note', async () => {
  process.env.WHATSAPP_TOKEN = 'wa-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  const calls = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith('/media')) return { ok: true, json: async () => ({ id: 'media-99' }) };
    return { ok: true, json: async () => ({}) , body: init.body };
  };

  const ok = await whatsapp.sendWhatsAppAudio('+34600111222', Buffer.from('OggS'), {});
  assert.equal(ok, true);
  assert.match(calls[0], /\/media$/, 'bytes first');
  assert.match(calls[1], /\/messages$/, 'then the message that references them');
});

test('an upload that returns no id is an error, not a silent no-op', async () => {
  process.env.WHATSAPP_TOKEN = 'wa-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  await assert.rejects(() => whatsapp.uploadMedia(Buffer.from('x')), /returned no media id/);
});

test('with WhatsApp unconfigured nothing is attempted', async () => {
  assert.equal(await whatsapp.sendWhatsAppAudio('+34600111222', Buffer.from('x')), false);
  await assert.rejects(() => whatsapp.uploadMedia(Buffer.from('x')), /not configured/);
});

// --- Answering in the right language ------------------------------------------------------

test('a Spanish voice note is answered in Spanish', () => {
  const instruction = language.replyLanguageInstruction({ detected: 'es' });
  assert.match(instruction, /Reply in Spanish/);
  assert.match(instruction, /ventureIds exactly as they are/, 'ids and commands are not words to translate');
});

// The common case, and the one where saying anything would be tokens spent to
// change nothing.
test('an English question gets no language instruction at all', () => {
  assert.equal(language.replyLanguageInstruction({ detected: 'en' }), '');
  assert.equal(language.replyLanguageInstruction({ detected: '' }), '');
});

// A model told "reply in xx" will obey. Silence is safer than a guess.
test('a language this app cannot name produces silence, not a guess', () => {
  assert.equal(language.replyLanguageInstruction({ detected: 'zz' }), '');
  assert.equal(language.languageName('zz'), '');
});

test('REPLY_LANGUAGE pins one language whatever comes in — the translation case', () => {
  process.env.REPLY_LANGUAGE = 'es';
  const instruction = language.replyLanguageInstruction({ detected: 'en' });
  assert.match(instruction, /Reply in Spanish, whatever language/);
  assert.match(language.describeLanguageSetting(), /pinned to Spanish/);
});

test('mirror and auto both mean "do not pin"', () => {
  for (const value of ['mirror', 'auto', '']) {
    process.env.REPLY_LANGUAGE = value;
    assert.equal(language.pinnedLanguage(), '', `"${value}" should not pin`);
  }
  assert.match(language.describeLanguageSetting(), /mirror the language you use/);
});

test('a pinned language beats the detected one', () => {
  process.env.REPLY_LANGUAGE = 'fr';
  assert.match(language.replyLanguageInstruction({ detected: 'es' }), /Reply in French/);
});

test('language codes are matched case- and region-insensitively', () => {
  assert.equal(language.languageName('ES'), 'Spanish');
  assert.equal(language.languageName('pt-BR'), 'Portuguese');
  assert.equal(language.languageName('  de  '), 'German');
});
