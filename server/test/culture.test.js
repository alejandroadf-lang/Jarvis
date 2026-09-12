// Values in a prompt are the weakest thing in this codebase: every other
// constraint — scope, caps, the plan, the kill switch — is a function that
// refuses to return, and this one cannot be, because no function returns
// false for "this venture makes people worse off".
//
// So what is testable is the thing that makes prose work at all: that it
// reaches every agent, that it comes before the numbers rather than after,
// and that it names specific decisions instead of being a sentiment. A value
// that changes no decision is decoration, and decoration at the top of a
// system prompt teaches every agent that the opening lines are not the
// operative part.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let culture;
let context;
let ventures;
const savedValues = process.env.COMPANY_VALUES;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-culture-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  delete process.env.COMPANY_VALUES;
  culture = await import('../culture.js');
  context = await import('../finance/context.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedValues === undefined) delete process.env.COMPANY_VALUES;
  else process.env.COMPANY_VALUES = savedValues;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
  delete process.env.COMPANY_VALUES;
});

test('both teams read it, not just the one that talks to customers', () => {
  assert.match(context.buildCompanyContext(), /make people's lives better/);
  assert.match(context.buildStudioContext(), /make people's lives better/);
});

test('it comes before the numbers', () => {
  // An agent that reads what the work is for after reading what the
  // constraints are has already decided what it intends to do.
  const text = context.buildCompanyContext();
  assert.ok(
    text.indexOf("make people's lives better") < text.indexOf('Money actually earned'),
    'the purpose has to be read before the ledger, or it reads as an afterthought'
  );
});

test('it names the decisions it binds, not a sentiment', () => {
  // The difference between a value and a slogan is whether it tells you what
  // to do differently on a Tuesday.
  const text = culture.buildCultureContext();
  assert.match(text, /What gets built/, 'which ventures clear the bar');
  assert.match(text, /What gets sent/, 'what goes in a real email');
  assert.match(text, /What gets claimed/, 'what a product may say it does');
});

test('it says the profitable answer can be the wrong one', () => {
  // Without this it is just "be nice", which no agent has ever been stopped by.
  const text = culture.buildCultureContext();
  assert.match(text, /however large the market/i);
  assert.match(text, /"It would work" is not the\s+same as "we should"/);
});

test('it does not argue for timidity', () => {
  // A values block that reads as "be careful" produces a company that builds
  // nothing, which helps nobody.
  assert.match(culture.buildCultureContext(), /None of this is a reason to be timid/i);
});

test('the ambition bar carries both halves', async () => {
  // The Studio decides what gets built at all — the one place where "it makes
  // money" and "we should" come apart most often.
  const { AGENTS } = await import('../agents/ideationTeam.js');
  const partner = Object.values(AGENTS).find((a) => (a.actions || []).some((x) => x.name === 'propose_venture'));
  assert.match(partner.systemPrompt, /\$1M\+/, 'still has to make real money');
  assert.match(partner.systemPrompt, /genuinely good for the people who would use it/);
  assert.match(partner.systemPrompt, /fails here on the merits/);
});

test('the founder can change what their own company is for', () => {
  // Asking them to open a pull request to adjust their own values would be
  // the tail wagging the dog.
  process.env.COMPANY_VALUES = 'We build tools for people who repair things.';
  assert.equal(culture.buildCultureContext(), 'We build tools for people who repair things.');
  assert.match(context.buildCompanyContext(), /repair things/);
});

test('a blank override falls back rather than erasing the values', () => {
  // The blank-env trap this codebase has now hit twice: an unset variable
  // must not silently mean "the company stands for nothing".
  process.env.COMPANY_VALUES = '   ';
  assert.equal(culture.buildCultureContext(), culture.__defaultValuesForTests);
});
