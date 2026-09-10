import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let context;
let ventures;
let weeklyReflections;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-context-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  context = await import('../finance/context.js');
  ventures = await import('../finance/ventures.js');
  weeklyReflections = await import('../weeklyReflections.js');
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
    milestones: ['ship it'],
  });
  ventures.killVenture(v.id, 'market too saturated, no real differentiation');

  const text = context.buildPastLessonsContext();
  assert.match(text, /Yet Another Resume Builder/);
  assert.match(text, /AI resumes for job seekers/);
  assert.match(text, /market too saturated, no real differentiation/);
  assert.doesNotMatch(text, /No ventures have been killed yet/);
});

test('buildPastLessonsContext ignores live ventures, only killed ones', () => {
  ventures.createVenture({
    title: 'Still Running Co',
    oneLiner: 'x',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    milestones: [],
  });

  const text = context.buildPastLessonsContext();
  assert.doesNotMatch(text, /Still Running Co/);
});

test('buildStudioContext includes the business context and the past-lessons context', () => {
  const text = context.buildStudioContext();
  assert.match(text, /Money actually earned so far:/);
  assert.match(text, /Yet Another Resume Builder|No ventures have been killed yet/);
});

test('buildOutreachContext says there is nothing to check when no venture has an outreach scope', () => {
  assert.match(context.buildOutreachContext(), /No venture has an outreach scope/);
});

test('buildOutreachContext puts prior emails and notes in front of the agent before it drafts', () => {
  const v = ventures.createVenture({
    title: 'Outreach Co',
    oneLiner: 'x',
    problem: 'p',
    targetCustomer: 'c',
    businessModel: 'm',
    marketSize: 's',
    pathToMillions: 'path',
    milestones: [],
  });
  ventures.linkOutreachScope(v.id, { allowedRecipients: ['@acme.com'] });
  ventures.recordOutreach(v.id, { to: 'jane@acme.com', subject: 'Following up on the proposal' });
  ventures.recordContactNote(v.id, { email: 'jane@acme.com', note: 'Said revisit next quarter' });

  const text = context.buildOutreachContext();
  assert.match(text, /Outreach Co/);
  assert.match(text, /jane@acme\.com/);
  assert.match(text, /1 email\(s\) sent/);
  assert.match(text, /Following up on the proposal/);
  assert.match(text, /Said revisit next quarter/);
});

test('buildCompanyContext carries both the business picture and the contact history', () => {
  const text = context.buildCompanyContext();
  assert.match(text, /Money actually earned so far:/);
  assert.match(text, /jane@acme\.com/);
});

test('buildStudioContext leaves contact history out — ideation does not send email', () => {
  assert.doesNotMatch(context.buildStudioContext(), /jane@acme\.com/);
});

test('buildStudioContext says no weekly reflection has run yet when none exists', () => {
  const text = context.buildStudioContext();
  assert.match(text, /No weekly reflection has run yet/);
});

test('buildStudioContext includes the latest weekly reflection once one exists', () => {
  weeklyReflections.saveWeeklyReflection({
    weekEnding: '2026-01-04',
    generatedAt: '2026-01-04T01:30:00.000Z',
    reportsConsidered: 7,
    reflection: 'The competitor-gap opportunity was the only one anyone actually followed up on.',
    trace: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0.001,
    durationMs: 5000,
  });

  const text = context.buildStudioContext();
  assert.match(text, /week ending 2026-01-04/);
  assert.match(text, /competitor-gap opportunity was the only one/);
  assert.doesNotMatch(text, /No weekly reflection has run yet/);
});

// The old context told every agent how much of a $100 seed was left, which
// invited exactly the reasoning the founder wanted gone: weighing ideas by
// what the treasury could bear. These two guard the replacement.
test('buildTreasuryContext is gone; buildBusinessContext replaces it', () => {
  assert.equal(context.buildTreasuryContext, undefined);
  assert.equal(typeof context.buildBusinessContext, 'function');
});

test('buildBusinessContext tells agents affordability is not a constraint', () => {
  const text = context.buildBusinessContext();
  assert.match(text, /no seed capital and no budget ceiling/);
  assert.match(text, /Don't reason\s+about affordability, runway/);
  assert.doesNotMatch(text, /\$100/);
  // What actually binds instead.
  assert.match(text, /founder's attention/);
  assert.match(text, /model-spend\s+budget/);
});
