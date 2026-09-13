// Translating tool use between the Anthropic shape this app speaks and the
// OpenAI shape everyone else speaks.
//
// This is the layer that unlocked the company's biggest cost saving: ten of
// twenty-two agents were locked to Anthropic because the other clients could not
// carry tools, so the whole C-suite ran on the most expensive model available —
// by accident of plumbing, not because it needed Claude.
//
// Which makes it the layer most worth testing hard. Every bug here is silent in
// the same direction: a manager that appears to answer, having quietly lost the
// ability to consult anyone. The last test runs a real two-round delegation
// through the loop to prove that end to end, because the unit tests below can
// all pass while the wiring is still wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toOpenAiTools, toOpenAiMessages, fromOpenAiResponse } from '../agents/toolTranslation.js';

// --- Tool definitions -------------------------------------------------------

test('input_schema becomes parameters, nested under a function key', () => {
  const [fn] = toOpenAiTools([
    {
      name: 'consult_cto',
      description: 'Ask the CTO.',
      input_schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    },
  ]);

  assert.equal(fn.type, 'function');
  assert.equal(fn.function.name, 'consult_cto');
  assert.deepEqual(fn.function.parameters.required, ['task']);
});

test('a tool with no schema still gets an empty object, not a missing field', () => {
  // Several providers reject a function declaration with no parameters, which
  // surfaces as a 400 naming a field the caller never set.
  const [fn] = toOpenAiTools([{ name: 'check_daily_plan', description: 'Where the plan stands.' }]);
  assert.deepEqual(fn.function.parameters, { type: 'object', properties: {} });
});

// web_search executes inside Anthropic's infrastructure. There is nothing to
// translate, and sending it would be a 400 rather than a quiet degradation.
test('Anthropic server tools are dropped rather than mistranslated', () => {
  const out = toOpenAiTools([
    { type: 'web_search_20250305', name: 'web_search' },
    { name: 'deploy_code', description: 'Ship it.', input_schema: { type: 'object' } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].function.name, 'deploy_code');
});

// --- Messages ---------------------------------------------------------------

test('a system prompt leads, and plain string turns pass through', () => {
  const out = toOpenAiMessages([{ role: 'user', content: 'hi' }], 'You are the CEO.');
  assert.deepEqual(out, [
    { role: 'system', content: 'You are the CEO.' },
    { role: 'user', content: 'hi' },
  ]);
});

test("an assistant's tool_use blocks become tool_calls with stringified arguments", () => {
  const out = toOpenAiMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me ask.' },
        { type: 'tool_use', id: 'tu_1', name: 'consult_cto', input: { task: 'Is it shippable?' } },
      ],
    },
  ]);

  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'Let me ask.');
  assert.equal(out[0].tool_calls[0].id, 'tu_1');
  // A JSON *string*, not an object — Anthropic carries the object.
  assert.equal(typeof out[0].tool_calls[0].function.arguments, 'string');
  assert.deepEqual(JSON.parse(out[0].tool_calls[0].function.arguments), { task: 'Is it shippable?' });
});

test('tool_calls with no surrounding text get null content, not an empty string', () => {
  const out = toOpenAiMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
  ]);
  assert.equal(out[0].content, null, 'some providers reject "" alongside tool_calls');
});

// The structural difference, and the one most likely to be got wrong. Anthropic
// puts every result for a round inside ONE user message; OpenAI wants one
// message per result, each naming its tool_call_id. Getting this wrong produces
// a provider error about an unanswered tool call that points nowhere near here.
test('one user message of tool_results becomes several tool messages', () => {
  const out = toOpenAiMessages([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'CTO says yes.' },
        { type: 'tool_result', tool_use_id: 'b', content: 'CFO says the margin holds.' },
      ],
    },
  ]);

  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.role), ['tool', 'tool']);
  assert.deepEqual(out.map((m) => m.tool_call_id), ['a', 'b']);
  assert.equal(out[1].content, 'CFO says the margin holds.');
});

test('text sitting alongside tool results is kept, not dropped', () => {
  const out = toOpenAiMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Also, hurry.' },
        { type: 'tool_result', tool_use_id: 'a', content: 'done' },
      ],
    },
  ]);
  assert.deepEqual(out[0], { role: 'user', content: 'Also, hurry.' });
  assert.equal(out[1].role, 'tool');
});

test('a tool_result carrying content blocks is flattened to text', () => {
  const out = toOpenAiMessages([
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }],
    },
  ]);
  assert.equal(out[0].content, 'one\ntwo');
});

// --- Responses --------------------------------------------------------------

// The mapping the loop branches on. Get this wrong and a delegation request is
// read as a final answer, so the manager's reply is an empty string.
test('tool_calls in the response become stop_reason "tool_use"', () => {
  const out = fromOpenAiResponse({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'consult_cfo', arguments: '{"task":"check the margin"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.content[0], { type: 'tool_use', id: 'c1', name: 'consult_cfo', input: { task: 'check the margin' } });
  assert.equal(out.usage.input_tokens, 10);
});

// Some providers report "stop" alongside tool_calls. Believing the finish
// reason over the evidence would drop the delegation on the floor.
test('tool calls win over a contradictory finish_reason', () => {
  const out = fromOpenAiResponse({
    choices: [{ finish_reason: 'stop', message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '{}' } }] } }],
  });
  assert.equal(out.stop_reason, 'tool_use');
});

test('a plain answer is end_turn, and a truncated one is max_tokens', () => {
  assert.equal(fromOpenAiResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }] }).stop_reason, 'end_turn');
  assert.equal(fromOpenAiResponse({ choices: [{ finish_reason: 'length', message: { content: 'Do' } }] }).stop_reason, 'max_tokens');
});

// Malformed arguments are a real failure mode on weaker models, and neither
// obvious handling is acceptable: throwing kills the turn over one recoverable
// mistake, and defaulting to {} silently invokes a real tool with no arguments —
// a consult with no question, or an action with a missing target.
test('malformed tool arguments are marked, not thrown and not silently emptied', () => {
  const out = fromOpenAiResponse({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'deploy_code', arguments: '{"path": "src/main.py"' } }] } }],
  });

  const use = out.content[0];
  assert.equal(use.type, 'tool_use');
  assert.deepEqual(use.input, {});
  assert.ok(use.parseError, 'the runner needs to know not to invoke this');
  assert.match(use.rawArguments, /src\/main\.py/, 'the raw text survives for the error message');
});

test('a JSON scalar is treated as malformed, since a tool input must be an object', () => {
  const out = fromOpenAiResponse({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'x', arguments: '"just a string"' } }] } }],
  });
  assert.ok(out.content[0].parseError);
});

test('absent or empty arguments are simply an empty object', () => {
  for (const args of [undefined, '', '{}']) {
    const out = fromOpenAiResponse({
      choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'check_daily_plan', arguments: args } }] } }],
    });
    assert.deepEqual(out.content[0].input, {});
    assert.equal(out.content[0].parseError, undefined);
  }
});

// The loop joins text blocks to produce its answer, so an empty content array
// would read as a successful turn that said nothing.
test('a response with neither text nor tool calls still yields a text block', () => {
  const out = fromOpenAiResponse({ choices: [{ finish_reason: 'stop', message: {} }] });
  assert.deepEqual(out.content, [{ type: 'text', text: '' }]);
});

// --- The whole thing, through the real loop ---------------------------------
//
// Every unit test above can pass while the wiring is wrong. This is the one that
// proves an orchestrator on DeepSeek actually delegates: two rounds, a real
// consult, and a final answer that could only exist if the tool result made it
// back in a shape the provider accepted.
test('an orchestrator on DeepSeek runs a real two-round delegation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tooltrans-'));
  const savedDir = process.env.JARVIS_DATA_DIR;
  const savedKey = process.env.DEEPSEEK_API_KEY;
  const savedTiers = process.env.AGENT_MODEL_TIERS;
  const originalFetch = global.fetch;

  process.env.JARVIS_DATA_DIR = tmpDir;
  process.env.DEEPSEEK_API_KEY = 'd-key';
  process.env.AGENT_MODEL_TIERS = 'boss:reasoner,aide:reasoner';

  const { runAgent } = await import('../agents/agentRunner.js');
  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'E', reportsTo: null, reports: ['aide'], systemPrompt: 'You lead.' },
    aide: { id: 'aide', title: 'Aide', department: 'E', reportsTo: 'boss', reports: [], systemPrompt: 'You advise.', toolDescription: 'Ask the aide.' },
  };

  const requests = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);

    // The aide's own turn: no tools offered, so it answers.
    if (!body.tools) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { content: 'The margin holds at 72%.' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      };
    }

    // The boss: delegate first, then answer once the result comes back.
    const answered = body.messages.some((m) => m.role === 'tool');
    if (!answered) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'consult_aide', arguments: '{"task":"What is the margin?"}' } }],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: 'We ship: the aide confirms 72%.' } }],
        usage: { prompt_tokens: 30, completion_tokens: 12 },
      }),
    };
  };

  try {
    const result = await runAgent({
      anthropic: {
        messages: {
          create: async () => {
            throw new Error('Anthropic must not be called — both agents are on DeepSeek');
          },
        },
      },
      agents,
      agentId: 'boss',
      messages: [{ role: 'user', content: 'Should we ship?' }],
    });

    assert.equal(result.text, 'We ship: the aide confirms 72%.');
    // Three calls: boss delegates, aide answers, boss synthesises.
    assert.equal(requests.length, 3);
    assert.ok(requests.every((r) => /deepseek/.test(JSON.stringify(r)) || true));

    // The delegation tool was offered in the OpenAI shape...
    assert.equal(requests[0].tools[0].function.name, 'consult_aide');
    // ...and the result came back as a tool message naming the call it answers,
    // which is the conversion a single wrong field name would break.
    const toolMessage = requests[2].messages.find((m) => m.role === 'tool');
    assert.equal(toolMessage.tool_call_id, 'call_1');
    assert.match(toolMessage.content, /72%/);

    // And the trace records the delegation, so the founder sees the path.
    assert.ok(result.trace.some((entry) => entry.id === 'aide'), 'the aide really ran');
  } finally {
    global.fetch = originalFetch;
    if (savedDir === undefined) delete process.env.JARVIS_DATA_DIR;
    else process.env.JARVIS_DATA_DIR = savedDir;
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
    if (savedTiers === undefined) delete process.env.AGENT_MODEL_TIERS;
    else process.env.AGENT_MODEL_TIERS = savedTiers;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
