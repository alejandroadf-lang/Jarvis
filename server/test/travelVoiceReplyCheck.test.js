// Checking the advisor's own answer before the caller hears it.
//
// Two failure modes, treated differently on purpose: a wrong-language reply
// is a total loss and worth a second call, an overlong one is fine in text
// and only needs cutting in audio. What is pinned hardest here is the
// reluctance — the language check must stay silent on anything it cannot
// judge, because a false positive doubles the wait on a phone.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let check;
let advisor;
let speech;
let spend;
const saved = {};
const KEYS = [
  'TRAVEL_VOICE_SPOKEN_MAX_WORDS',
  'TRAVEL_VOICE_LANGUAGE_RETRY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DAILY_SPEND_CAP_USD',
];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-travel-check-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  check = await import('../travelVoice/replyCheck.js');
  advisor = await import('../travelVoice/advisor.js');
  speech = await import('../travelVoice/speech.js');
  spend = await import('../spend.js');
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
  process.env.ANTHROPIC_API_KEY = 'an-key';
});

const SPANISH_ANSWER =
  'Para valorar el PNR con la tarifa más baja, utilice FXB. Eso vuelve a reservar el itinerario en las clases más económicas que hay disponibles y crea el TST. Si no quiere cambiar las clases, utilice FXP con lo que ya está reservado.';
const ENGLISH_ANSWER =
  'To price the booking with the lowest fare, use FXB. That rebooks the itinerary into the cheapest classes that are still available and creates the TST. If you do not want to change the classes, use FXP with what is already booked.';

// --- the checks -------------------------------------------------------------

test('an answer in the language that was asked for passes', () => {
  const result = check.checkReply(SPANISH_ANSWER, { language: 'es' });
  assert.equal(result.drifted, false);
  assert.equal(result.detected, 'es');
  assert.equal(result.tooLong, false);
  assert.ok(result.words > 20);
});

test('an English answer to a Spanish caller is caught', () => {
  const result = check.checkReply(ENGLISH_ANSWER, { language: 'es' });
  assert.equal(result.drifted, true);
  assert.equal(result.detected, 'en');
});

test('a French caller answered in Spanish is caught, and vice versa', () => {
  assert.equal(check.checkReply(SPANISH_ANSWER, { language: 'fr' }).drifted, true);
  assert.equal(
    check.checkReply(
      "Pour valoriser le dossier avec le tarif le plus bas, utilisez FXB. Cela remet l'itinéraire dans les classes les moins chères qui sont encore disponibles et crée le TST.",
      { language: 'es' }
    ).drifted,
    true
  );
});

test('an answer that is mostly entries and codes is left alone, not guessed at', () => {
  // The common shape of the shortest, best answers. There is no language
  // here to detect, and a retry would be a wasted call and a longer wait.
  for (const reply of ['FXP', 'RT ABC123, then TTP/RT.', 'MAD CDG 25DEC, FQN1*16']) {
    const result = check.checkReply(reply, { language: 'es' });
    assert.equal(result.drifted, false, reply);
  }
});

test('a short reply is never judged on one stray word', () => {
  // "no" and "very" are English markers and also ordinary Spanish; one or
  // two hits is not evidence of anything.
  assert.equal(check.checkReply('No.', { language: 'es' }).drifted, false);
  assert.equal(check.checkReply('Sí, con FXP.', { language: 'en' }).drifted, false);
  assert.equal(check.checkReply('', { language: 'es' }).drifted, false);
});

test('length is measured against a configurable ceiling', () => {
  const long = Array.from({ length: 300 }, () => 'palabra').join(' ');
  assert.equal(check.checkReply(long, { language: 'es' }).tooLong, true);
  assert.equal(check.checkReply(SPANISH_ANSWER, { language: 'es' }).tooLong, false);

  process.env.TRAVEL_VOICE_SPOKEN_MAX_WORDS = '10';
  assert.equal(check.checkReply(SPANISH_ANSWER, { language: 'es' }).tooLong, true);
});

test('the correction is written in the target language first', () => {
  assert.match(check.correctionPrompt('es'), /no estaba en español/);
  assert.match(check.correctionPrompt('es'), /Answer in Spanish/);
  assert.match(check.correctionPrompt('fr'), /pas en français/);
  assert.match(check.correctionPrompt('en'), /not in English/);
});

// --- trimming ---------------------------------------------------------------

test('an overlong spoken reply is cut at a sentence end, never mid-word', () => {
  const text = 'Uno dos tres. Cuatro cinco seis. Siete ocho nueve. Diez once doce.';
  const trimmed = check.trimToSentence(text, 7);
  assert.equal(trimmed, 'Uno dos tres. Cuatro cinco seis.');
  assert.ok(trimmed.endsWith('.'), 'it sounds finished');
});

test('a short reply passes through untouched', () => {
  assert.equal(check.trimToSentence(SPANISH_ANSWER, 500), SPANISH_ANSWER);
});

test('one sentence longer than the whole budget is spoken rather than dropped', () => {
  const single = Array.from({ length: 50 }, () => 'palabra').join(' ') + '.';
  assert.equal(check.trimToSentence(single, 10), single);
});

test('speakable trims by default and speaks everything when asked to', () => {
  const long = Array.from({ length: 60 }, () => 'palabra').join(' ') + '. Final.';
  process.env.TRAVEL_VOICE_SPOKEN_MAX_WORDS = '20';
  assert.ok(speech.speakable(long).length < long.length, 'the advisor is cut');
  assert.equal(speech.speakable(long, { maxWords: Infinity }), long, "the founder's own words are not");
});

// --- the retry --------------------------------------------------------------

function stubClient(replies) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push({ ...request, messages: [...request.messages] });
        const text = replies.shift();
        if (text === undefined) throw new Error('no more stubbed replies');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 20, output_tokens: 10 } };
      },
    },
  };
}

test('a drifted answer is asked again and the corrected one is what comes back', async () => {
  const client = stubClient([ENGLISH_ANSWER, SPANISH_ANSWER]);
  const result = await advisor.runAdvisorTurn({ anthropic: client, text: '¿Cómo valoro el PNR?', language: 'es' });

  assert.equal(client.calls.length, 2, 'one answer, one correction');
  assert.equal(result.reply, SPANISH_ANSWER, 'the caller hears the Spanish one');
  assert.deepEqual(result.drift, { detected: 'en', corrected: true, stillDrifted: false });

  const correction = client.calls[1].messages[client.calls[1].messages.length - 1];
  assert.equal(correction.role, 'user');
  assert.match(correction.content, /no estaba en español/);
  assert.equal(client.calls[1].tools, undefined, 'no tool round on a rewrite');
  assert.equal(result.usage.inputTokens, 40, 'both calls are billed');
});

test('an answer already in the right language costs exactly one call', async () => {
  const client = stubClient([SPANISH_ANSWER]);
  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'x', language: 'es' });
  assert.equal(client.calls.length, 1);
  assert.equal(result.drift, null);
  assert.equal(result.tooLong, false);
  assert.ok(result.words > 20);
});

test('a correction that drifts again is still used, and says so', async () => {
  const client = stubClient([ENGLISH_ANSWER, ENGLISH_ANSWER]);
  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'x', language: 'es' });
  assert.equal(client.calls.length, 2, 'it is asked once, not until it gives in');
  assert.equal(result.reply, ENGLISH_ANSWER, 'a wrong-language answer beats no answer');
  assert.equal(result.drift.corrected, false);
  assert.equal(result.drift.stillDrifted, true);
});

test('a correction that cannot run leaves the first answer intact and names the reason', async () => {
  // A cap set just above what has been spent so far: the first call clears
  // it, and its own cost puts the correction over. Read rather than
  // hard-coded, because the tests above have already spent some of the day.
  process.env.DAILY_SPEND_CAP_USD = String(spend.getSpendToday() + 0.00001);
  const client = stubClient([ENGLISH_ANSWER, SPANISH_ANSWER]);
  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'x', language: 'es' });

  assert.equal(result.reply, ENGLISH_ANSWER, 'the answer survives the failed retry');
  assert.equal(client.calls.length, 1, 'the correction never reached the model');
  assert.equal(result.drift.corrected, false);
  assert.match(result.drift.error, /daily spend cap/);
});

test('the retry can be switched off for a deployment that would rather pay once', async () => {
  process.env.TRAVEL_VOICE_LANGUAGE_RETRY = 'false';
  const client = stubClient([ENGLISH_ANSWER]);
  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'x', language: 'es' });
  assert.equal(client.calls.length, 1);
  assert.equal(result.drift, null, 'nothing was corrected, so nothing is claimed');
  assert.equal(result.reply, ENGLISH_ANSWER);
});

test('an overlong answer is reported but never retried', async () => {
  process.env.TRAVEL_VOICE_SPOKEN_MAX_WORDS = '10';
  const client = stubClient([SPANISH_ANSWER]);
  const result = await advisor.runAdvisorTurn({ anthropic: client, text: 'x', language: 'es' });
  assert.equal(client.calls.length, 1, 'the words are fine, only the audio is long');
  assert.equal(result.tooLong, true);
  assert.equal(result.drift, null);
});
