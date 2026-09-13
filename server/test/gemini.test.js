// Gemini now goes through Google's OpenAI-compatible endpoint rather than the
// native generateContent one.
//
// The native API differs from everyone else's in three ways — key in a query
// parameter, "assistant" renamed to "model", text inside a `parts` array — and
// this file used to test each of those. Tool calling is what changed the
// arithmetic: native Gemini has function calling in its own vocabulary, so
// supporting it natively meant a second translation layer to keep in step with
// the OpenAI one forever. The compatibility endpoint speaks the protocol the
// other three providers already speak.
//
// So these tests now assert the compatibility shape, and the translation itself
// is tested once in toolTranslation.test.js rather than per provider. The
// chain tests matter most either way: two backups exist specifically so one
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
    capture.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return {
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: text } }],
        usage: { prompt_tokens: 25, completion_tokens: 50 },
      }),
    };
  };
}

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

test('it posts to the OpenAI-compatible endpoint with a bearer key', async () => {
  const sent = [];
  stubGemini('hello', sent);

  await createCompletion({ model: 'gemini-test', system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  assert.match(sent[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(sent[0].url, /\/openai\/chat\/completions$/);
  assert.equal(sent[0].headers.Authorization, 'Bearer g-key');
  // The key must no longer be in the URL: a URL is logged by every proxy and
  // error tracker in the path, which is the same reason api-authentication
  // tells the team never to put a key in a query string.
  assert.doesNotMatch(sent[0].url, /key=/);
  assert.equal(sent[0].body.model, 'gemini-test');
});

// A "models/" prefix is valid in the native API and a 404 on the compatibility
// endpoint — exactly the kind of difference that reads as "Gemini is broken".
test('a native-style "models/" prefix is stripped', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({ model: 'models/gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 });

  assert.equal(sent[0].body.model, 'gemini-2.0-flash');
});

test('the system prompt is the first message, not a separate field', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({ system: 'You are the CFO.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  assert.deepEqual(sent[0].body.messages[0], { role: 'system', content: 'You are the CFO.' });
  assert.equal(sent[0].body.messages.length, 2);
});

test('assistant turns keep the name every other provider uses', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ],
    maxTokens: 100,
  });

  assert.deepEqual(sent[0].body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('the reply comes back in the shape every caller already reads', async () => {
  stubGemini('The answer.');

  const response = await createCompletion({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  assert.equal(response.stop_reason, 'end_turn');
  assert.equal(response.content[0].text, 'The answer.');
  assert.equal(response.usage.input_tokens, 25);
  assert.equal(response.usage.output_tokens, 50);
});

// The whole reason for the switch: an orchestrator can delegate from here.
test('tools are sent, so an orchestrator can run on Gemini', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 100,
    tools: [{ name: 'consult_cto', description: 'Ask the CTO.', input_schema: { type: 'object', properties: {} } }],
  });

  assert.equal(sent[0].body.tools[0].function.name, 'consult_cto');
  assert.equal(sent[0].body.tool_choice, 'auto');
});

test('no tools means no tools field at all, not an empty one', async () => {
  const sent = [];
  stubGemini('ok', sent);

  await createCompletion({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });

  assert.equal(sent[0].body.tools, undefined, 'an empty tools array is a 400 on some providers');
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
        choices: [{ finish_reason: 'stop', message: { content: 'Gemini caught it.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
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

// No longer leaf-only: an orchestrator assigned this tier runs here and keeps
// its reports, because the compatibility endpoint carries tools. Still opt-in
// and still inert without a key.
test('the Gemini tier takes orchestrators too, and stays inert without a key', () => {
  const leaf = { id: 'leaf', reports: [], actions: [], serverTools: [], modelTier: GEMINI_TIER };
  const orchestrator = { id: 'boss', reports: ['leaf'], actions: [], serverTools: [], modelTier: GEMINI_TIER };

  assert.equal(resolveModelForAgent(leaf, false).provider, 'gemini');
  assert.equal(resolveModelForAgent(orchestrator, false).provider, 'gemini');

  delete process.env.GEMINI_API_KEY;
  assert.equal(resolveModelForAgent(leaf, false), MODELS[DEFAULT_TIER]);
  assert.equal(resolveModelForAgent(orchestrator, false), MODELS[DEFAULT_TIER]);
});
