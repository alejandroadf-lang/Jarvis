// Turning a demo into a benchmark.
//
// The ears benchmark (bench/stt.js) measures word error rate, chrF and
// entity error rate — but only against audio you supply, and the whole
// point of it is that the vendors' published figures are on somebody
// else's recordings. A Spanish agent on a bad line in a busy office saying
// a record locator is the audio that matters, and there is exactly one
// place it exists: the demo you just ran.
//
// So: TRAVEL CAPTURE ON, hand the phone round, TRAVEL CAPTURE OFF. Every
// voice note answered in between is written next to its transcript in the
// layout the bench reads, and `npm run travel:bench` then scores all four
// ears against what real people actually said.
//
// Two things this is careful about. It is OFF by default and switched on
// deliberately, because it writes a caller's voice to disk — the one thing
// the rest of this product goes out of its way not to do. And it is swept
// on the same clock as everything else, so a fixture folder nobody curated
// does not quietly become a permanent archive of people's voices.

import fs from 'node:fs';
import path from 'node:path';
import { dataPath, readJson, writeJson } from '../../store.js';

const FILE = 'travelVoiceCapture.json';
const DIR = 'voiceFixtures';
const MAX_FIXTURES = 200;
const AUDIO = /\.(ogg|opus|mp3|m4a|wav|webm)$/i;

/** Where captured audio lands. Under the data directory, so it moves with it. */
export function captureDir() {
  return dataPath(DIR);
}

function ensureDir() {
  const dir = captureDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function load() {
  return readJson(FILE, { on: false, since: null, count: 0 });
}

/** Whether inbound voice notes are being kept as fixtures right now. */
export function capturing() {
  return Boolean(load().on);
}

export function setCapturing(on) {
  const data = load();
  data.on = Boolean(on);
  if (on) {
    data.since = new Date().toISOString();
    data.count = 0;
  }
  writeJson(FILE, data);
  return data;
}

export function captureState() {
  return load();
}

/**
 * Writes one voice note and what was heard, named the way the bench reads:
 * `{language}-{stamp}.{ext}` beside `{language}-{stamp}.txt`.
 *
 * Never throws — a demo must not fall over because a disk is full — and
 * never runs unless capture was switched on deliberately.
 */
export function captureVoiceNote({ audio, filename = 'voice.ogg', transcript = '', language = null } = {}) {
  if (!capturing() || !audio?.length || !String(transcript || '').trim()) return null;
  try {
    const dir = ensureDir();
    if (fs.readdirSync(dir).filter((f) => AUDIO.test(f)).length >= MAX_FIXTURES) return null;
    const ext = (path.extname(filename) || '.ogg').toLowerCase();
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = `${language || 'xx'}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(path.join(dir, `${base}${ext}`), audio);
    // What the live ear heard is a starting point, not a reference. The
    // whole value of the benchmark rests on someone reading these and
    // correcting them, which is why the founder is told to.
    fs.writeFileSync(path.join(dir, `${base}.txt`), `${String(transcript).trim()}\n`);
    const data = load();
    data.count = (data.count || 0) + 1;
    writeJson(FILE, data);
    return base;
  } catch (err) {
    console.warn(`Travel voice: could not keep a voice note as a fixture: ${err.message}`);
    return null;
  }
}

/** What has been captured so far, for the founder and for verify.js. */
export function capturedFixtures() {
  const dir = captureDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => AUDIO.test(f))
    .map((file) => {
      const base = file.replace(/\.[^.]+$/, '');
      const ref = path.join(dir, `${base}.txt`);
      return {
        id: base,
        file: path.join(dir, file),
        language: /^[a-z]{2}-/.test(base) ? base.slice(0, 2) : null,
        reference: fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8').trim() : '',
      };
    })
    .filter((f) => f.reference);
}

/** Forgets captured audio older than the cutoff. Runs with every other clock. */
export function sweepFixtures(cutoffMs) {
  const dir = captureDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    try {
      if (fs.statSync(full).mtimeMs >= cutoffMs) continue;
      fs.unlinkSync(full);
      if (AUDIO.test(file)) removed += 1;
    } catch {
      // A file that vanished under us needs no attention.
    }
  }
  return removed;
}

export function __resetCaptureForTests() {
  writeJson(FILE, { on: false, since: null, count: 0 });
  const dir = captureDir();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
