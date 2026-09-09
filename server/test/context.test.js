import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let context;
let ventures;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-context-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  context = await import('../finance/context.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('buildPastLessonsContext says nothing has been killed yet when there are no killed ventures', () => {
  const text = context.buildPastLessonsContext();
  assert.match(text, /No ventures have been killed yet/);
});

test('buildPastLessonsContext lists a killed venture with its title and reason', () => {
  const v = ventures.createVenture({
    title: 'Yet Another Resume Builder',
    oneLiner: 'AI resumes for job seekers',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    budgetRequested: 10,
    milestones: ['ship it'],
  });
  ventures.activateVenture(v.id);
  ventures.killVenture(v.id, 'market too saturated, no real differentiation');

  const text = context.buildPastLessonsContext();
  assert.match(text, /Yet Another Resume Builder/);
  assert.match(text, /AI resumes for job seekers/);
  assert.match(text, /market too saturated, no real differentiation/);
  assert.doesNotMatch(text, /No ventures have been killed yet/);
});

test('buildPastLessonsContext ignores proposed and active ventures, only killed ones', () => {
  ventures.createVenture({
    title: 'Still Proposed Co',
    oneLiner: 'x',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    budgetRequested: 5,
    milestones: [],
  });

  const text = context.buildPastLessonsContext();
  assert.doesNotMatch(text, /Still Proposed Co/);
});

test('buildStudioContext includes both the treasury context and the past-lessons context', () => {
  const text = context.buildStudioContext();
  assert.match(text, /Company treasury:/);
  assert.match(text, /Yet Another Resume Builder|No ventures have been killed yet/);
});
