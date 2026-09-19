// Benchmark the ears on your own audio, not the vendor's.
//
// Every published word-error rate is on somebody else's audio: read
// speech, clean rooms, English. What matters here is a Spanish agent on
// a bad line in a busy office saying a locator, and the only way to know
// which ear hears that best is to record some and count. So: a folder of
// voice notes with a reference transcript beside each, every configured
// ear run over all of them, and three numbers per ear per language —
// word error rate, chrF, and the entity error rate, which is the one that
// matters for a locator.
//
//   fixtures/
//     es-locator-01.ogg
//     es-locator-01.txt      "no me valora el localizador X7K2PQ"
//     fr-refund-01.ogg
//     fr-refund-01.txt
//
// The language is the first two letters of the filename. Run with
// `npm run travel:bench -- path/to/fixtures`.

import fs from 'node:fs';
import path from 'node:path';
import { EARS } from '../providers/stt.js';
import { codesIn } from '../translate.js';
import { normalizeLanguage } from '../languages.js';

// --- the measures ---------------------------------------------------------------

// Case, punctuation and accents are not errors for this purpose: "cómo"
// heard as "como" is a transcript an agent can act on. Letters are.
function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein distance on token arrays: substitutions, insertions, deletions. */
export function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    for (let j = 1; j < cols; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[cols - 1];
}

/** Word error rate: edits over reference words. */
export function wordErrorRate(reference, hypothesis) {
  const ref = tokens(reference);
  const hyp = tokens(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  return editDistance(ref, hyp) / ref.length;
}

function charNgrams(text, n) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = new Map();
  for (let i = 0; i + n <= s.length; i++) {
    const g = s.slice(i, i + n);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  return grams;
}

/**
 * chrF (character n-gram F-score, n = 1..6, β = 2), the metric the
 * translation people use because it survives inflection and spelling
 * variants that a word match does not. 0 to 1.
 */
export function chrF(reference, hypothesis, { maxN = 6, beta = 2 } = {}) {
  let precision = 0;
  let recall = 0;
  let counted = 0;
  for (let n = 1; n <= maxN; n++) {
    const ref = charNgrams(reference, n);
    const hyp = charNgrams(hypothesis, n);
    const refTotal = [...ref.values()].reduce((a, b) => a + b, 0);
    const hypTotal = [...hyp.values()].reduce((a, b) => a + b, 0);
    if (!refTotal || !hypTotal) continue;
    let matched = 0;
    for (const [g, c] of hyp) matched += Math.min(c, ref.get(g) || 0);
    precision += matched / hypTotal;
    recall += matched / refTotal;
    counted += 1;
  }
  if (!counted) return 0;
  precision /= counted;
  recall /= counted;
  if (!precision && !recall) return 0;
  const b2 = beta * beta;
  return ((1 + b2) * precision * recall) / (b2 * precision + recall);
}

/**
 * Entity error rate: of the codes in the reference (locators, IATA codes,
 * entries, ticket numbers), the share missing from the hypothesis. This
 * is the number for a GDS helpdesk; a transcript can be 95% right by
 * words and 100% wrong by locator.
 */
export function entityErrorRate(reference, hypothesis) {
  const expected = codesIn(reference);
  if (!expected.length) return null;
  const heard = new Set(codesIn(hypothesis).map((c) => c.toUpperCase()));
  const missed = expected.filter((c) => !heard.has(c.toUpperCase()));
  return missed.length / expected.length;
}

// --- the fixtures ---------------------------------------------------------------

const AUDIO = new Set(['.ogg', '.opus', '.mp3', '.m4a', '.wav', '.webm']);

export function loadFixtures(dir) {
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const ext = path.extname(file).toLowerCase();
    if (!AUDIO.has(ext)) continue;
    const base = file.slice(0, -ext.length);
    const refPath = path.join(dir, `${base}.txt`);
    if (!fs.existsSync(refPath)) continue;
    const language = normalizeLanguage(base.slice(0, 2));
    out.push({ id: base, file: path.join(dir, file), language, reference: fs.readFileSync(refPath, 'utf8').trim() });
  }
  return out;
}

// --- the run --------------------------------------------------------------------------

/**
 * Runs every configured ear (or the ones named) over the fixtures.
 * `transcribe` is injectable so the scoring can be tested without audio.
 */
export async function runBench(fixtures, { ears = EARS.filter((e) => e.configured()), transcribe = null, log = () => {} } = {}) {
  const rows = [];
  for (const ear of ears) {
    for (const fx of fixtures) {
      const startedAt = Date.now();
      let text = '';
      let error = null;
      let costUsd = 0;
      try {
        const audio = transcribe ? null : fs.readFileSync(fx.file);
        const result = transcribe
          ? await transcribe(ear, fx)
          : await ear.transcribe(audio, { filename: path.basename(fx.file), languageHint: fx.language });
        text = result.text || '';
        costUsd = result.costUsd || 0;
      } catch (err) {
        error = err.message;
      }
      const row = {
        ear: ear.id,
        fixture: fx.id,
        language: fx.language,
        ms: Date.now() - startedAt,
        costUsd,
        error,
        wer: error ? null : wordErrorRate(fx.reference, text),
        chrf: error ? null : chrF(fx.reference, text),
        eer: error ? null : entityErrorRate(fx.reference, text),
        hypothesis: text,
      };
      rows.push(row);
      log(`${ear.id.padEnd(11)} ${fx.id.padEnd(22)} ${error ? `ERROR ${error}` : `WER ${(row.wer * 100).toFixed(1).padStart(5)}%  chrF ${(row.chrf * 100).toFixed(1).padStart(5)}  EER ${row.eer === null ? '  n/a' : `${(row.eer * 100).toFixed(0).padStart(3)}%`}  ${row.ms}ms`}`);
    }
  }
  return { rows, table: aggregate(rows) };
}

/** Per ear, per language: mean WER, chrF, EER, latency and cost. */
export function aggregate(rows) {
  const table = {};
  for (const row of rows) {
    if (row.error) continue;
    const key = `${row.ear}/${row.language || '??'}`;
    const b = table[key] || (table[key] = { ear: row.ear, language: row.language, n: 0, wer: 0, chrf: 0, eer: 0, eerN: 0, ms: 0, costUsd: 0 });
    b.n += 1;
    b.wer += row.wer;
    b.chrf += row.chrf;
    if (row.eer !== null) {
      b.eer += row.eer;
      b.eerN += 1;
    }
    b.ms += row.ms;
    b.costUsd += row.costUsd;
  }
  for (const b of Object.values(table)) {
    b.wer /= b.n;
    b.chrf /= b.n;
    b.eer = b.eerN ? b.eer / b.eerN : null;
    b.ms = Math.round(b.ms / b.n);
  }
  return table;
}

export function formatTable(table) {
  const lines = ['ear         lang   n   WER     chrF    EER     ms     $'];
  for (const b of Object.values(table).sort((a, c) => `${a.language}${a.wer}`.localeCompare(`${c.language}${c.wer}`))) {
    lines.push(
      `${b.ear.padEnd(11)} ${String(b.language || '??').padEnd(6)} ${String(b.n).padStart(2)}  ${(b.wer * 100).toFixed(1).padStart(5)}%  ${(b.chrf * 100).toFixed(1).padStart(5)}  ${b.eer === null ? '  n/a ' : `${(b.eer * 100).toFixed(0).padStart(4)}% `} ${String(b.ms).padStart(5)}  ${b.costUsd.toFixed(4)}`
    );
  }
  return lines.join('\n');
}
