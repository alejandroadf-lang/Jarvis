// Grok (agents/xai.js): the model tier, and the x_search tool the research
// agents use to read posts on X. xAI is replaced by a fake fetch that answers
// in the Responses API's shape: output items, message text with url_citation
// annotations, and usage with the server-side tool counts.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agents/agentRunner.js';
import { xSearchRequest, searchX, X_SEARCH_TOOL } from '../agents/xai.js';
import { MODELS, GROK_TIER, DEFAULT_TIER, resolveModelForAgent, ecoTier } from '../agents/models.js';
import { AGENTS as STUDIO_AGENTS } from '../agents/ideationTeam.js';
import { getSpendToday } from '../spend.js';
import { listSearches } from '../searchLog.js';

let tmpDir;
let saved;
let originalFetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-xai-'));
  saved = { ...process.env };
  originalFetch = global.fetch;
});

after(() => {
  process.env = saved;
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env = { ...saved, JARVIS_DATA_DIR: fs.mkdtempSync(path.join(tmpDir, 'run-')), XAI_API_KEY: 'xai-test-key' };
  for (const k of ['XAI_MODEL', 'XAI_INPUT_PRICE_PER_MTOK', 'XAI_OUTPUT_PRICE_PER_MTOK', 'XAI_X_SEARCH_PRICE_PER_1K',
    'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'AGENT_MODEL_TIERS']) {
    delete process.env[k];
  }
  global.fetch = originalFetch;
});

const ANSWER = {
  output: [
    { type: 'x_search_call', id: 'xs_1', status: 'completed' },
    {
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'About 40 posts in the last month complain that Notion AI is slow on large pages.',
        annotations: [
          { type: 'url_citation', url: 'https://x.com/a/status/1' },
          { type: 'url_citation', url: 'https://x.com/b/status/2' },
          { type: 'url_citation', url: 'https://x.com/a/status/1' },
        ],
      }],
    },
  ],
  usage: { input_tokens: 10_000, output_tokens: 1_000, server_side_tool_usage_details: { x_search_calls: 2 } },
};

function fakeXai(calls, answer = ANSWER, status = 200) {
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => answer,
      text: async () => JSON.stringify(answer),
    };
  };
}

test('the request asks Grok to search X over the right days, from the right accounts', () => {
  const body = xSearchRequest(
    { question: 'What do people hate about Notion AI?', handles: ['@NotionHQ', 'not a handle!', 'levelsio'], days: 7 },
    new Date('2026-09-28T12:00:00Z')
  );
  assert.equal(body.model, 'grok-4.3');
  assert.equal(body.input.at(-1).content, 'What do people hate about Notion AI?');
  assert.deepEqual(body.tools, [{
    type: 'x_search', from_date: '2026-09-21', to_date: '2026-09-28', allowed_x_handles: ['NotionHQ', 'levelsio'],
  }]);
  // No handles means the whole of X, and the lookback is clamped.
  const wide = xSearchRequest({ question: 'q', days: 500 }, new Date('2026-09-28T12:00:00Z'));
  assert.equal('allowed_x_handles' in wide.tools[0], false);
  assert.equal(wide.tools[0].from_date, '2026-06-30');
});

test('a search returns the summary and each cited post once, and is metered', async () => {
  const calls = [];
  fakeXai(calls);
  const metered = [];
  const out = await searchX({ question: 'Notion AI complaints' }, {
    pricing: { inputPricePerMTok: 1.25, outputPricePerMTok: 2.5 },
    meter: (usd, tokens) => metered.push({ usd, tokens }),
  });
  assert.equal(calls[0].url, 'https://api.x.ai/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer xai-test-key');
  assert.match(out, /^About 40 posts/);
  assert.equal(out.match(/x\.com\/a\/status\/1/g).length, 1, 'a post cited twice is listed once');
  assert.match(out, /x\.com\/b\/status\/2/);
  // 10k in at $1.25/M + 1k out at $2.50/M + 2 search calls at $5 per 1,000.
  assert.equal(metered.length, 1);
  assert.ok(Math.abs(metered[0].usd - (0.0125 + 0.0025 + 0.01)) < 1e-9);
});

test('each failure says what to set, and never throws into the agent turn', async () => {
  const pricing = { inputPricePerMTok: 1, outputPricePerMTok: 1 };
  fakeXai([], { error: 'bad key' }, 401);
  assert.match(await searchX({ question: 'q' }, { pricing }), /XAI_API_KEY/);
  fakeXai([], { error: 'The model grok-9 does not exist' }, 404);
  assert.match(await searchX({ question: 'q' }, { pricing }), /XAI_MODEL/);
  global.fetch = async () => { throw new Error('socket hang up'); };
  assert.match(await searchX({ question: 'q' }, { pricing }), /did not answer.*socket hang up/);
  fakeXai([], { output: [] });
  assert.match(await searchX({ question: 'q' }, { pricing }), /came back empty/);
  delete process.env.XAI_API_KEY;
  assert.match(await searchX({ question: 'q' }, { pricing }), /XAI_API_KEY is not set/);
});

// --- in the agent loop ------------------------------------------------------------------

const TEAM = {
  lead: { id: 'lead', title: 'Lead', department: 'Studio', reportsTo: null, reports: ['researcher', 'writer'], systemPrompt: 'You lead.' },
  researcher: {
    id: 'researcher', title: 'Researcher', department: 'Studio', reportsTo: 'lead', reports: [], xSearch: true,
    serverTools: [{ type: 'web_search_20260209', name: 'web_search' }], systemPrompt: 'You research.',
  },
  writer: { id: 'writer', title: 'Writer', department: 'Studio', reportsTo: 'lead', reports: [], systemPrompt: 'You write.' },
};

function claudeThatSearchesX(requests) {
  return {
    messages: {
      create: async (params) => {
        requests.push(params);
        const results = params.messages.at(-1).content;
        if (Array.isArray(results) && results[0]?.type === 'tool_result') {
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: `Found: ${results[0].content.split('\n')[0]}` }], usage: { input_tokens: 1, output_tokens: 1 } };
        }
        return {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'x_search', input: { question: 'Why do people switch away from Notion?' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
}

test('a research agent searches X, stays on Claude, and the search is logged and counted', async () => {
  const xCalls = [];
  fakeXai(xCalls);
  const requests = [];
  const trace = [];
  const { text } = await runAgent({ anthropic: claudeThatSearchesX(requests), agents: TEAM, agentId: 'researcher', messages: [{ role: 'user', content: 'research' }], trace });
  assert.equal(text, 'Found: About 40 posts in the last month complain that Notion AI is slow on large pages.');
  assert.equal(requests[0].model, MODELS[DEFAULT_TIER].model, 'web search keeps it on Claude');
  assert.ok(requests[0].tools.some((t) => t.name === 'x_search'));
  assert.equal(xCalls.length, 1);
  assert.equal(xCalls[0].body.input.at(-1).content, 'Why do people switch away from Notion?');
  assert.ok(trace.some((t) => t.tool === 'x_search' && t.ok));
  assert.ok(getSpendToday() > 0.02, 'the search is in the daily spend');
  assert.match(listSearches().at(-1).query, /^\[X\] Why do people switch/);
});

test('the tool is offered only to agents given it, and only with the key set', async () => {
  const toolsSeen = async (agentId) => {
    const requests = [];
    const anthropic = { messages: { create: async (p) => { requests.push(p); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} }; } } };
    await runAgent({ anthropic, agents: TEAM, agentId, messages: [{ role: 'user', content: 'hi' }] });
    return (requests[0].tools || []).map((t) => t.name);
  };
  assert.ok((await toolsSeen('researcher')).includes('x_search'));
  assert.ok(!(await toolsSeen('writer')).includes('x_search'));
  delete process.env.XAI_API_KEY;
  assert.ok(!(await toolsSeen('researcher')).includes('x_search'), 'no key: no tool that can only fail');
});

test('the studio research agents are the ones with X search', () => {
  const withX = Object.values(STUDIO_AGENTS).filter((a) => a.xSearch).map((a) => a.id).sort();
  assert.deepEqual(withX, ['market_researcher', 'scale_strategist']);
  assert.equal(X_SEARCH_TOOL.input_schema.required[0], 'question');
});

// --- the tier ---------------------------------------------------------------------------

test('grok is a tier like the others: used with a key, Claude without one', () => {
  const leaf = { id: 'copywriter', reports: [], actions: [] };
  process.env.AGENT_MODEL_TIERS = 'copywriter:grok';
  assert.equal(resolveModelForAgent(leaf, false).provider, 'xai');
  assert.equal(resolveModelForAgent(leaf, false).model, 'grok-4.3');
  process.env.XAI_MODEL = 'grok-5';
  assert.equal(MODELS[GROK_TIER].model, 'grok-5');
  delete process.env.XAI_API_KEY;
  assert.equal(resolveModelForAgent(leaf, false).provider, 'anthropic');
});

test('ECO counts Grok among the providers it can pick, by price', () => {
  assert.equal(ecoTier(), GROK_TIER, 'the only key set');
  process.env.DEEPSEEK_API_KEY = 'ds';
  assert.notEqual(ecoTier(), GROK_TIER, 'DeepSeek is cheaper');
});

test('a grok-tier turn goes to xAI chat completions with the key', async () => {
  process.env.AGENT_MODEL_TIERS = 'writer:grok';
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'Drafted on Grok.' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) };
  };
  const { text } = await runAgent({ anthropic: {}, agents: TEAM, agentId: 'writer', messages: [{ role: 'user', content: 'draft' }] });
  assert.equal(text, 'Drafted on Grok.');
  assert.equal(calls[0].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer xai-test-key');
});
