// The spoken form of a written reply: codes spelled, locators read back in
// the caller's spelling alphabet, prices and dates said the way the language
// says them. The written twin is never touched, which is what the tests on
// the orchestrator check; these check the derivation itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spellOut, letterByLetter, readBack, readBackCodes, spokenForm, __testing } from '../travelVoice/spoken.js';

test('a locator is spelled in the spelling alphabet of the language', () => {
  assert.equal(spellOut('X7K2PQ', 'es'), 'X de Xiquena, 7, K de Kilo, 2, P de París, Q de Querido');
  assert.equal(spellOut('X7K2PQ', 'fr'), 'X comme Xavier, 7, K comme Kléber, 2, P comme Pierre, Q comme Quintal');
  assert.equal(spellOut('X7K2PQ', 'en'), 'X for X-ray, 7, K for Kilo, 2, P for Papa, Q for Quebec');
  assert.equal(spellOut('mad', 'en'), 'M for Mike, A for Alfa, D for Delta', 'case does not matter');
});

test('every letter of every alphabet is covered', () => {
  for (const [language, alphabet] of Object.entries(__testing.ALPHABETS)) {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.ok(alphabet[letter], `${language} has no word for ${letter}`);
  }
});

test('read-back finds locators and ticket numbers but not airport codes', () => {
  assert.deepEqual(readBackCodes('El PNR es X7K2PQ, vuelo MAD CDG'), ['X7K2PQ']);
  assert.deepEqual(readBackCodes('billete 075-1234567890 del dossier ABCDEF'), ['ABCDEF', '075-1234567890']);
  assert.deepEqual(readBackCodes('vuelo de MAD a CDG mañana'), [], 'airport codes are not read back');
  assert.deepEqual(readBackCodes('MADRID es la ciudad'), [], 'a six-letter word with no cue is not a locator');
});

test('the read-back line is spoken in the alphabet and written as heard', () => {
  const line = readBack('¿Puedes ver el localizador X7K2PQ?', 'es');
  assert.deepEqual(line.codes, ['X7K2PQ']);
  assert.equal(line.spoken, 'He entendido: Localizador X de Xiquena, 7, K de Kilo, 2, P de París, Q de Querido.');
  assert.equal(line.written, 'He entendido — Localizador: X7K2PQ');
  assert.equal(readBack('rien à lire', 'fr'), null);
  const fr = readBack('le dossier ABCDEF', 'fr');
  assert.match(fr.spoken, /^J'ai compris: Dossier A comme Anatole/);
});

test('prices are said with their currency and cents in each language', () => {
  assert.equal(spokenForm('cuesta €1,234.50', 'es'), 'cuesta 1234 euros con 50 céntimos');
  assert.equal(spokenForm('cuesta 1.234,50 €', 'es'), 'cuesta 1234 euros con 50 céntimos');
  assert.equal(spokenForm('coûte 89,00 €', 'fr'), 'coûte 89 euros');
  assert.equal(spokenForm('coûte EUR 89.90', 'fr'), 'coûte 89 euros 90');
  assert.equal(spokenForm('costs $1 and 210 USD', 'en'), 'costs 1 dollar and 210 dollars');
  assert.equal(spokenForm('fee of 35 GBP', 'en'), 'fee of 35 pounds');
});

test('ISO and Amadeus dates become spoken dates', () => {
  assert.equal(spokenForm('sale el 2026-09-19', 'es'), 'sale el 19 de septiembre de 2026');
  assert.equal(spokenForm('départ le 2026-03-01', 'fr'), 'départ le 1er mars 2026');
  assert.equal(spokenForm('on 2026-12-25', 'en'), 'on 25 December 2026');
  assert.equal(spokenForm('AN25DECMADCDG is the entry', 'en'), 'A-N-2-5-D-E-C-M-A-D-C-D-G is the entry', 'an entry stays an entry');
  assert.equal(spokenForm('la fecha 25DEC', 'es'), 'la fecha 25 de diciembre');
  assert.equal(spokenForm('TKTL 25DEC26', 'fr'), 'T-K-T-L 25 décembre 2026');
});

test('codes are spelled letter by letter and locators in the alphabet', () => {
  assert.equal(spokenForm('vuelo IB3456 de MAD a CDG', 'es'), 'vuelo I-B 3 4 5 6 de M-A-D a C-D-G');
  assert.equal(spokenForm('use FXP then TTP', 'en'), 'use F-X-P then T-T-P');
  assert.equal(spokenForm('entry SS1Y2 and FQN1*16', 'en'), 'entry S-S-1-Y-2 and F-Q-N-1-*-1-6');
  assert.equal(spokenForm('locator X7K2PQ', 'en'), 'locator X for X-ray, 7, K for Kilo, 2, P for Papa, Q for Quebec');
  assert.equal(spokenForm('IATA rules and the BSP', 'en'), 'IATA rules and the BSP', 'pronounced acronyms stay words');
  assert.equal(spokenForm('ticket 075-1234567890', 'en'), 'ticket 0 7 5, 1 2 3 4 5 6 7 8 9 0');
});

test('French times are read as hours', () => {
  assert.equal(spokenForm('départ à 14:35 et 09:00', 'fr'), 'départ à 14 h 35 et 9 h');
  assert.equal(spokenForm('sale a las 14:35', 'es'), 'sale a las 14:35');
});

test('ordinary prose is left alone', () => {
  const es = 'Primero valore el PNR con la entrada, después emita. Si el cliente pide reembolso, compruebe la categoría 16.';
  assert.equal(spokenForm(es, 'es'), es.replace('PNR', 'P-N-R'));
  assert.equal(letterByLetter('CDG'), 'C-D-G');
  assert.deepEqual(__testing.parseAmount('1.234,50'), { whole: '1234', cents: '50' });
  assert.deepEqual(__testing.parseAmount('1,234'), { whole: '1234', cents: null });
});
