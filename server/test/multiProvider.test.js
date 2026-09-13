// Four tiers were defined and two of them — OpenAI and Gemini — were used by
// no agent at all. They existed only as fallbacks, which meant the company
// had three providers configured and had never deliberately run a single
// turn on two of them. The fourth capability in this codebase found sitting
// behind a door nothing opened.
//
// Assignment is configuration rather than code because nobody here has
// measured which model is better at sizing a market or drafting an outreach
// email. Picking by reputation is exactly the confident guess this project
// keeps getting caught by, so the founder moves an agent in one variable and
// watches what happens.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let models;
let orgChart;
const KEYS = ['AGENT_MODEL_TIERS', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_MODEL'];
const saved = {};

before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  models = await import('../agents/models.js');
  orgChart = await import('../agents/orgChart.js');
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

function resolve(agentId) {
  return models.resolveModelForAgent(orgChart.AGENTS[agentId], false).model;
}

test('a leaf agent can be moved to any provider from one variable', () => {
  process.env.DEEPSEEK_API_KEY = 'd';
  process.env.GEMINI_API_KEY = 'g';
  process.env.OPENAI_API_KEY = 'o';
  process.env.AGENT_MODEL_TIERS = 'qa_engineer:reasoner,brand_strategist:analyst,hr_manager:assistant';

  assert.equal(resolve('qa_engineer'), 'deepseek-chat');
  assert.equal(resolve('brand_strategist'), 'gemini-2.0-flash');
  assert.equal(resolve('hr_manager'), 'gpt-4o-mini');
});

test('an orchestrator cannot be moved, however the variable is set', () => {
  // The rule that makes the whole thing safe. A non-Anthropic call here is a
  // plain completion with no tool loop, so moving an agent that delegates
  // would silently strip its ability to delegate — a vague answer rather
  // than an error, which is far worse than a bigger bill.
  process.env.DEEPSEEK_API_KEY = 'd';
  process.env.AGENT_MODEL_TIERS = 'ceo:reasoner,cto:reasoner,engineering_lead:reasoner';

  assert.equal(resolve('ceo'), 'claude-sonnet-5');
  assert.equal(resolve('cto'), 'claude-sonnet-5');
  assert.equal(resolve('engineering_lead'), 'claude-sonnet-5', 'it holds deploy_code — it must keep its tools');
});

test('an agent with web search stays on the frontier model', () => {
  // An alternative provider gets no server tools, so a researcher moved off
  // Anthropic would quietly stop being able to search and start answering
  // from memory.
  process.env.GEMINI_API_KEY = 'g';
  process.env.AGENT_MODEL_TIERS = 'seo_specialist:analyst';
  const agent = orgChart.AGENTS.seo_specialist;
  if ((agent.serverTools || []).length) {
    assert.equal(resolve('seo_specialist'), 'claude-sonnet-5');
  }
});

test('an assignment whose provider has no key falls back rather than failing', () => {
  // Setting the variable before the key is the obvious order to do it in.
  process.env.AGENT_MODEL_TIERS = 'qa_engineer:reasoner';
  assert.equal(resolve('qa_engineer'), 'claude-sonnet-5');
});

test('a malformed entry is dropped, not fatal', () => {
  // Read on every agent resolution, so a typo taking the roster down would
  // turn a slip into an outage.
  process.env.DEEPSEEK_API_KEY = 'd';
  process.env.AGENT_MODEL_TIERS = 'qa_engineer:reasoner,,nonsense,qa_engineer:no_such_tier';
  assert.deepEqual(models.agentTierOverrides(), { qa_engineer: 'reasoner' }, 'an unknown tier is dropped');
});

test('a mistyped agent id is harmless but silent — pinned so it stays known', () => {
  // It is kept and never matches, so the assignment looks fine and does
  // nothing. Validating ids here would mean importing the rosters, and the
  // rosters import this file; the honest fix is to know it, not to hide it.
  process.env.DEEPSEEK_API_KEY = 'd';
  process.env.AGENT_MODEL_TIERS = 'qa_enginer:reasoner';
  assert.deepEqual(models.agentTierOverrides(), { qa_enginer: 'reasoner' });
  assert.equal(resolve('qa_engineer'), 'claude-sonnet-5', 'the real agent is untouched');
});

test('DeepSeek is priced, because a tier that looks free stops being capped', () => {
  // Number('') is 0 and 0 passes ">= 0" — the trap that already metered two
  // providers at nothing. Every tier gets the same check from now on.
  for (const tier of Object.keys(models.MODELS)) {
    const spec = models.MODELS[tier];
    assert.ok(spec.inputPricePerMTok > 0, `${tier} input price is not real`);
    assert.ok(spec.outputPricePerMTok > 0, `${tier} output price is not real`);
  }
});

test('the DeepSeek model name is overridable without a redeploy', () => {
  process.env.DEEPSEEK_MODEL = 'deepseek-reasoner';
  assert.equal(models.MODELS[models.DEEPSEEK_TIER].model, 'deepseek-reasoner');
});

test('every provider is reachable as a fallback, not only as an assignment', async () => {
  // The failure this protects against: Anthropic is down, and the company
  // has four configured providers and no route to three of them.
  const runner = await import('../agents/agentRunner.js');
  const names = (runner.__backupProvidersForTests?.() || []).map((p) => p.name);
  if (names.length) {
    for (const expected of ['OpenAI', 'Gemini', 'DeepSeek', 'OpenRouter']) {
      assert.ok(names.includes(expected), `${expected} is not in the fallback chain`);
    }
  }
});
