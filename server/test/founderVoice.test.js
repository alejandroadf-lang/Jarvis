// The company talks to one person, on a phone, all day — and nothing
// anywhere said so. Every agent wrote for the only reader it had ever been
// described: another engineer. The output was accurate and unreadable.
//
// What's testable is that the description reaches every agent, that it sits
// where it can still change what gets written, and that it keeps the
// concrete rewrites rather than decaying into "be clear" — which is advice
// nobody has ever acted on.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIBRARY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'library');
let tmpDir;
let founder;
let context;
const savedProfile = process.env.FOUNDER_PROFILE;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  delete process.env.FOUNDER_PROFILE;
  founder = await import('../founder.js');
  context = await import('../finance/context.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedProfile === undefined) delete process.env.FOUNDER_PROFILE;
  else process.env.FOUNDER_PROFILE = savedProfile;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.FOUNDER_PROFILE;
});

test('every agent on both teams is told who it is writing to', () => {
  assert.match(context.buildCompanyContext(), /Who you are writing to/);
  assert.match(context.buildStudioContext(), /Who you are writing to/);
});

test('it arrives before the work, not after', () => {
  // An agent that learns its audience after composing has already written
  // for the wrong one.
  const text = context.buildCompanyContext();
  assert.ok(
    text.indexOf('Who you are writing to') < text.indexOf('Money actually earned'),
    'audience has to be read before the material'
  );
});

test('the default is the register the founder asked for, not a placeholder', () => {
  // A default that needs configuring before it is any good is a default that
  // stays unconfigured. This one is what they actually asked for.
  const text = founder.buildFounderProfile();
  assert.match(text, /like a trader/i);
  assert.match(text, /what changed, what you need, one line\s+each/i);
  assert.match(text, /nothing needed, carrying on/i, 'and no-news is a real message');
});

test('the profile is short enough to sit on every single turn', () => {
  // It is prepended to every agent call. A page of style guidance would cost
  // more in tokens across a day than the clarity is worth, and would push
  // the material it is meant to shape further down.
  assert.ok(founder.buildFounderProfile().length < 2000);
});

test('it names the vocabulary that makes a true report unreadable', () => {
  const text = founder.buildFounderProfile();
  assert.match(text, /next_task/, 'tool names');
  assert.match(text, /internal\s+ids/i);
  // ...while keeping the exception, or agents will strip the venture id and
  // commit URL the founder actually has to copy.
  assert.match(text, /an id they have to copy/i);
  assert.match(text, /earn their place/i);
});

test('it does not tell agents to dumb things down', () => {
  // The founder built this system. Condescension would be both wrong and
  // less useful than the right ordering.
  const text = founder.buildFounderProfile();
  assert.match(text, /not about simplifying/i);
});

test('the skill keeps the real example it was written from', () => {
  // A skill that decays into generalities has stopped changing behaviour,
  // and the before/after pair is the part that teaches.
  const body = fs.readFileSync(path.join(LIBRARY, 'writing-for-the-founder.md'), 'utf8');
  assert.match(body, /next_task` handed engineering the auth task/, 'the message that prompted it');
  assert.match(body, /One is a decision; the other is a transcript/);
  assert.match(body, /Not:/, 'and the rewrites');
  assert.match(body, /But:/);
});

test('the founder can describe themselves differently', () => {
  process.env.FOUNDER_PROFILE = 'Write to me like a trader: number first, one line, no preamble.';
  assert.match(context.buildCompanyContext(), /like a trader/);
});

test('a blank override falls back rather than leaving agents with no reader', () => {
  process.env.FOUNDER_PROFILE = '   ';
  assert.equal(founder.buildFounderProfile(), founder.__defaultProfileForTests);
});
