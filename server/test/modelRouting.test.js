// Covers the two properties that make cheap-model routing safe rather than
// just cheaper: an agent only leaves the default model if its turn genuinely
// needs nothing but text, and the whole thing is inert until the founder
// configures it. Uses a stubbed global.fetch so no test ever reaches
// OpenRouter (the same pattern deployGithub.test.js uses for GitHub).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agents/agentRunner.js';
import {
  MODELS,
  CHEAP_TIER,
  DEFAULT_TIER,
  resolveModelForAgent,
  canUseAlternativeModel,
} from '../agents/models.js';

let tmpDir;
let savedKey;
let originalFetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-modelrouting-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  savedKey = process.env.OPENROUTER_API_KEY;
  originalFetch = global.fetch;
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  global.fetch = originalFetch;
});

const leaf = { id: 'leaf', reports: [], actions: [], serverTools: [], modelTier: CHEAP_TIER };

test('canUseAlternativeModel admits a bare leaf and refuses anything with tools', () => {
  assert.equal(canUseAlternativeModel(leaf), true);
  assert.equal(canUseAlternativeModel({ ...leaf, reports: ['someone'] }), false);
  assert.equal(canUseAlternativeModel({ ...leaf, actions: [{ name: 'log_revenue' }] }), false);
  assert.equal(canUseAlternativeModel({ ...leaf, serverTools: [{ type: 'web_search_20250305' }] }), false);
});

test('the cheap tier is ignored entirely until OpenRouter is configured', () => {
  assert.equal(resolveModelForAgent(leaf, false).model, MODELS[DEFAULT_TIER].model);
  assert.equal(resolveModelForAgent(leaf, true).model, MODELS[CHEAP_TIER].model);
});

// The important one. An agent that delegates or acts would lose those tools
// on the alternative path, which fails as a vague answer rather than an
// error — so the tier is overridden in code, not just discouraged in a
// comment on the agent definition.
test('a tiered agent that gained an action falls back to the default model', () => {
  const grew = { ...leaf, actions: [{ name: 'deploy_code' }] };
  assert.equal(resolveModelForAgent(grew, true).model, MODELS[DEFAULT_TIER].model);
});

test('an untiered agent stays on the default model even with OpenRouter available', () => {
  assert.equal(resolveModelForAgent({ id: 'x', reports: [] }, true).model, MODELS[DEFAULT_TIER].model);
});

const AGENTS = {
  specialist: {
    id: 'specialist',
    title: 'Specialist',
    department: 'Test',
    reportsTo: null,
    reports: [],
    modelTier: CHEAP_TIER,
    systemPrompt: 'You are a specialist.',
    toolDescription: 'Consult the specialist.',
  },
};

function anthropicThatMustNotBeCalled() {
  return {
    messages: {
      create: async () => {
        throw new Error('Anthropic was called for an agent that should have routed to OpenRouter');
      },
    },
  };
}

test('a tiered leaf actually runs against OpenRouter, and is priced at its rate', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key';

  let sentBody;
  global.fetch = async (url, options) => {
    assert.match(url, /openrouter\.ai/);
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'A specialist opinion.' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    };
  };

  const { text, usage } = await runAgent({
    anthropic: anthropicThatMustNotBeCalled(),
    agents: AGENTS,
    agentId: 'specialist',
    messages: [{ role: 'user', content: 'What do you think?' }],
  });

  assert.equal(text, 'A specialist opinion.');
  assert.equal(sentBody.model, MODELS[CHEAP_TIER].model);
  // The system prompt has to survive the hop, or the agent loses its persona.
  assert.equal(sentBody.messages[0].role, 'system');
  assert.match(sentBody.messages[0].content, /You are a specialist/);

  // 1M in + 1M out: $12 on the default model, well under $1 here.
  assert.equal(usage.inputTokens, 1_000_000);
  assert.ok(usage.costUsd < 1, `expected cheap-tier pricing, got ${usage.costUsd}`);
});

test('with no OpenRouter key the same agent goes to Anthropic instead', async () => {
  global.fetch = async () => {
    throw new Error('OpenRouter was called despite no OPENROUTER_API_KEY');
  };

  const anthropic = {
    messages: {
      create: async (params) => {
        assert.equal(params.model, MODELS[DEFAULT_TIER].model);
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Claude answered.' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  };

  const { text } = await runAgent({
    anthropic,
    agents: AGENTS,
    agentId: 'specialist',
    messages: [{ role: 'user', content: 'What do you think?' }],
  });
  assert.equal(text, 'Claude answered.');
});

test('an OpenRouter failure surfaces its status so the runner can retry it', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Second time lucky.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    };
  };

  const { text } = await runAgent({
    anthropic: anthropicThatMustNotBeCalled(),
    agents: AGENTS,
    agentId: 'specialist',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(calls, 2, 'a 429 from OpenRouter should be retried like one from Anthropic');
  assert.equal(text, 'Second time lucky.');
});

// The daily dollar cap is the company's one hard budget ceiling, and adding
// a second provider is exactly the kind of change that could route around
// it. Both of these assert it didn't.
test('the daily spend cap blocks an OpenRouter call, not just an Anthropic one', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  const savedCap = process.env.DAILY_SPEND_CAP_USD;
  process.env.DAILY_SPEND_CAP_USD = '0.01';

  const { recordSpend } = await import('../spend.js');
  recordSpend(5); // blow through the cap before the call is attempted

  let reached = false;
  global.fetch = async () => {
    reached = true;
    throw new Error('unreachable');
  };

  try {
    await assert.rejects(
      runAgent({
        anthropic: anthropicThatMustNotBeCalled(),
        agents: AGENTS,
        agentId: 'specialist',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      /Daily spend cap reached/
    );
    assert.equal(reached, false, 'the cap must stop the call before it goes out, not after');
  } finally {
    if (savedCap === undefined) delete process.env.DAILY_SPEND_CAP_USD;
    else process.env.DAILY_SPEND_CAP_USD = savedCap;
    fs.rmSync(path.join(tmpDir, 'spend.json'), { force: true });
  }
});

test('spend from an OpenRouter call is recorded against the same daily ledger', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  const { getSpendToday } = await import('../spend.js');
  const before = getSpendToday();

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    }),
  });

  try {
    await runAgent({
      anthropic: anthropicThatMustNotBeCalled(),
      agents: AGENTS,
      agentId: 'specialist',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.ok(getSpendToday() > before, 'an OpenRouter call must count against the cap');
  } finally {
    fs.rmSync(path.join(tmpDir, 'spend.json'), { force: true });
  }
});

// --- Prices that actually meter ---------------------------------------------
// Number('') is 0, and 0 passes a ">= 0" check, so an unset price variable
// read as a price of zero. Every OpenAI and Gemini fallback call was metered
// at nothing and the daily spend cap quietly stopped counting them — the one
// guardrail standing between a runaway loop and a real bill.
//
// Second time this exact trap has bitten here. The first was a blank
// profit-share percentage silently zeroing every agent's earnings.

test('every tier has a real price with nothing configured', async () => {
  const { MODELS } = await import('../agents/models.js');

  for (const [tier, spec] of Object.entries(MODELS)) {
    assert.ok(spec.inputPricePerMTok > 0, `${tier} input price was ${spec.inputPricePerMTok}`);
    assert.ok(spec.outputPricePerMTok > 0, `${tier} output price was ${spec.outputPricePerMTok}`);
  }
});

test('a blank price variable falls back rather than reading as free', async () => {
  const { MODELS, CHEAP_TIER } = await import('../agents/models.js');
  const saved = process.env.OPENROUTER_INPUT_PRICE_PER_MTOK;
  try {
    // What a dashboard leaves behind when someone types a value and clears it.
    process.env.OPENROUTER_INPUT_PRICE_PER_MTOK = '';
    assert.equal(MODELS[CHEAP_TIER].inputPricePerMTok, 0.13);

    process.env.OPENROUTER_INPUT_PRICE_PER_MTOK = '   ';
    assert.equal(MODELS[CHEAP_TIER].inputPricePerMTok, 0.13);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_INPUT_PRICE_PER_MTOK;
    else process.env.OPENROUTER_INPUT_PRICE_PER_MTOK = saved;
  }
});

test('a real override is honoured, which is the point of the variable', async () => {
  const { MODELS, CHEAP_TIER } = await import('../agents/models.js');
  const saved = process.env.OPENROUTER_MODEL;
  try {
    process.env.OPENROUTER_MODEL = 'some/newer-model';
    assert.equal(MODELS[CHEAP_TIER].model, 'some/newer-model');
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = saved;
  }
});

test('a nonsense price falls back instead of metering at NaN', async () => {
  const { MODELS, CHEAP_TIER } = await import('../agents/models.js');
  const saved = process.env.OPENROUTER_OUTPUT_PRICE_PER_MTOK;
  try {
    process.env.OPENROUTER_OUTPUT_PRICE_PER_MTOK = 'free please';
    assert.equal(MODELS[CHEAP_TIER].outputPricePerMTok, 0.4);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_OUTPUT_PRICE_PER_MTOK;
    else process.env.OPENROUTER_OUTPUT_PRICE_PER_MTOK = saved;
  }
});
