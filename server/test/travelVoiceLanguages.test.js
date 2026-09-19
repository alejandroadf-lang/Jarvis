// Language is the first thing a voice product has to get right: a reply in
// the wrong language is thirty seconds of noise on a phone. What's pinned
// here is the order of trust (chosen, heard, guessed, previous, default) and
// that the guess says "don't know" rather than picking a side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLanguage,
  guessLanguage,
  resolveLanguage,
  requestedLanguageSwitch,
  localized,
  SUPPORTED_LANGUAGES,
} from '../travelVoice/languages.js';

test('exactly three languages, and codes, locales and Whisper names all normalise to them', () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, ['es', 'fr', 'en']);
  assert.equal(normalizeLanguage('es'), 'es');
  assert.equal(normalizeLanguage('fr-CA'), 'fr');
  assert.equal(normalizeLanguage('en_GB'), 'en');
  assert.equal(normalizeLanguage('Spanish'), 'es');
  assert.equal(normalizeLanguage('french'), 'fr');
  assert.equal(normalizeLanguage('portuguese'), null, 'a fourth language is unknown, not the nearest one');
  assert.equal(normalizeLanguage(''), null);
  assert.equal(normalizeLanguage(undefined), null);
});

test('the word heuristic tells the three apart on ordinary sentences', () => {
  assert.equal(guessLanguage('Hola, necesito el precio de un vuelo de Madrid a París para mañana').language, 'es');
  assert.equal(guessLanguage("Bonjour, je voudrais le tarif d'un vol de Paris à Madrid pour demain").language, 'fr');
  assert.equal(guessLanguage('Hi, I need the fare for a flight from Madrid to Paris tomorrow').language, 'en');
});

test('a string of codes is unknown rather than a coin toss', () => {
  const guess = guessLanguage('MAD CDG 25DEC FXP');
  assert.equal(guess.language, null);
  assert.equal(guess.confidence, 0);
});

test('a dead heat between two languages is not a detection', () => {
  // "la" scores for both Spanish and French; nothing breaks the tie.
  assert.equal(guessLanguage('la PNR').language, null);
});

test('what the caller chose beats what the transcriber heard', () => {
  const r = resolveLanguage({ chosen: 'fr', heard: 'spanish', text: 'hola necesito ayuda con la reserva' });
  assert.deepEqual(r, { language: 'fr', source: 'chosen' });
});

test('what the transcriber heard beats the word guess', () => {
  const r = resolveLanguage({ heard: 'french', text: 'ok' });
  assert.deepEqual(r, { language: 'fr', source: 'heard' });
});

test('a weak guess does not flip a conversation out of its previous language', () => {
  // One Spanish-looking token in a short message, mid-way through an
  // English conversation: stay in English.
  const r = resolveLanguage({ text: 'ok la', previous: 'en' });
  assert.equal(r.language, 'en');
  assert.equal(r.source, 'previous');
});

test('a strong guess wins over the previous turn', () => {
  const r = resolveLanguage({ text: 'Merci, et pour le billet je voudrais aussi le tarif pour un enfant', previous: 'en' });
  assert.deepEqual(r, { language: 'fr', source: 'guessed' });
});

test('nothing at all falls back to English', () => {
  assert.deepEqual(resolveLanguage({ text: 'MAD CDG' }), { language: 'en', source: 'default' });
});

test('asking to switch language is honoured, in any of the three', () => {
  assert.equal(requestedLanguageSwitch('Can you continue in French please?'), 'fr');
  assert.equal(requestedLanguageSwitch('¿Puedes hablar en inglés?'), 'en');
  assert.equal(requestedLanguageSwitch('Parlez espagnol s’il vous plaît'), 'es');
  assert.equal(requestedLanguageSwitch('Continue in Spanish'), 'es');
  assert.equal(requestedLanguageSwitch('What is the fare in euros?'), null);
});

test('every plumbing message exists in all three languages', () => {
  for (const key of ['greeting', 'emptyVoiceNote', 'transcriptionFailed', 'answerFailed', 'rateLimited', 'unsupportedType', 'liveCallUnavailable', 'callPermissionIntro', 'demoModeOn', 'demoModeOff']) {
    const es = localized(key, 'es');
    const fr = localized(key, 'fr');
    const en = localized(key, 'en');
    assert.ok(es && fr && en, `${key} missing a language`);
    assert.notEqual(es, en, `${key} not translated to Spanish`);
    assert.notEqual(fr, en, `${key} not translated to French`);
  }
  assert.equal(localized('greeting', 'pt'), localized('greeting', 'en'), 'unknown language falls back to English');
  assert.throws(() => localized('nope', 'en'), /No localized string/);
});

test('a country code is a language hint for the moment before anything is heard', async () => {
  const { languageFromNumber } = await import('../travelVoice/languages.js');
  assert.equal(languageFromNumber('+34 600 111 222'), 'es');
  assert.equal(languageFromNumber('5215512345678'), 'es', 'Mexico');
  assert.equal(languageFromNumber('33612345678'), 'fr');
  assert.equal(languageFromNumber('2250700000000'), 'fr', "Côte d'Ivoire");
  assert.equal(languageFromNumber('447700900123'), 'en');
  assert.equal(languageFromNumber('12125551234'), 'en', 'a bare 1 is North America');
  assert.equal(languageFromNumber('18095551234'), 'es', 'but the Dominican Republic is Spanish');
  assert.equal(languageFromNumber('4915112345678'), null, 'Germany is none of the three');
  assert.equal(languageFromNumber(''), null);
});

