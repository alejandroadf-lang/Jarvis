// Gemini's API differs from the other two providers in three ways that all
// have to be handled in the client rather than by callers: the key goes in a
// query parameter, "assistant" is called "model", and text lives in a parts
// array. Each of those is a silent-wrong-answer bug if it regresses, so each
// has a test.
//
// The chain tests matter most: two backups exist specifically so that one
// dead provider isn't still a single point of failure.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompletion } from '../agents/gemini.js';
import { runAgent } from '../agents/agentRunner.js';
import { resolveModelForAgent, MODELS, GEMINI_TIER, DEFAULT_TIER } from '../agents/models.js';

let tmpDir;
let originalFetch;
const KEYS = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_MODEL'];
const saved = {};

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gemini-test-'));
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
  process.env.GEMINI_API_KEY = 'g-key';
});

function stubGemini(text, capture = []) {
  global.fetch = async (url, init) => {
    capture.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 50 },
      }),
    };
  };
}

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

test('the key travels in the query string, not a header', async () => {
  const sent = [];
  stubGemini('hello', sent);

  await createCompletion({ model: 'gemini-test', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  assert.match(sent[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(sent[0].url, /key=g-key/);
  assert.match(sent[0].url, /models\/gemini-test:generateContent/);
});

test('assistant turns are renamed to "model" — Gemini rejects the other name', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({
    system: 'sys',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ],
    maxTokens: 100,
  });

  assert.deepEqual(sent[0].body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(sent[0].body.contents[1].parts[0].text, 'second');
});

test('the system prompt goes to systemInstruction, not into the transcript', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({ system: 'You are the CFO.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  assert.equal(sent[0].body.systemInstruction.parts[0].text, 'You are the CFO.');
  assert.equal(sent[0].body.contents.length, 1, 'the system prompt must not also appear as a turn');
});

test('content blocks are flattened to text', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'b' }] }],
    maxTokens: 100,
  });

  assert.equal(sent[0].body.contents[0].parts[0].text, 'a\nb');
});

test('the reply comes back in the shape every caller already reads', async () => {
  stubGemini('The answer.');

  const response = await createCompletion({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  assert.equal(response.stop_reason, 'end_turn');
  assert.equal(response.content[0].text, 'The answer.');
  assert.equal(response.usage.input_tokens, 25);
  assert.equal(response.usage.output_tokens, 50);
});

test('a failure carries its status so the retry policy treats it like the others', async () => {
  global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });

  await assert.rejects(
    () => createCompletion({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 }),
    (err) => err.status === 429
  );
});

// --- The backup chain -------------------------------------------------------

test('Gemini answers when Anthropic is out of credit and OpenAI is not set', async () => {
  stubGemini('Gemini took it.');
  const anthropic = {
    messages: { create: async () => { throw apiError(400, 'Your credit balance is too low'); } },
  };
  const agents = { solo: { id: 'solo', title: 'Solo', department: 'T', reportsTo: null, reports: [], systemPrompt: 'x' } };

  const { text } = await runAgent({ anthropic, agents, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'Gemini took it.');
});

test('when OpenAI is also dead, Gemini still catches it', async () => {
  // One backup is still a single point of failure. This is the case the
  // second one exists for.
  global.fetch = async (url) => {
    if (String(url).includes('openai.com')) return { ok: false, status: 500, text: async () => 'openai down' };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Gemini caught it.' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
      }),
    };
  };
  process.env.OPENAI_API_KEY = 'o-key';

  const anthropic = { messages: { create: async () => { throw apiError(529, 'overloaded'); } } };
  const agents = { solo: { id: 'solo', title: 'Solo', department: 'T', reportsTo: null, reports: [], systemPrompt: 'x' } };

  const { text } = await runAgent({ anthropic, agents, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'Gemini caught it.');
});

test('when every provider fails, the Anthropic error is what surfaces', async () => {
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'also down' });
  process.env.OPENAI_API_KEY = 'o-key';

  const anthropic = {
    messages: { create: async () => { throw apiError(400, 'Your credit balance is too low'); } },
  };
  const agents = { solo: { id: 'solo', title: 'Solo', department: 'T', reportsTo: null, reports: [], systemPrompt: 'x' } };

  // The founder needs the actionable one — the provider the company is meant
  // to run on — not whichever backup happened to fail last.
  await assert.rejects(
    () => runAgent({ anthropic, agents, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] }),
    /credit balance/
  );
});

test('the Gemini tier is leaf-only, like every other alternative', () => {
  const leaf = { id: 'leaf', reports: [], actions: [], serverTools: [], modelTier: GEMINI_TIER };
  const orchestrator = { id: 'boss', reports: ['leaf'], actions: [], serverTools: [], modelTier: GEMINI_TIER };

  assert.equal(resolveModelForAgent(leaf, false).provider, 'gemini');
  assert.equal(resolveModelForAgent(orchestrator, false), MODELS[DEFAULT_TIER]);

  delete process.env.GEMINI_API_KEY;
  assert.equal(resolveModelForAgent(leaf, false), MODELS[DEFAULT_TIER]);
});
