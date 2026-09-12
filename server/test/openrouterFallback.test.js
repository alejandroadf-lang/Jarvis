// OpenRouter as a backup, not just as the cheap tier.
//
// The case this is really for: an Anthropic account out of credit. Point
// OPENROUTER_FALLBACK_MODEL at an Anthropic model on OpenRouter and the
// company answers on the same model through a different account — the truest
// substitute available, and the exact failure that took this company down.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agents/agentRunner.js';
import { openRouterFallbackModel } from '../agents/openrouter.js';

let tmpDir;
let originalFetch;
const KEYS = ['OPENROUTER_API_KEY', 'OPENROUTER_FALLBACK_MODEL', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
const saved = {};

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-orfallback-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  originalFetch = global.fetch;
  for (const k of KEYS) saved[k] = process.env[k];
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  global.fetch = originalFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  global.fetch = originalFetch;
  for (const k of KEYS) delete process.env[k];
  process.env.OPENROUTER_API_KEY = 'or-key';
});

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

function stubOpenRouter(text, capture = []) {
  global.fetch = async (url, init) => {
    capture.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 15, completion_tokens: 30 },
      }),
    };
  };
}

const SOLO = { solo: { id: 'solo', title: 'Solo', department: 'T', reportsTo: null, reports: [], systemPrompt: 'x' } };
const BOSS = {
  boss: { id: 'boss', title: 'Boss', department: 'E', reportsTo: null, reports: ['aide'], systemPrompt: 'x' },
  aide: { id: 'aide', title: 'Aide', department: 'E', reportsTo: 'boss', reports: [], systemPrompt: 'y' },
};

test('OpenRouter answers when Anthropic is out of credit and nothing else is set', async () => {
  const sent = [];
  stubOpenRouter('OpenRouter took it.', sent);
  const anthropic = { messages: { create: async () => { throw apiError(400, 'Your credit balance is too low'); } } };

  const { text } = await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'OpenRouter took it.');
  assert.match(sent[0].url, /openrouter\.ai/);
});

test('the fallback model is configurable, so it can be the same model billed elsewhere', async () => {
  const sent = [];
  process.env.OPENROUTER_FALLBACK_MODEL = 'anthropic/claude-sonnet-5';
  stubOpenRouter('Same model, different account.', sent);
  const anthropic = { messages: { create: async () => { throw apiError(400, 'Your credit balance is too low'); } } };

  await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(sent[0].body.model, 'anthropic/claude-sonnet-5');
  assert.equal(openRouterFallbackModel(), 'anthropic/claude-sonnet-5');
});

test('OpenRouter comes after OpenAI when both are configured', async () => {
  const seen = [];
  process.env.OPENAI_API_KEY = 'oa-key';
  global.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'answered' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  };
  const anthropic = { messages: { create: async () => { throw apiError(529, 'overloaded'); } } };

  await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.match(seen[0], /openai\.com/, 'OpenAI is tried first with default models');
  assert.equal(seen.length, 1, 'a working backup ends the chain');
});

test('a failing tier provider is not asked again as a backup', async () => {
  // The cheap tier already routes to OpenRouter. When that is the thing
  // refusing us, retrying it as a backup is a guaranteed second failure.
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: false, status: 401, text: async () => 'Missing Authentication header' };
  };

  const agents = {
    leaf: { id: 'leaf', title: 'Leaf', department: 'T', reportsTo: null, reports: [], modelTier: 'specialist', systemPrompt: 'x' },
  };
  const anthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Anthropic picked it up.' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    },
  };

  const { text } = await runAgent({ anthropic, agents, agentId: 'leaf', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'Anthropic picked it up.');
  assert.equal(calls.filter((u) => u.includes('openrouter.ai')).length, 1, 'OpenRouter is tried once, not twice');
});

test('a tiered agent still reaches the backups when Anthropic is down too', async () => {
  // Previously this agent gave up here, while a plain Anthropic agent in the
  // same outage had two more options left.
  process.env.OPENAI_API_KEY = 'oa-key';
  global.fetch = async (url) => {
    if (String(url).includes('openrouter.ai')) return { ok: false, status: 401, text: async () => 'bad key' };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'OpenAI caught it.' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  };

  const agents = {
    leaf: { id: 'leaf', title: 'Leaf', department: 'T', reportsTo: null, reports: [], modelTier: 'specialist', systemPrompt: 'x' },
  };
  const anthropic = { messages: { create: async () => { throw apiError(529, 'overloaded'); } } };

  const { text } = await runAgent({ anthropic, agents, agentId: 'leaf', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'OpenAI caught it.');
});

test('an orchestrator answering through OpenRouter still says it is alone', async () => {
  stubOpenRouter('My own read.');
  const anthropic = { messages: { create: async () => { throw apiError(401, 'invalid key'); } } };

  const { text } = await runAgent({ anthropic, agents: BOSS, agentId: 'boss', messages: [{ role: 'user', content: 'hi' }] });

  assert.match(text, /without the team/i);
});

// --- The catalogue lookup, added after "nousresearch/hermes-4-70b" retired ---

test('listAffordableModels sorts by output price and converts to per-MTok', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'pricey/model', context_length: 8000, pricing: { prompt: '0.000002', completion: '0.00001' } },
        { id: 'cheap/model', context_length: 32000, pricing: { prompt: '0.00000013', completion: '0.0000004' } },
        { id: 'broken/model', context_length: 1000, pricing: {} },
      ],
    }),
  });
  try {
    const { listAffordableModels } = await import('../agents/openrouter.js');
    const models = await listAffordableModels();
    assert.deepEqual(models.map((m) => m.id), ['cheap/model'], 'the $10/MTok model is over the ceiling');
    assert.equal(models[0].inputPricePerMTok, 0.13, 'per-token strings become per-million-token numbers');
    assert.equal(models[0].outputPricePerMTok, 0.4);
  } finally {
    global.fetch = realFetch;
  }
});

test('a search beats the price ceiling', async () => {
  // Asking for "hermes" and getting nothing because every Hermes is a cent
  // too expensive would be the tool refusing the question it was asked.
  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'nousresearch/hermes-9-expensive', pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'someone/else', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
      ],
    }),
  });
  try {
    const { listAffordableModels } = await import('../agents/openrouter.js');
    const models = await listAffordableModels({ search: 'hermes' });
    assert.deepEqual(models.map((m) => m.id), ['nousresearch/hermes-9-expensive']);
  } finally {
    global.fetch = realFetch;
  }
});
