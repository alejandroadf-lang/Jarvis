// The keypad language menu.
//
// Off unless two or more languages are configured, because one language is
// not a choice. Everything else here guards the two ways a menu goes wrong
// on a phone: offering something the caller cannot pick ("For undefined,
// press 3") and punishing a press the menu did not list.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  menuLanguages,
  isLanguageMenuEnabled,
  chosenLanguage,
  languageMenuTwiml,
  describeLanguageMenu,
} from '../realtime/languageMenu.js';

let saved;
beforeEach(() => { saved = process.env.CALL_LANGUAGES; });
afterEach(() => {
  if (saved === undefined) delete process.env.CALL_LANGUAGES;
  else process.env.CALL_LANGUAGES = saved;
});

test('unset means English, French and Spanish, in that order', () => {
  // The three the founder asked for by name. The order is the digits callers
  // learn, so it is fixed here rather than sorted.
  delete process.env.CALL_LANGUAGES;
  assert.deepEqual(menuLanguages(), ['English', 'French', 'Spanish']);
  assert.equal(isLanguageMenuEnabled(), true);
  assert.equal(chosenLanguage('2'), 'French');
});

test('off, or one language, is no menu at all', () => {
  process.env.CALL_LANGUAGES = 'off';
  assert.deepEqual(menuLanguages(), []);
  assert.equal(isLanguageMenuEnabled(), false);
  assert.equal(describeLanguageMenu(), '');

  process.env.CALL_LANGUAGES = 'en';
  assert.equal(isLanguageMenuEnabled(), false, 'a menu with one option is a delay with a prompt');
});

test('codes, names and tags are all accepted; unknowns and duplicates are dropped', () => {
  process.env.CALL_LANGUAGES = 'en, Spanish, fr-CA, xx, es, thai';
  assert.deepEqual(menuLanguages(), ['English', 'Spanish', 'French', 'Thai']);
  assert.equal(isLanguageMenuEnabled(), true);
});

test('the keypad has nine digits that choose, so the menu stops at nine', () => {
  process.env.CALL_LANGUAGES = 'en,es,fr,de,it,pt,nl,th,zh,ja,ko';
  assert.equal(menuLanguages().length, 9);
  assert.equal(chosenLanguage('9'), 'Chinese');
});

test('a digit picks by position; anything else means the default, silently', () => {
  process.env.CALL_LANGUAGES = 'en,es,fr';
  assert.equal(chosenLanguage('1'), 'English');
  assert.equal(chosenLanguage('3'), 'French');
  assert.equal(chosenLanguage('4'), '', 'off the menu');
  assert.equal(chosenLanguage('0'), '', '0 is left for reaching a person');
  assert.equal(chosenLanguage(''), '', 'pressed nothing');
  assert.equal(chosenLanguage('12'), '');
  assert.equal(chosenLanguage(undefined), '');
});

test('the TwiML gathers one digit, speaks each line in its own language, and falls through to the default', () => {
  process.env.CALL_LANGUAGES = 'en,th,sv';
  const xml = languageMenuTwiml({ host: 'jarvis.example.com' });
  assert.match(xml, /<Gather input="dtmf" numDigits="1" timeout="\d+" action="https:\/\/jarvis\.example\.com\/api\/calls\/language" method="POST">/);
  assert.match(xml, /<Say language="en-US">For English, press 1\.<\/Say>/);
  assert.match(xml, /<Say language="th-TH">สำหรับภาษาไทย กด 2<\/Say>/, 'spoken in Thai by a Thai voice');
  assert.match(xml, /<Say language="sv-SE">För svenska, tryck 3\.<\/Say>/);
  // No digit within the timeout: the same endpoint, no Digits, default language.
  assert.match(xml, /<\/Gather><Redirect method="POST">https:\/\/jarvis\.example\.com\/api\/calls\/language<\/Redirect>/);
  assert.doesNotMatch(xml, /<Stream/, 'the model session does not open until the choice is made');
});

test('a language with no scripted line is still offered, in English', () => {
  process.env.CALL_LANGUAGES = 'en,vi';
  const xml = languageMenuTwiml({ host: 'h' });
  assert.match(xml, /<Say language="en-US">For Vietnamese, press 2\.<\/Say>/);
});

test('the founder can read the menu back in one clause', () => {
  process.env.CALL_LANGUAGES = 'es,en';
  assert.equal(describeLanguageMenu(), 'Callers first pick a language on the keypad: 1 for Spanish, 2 for English.');
});
