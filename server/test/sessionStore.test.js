import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let sessionStore;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sessions-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  sessionStore = await import('../sessionStore.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadSessions starts empty for every mode', () => {
  assert.equal(sessionStore.loadSessions('jarvis').size, 0);
  assert.equal(sessionStore.loadSessions('company').size, 0);
  assert.equal(sessionStore.loadSessions('studio').size, 0);
});

test('saveSession persists history that a fresh loadSessions call picks up', () => {
  const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  sessionStore.saveSession('jarvis', 'session-1', history);

  const reloaded = sessionStore.loadSessions('jarvis');
  assert.deepEqual(reloaded.get('session-1'), history);
});

test('saveSession keeps modes and sessions independent', () => {
  sessionStore.saveSession('company', 'session-1', [{ role: 'user', content: 'company msg' }]);

  const jarvisSessions = sessionStore.loadSessions('jarvis');
  const companySessions = sessionStore.loadSessions('company');
  assert.ok(jarvisSessions.has('session-1'));
  assert.ok(companySessions.has('session-1'));
  assert.notDeepEqual(jarvisSessions.get('session-1'), companySessions.get('session-1'));
});

test('deleteSession removes just that session', () => {
  sessionStore.saveSession('studio', 'a', [{ role: 'user', content: 'a' }]);
  sessionStore.saveSession('studio', 'b', [{ role: 'user', content: 'b' }]);

  sessionStore.deleteSession('studio', 'a');

  const reloaded = sessionStore.loadSessions('studio');
  assert.equal(reloaded.has('a'), false);
  assert.ok(reloaded.has('b'));
});

test('deleteSession on an unknown id/mode is a no-op, not an error', () => {
  assert.doesNotThrow(() => sessionStore.deleteSession('jarvis', 'never-existed'));
  assert.doesNotThrow(() => sessionStore.deleteSession('nonexistent-mode', 'x'));
});

test('each mode has its own file, so a turn in one never rewrites another', () => {
  sessionStore.saveSession('studio', 'studio-1', [{ role: 'user', content: 'idea' }]);
  const companyFile = path.join(tmpDir, 'sessions-company.json');
  const before = fs.statSync(companyFile).mtimeMs;
  const beforeText = fs.readFileSync(companyFile, 'utf-8');
  sessionStore.saveSession('jarvis', 'another', [{ role: 'user', content: 'hello again' }]);
  assert.equal(fs.readFileSync(companyFile, 'utf-8'), beforeText);
  assert.equal(fs.statSync(companyFile).mtimeMs, before);
  assert.ok(fs.existsSync(path.join(tmpDir, 'sessions-studio.json')));
});

test('conversations in the old combined file are carried over once, and the old file is kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sessions-legacy-'));
  const legacy = { jarvis: { s1: [{ role: 'user', content: 'from before' }] }, company: { 'whatsapp-44': [{ role: 'user', content: 'plan?' }] }, studio: {} };
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(legacy));
  const previous = process.env.JARVIS_DATA_DIR;
  process.env.JARVIS_DATA_DIR = dir;
  try {
    assert.deepEqual(sessionStore.loadSessions('jarvis').get('s1'), legacy.jarvis.s1);
    assert.deepEqual(sessionStore.loadSessions('company').get('whatsapp-44'), legacy.company['whatsapp-44']);
    assert.equal(sessionStore.loadSessions('desk').size, 0, 'a mode the old file never had starts empty');
    // After the carry-over, the new file is the truth: a later save is not undone by the old file.
    sessionStore.saveSession('jarvis', 's1', [{ role: 'user', content: 'newer' }]);
    assert.equal(sessionStore.loadSessions('jarvis').get('s1')[0].content, 'newer');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf-8')), legacy, 'the old file is left as a backup');
  } finally {
    process.env.JARVIS_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a mode name that is not a plain word is refused', () => {
  assert.throws(() => sessionStore.saveSession('../ledger', 'x', []), /Unknown session mode/);
});
