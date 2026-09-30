// The weekly compile is a delta over a cited page, not a rewrite. Pinned here:
// only trusted lessons feed it (an unconfirmed note must not become an
// unlabelled sentence every agent reads), a pass that loses most of the page is
// refused, a page the founder locked is left alone, and a page they edited is
// the base of the next pass.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeVault, configureVault, KEYS } from './helpers/fakeVault.js';

let tmpDir;
let originalFetch;
const saved = {};
let knowledge;
let notebook;
let ventures;
let vaultIndex;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-kdelta-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  knowledge = await import('../workspace/knowledge.js');
  notebook = await import('../workspace/notebook.js');
  ventures = await import('../finance/ventures.js');
  vaultIndex = await import('../workspace/vaultIndex.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  vaultIndex.invalidateIndex();
  global.fetch = originalFetch;
});

const say = (name, input, agent) => notebook.runNotebookTool(name, input, { agentId: agent });
const LONG = '- A bullet that is still true, with its source [[2026-09-01 Older lesson]].\n'.repeat(12);

test('only trusted lessons reach the compile, each with its wikilink and evidence', async () => {
  configureVault();
  const vault = fakeVault();
  const v = ventures.createVenture({ title: 'Delta Co', oneLiner: 'x', proposedBy: 'venture_partner' });
  await say('write_lesson', { title: 'Confirmed thing', lesson: 'Three tiers convert.', evidence: 'PR #7, 2026-09-01', ventureId: v.id }, 'cmo');
  const first = Object.keys(vault.files).find((p) => p.startsWith('Company/Lessons/'));
  await say('write_lesson', { title: 'Second look', lesson: 'Confirmed by a trial.', evidence: '2026-09-15 trial results', ventureId: v.id, confirms: first }, 'coo');
  await say('write_lesson', { title: 'Unchecked claim', lesson: 'Maybe annual billing wins.', evidence: '2026-09-16 a hunch note', ventureId: v.id }, 'cfo');

  let prompt = '';
  const written = await knowledge.compileKnowledge({
    runAgentImpl: async (args) => { prompt = args.messages[0].content; return { text: '- Three tiers convert [[2026-09-01 Confirmed thing]].' }; },
    publishImpl: async () => true,
  });
  assert.equal(written.length, 1);
  assert.match(prompt, /\[\[.*Confirmed thing\]\] \(cmo; evidence: PR #7, 2026-09-01\)/);
  assert.doesNotMatch(prompt, /Unchecked claim/, 'a candidate is not compiled');
  assert.match(prompt, /This is an update, not a rewrite/);
  assert.match(prompt, /Keep every existing bullet that is still true, word for word/);
  assert.match(prompt, /replaced YYYY-MM-DD: why/);
});

test('a pass that loses most of the page is refused and the old page stays', async () => {
  const v = ventures.createVenture({ title: 'Shrink Co', oneLiner: 'x', proposedBy: 'venture_partner' });
  await knowledge.compileKnowledge({ runAgentImpl: async () => ({ text: LONG }), publishImpl: async () => true });
  const before = knowledge.getKnowledgePage(v.id).markdown;
  assert.ok(before.length >= 600);

  const errors = [];
  const savedErr = console.error;
  console.error = (m) => errors.push(m);
  const written = await knowledge.compileKnowledge({ runAgentImpl: async () => ({ text: 'Everything is fine.' }), publishImpl: async () => true });
  console.error = savedErr;
  assert.equal(knowledge.getKnowledgePage(v.id).markdown, before);
  assert.ok(!written.some((w) => w.ventureId === v.id));
  assert.ok(errors.some((e) => /kept the old one/.test(e)));
});

test('a page the founder locked is left alone, and one they edited is the base of the next pass', async () => {
  configureVault();
  const v = ventures.createVenture({ title: 'Locked Co', oneLiner: 'x', proposedBy: 'venture_partner' });
  const page = 'Company/Knowledge/Locked Co.md';
  const vault = fakeVault({
    [page]: '---\ntype: knowledge\nlocked: true\n---\n# Locked Co — what we know\n\n_Compiled 2026-09-01 from trusted lessons._\n\n- The founder wrote this.\n',
  });

  let calls = 0;
  await knowledge.compileKnowledge({ runAgentImpl: async (a) => { if (/Locked Co/.test(a.messages[0].content)) calls += 1; return { text: 'x' }; }, publishImpl: async () => true });
  assert.equal(calls, 0, 'a locked page costs no model call');

  vault.files[page] = vault.files[page].replace('locked: true', 'locked: false').replace('- The founder wrote this.', '- The founder wrote this. And edited it on the phone.');
  vaultIndex.invalidateIndex();
  let seen = '';
  await knowledge.compileKnowledge({ runAgentImpl: async (a) => { if (/Locked Co/.test(a.messages[0].content)) seen = a.messages[0].content; return { text: 'x' }; }, publishImpl: async () => true });
  assert.match(seen, /And edited it on the phone\./, "the founder's edit is the base");
  assert.equal(v.title, 'Locked Co');
});
