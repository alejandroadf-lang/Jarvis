// The customer desk.
//
// The founder's brief opens "you are speaking with the founder, who owns it"
// and injects COMPANY STATE — revenue to date, the pipeline, prospect names,
// today's plan. Point that at a customer and the first person who asks how
// business is going gets the revenue figure and a list of who else is being
// sold to.
//
// So the desk is built from an allowlist rather than by filtering the
// founder's context. A filter has to anticipate every field that should not go
// out and loses the moment somebody adds one; an allowlist only ever emits
// what is named in it, so a new field is invisible by default. The tests below
// are written against that property rather than against today's field list.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;
let desk;
let ventureId;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-desk-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  ventures = await import('../finance/ventures.js');
  desk = await import('../realtime/deskBrief.js');

  const v = ventures.createVenture({
    title: 'CircadianAPI',
    oneLiner: 'Sleep-cycle scoring for wearables.',
    problem: 'Wearable makers ship raw sleep data nobody can act on.',
    targetCustomer: 'Wearable hardware companies with an existing app.',
    businessModel: 'Per-seat SaaS',
    marketSize: 'USD 2.1bn',
    pathToMillions: 'Land three OEMs, expand per device.',
    agentNativeEdge: 'Nightly re-scoring nobody staffs.',
  });
  ventureId = v.id;
  ventures.setPricing(v.id, { currency: 'USD', floorMonthly: 29, perUnit: 0, unit: '' });
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the desk greets by name and asks how it can help', () => {
  const venture = ventures.getVenture(ventureId);
  const greeting = desk.deskGreeting(venture);
  assert.match(greeting, /CircadianAPI/);
  assert.match(greeting, /how you can help/i);
  assert.match(greeting, /One sentence/, 'a desk that recites is a desk people hang up on');
});

test('DESK_NAME overrides the venture title, so it can answer as a health desk', (t) => {
  const saved = process.env.DESK_NAME;
  t.after(() => { if (saved === undefined) delete process.env.DESK_NAME; else process.env.DESK_NAME = saved; });
  process.env.DESK_NAME = 'the Circadian Health Desk';
  assert.match(desk.deskGreeting(ventures.getVenture(ventureId)), /the Circadian Health Desk/);
});

// --- The boundary, which is the whole point -----------------------------------------------

test('the desk brief contains no company state at all', () => {
  const brief = desk.buildDeskInstructions(ventureId);
  // Not "is it filtered" — is any of it present in any form.
  for (const leak of ['COMPANY STATE', 'Revenue to date', 'pipeline', 'Treasury', 'prospect']) {
    assert.doesNotMatch(brief, new RegExp(leak, 'i'), `a customer must not be told about ${leak}`);
  }
});

test('internal venture fields never reach a customer, even though the venture has them', () => {
  // marketSize, pathToMillions and agentNativeEdge are on the venture and are
  // strategy, not product. The allowlist is what keeps them out; this test
  // fails the moment someone "helpfully" widens it.
  const brief = desk.buildDeskInstructions(ventureId);
  assert.doesNotMatch(brief, /2\.1bn/, 'market size is not a customer fact');
  assert.doesNotMatch(brief, /Land three OEMs/, 'the growth plan is not a customer fact');
  assert.doesNotMatch(brief, /Nightly re-scoring nobody staffs/, 'the edge is not a customer fact');
});

test('a field added to a venture tomorrow is invisible to the desk by default', () => {
  // The property the allowlist exists for, tested directly: write something
  // secret onto the stored venture and confirm it does not appear.
  const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'ventures.json'), 'utf8'));
  data.ventures[0].internalNoteAddedLater = 'ACME are threatening to churn';
  fs.writeFileSync(path.join(tmpDir, 'ventures.json'), JSON.stringify(data));

  const brief = desk.buildDeskInstructions(ventureId);
  assert.doesNotMatch(brief, /ACME/, 'a new field must not leak just by existing');
  assert.match(brief, /CircadianAPI/, 'while the allowlisted facts still come through');
});

test('the desk knows the five things a customer may hear, and the price is one', () => {
  const brief = desk.buildDeskInstructions(ventureId);
  assert.match(brief, /Sleep-cycle scoring for wearables/);
  assert.match(brief, /Wearable hardware companies/);
  assert.match(brief, /USD 29\.00\/month/);
});

test('the desk is told it cannot discount, and that saying so is not a weakness', () => {
  // The Project Vend failure, on a phone call. A model asked for a discount by
  // a persuasive customer will give one unless told plainly it has no such
  // authority.
  const brief = desk.buildDeskInstructions(ventureId);
  assert.match(brief, /Never offer a discount/i);
  assert.match(brief, /not a weakness/);
});

test('the desk refuses card numbers rather than repeating them back', () => {
  const brief = desk.buildDeskInstructions(ventureId);
  assert.match(brief, /Never accept payment details, card numbers or passwords/i);
});

test('the desk is barred from inventing features and dates', () => {
  const brief = desk.buildDeskInstructions(ventureId);
  assert.match(brief, /Never invent a feature, a date, an integration, a customer name/i);
  assert.match(brief, /wrong yes on a call becomes a refund/i);
});

test('the desk is told to follow the caller\'s language, not to negotiate about it', () => {
  const brief = desk.buildDeskInstructions(ventureId);
  assert.match(brief, /use their language and keep using it/i);
  assert.match(brief, /Never comment on which language/i, 'asking someone to repeat in English is the failure');
  assert.match(brief, /Keep the product name exactly as written/i);
});

test('DESK_LANGUAGE picks the language it opens in, before anyone has spoken', (t) => {
  // A greeting has to commit to a language and the caller has not spoken yet.
  const saved = process.env.DESK_LANGUAGE;
  t.after(() => { if (saved === undefined) delete process.env.DESK_LANGUAGE; else process.env.DESK_LANGUAGE = saved; });

  process.env.DESK_LANGUAGE = 'es';
  assert.equal(desk.deskGreetingLanguage(), 'Spanish');
  assert.match(desk.buildDeskInstructions(ventureId), /Open in Spanish/);

  process.env.DESK_LANGUAGE = 'thai';
  assert.equal(desk.deskGreetingLanguage(), 'Thai', 'a name works as well as a code');

  delete process.env.DESK_LANGUAGE;
  assert.equal(desk.deskGreetingLanguage(), 'English', 'a safe default, not a statement');
});

test('a desk with no venture says so rather than describing nothing confidently', () => {
  const brief = desk.buildDeskInstructions('v_does_not_exist');
  assert.match(brief, /no product on record/i);
});
