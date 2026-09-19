// Money the advisor did not get from anywhere: finding amounts in a reply
// and checking each against the turn's tool results and the caller's words.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountsIn, amountValue, groundingCheck, groundingCorrectionPrompt } from '../travelVoice/grounding.js';

test('amounts are found in every way the three languages write them', () => {
  const found = amountsIn('Cuesta €189.40, o 1.234,50 € en business, EUR 35 de tasa, 12 euros de gestión y $99. Vuelo IB3402 el 2026-10-01.');
  assert.deepEqual(found.map((a) => a.value).sort((a, b) => a - b), [12, 35, 99, 189.4, 1234.5]);
  assert.deepEqual(amountsIn('Use FXP on line 2, category 16'), [], 'numbers that are not money are ignored');
  assert.equal(amountValue('1,234.50'), 1234.5);
  assert.equal(amountValue('1.234,50'), 1234.5);
  assert.equal(amountValue('300'), 300);
});

test('an amount is grounded by a tool result or by the caller, in any notation', () => {
  const tool = JSON.stringify([{ price: { total: '189.40', currency: 'EUR' } }]);
  assert.deepEqual(groundingCheck('The cheapest is 189,40 € with Iberia', { toolOutputs: [tool] }).ungrounded, []);
  assert.deepEqual(groundingCheck('The fee is 300 euros', { callerText: ['the client paid €300'] }).ungrounded, []);
  const bad = groundingCheck('The fee is 150 euros and the fare 189.40 EUR', { toolOutputs: [tool] });
  assert.deepEqual(bad.ungrounded.map((a) => a.text), ['150 euros']);
});

test('the correction is written in the language of the answer', () => {
  assert.match(groundingCorrectionPrompt('es', [{ value: 150, text: '150 euros' }]), /^Tu respuesta anterior cita importes \(150 euros\)/);
  assert.match(groundingCorrectionPrompt('fr', [{ value: 150, text: '150 €' }]), /^Votre réponse précédente/);
  assert.match(groundingCorrectionPrompt('en', [{ value: 150, text: '€150' }]), /Answer in English only/);
});
