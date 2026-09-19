// The ears benchmark: the three measures, and a run with a fake transcriber.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editDistance, wordErrorRate, chrF, entityErrorRate, loadFixtures, runBench, aggregate, formatTable } from '../travelVoice/bench/stt.js';

test('word error rate counts substitutions, insertions and deletions over the reference', () => {
  assert.equal(editDistance(['a', 'b', 'c'], ['a', 'x', 'c']), 1);
  assert.equal(wordErrorRate('no me valora el localizador', 'no me valora el localizador'), 0);
  assert.equal(wordErrorRate('no me valora el localizador', 'no valora el localizador'), 0.2, 'one deletion in five');
  assert.equal(wordErrorRate('a b c d', 'a b c d e f'), 0.5, 'insertions count too');
  assert.equal(wordErrorRate('', 'x'), 1);
  assert.equal(wordErrorRate('¿Cómo emito?', 'como emito'), 0, 'punctuation and case are not errors');
});

test('chrF rewards near-misses that a word match would not', () => {
  assert.ok(chrF('localizador', 'localizador') > 0.99);
  const near = chrF('el localizador no valora', 'el localisador no valora');
  const far = chrF('el localizador no valora', 'the booking will not price');
  assert.ok(near > 0.7 && near < 1, `near miss scores ${near}`);
  assert.ok(far < 0.2, `unrelated scores ${far}`);
  assert.equal(chrF('', ''), 0);
});

test('the entity error rate is the share of codes the ear lost', () => {
  assert.equal(entityErrorRate('locator X7K2PQ flight IB3402 MAD CDG', 'locator X7K2PQ flight IB3402 MAD CDG'), 0);
  assert.equal(entityErrorRate('locator X7K2PQ flight IB3402 MAD CDG', 'locator X7 K2 PQ flight IB3402 MAD CDG'), 0.25, 'one of four');
  assert.equal(entityErrorRate('no codes here at all', 'anything'), null);
});

test('fixtures pair audio with a reference and take the language from the name; a run scores every ear', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bench-'));
  fs.writeFileSync(path.join(dir, 'es-locator-01.ogg'), 'OggS');
  fs.writeFileSync(path.join(dir, 'es-locator-01.txt'), 'no me valora el localizador X7K2PQ\n');
  fs.writeFileSync(path.join(dir, 'fr-refund-01.ogg'), 'OggS');
  fs.writeFileSync(path.join(dir, 'fr-refund-01.txt'), 'remboursement du dossier ABC123');
  fs.writeFileSync(path.join(dir, 'orphan.ogg'), 'OggS');
  const fixtures = loadFixtures(dir);
  assert.deepEqual(fixtures.map((f) => [f.id, f.language]), [['es-locator-01', 'es'], ['fr-refund-01', 'fr']]);

  const ears = [
    { id: 'sharp', configured: () => true },
    { id: 'deaf', configured: () => true },
  ];
  const transcribe = async (ear, fx) => {
    if (ear.id === 'deaf' && fx.language === 'fr') throw new Error('boom');
    return { text: ear.id === 'sharp' ? fx.reference : fx.reference.replace(/X7K2PQ/, 'X7 K2 PQ').replace('valora', 'balora'), costUsd: 0.001 };
  };
  const lines = [];
  const { rows, table } = await runBench(fixtures, { ears, transcribe, log: (l) => lines.push(l) });
  assert.equal(rows.length, 4);
  assert.equal(table['sharp/es'].wer, 0);
  assert.equal(table['sharp/es'].eer, 0);
  assert.equal(table['deaf/es'].eer, 1, 'the locator was lost');
  assert.ok(table['deaf/es'].wer > 0);
  assert.equal(table['deaf/fr'], undefined, 'an error is not a score');
  assert.ok(rows.find((r) => r.ear === 'deaf' && r.language === 'fr').error);
  const text = formatTable(aggregate(rows));
  assert.match(text, /^ear\s+lang\s+n\s+WER/);
  assert.match(text, /sharp\s+es\s+1\s+0\.0%/);
  assert.ok(lines.some((l) => /ERROR boom/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
});
