// Every environment variable the server reads is listed in .env.example.
//
// CLAUDE.md asks for it ("Env vars get an entry in server/.env.example with a
// sentence on what breaks without them"), and the audit found it drifting:
// eleven variables read in code with no entry, among them the one that
// decides whether a view link in WhatsApp expires and the two that cap how
// often an agent may deploy without green checks. .env.example is the only
// place the founder, on a phone, can see what a Railway variable does; a
// variable missing from it is a switch nobody knows is there.
//
// This reads the code rather than keeping a second list, so a new variable
// fails the build until it is written down. Names are found where the code
// reads them: process.env.NAME, process.env['NAME'], and the helpers that
// take a name as a string (readSecret, hasSecret, numberFromEnv, limit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'test', 'data'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const READS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  /\b(?:readSecret|hasSecret|numberFromEnv|limit)\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
];

function variablesRead() {
  const names = new Map();
  for (const file of sources(SERVER)) {
    const text = fs.readFileSync(file, 'utf-8');
    for (const re of READS) {
      for (const match of text.matchAll(re)) {
        if (!names.has(match[1])) names.set(match[1], path.relative(SERVER, file));
      }
    }
  }
  return names;
}

test('every variable the server reads has an entry in .env.example', () => {
  const example = fs.readFileSync(path.join(SERVER, '.env.example'), 'utf-8');
  const read = variablesRead();
  assert.ok(read.size > 50, `found only ${read.size} variables; the scan is broken, not the code`);
  const missing = [...read].filter(([name]) => !new RegExp(`\\b${name}\\b`).test(example));
  assert.deepEqual(
    missing.map(([name, file]) => `${name} (read in ${file})`),
    [],
    'add each to server/.env.example with a sentence on what happens without it',
  );
});
