// The two gaps that made the team write blind: it could commit files it had
// never read back, and nothing accumulated about the venture between turns.
// Both show up the same way — an agent confidently contradicting work it did
// itself an hour earlier, discovered by CI rather than by looking.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let handlers;
let ventures;
let context;
const savedFetch = global.fetch;
const savedToken = process.env.GITHUB_TOKEN;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-buildloop-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  process.env.GITHUB_TOKEN = 'test-token';
  handlers = await import('../actionHandlers.js');
  ventures = await import('../finance/ventures.js');
  context = await import('../finance/context.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
  global.fetch = savedFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
  global.fetch = savedFetch;
});

function linkedVenture() {
  const v = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship v1'] });
  ventures.linkRepo(v.id, { owner: 'acme', name: 'circadian-api', allowedPaths: ['src/'] });
  return v;
}

test('an agent can read a file it committed in an earlier turn', async () => {
  const v = linkedVenture();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: Buffer.from('def phase_advance():\n    return 1.0\n').toString('base64') }),
  });

  const reply = await handlers.handleReadRepoFile({ ventureId: v.id, path: 'src/engine.py' });
  assert.match(reply, /def phase_advance/, 'the real content, not a summary of it');
  assert.match(reply, /acme\/circadian-api:src\/engine\.py/);
});

test('a missing file is an answer, not an error', async () => {
  // The agent needs to be able to tell "not written yet" from "the read
  // failed", because those lead to opposite next actions.
  const v = linkedVenture();
  global.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });

  const reply = await handlers.handleReadRepoFile({ ventureId: v.id, path: 'src/nothing.py' });
  assert.match(reply, /does not exist/);
  assert.doesNotMatch(reply, /Could not read/);
});

test('reading needs a linked repo, and says so when there is none', async () => {
  const v = ventures.createVenture({ title: 'No repo yet', milestones: [] });
  const reply = await handlers.handleReadRepoFile({ ventureId: v.id, path: 'src/x.py' });
  assert.match(reply, /no repo is linked/i);
});

test('a venture note is read back into every agent turn', () => {
  const v = linkedVenture();
  handlers.handleLogVentureNote(
    { ventureId: v.id, note: 'pytz is wrong for this — DST transitions break the shift maths. Use zoneinfo.' },
    { agentId: 'engineering_lead' }
  );

  const text = context.buildCompanyContext();
  assert.match(text, /zoneinfo/, 'the next attempt starts knowing');
  assert.match(text, /CircadianAPI/);
  assert.match(text, /log_venture_note/, 'and is told how to add to it');
});

test('notes stay silent when there are none', () => {
  linkedVenture();
  assert.equal(context.buildVentureNotesContext(), '', 'a "no notes" line on every turn is noise');
});

test('the note log is capped, keeping the most recent', () => {
  // An unbounded learning log stops being read — by the model as much as by
  // a person — and the oldest notes are the ones most likely to be stale.
  const v = linkedVenture();
  for (let i = 0; i < 45; i += 1) {
    ventures.recordVentureNote(v.id, { note: `lesson ${i}`, agentId: 'x' });
  }
  const notes = ventures.listVentureNotes(v.id);
  assert.equal(notes.length, 40);
  assert.equal(notes[notes.length - 1].note, 'lesson 44');
});

test('an empty note is refused rather than stored', () => {
  const v = linkedVenture();
  const reply = handlers.handleLogVentureNote({ ventureId: v.id, note: '   ' }, {});
  assert.match(reply, /Could not log/);
  assert.equal(ventures.listVentureNotes(v.id).length, 0);
});
