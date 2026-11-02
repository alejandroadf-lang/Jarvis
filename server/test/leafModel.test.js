// The specialists run on Claude Haiku when there is an Anthropic key, and go back to
// OpenRouter when there is not, when the founder says so, or when paid models are off.
//
// Pinned because the org chart pins its specialists to the OpenRouter tier by name, and
// the change is that "the cheap tier" now means Haiku where Claude is available. A test
// that only checked the new model would pass while the pins quietly stopped working.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODELS, LIGHT_TIER, CHEAP_TIER, DEFAULT_TIER, resolveModelForAgent, leavesOnClaude, leafSpec, describeModelMode } from '../agents/models.js';
import { setPaidModels } from '../agents/modelPolicy.js';

const ENV = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'LEAVES_ON_CLAUDE', 'ANTHROPIC_LEAF_MODEL', 'ANTHROPIC_LEAF_INPUT_PRICE_PER_MTOK', 'ANTHROPIC_LEAF_OUTPUT_PRICE_PER_MTOK', 'GEMINI_API_KEY', 'PAID_MODELS'];
const saved = {};
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-leaf-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of ENV) saved[k] = process.env[k];
});
after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  fs.rmSync(path.join(tmpDir, 'model-policy.json'), { force: true });
  fs.rmSync(path.join(tmpDir, 'modelMode.json'), { force: true });
});

const pinned = { id: 'marketing_writer', reports: [], actions: [], serverTools: [], modelTier: CHEAP_TIER };

test('Haiku is priced at its real rates, with nothing configured', () => {
  assert.equal(MODELS[LIGHT_TIER].model, 'claude-haiku-5-5');
  assert.equal(MODELS[LIGHT_TIER].provider, 'anthropic');
  assert.equal(MODELS[LIGHT_TIER].inputPricePerMTok, 0.1);
  assert.equal(MODELS[LIGHT_TIER].outputPricePerMTok, 0.5);
});

test('a specialist pinned to the cheap tier runs on Haiku when there is an Anthropic key, even with OpenRouter configured', () => {
  process.env.ANTHROPIC_API_KEY = 'a-test';
  process.env.OPENROUTER_API_KEY = 'o-test';
  assert.equal(leavesOnClaude(), true);
  const spec = resolveModelForAgent(pinned, true);
  assert.equal(spec.model, 'claude-haiku-5-5');
  assert.equal(spec.provider, 'anthropic');
  // An untiered leaf is treated the same way: it defaults to the cheap tier.
  assert.equal(resolveModelForAgent({ ...pinned, modelTier: undefined }, true).model, 'claude-haiku-5-5');
});

test('without an Anthropic key, or with LEAVES_ON_CLAUDE=false, the specialist goes to OpenRouter as before', () => {
  process.env.OPENROUTER_API_KEY = 'o-test';
  assert.equal(leavesOnClaude(), false);
  assert.equal(resolveModelForAgent(pinned, true).provider, 'openrouter');
  process.env.ANTHROPIC_API_KEY = 'a-test';
  process.env.LEAVES_ON_CLAUDE = 'false';
  assert.equal(leavesOnClaude(), false);
  assert.equal(resolveModelForAgent(pinned, true).provider, 'openrouter');
});

test('managers and agents that search the web stay on the main Claude model', () => {
  process.env.ANTHROPIC_API_KEY = 'a-test';
  assert.equal(resolveModelForAgent({ id: 'ceo', reports: ['a'], actions: [], serverTools: [] }, false).model, MODELS[DEFAULT_TIER].model);
  const searcher = { ...pinned, serverTools: [{ type: 'web_search_20260209', name: 'web_search' }] };
  assert.equal(resolveModelForAgent(searcher, false).model, MODELS[DEFAULT_TIER].model);
});

test('another leaf model and its prices can be set, and the spend meter follows', () => {
  process.env.ANTHROPIC_LEAF_MODEL = ' claude-haiku-4-5 ';
  process.env.ANTHROPIC_LEAF_INPUT_PRICE_PER_MTOK = '1';
  process.env.ANTHROPIC_LEAF_OUTPUT_PRICE_PER_MTOK = '5';
  assert.equal(MODELS[LIGHT_TIER].model, 'claude-haiku-4-5');
  assert.equal(MODELS[LIGHT_TIER].inputPricePerMTok, 1);
  assert.equal(MODELS[LIGHT_TIER].outputPricePerMTok, 5);
});

test('with paid models off, the specialist is replaced by a free model rather than quietly using Haiku', () => {
  process.env.ANTHROPIC_API_KEY = 'a-test';
  process.env.GEMINI_API_KEY = 'g-test';
  setPaidModels(false);
  const spec = resolveModelForAgent(pinned, false);
  assert.notEqual(spec.model, 'claude-haiku-5-5');
  assert.equal(spec.inputPricePerMTok, 0);
});

test('a cheap one-off call (fact check, review) uses the same choice, and MODE says where the specialists run', () => {
  process.env.ANTHROPIC_API_KEY = 'a-test';
  assert.equal(leafSpec().model, 'claude-haiku-5-5');
  assert.match(describeModelMode(), /Specialists run on claude-haiku-5-5 \(\$0\.1 in \/ \$0\.5 out/);
  process.env.LEAVES_ON_CLAUDE = 'no';
  assert.equal(leafSpec().provider, 'openrouter');
});
