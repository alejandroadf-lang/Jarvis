import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let killSwitch;
let savedEnv;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-killswitch-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  savedEnv = process.env.REAL_ACTIONS_DISABLED;
  killSwitch = await import('../killSwitch.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedEnv === undefined) delete process.env.REAL_ACTIONS_DISABLED;
  else process.env.REAL_ACTIONS_DISABLED = savedEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.REAL_ACTIONS_DISABLED;
  fs.rmSync(path.join(tmpDir, 'killSwitch.json'), { force: true });
});

test('starts un-halted, and assertRealActionsAllowed passes', () => {
  assert.equal(killSwitch.getKillSwitch().halted, false);
  assert.doesNotThrow(() => killSwitch.assertRealActionsAllowed());
});

test('halting blocks real actions and reports the reason back', () => {
  killSwitch.haltRealActions('customer emails looked wrong');

  const state = killSwitch.getKillSwitch();
  assert.equal(state.halted, true);
  assert.equal(state.reason, 'customer emails looked wrong');
  assert.ok(state.changedAt);
  assert.throws(() => killSwitch.assertRealActionsAllowed(), /customer emails looked wrong/);
});

test('halting without a reason still records a usable one', () => {
  killSwitch.haltRealActions('   ');
  assert.match(killSwitch.getKillSwitch().reason, /Ventures panel/);
});

test('resuming clears the halt', () => {
  killSwitch.haltRealActions('pause');
  killSwitch.resumeRealActions();

  assert.equal(killSwitch.getKillSwitch().halted, false);
  assert.doesNotThrow(() => killSwitch.assertRealActionsAllowed());
});

test('REAL_ACTIONS_DISABLED halts everything regardless of stored state', () => {
  killSwitch.resumeRealActions(); // stored state says "go"
  process.env.REAL_ACTIONS_DISABLED = 'true';

  const state = killSwitch.getKillSwitch();
  assert.equal(state.halted, true);
  assert.equal(state.envLocked, true);
  assert.match(state.reason, /REAL_ACTIONS_DISABLED/);
  assert.throws(() => killSwitch.assertRealActionsAllowed(), /halted/);
});

test('the env halt cannot be lifted from the app — resume refuses instead of pretending', () => {
  process.env.REAL_ACTIONS_DISABLED = 'true';
  assert.throws(() => killSwitch.resumeRealActions(), /unset it and restart/);
  assert.equal(killSwitch.getKillSwitch().halted, true);
});

test('only the exact string "true" locks it, so a stray value cannot silently disarm real actions', () => {
  process.env.REAL_ACTIONS_DISABLED = 'false';
  assert.equal(killSwitch.getKillSwitch().envLocked, false);
});
