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
