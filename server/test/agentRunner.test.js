import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, isRetryableError } from '../agents/agentRunner.js';

// runAgent records real spend against the ledger on every call (see
// spend.js), so this file needs its own data dir like every other test —
// otherwise a test run writes fake spend into the real server/data.
let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-agentrunner-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

  assert.equal(usage.inputTokens, 12);
  assert.equal(usage.outputTokens, 6);
  assert.ok(usage.costUsd > 0, 'a real call should record a real cost');
});

// The spend ledger is shared state for the whole run, so these two put it
// back where they found it rather than leaving a balance that would trip
// whichever test happens to come next.
async function withIsolatedSpend(capUsd, fn) {
  const spend = await import('../spend.js');
  const savedCap = process.env.DAILY_SPEND_CAP_USD;
  process.env.DAILY_SPEND_CAP_USD = capUsd;
  try {
    await fn(spend);
  } finally {
    if (savedCap === undefined) delete process.env.DAILY_SPEND_CAP_USD;
    else process.env.DAILY_SPEND_CAP_USD = savedCap;
    fs.rmSync(path.join(tmpDir, 'spend.json'), { force: true });
  }
}

test('runAgent records real spend from the response it just paid for', async () => {
  await withIsolatedSpend('1000', async (spend) => {
    const before = spend.getSpendToday();

    await runAgent({
      anthropic: makeClient([textResponse('hello', { input_tokens: 1_000_000, output_tokens: 1_000_000 })]),
      agents: AGENTS,
      agentId: 'test_agent',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // $2.00/MTok in + $10.00/MTok out on a million tokens each.
    assert.equal(Math.round((spend.getSpendToday() - before) * 100) / 100, 12);
  });
});

test('runAgent refuses to make a paid call once the daily spend cap is spent', async () => {
  await withIsolatedSpend('0.001', async (spend) => {
    spend.recordSpend(0.01); // over the cap set above

    const anthropic = makeClient([textResponse('should never be reached')]);
    await assert.rejects(
      runAgent({
        anthropic,
        agents: AGENTS,
        agentId: 'test_agent',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      /Daily spend cap reached/
    );
    // The whole point of checking before the call: no request was made at all.
    assert.equal(anthropic.callCount, 0);
  });
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
  assert.equal(usage.inputTokens, 75);
  assert.equal(usage.outputTokens, 23);
  assert.ok(usage.costUsd > 0, 'a delegated run should accumulate cost too');
});
