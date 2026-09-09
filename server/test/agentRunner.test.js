import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, isRetryableError } from '../agents/agentRunner.js';

function apiError(status, message) {
  return Object.assign(new Error(message || `status ${status}`), { status });
}

function textResponse(text, usage) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage };
}

function toolUseResponse(toolName, input) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `tu_${toolName}`, name: toolName, input }],
    usage: { input_tokens: 40, output_tokens: 10 },
  };
}

// A minimal single-agent team with no reports/actions, so buildTools()
// returns no tools and the loop always finishes on the first successful
// response.
const AGENTS = {
  test_agent: {
    id: 'test_agent',
    title: 'Test Agent',
    department: 'Test',
    reportsTo: null,
    reports: [],
    systemPrompt: 'You are a test agent.',
  },
};

const DELEGATING_AGENTS = {
  manager: {
    id: 'manager',
    title: 'Manager',
    department: 'Test',
    reportsTo: null,
    reports: ['report_agent'],
    systemPrompt: 'You are a manager.',
  },
  report_agent: {
    id: 'report_agent',
    title: 'Report Agent',
    department: 'Test',
    reportsTo: 'manager',
    reports: [],
    toolDescription: 'Consult the report agent.',
    systemPrompt: 'You are a report agent.',
  },
};

function makeClient(responses) {
  let calls = 0;
  return {
    get callCount() {
      return calls;
    },
    messages: {
      create: async () => {
        const next = responses[calls];
        calls++;
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

test('isRetryableError treats rate limits, 5xx, and connection errors as retryable', () => {
  assert.equal(isRetryableError(apiError(429)), true);
  assert.equal(isRetryableError(apiError(500)), true);
  assert.equal(isRetryableError(apiError(529)), true);
  assert.equal(isRetryableError(apiError(undefined)), true); // connection error, no status
});

test('isRetryableError treats client errors as non-retryable', () => {
  assert.equal(isRetryableError(apiError(400)), false);
  assert.equal(isRetryableError(apiError(401)), false);
  assert.equal(isRetryableError(apiError(403)), false);
  assert.equal(isRetryableError(apiError(404)), false);
});

test('runAgent retries once after a transient error and succeeds', async () => {
  const anthropic = makeClient([apiError(429, 'rate limited'), textResponse('recovered')]);

  const { text } = await runAgent({
    anthropic,
    agents: AGENTS,
    agentId: 'test_agent',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(text, 'recovered');
  assert.equal(anthropic.callCount, 2);
});

test('runAgent does not retry a non-retryable error and propagates it', async () => {
  const anthropic = makeClient([apiError(400, 'bad request')]);

  await assert.rejects(
    runAgent({
      anthropic,
      agents: AGENTS,
      agentId: 'test_agent',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    /bad request/
  );
  assert.equal(anthropic.callCount, 1);
});

test('runAgent still fails after the retry is exhausted', async () => {
  const anthropic = makeClient([apiError(503, 'overloaded'), apiError(503, 'still overloaded')]);

  await assert.rejects(
    runAgent({
      anthropic,
      agents: AGENTS,
      agentId: 'test_agent',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    /still overloaded/
  );
  assert.equal(anthropic.callCount, 2);
});

test('runAgent reports token usage for a single-round turn', async () => {
  const anthropic = makeClient([textResponse('hello', { input_tokens: 12, output_tokens: 6 })]);

  const { usage } = await runAgent({
    anthropic,
    agents: AGENTS,
    agentId: 'test_agent',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 6 });
});

test('runAgent accumulates token usage across a delegated sub-agent call', async () => {
  const anthropic = makeClient([
    toolUseResponse('consult_report_agent', { task: 'do a thing' }), // manager round 1: 40 in / 10 out
    textResponse('sub answer', { input_tokens: 15, output_tokens: 5 }), // report_agent's only round
    textResponse('final answer', { input_tokens: 20, output_tokens: 8 }), // manager round 2
  ]);

  const { text, usage } = await runAgent({
    anthropic,
    agents: DELEGATING_AGENTS,
    agentId: 'manager',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(text, 'final answer');
  assert.deepEqual(usage, { inputTokens: 75, outputTokens: 23 });
});
