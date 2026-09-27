// The founder's switch between models: MODE ECO / NORMAL / MAX on WhatsApp.
//
// Pinned because each position fails quietly if it is wrong: ECO that leaves
// the managers on Claude saves little, MAX that leaves a specialist on a cheap
// model is not the quality the founder asked for, a switch that forgets its
// position on a redeploy is not a switch, and an agent with web search moved
// off Claude loses the search without saying so.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveModelForAgent,
  setModelMode,
  getModelMode,
  ecoTier,
  describeModelMode,
  MODELS,
  DEFAULT_TIER,
  DEEPSEEK_TIER,
  CHEAP_TIER,
} from '../agents/models.js';
import { parseFounderCommand, runFounderCommand } from '../channels/founderCommands.js';

const KEYS = ['JARVIS_DATA_DIR', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AGENT_MODEL_TIERS'];
const saved = {};
let tmpDir;

const MANAGER = { id: 'cfo', reports: ['analyst'], actions: [], serverTools: [] };
const SPECIALIST = { id: 'analyst', reports: [], actions: [], serverTools: [] };
const SEARCHER = { id: 'market_researcher', reports: [], actions: [], serverTools: [{ type: 'web_search' }] };

before(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mode-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
});

const model = (agent) => resolveModelForAgent(agent, Boolean(process.env.OPENROUTER_API_KEY)).model;

test('NORMAL is the default and keeps today behaviour: specialists cheap, managers on Claude', () => {
  process.env.OPENROUTER_API_KEY = 'o';
  assert.equal(getModelMode(), 'normal');
  assert.equal(model(SPECIALIST), MODELS[CHEAP_TIER].model);
  assert.equal(model(MANAGER), MODELS[DEFAULT_TIER].model);
});

test('ECO moves managers too, onto the cheapest provider that has a key', () => {
  process.env.OPENROUTER_API_KEY = 'o';
  process.env.DEEPSEEK_API_KEY = 'd';
  setModelMode('eco');
  // Chosen on the same prices the spend cap meters with, not by reputation.
  const cost = (tier) => MODELS[tier].inputPricePerMTok + MODELS[tier].outputPricePerMTok;
  const cheapest = cost(DEEPSEEK_TIER) < cost(CHEAP_TIER) ? DEEPSEEK_TIER : CHEAP_TIER;
  assert.equal(ecoTier(), cheapest);
  assert.equal(model(MANAGER), MODELS[cheapest].model);
  assert.equal(model(SPECIALIST), MODELS[cheapest].model);

  // Change a price and the switch follows it.
  process.env.OPENROUTER_OUTPUT_PRICE_PER_MTOK = '5';
  try {
    assert.equal(ecoTier(), DEEPSEEK_TIER);
  } finally {
    delete process.env.OPENROUTER_OUTPUT_PRICE_PER_MTOK;
  }
});

test('ECO with no cheaper key stays on Claude and says what to set', () => {
  setModelMode('eco');
  assert.equal(ecoTier(), null);
  assert.equal(model(MANAGER), MODELS[DEFAULT_TIER].model);
  assert.match(describeModelMode(), /DEEPSEEK_API_KEY/);
});

test('MAX puts specialists on Claude too', () => {
  process.env.OPENROUTER_API_KEY = 'o';
  setModelMode('max');
  assert.equal(model(SPECIALIST), MODELS[DEFAULT_TIER].model);
});

test('an agent that searches the web stays on Claude even in ECO', () => {
  process.env.DEEPSEEK_API_KEY = 'd';
  setModelMode('eco');
  assert.equal(model(SEARCHER), MODELS[DEFAULT_TIER].model);
});

test("a founder's per-agent assignment still wins over the switch", () => {
  process.env.DEEPSEEK_API_KEY = 'd';
  process.env.AGENT_MODEL_TIERS = 'analyst:frontier';
  setModelMode('eco');
  assert.equal(model(SPECIALIST), MODELS[DEFAULT_TIER].model);
});

test('the position survives a restart, because it is kept in the data directory', () => {
  setModelMode('max');
  assert.ok(fs.existsSync(path.join(tmpDir, 'modelMode.json')));
  assert.equal(getModelMode(), 'max');
});

test('an unknown position is refused with the valid ones', () => {
  assert.throws(() => setModelMode('turbo'), /ECO, NORMAL, MAX/);
});

test('MODE on WhatsApp shows the switch, and MODE ECO flips it', async () => {
  process.env.DEEPSEEK_API_KEY = 'd';
  const shown = await runFounderCommand(parseFounderCommand('MODE'), {});
  assert.match(shown, /Model mode: NORMAL/);
  const flipped = await runFounderCommand(parseFounderCommand('mode eco'), {});
  assert.match(flipped, /Model mode: ECO/);
  assert.match(flipped, /managers included/);
  assert.equal(getModelMode(), 'eco');
  assert.equal(parseFounderCommand('mode please'), null, 'ordinary prose is not swallowed');
});
