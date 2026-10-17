// Free models by default, paid ones only when the founder says so.
//
// Pinned: "free" is a price of 0 on both sides; with paid models off a paid model
// is replaced by the first free one that has a key, and with none it is refused
// by name rather than quietly replaced by another paid model; that refusal is not
// an outage, so the fallback chain does not turn it into a different paid call;
// the failover chain skips paid providers; the briefing panel lists only allowed
// models; the founder's PAID MODELS command wins over the environment, is parsed
// by code, and is visible in SPEND; and turning paid models on restores everything.
//
// Paid models are on by default; most tests here are about the OFF position, so
// beforeEach sets PAID_MODELS=false and the first test clears it to check the default.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let models;
let policy;
let runner;
let panelModels;
let commands;
const ENV = ['PAID_MODELS', 'GEMINI_API_KEY', 'GEMINI_INPUT_PRICE_PER_MTOK', 'GEMINI_OUTPUT_PRICE_PER_MTOK', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_INPUT_PRICE_PER_MTOK', 'OPENROUTER_OUTPUT_PRICE_PER_MTOK', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-policy-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of ENV) saved[k] = process.env[k];
  models = await import('../agents/models.js');
  policy = await import('../agents/modelPolicy.js');
  runner = await import('../agents/agentRunner.js');
  panelModels = await import('../consultant/models.js');
  commands = await import('../channels/founderCommands.js');
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
  // Most tests below are about the OFF position, so they start there; the first
  // one is about the default and clears this itself.
  process.env.PAID_MODELS = 'false';
});

// Gemini is priced at 0 by default, so a key alone is the free-tier case.
const freeGemini = () => {
  process.env.GEMINI_API_KEY = 'g-test';
};

test('paid models are on by default, the variable sets the default, and the founder\'s command wins and survives', () => {
  delete process.env.PAID_MODELS;
  assert.equal(policy.paidModelsAllowed(), true, 'the API credit is there to be spent; free models are the fallback');
  assert.match(policy.paidModelsSource(), /default \(on\)/);
  process.env.PAID_MODELS = 'false';
  assert.equal(policy.paidModelsAllowed(), false);
  assert.match(policy.paidModelsSource(), /PAID_MODELS variable/);
  process.env.PAID_MODELS = 'true';
  assert.equal(policy.paidModelsAllowed(), true);
  policy.setPaidModels(false);
  assert.equal(policy.paidModelsAllowed(), false, 'the command beats the variable');
  assert.match(policy.paidModelsSource(), /your PAID MODELS command/);
  policy.setPaidModels(true);
  process.env.PAID_MODELS = 'false';
  assert.equal(policy.paidModelsAllowed(), true, 'and it does not need the variable');
});

test('when a paid provider is down, free models are tried before another paid one', async () => {
  // Claude is out of credit; OpenAI (paid) is listed before Gemini (free) in the chain.
  process.env.PAID_MODELS = 'true';
  process.env.ANTHROPIC_API_KEY = 'a-test';
  process.env.OPENAI_API_KEY = 'o-test';
  process.env.GEMINI_API_KEY = 'g-test';
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'free answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } }), text: async () => '' };
  };
  const broke = Object.assign(new Error('Your credit balance is too low'), { status: 400 });
  const anthropic = { messages: { create: async () => { throw broke; } } };
  try {
    const res = await runner.createMessage(anthropic, models.MODELS[models.DEFAULT_TIER], { max_tokens: 20, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(seen.length >= 1 && /generativelanguage|gemini/i.test(seen[0]), `the first backup asked was Gemini, got ${seen[0]}`);
    assert.equal(res.costUsd, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('free is a price of zero on both sides, nothing else', () => {
  assert.equal(models.isFreeSpec({ inputPricePerMTok: 0, outputPricePerMTok: 0 }), true);
  assert.equal(models.isFreeSpec({ inputPricePerMTok: 0, outputPricePerMTok: 0.1 }), false);
  assert.equal(models.isFreeSpec({ inputPricePerMTok: 2, outputPricePerMTok: 10 }), false);
  assert.equal(models.isFreeSpec(undefined), false);
  assert.equal(models.isFreeSpec(models.MODELS[models.DEFAULT_TIER]), false, 'Claude is paid');
});

test('Gemini is free by default, stops being free the day real prices are set, and is what a paid model becomes while it is free', () => {
  assert.equal(models.freeSpec(), null, 'no key, no free model');
  process.env.GEMINI_API_KEY = 'g-test';
  process.env.GEMINI_INPUT_PRICE_PER_MTOK = '0.1';
  process.env.GEMINI_OUTPUT_PRICE_PER_MTOK = '0.4';
  assert.equal(models.freeSpec(), null, 'with real prices set (billing turned on) it is paid, and the switch treats it so');
  delete process.env.GEMINI_INPUT_PRICE_PER_MTOK;
  delete process.env.GEMINI_OUTPUT_PRICE_PER_MTOK;
  assert.equal(models.MODELS[models.GEMINI_TIER].inputPricePerMTok, 0);
  assert.equal(models.MODELS[models.GEMINI_TIER].outputPricePerMTok, 0);
  const free = models.freeSpec();
  assert.equal(free.provider, 'gemini');
  const agent = { id: 'ceo', reports: ['a'], actions: [], serverTools: [] };
  assert.equal(models.resolveModelForAgent(agent, false).provider, 'gemini', 'an orchestrator that would have run on Claude runs on the free model');
  const researcher = { id: 'market_researcher', reports: [], actions: [], serverTools: [{ type: 'web_search_20260209', name: 'web_search' }] };
  assert.equal(models.resolveModelForAgent(researcher, false).provider, 'gemini', 'and so does an agent built around web search (it loses the search, and is told so)');
});

test('an OpenRouter ":free" model counts once its prices are zero', () => {
  process.env.OPENROUTER_API_KEY = 'or-test';
  process.env.OPENROUTER_MODEL = 'vendor/some-model:free';
  process.env.OPENROUTER_INPUT_PRICE_PER_MTOK = '0';
  process.env.OPENROUTER_OUTPUT_PRICE_PER_MTOK = '0';
  const free = models.freeSpec();
  assert.equal(free.provider, 'openrouter');
  assert.equal(free.model, 'vendor/some-model:free');
});

test('turning paid models on restores the normal routing', () => {
  freeGemini();
  policy.setPaidModels(true);
  const agent = { id: 'ceo', reports: ['a'], actions: [], serverTools: [] };
  assert.equal(models.resolveModelForAgent(agent, false).provider, 'anthropic');
  assert.equal(models.specAllowed(models.MODELS[models.DEFAULT_TIER]), true);
});

test('with no free model, a paid call is refused by name, and the refusal is not an outage', async () => {
  const anthropic = { messages: { create: async () => { throw new Error('should not be called'); } } };
  await assert.rejects(
    () => runner.createMessage(anthropic, models.MODELS[models.DEFAULT_TIER], { max_tokens: 10, system: 's', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.equal(err.code, 'PAID_MODELS_OFF');
      assert.match(err.message, /Paid models are switched off and no free model is available/);
      assert.match(err.message, /Gemini is priced at 0 by default, so set GEMINI_API_KEY/);
      assert.match(err.message, /PAID MODELS ON/);
      // The patterns agentRunner treats as "the provider is down, try another":
      assert.doesNotMatch(err.message, /credit balance|billing|quota/i);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('a caller that names a paid model itself (the fact check does) gets the free one instead', async () => {
  freeGemini();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'answered' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } }), text: async () => '' };
  };
  const anthropic = { messages: { create: async () => { throw new Error('Claude must not be called'); } } };
  try {
    const res = await runner.createMessage(anthropic, models.MODELS[models.DEFAULT_TIER], { max_tokens: 20, system: 's', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(seen.some((u) => /generativelanguage|gemini/i.test(u)), 'the request went to Gemini');
    assert.equal(res.costUsd, 0, 'and the spend meter reads $0 for it');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the briefing panel lists only models that are allowed', () => {
  process.env.ANTHROPIC_API_KEY = 'a-test';
  process.env.OPENAI_API_KEY = 'o-test';
  assert.deepEqual(panelModels.panelMembers({ anthropic: {} }).map((m) => m.name), [], 'nothing is free yet: Claude and OpenAI are paid, and there is no Gemini key');
  freeGemini();
  assert.deepEqual(panelModels.panelMembers({ anthropic: {} }).map((m) => m.name), ['Gemini']);
  policy.setPaidModels(true);
  assert.deepEqual(panelModels.panelMembers({ anthropic: {} }).map((m) => m.name), ['Claude', 'OpenAI', 'Gemini']);
});

test('web search is available only when Claude is allowed and has a key', () => {
  assert.equal(models.webSearchAvailable(), false);
  process.env.ANTHROPIC_API_KEY = 'a-test';
  assert.equal(models.webSearchAvailable(), false, 'a key is not enough while paid models are off');
  policy.setPaidModels(true);
  assert.equal(models.webSearchAvailable(), true);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(models.webSearchAvailable(), false);
});

test('PAID MODELS is a command of its own, parsed by code, and a sentence with "paid" in it is not one', async () => {
  // The argument keeps the case it was typed in; the handler lowercases it.
  assert.equal(commands.parseFounderCommand('PAID MODELS ON').mode.toLowerCase(), 'on');
  assert.equal(commands.parseFounderCommand('paid models off').mode, 'off');
  assert.equal(commands.parseFounderCommand('paid models').kind, 'paid_models');
  assert.equal(commands.parseFounderCommand('paid'), null, 'a bare word is not a command');
  assert.equal(commands.parseFounderCommand('the invoice was paid models later'), null);

  freeGemini();
  const on = await commands.runFounderCommand({ kind: 'paid_models', mode: 'on' }, {});
  assert.match(on, /^Paid models switched ON/);
  assert.match(on, /Paid models: ON \(from your PAID MODELS command\)/);
  assert.equal(policy.paidModelsAllowed(), true);
  const off = await commands.runFounderCommand({ kind: 'paid_models', mode: 'off' }, {});
  assert.match(off, /^Paid models switched OFF/);
  assert.match(off, /Free models available: gemini/);
  const status = await commands.runFounderCommand({ kind: 'paid_models' }, {});
  assert.match(status, /Paid models: OFF/);
  assert.match(commands.__helpForTests, /PAID MODELS \[ON\|OFF\|STATUS\]/);
});

test('SPEND shows the switch next to the numbers it changes', async () => {
  const spend = await commands.runFounderCommand({ kind: 'spend' }, {});
  assert.match(spend, /Paid models: OFF/);
});
