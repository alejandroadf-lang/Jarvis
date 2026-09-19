#!/usr/bin/env node
// npm run travel:bench -- path/to/fixtures [--ears deepgram,elevenlabs]
//
// Every configured ear over your own voice notes: word error rate, chrF
// and entity error rate per ear per language. See stt.js for the fixture
// layout. Costs transcription minutes and nothing else.

import 'dotenv/config';
import { EARS } from '../providers/stt.js';
import { loadFixtures, runBench, formatTable } from './stt.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) {
  console.error('usage: npm run travel:bench -- <fixtures dir> [--ears deepgram,elevenlabs]');
  process.exit(2);
}
const i = args.indexOf('--ears');
const wanted = i === -1 ? null : String(args[i + 1] || '').split(',').filter(Boolean);
const ears = EARS.filter((e) => e.configured() && (!wanted || wanted.includes(e.id)));
if (!ears.length) {
  console.error('No configured ear matches. Set OPENAI_API_KEY, ELEVENLABS_API_KEY, DEEPGRAM_API_KEY or ASSEMBLYAI_API_KEY.');
  process.exit(2);
}

const fixtures = loadFixtures(dir);
if (!fixtures.length) {
  console.error(`No fixtures in ${dir}: an audio file needs a .txt reference beside it, named ll-something.ogg with ll the language.`);
  process.exit(2);
}
console.log(`${fixtures.length} fixtures, ${ears.map((e) => e.id).join(', ')}\n`);
const { table } = await runBench(fixtures, { ears, log: (line) => console.log(line) });
console.log('');
console.log(formatTable(table));
