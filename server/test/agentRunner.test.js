import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, isRetryableError } from '../agents/agentRunner.js';

function apiError(status, message) {
  return Object.assign(new Error(message || `status ${status}`), { status });
}

function textResponse(text) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
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
