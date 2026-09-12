// OpenAI does three jobs here and each has a different failure worth pinning
// down: it transcribes voice notes, it answers when Anthropic can't, and it
// can run leaf agents as a tier.
//
// The fallback tests matter most. The first real question ever asked of this
// company over WhatsApp came back as a raw "credit balance is too low" error,
// which is the exact case these cover.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agents/agentRunner.js';
import { resolveModelForAgent, MODELS, OPENAI_TIER, DEFAULT_TIER } from '../agents/models.js';

let tmpDir;
let savedKey;
let originalFetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-openai-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  savedKey = process.env.OPENAI_API_KEY;
  originalFetch = global.fetch;
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = originalFetch;
});

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Stands in for OpenAI's HTTP API, which agents/openai.js calls with fetch.
function stubOpenAI(text, capture = []) {
  global.fetch = async (url, init) => {
    capture.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 30, completion_tokens: 60 },
      }),
    };
  };
}

const SOLO = {
  solo: { id: 'solo', title: 'Solo', department: 'Test', reportsTo: null, reports: [], systemPrompt: 'You are alone.' },
};

const BOSS = {
  boss: { id: 'boss', title: 'Boss', department: 'Exec', reportsTo: null, reports: ['aide'], systemPrompt: 'You lead.' },
  aide: { id: 'aide', title: 'Aide', department: 'Exec', reportsTo: 'boss', reports: [], systemPrompt: 'You assist.' },
};

test('an out-of-credit Anthropic account falls back to OpenAI instead of going silent', async () => {
  const sent = [];
  stubOpenAI('Here is the answer.', sent);
  const anthropic = {
    messages: {
      create: async () => {
        throw apiError(400, 'Your credit balance is too low to access the Anthropic API.');
      },
    },
  };

  const { text } = await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'Here is the answer.');
  assert.equal(sent.length, 1, 'exactly one OpenAI call');
  assert.match(sent[0].url, /api\.openai\.com/);
});

test('a genuine bad request still throws — only outages fail over', async () => {
  stubOpenAI('should never be reached');
  const anthropic = {
    messages: { create: async () => { throw apiError(400, 'messages.0.content: field required'); } },
  };

  await assert.rejects(
    () => runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] }),
    /field required/,
    'a malformed request must surface as a bug, not be papered over by another provider'
  );
});

test('an agent that delegates says so when it answers alone', async () => {
  stubOpenAI('My own read on it.');
  const anthropic = {
    messages: { create: async () => { throw apiError(401, 'invalid x-api-key'); } },
  };

  const { text } = await runAgent({ anthropic, agents: BOSS, agentId: 'boss', messages: [{ role: 'user', content: 'hi' }] });

  // Passing one model's guess off as the team's considered answer would be
  // the dishonest version of this feature.
  assert.match(text, /without the team/i);
  assert.match(text, /My own read on it\./);
});

test('a leaf agent answering alone is not labelled — it lost nothing', async () => {
  stubOpenAI('Plain answer.');
  const anthropic = {
    messages: { create: async () => { throw apiError(503, 'upstream unavailable'); } },
  };

  const { text } = await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'Plain answer.');
});

test('with no OpenAI key the original Anthropic error surfaces unchanged', async () => {
  delete process.env.OPENAI_API_KEY;
  const anthropic = {
    messages: { create: async () => { throw apiError(400, 'Your credit balance is too low') } },
  };

  await assert.rejects(
    () => runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] }),
    /credit balance/
  );
});

test('a fallback call is priced on OpenAI rates, not the Anthropic ones that failed', async () => {
  stubOpenAI('Answer.');
  const anthropic = {
    messages: { create: async () => { throw apiError(429, 'rate limited'); } },
  };

  const { usage } = await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  // 30 in / 60 out at the OpenAI tier's rates, not claude-sonnet-5's.
  const openai = MODELS[OPENAI_TIER];
  const expected = (30 / 1e6) * openai.inputPricePerMTok + (60 / 1e6) * openai.outputPricePerMTok;
  assert.ok(Math.abs(usage.costUsd - expected) < 1e-9, `costUsd was ${usage.costUsd}, expected ${expected}`);
});

// --- The tier ---------------------------------------------------------------

test('the OpenAI tier runs leaf agents and is refused to orchestrators', () => {
  const leaf = { id: 'leaf', reports: [], actions: [], serverTools: [], modelTier: OPENAI_TIER };
  const orchestrator = { id: 'boss', reports: ['leaf'], actions: [], serverTools: [], modelTier: OPENAI_TIER };

  assert.equal(resolveModelForAgent(leaf, false).provider, 'openai');
  // Falling back to a plain completion would silently strip delegation —
  // worse than a bigger bill, and invisible in the reply.
  assert.equal(resolveModelForAgent(orchestrator, false), MODELS[DEFAULT_TIER]);
});

test('without an OpenAI key the tier collapses to the default', () => {
  delete process.env.OPENAI_API_KEY;
  const leaf = { id: 'leaf', reports: [], actions: [], serverTools: [], modelTier: OPENAI_TIER };
  assert.equal(resolveModelForAgent(leaf, false), MODELS[DEFAULT_TIER]);
});

test('the tier model and its prices follow the environment', () => {
  const savedModel = process.env.OPENAI_MODEL;
  const savedPrice = process.env.OPENAI_INPUT_PRICE_PER_MTOK;
  try {
    process.env.OPENAI_MODEL = 'some-newer-model';
    process.env.OPENAI_INPUT_PRICE_PER_MTOK = '1.25';
    // Read live rather than frozen at import: OpenAI retires model names
    // faster than this repo gets edited, and the spend cap meters on price.
    assert.equal(MODELS[OPENAI_TIER].model, 'some-newer-model');
    assert.equal(MODELS[OPENAI_TIER].inputPricePerMTok, 1.25);
  } finally {
    if (savedModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = savedModel;
    if (savedPrice === undefined) delete process.env.OPENAI_INPUT_PRICE_PER_MTOK; else process.env.OPENAI_INPUT_PRICE_PER_MTOK = savedPrice;
  }
});
