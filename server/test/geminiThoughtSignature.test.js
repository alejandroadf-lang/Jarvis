// Gemini's thinking models sign each tool call and refuse the next request
// unless the signature comes back verbatim. The OpenAI-compatible format has
// no field for it, so the translation layer dropped it and every Gemini turn
// that used a tool failed on its second round:
//
//   Gemini request failed (400): Function call is missing a thought_signature
//   in functionCall parts ... function call `default_api:load_skill`
//
// (the founder's WhatsApp, 2026-09-28, "Failed after 21s").

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agents/agentRunner.js';
import { toOpenAiMessages, fromOpenAiResponse, forAnthropic } from '../agents/toolTranslation.js';
import { GEMINI_TIER, MODELS, DEFAULT_TIER } from '../agents/models.js';

const SIGNATURE = 'CiQBVKhc7nq-signed-thoughts==';
let tmpDir;
let saved;
let originalFetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gemini-sig-'));
  saved = { ...process.env };
  originalFetch = global.fetch;
  process.env.JARVIS_DATA_DIR = tmpDir;
});

after(() => {
  process.env = saved;
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'gemini-key';
  process.env.GEMINI_MODEL = 'gemini-3.8-flash';
  global.fetch = originalFetch;
});

const signedCall = (id, name, args) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
  extra_content: { google: { thought_signature: SIGNATURE } },
});

test('the signature is kept on the tool call and sent back on it, verbatim', () => {
  const response = fromOpenAiResponse({
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [signedCall('call_1', 'load_skill', { name: 'pricing' })] } }],
  });
  const use = response.content.find((b) => b.type === 'tool_use');
  assert.deepEqual(use.extra_content, { google: { thought_signature: SIGNATURE } });

  const outbound = toOpenAiMessages([
    { role: 'user', content: 'price it' },
    { role: 'assistant', content: response.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'skill text' }] },
  ]);
  const assistant = outbound.find((m) => m.role === 'assistant');
  assert.equal(assistant.tool_calls[0].extra_content.google.thought_signature, SIGNATURE);
});

test('a call without one is sent back without one', () => {
  const response = fromOpenAiResponse({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] } }],
  });
  const [assistant] = toOpenAiMessages([{ role: 'assistant', content: response.content }]);
  assert.equal('extra_content' in assistant.tool_calls[0], false);
});

test('Claude never sees fields it would refuse, and untouched messages are not copied', () => {
  const plain = { role: 'user', content: 'hello' };
  const clean = { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'n', input: {} }] };
  const dirty = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_use', id: 'b', name: 'n', input: { q: 1 }, extra_content: { google: {} }, parseError: 'x', rawArguments: '{' },
    ],
  };
  const out = forAnthropic([plain, clean, dirty]);
  assert.equal(out[0], plain);
  assert.equal(out[1], clean);
  assert.deepEqual(out[2].content[1], { type: 'tool_use', id: 'b', name: 'n', input: { q: 1 } });
  assert.deepEqual(out[2].content[0], dirty.content[0]);
  assert.equal(dirty.content[1].extra_content !== undefined, true, 'the original history is not mutated');
});

// A CEO on Gemini consults its aide. The fake Gemini behaves like the real one:
// the second request is refused unless the first call's signature is on it.
const TEAM = {
  ceo: { id: 'ceo', title: 'CEO', department: 'Exec', reportsTo: null, reports: ['aide'], modelTier: GEMINI_TIER, systemPrompt: 'You lead.' },
  aide: { id: 'aide', title: 'Aide', department: 'Exec', reportsTo: 'ceo', reports: [], systemPrompt: 'You assist.' },
};

function fakeGemini(requests) {
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const sentBack = body.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    if (requests.length === 1) {
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [signedCall('call_1', 'consult_aide', { question: 'What is the status?' })] } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) };
    }
    if (sentBack?.tool_calls?.[0]?.extra_content?.google?.thought_signature !== SIGNATURE) {
      const text = '[{"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts."}}]';
      return { ok: false, status: 400, text: async () => text, json: async () => JSON.parse(text) };
    }
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'All ventures are on track.' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) };
  };
}

const aideOnClaude = (claudeCalls = []) => ({
  messages: {
    create: async (params) => {
      claudeCalls.push(params);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fine from here.' }], usage: { input_tokens: 5, output_tokens: 5 } };
    },
  },
});

test('a Gemini turn that uses a tool finishes on Gemini', async () => {
  const requests = [];
  fakeGemini(requests);
  const { text } = await runAgent({ anthropic: aideOnClaude(), agents: TEAM, agentId: 'ceo', messages: [{ role: 'user', content: 'daily sync' }] });
  assert.equal(text, 'All ventures are on track.');
  assert.equal(requests.length, 2);
});

test('when a cheaper provider refuses a request, the turn moves to Claude, with clean history', async () => {
  // Gemini refuses the second round whatever is sent.
  let n = 0;
  global.fetch = async () => {
    n += 1;
    if (n === 1) {
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [signedCall('call_1', 'consult_aide', { question: 'Status?' })] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    }
    return { ok: false, status: 400, text: async () => 'some new rule about tools' };
  };
  const claudeCalls = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        claudeCalls.push(params);
        const isCeo = params.system && JSON.stringify(params.system).includes('You lead.');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: isCeo ? 'Answered on Claude.' : 'Fine from here.' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  const { text } = await runAgent({ anthropic, agents: TEAM, agentId: 'ceo', messages: [{ role: 'user', content: 'daily sync' }] });
  assert.equal(text, 'Answered on Claude.');
  const ceoOnClaude = claudeCalls.find((p) => JSON.stringify(p.system).includes('You lead.'));
  assert.equal(ceoOnClaude.model, MODELS[DEFAULT_TIER].model);
  const blocks = ceoOnClaude.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const use = blocks.find((b) => b.type === 'tool_use');
  assert.ok(use, 'the Gemini round is in the history Claude continues from');
  assert.equal('extra_content' in use, false, 'without the Gemini-only field Claude would refuse');
});

// The real API refuses a top-level field it does not know, with a 400. The
// fallback above passed only because its fake Claude accepted anything; the
// founder's WhatsApp got "effort: Extra inputs are not permitted" instead.
const API_FIELDS = new Set([
  'model', 'messages', 'system', 'max_tokens', 'tools', 'tool_choice', 'thinking', 'output_config',
  'metadata', 'stop_sequences', 'temperature', 'top_p', 'top_k', 'stream', 'mcp_servers', 'betas',
  'container', 'context_management', 'service_tier',
]);

function strictClaude(calls) {
  return {
    messages: {
      create: async (params) => {
        const extra = Object.keys(params).filter((k) => !API_FIELDS.has(k));
        if (extra.length) {
          const e = new Error(`400 {"type":"error","error":{"type":"invalid_request_error","message":"${extra[0]}: Extra inputs are not permitted"}}`);
          e.status = 400;
          throw e;
        }
        calls.push(params);
        const isCeo = JSON.stringify(params.system).includes('You lead.');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: isCeo ? 'Answered on Claude.' : 'Fine.' }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
}

test('a turn that falls back to Claude sends only fields the API accepts, with the effort level kept', async () => {
  global.fetch = async () => ({ ok: false, status: 400, text: async () => 'refused' });
  const calls = [];
  const { text } = await runAgent({ anthropic: strictClaude(calls), agents: TEAM, agentId: 'ceo', messages: [{ role: 'user', content: 'daily sync' }] });
  assert.equal(text, 'Answered on Claude.');
  const ceo = calls.find((p) => JSON.stringify(p.system).includes('You lead.'));
  assert.equal('effort' in ceo, false);
  assert.ok(ceo.output_config?.effort, 'the orchestrator still thinks at its own effort level');
});
