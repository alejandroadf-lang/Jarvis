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

// Dispatch used to be strictly sequential, which made a turn's latency
// proportional to how many agents were consulted rather than to the depth of
// the chart — about eight minutes for a company of 150. These cover the fix
// and, more importantly, the one thing that must NOT be parallelised.

const WIDE_TEAM = {
  boss: {
    id: 'boss',
    title: 'Boss',
    department: 'Test',
    reportsTo: null,
    reports: ['a', 'b', 'c', 'd'],
    systemPrompt: 'You are the boss.',
    toolDescription: 'Consult the boss.',
    actions: [
      { name: 'act', description: 'do a thing', input_schema: { type: 'object', properties: {} } },
    ],
  },
};
for (const id of ['a', 'b', 'c', 'd']) {
  WIDE_TEAM[id] = {
    id,
    title: `Specialist ${id}`,
    department: 'Test',
    reportsTo: 'boss',
    reports: [],
    systemPrompt: `You are ${id}.`,
    toolDescription: `Consult ${id}.`,
  };
}

function consultAll(ids) {
  return {
    stop_reason: 'tool_use',
    content: ids.map((id) => ({ type: 'tool_use', id: `tu_${id}`, name: `consult_${id}`, input: { task: 'go' } })),
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

test('delegations to several reports run concurrently', async () => {
  let inFlight = 0;
  let peak = 0;
  const anthropic = {
    messages: {
      create: async (params) => {
        // Only the sub-agent calls are slow; the boss answers immediately.
        const isSub = !params.tools || params.tools.length === 0;
        if (!isSub) {
          return params.messages.length === 1
            ? consultAll(['a', 'b', 'c', 'd'])
            : textResponse('done', { input_tokens: 5, output_tokens: 5 });
        }
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return textResponse('specialist answer', { input_tokens: 5, output_tokens: 5 });
      },
    },
  };

  const { trace } = await runAgent({ anthropic, agents: WIDE_TEAM, agentId: 'boss', messages: [{ role: 'user', content: 'go' }] });
  assert.ok(peak > 1, `expected concurrent consultations, peak in-flight was ${peak}`);
  assert.equal(trace.length, 4, 'every consulted specialist should still appear in the trace');
});

// The load-bearing one. An action tool has a real side effect governed by
// per-venture daily caps and a cooldown, and every one of those checks reads
// the log the previous action writes. Two at once would both read the same
// pre-action state and slip past a cap that should have stopped the second.
test('action tools are never dispatched concurrently', async () => {
  let inFlight = 0;
  let peak = 0;
  const anthropic = {
    messages: {
      create: async (params) => {
        if (params.messages.length === 1) {
          return {
            stop_reason: 'tool_use',
            content: [1, 2, 3].map((n) => ({ type: 'tool_use', id: `tu_act_${n}`, name: 'act', input: {} })),
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        return textResponse('done', { input_tokens: 5, output_tokens: 5 });
      },
    },
  };

  await runAgent({
    anthropic,
    agents: WIDE_TEAM,
    agentId: 'boss',
    messages: [{ role: 'user', content: 'go' }],
    actionHandlers: {
      act: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return 'acted';
      },
    },
  });

  assert.equal(peak, 1, `actions must run one at a time, peak in-flight was ${peak}`);
});

test('a failed consultation does not take down the ones beside it', async () => {
  const anthropic = {
    messages: {
      create: async (params) => {
        const isSub = !params.tools || params.tools.length === 0;
        if (!isSub) {
          return params.messages.length === 1
            ? consultAll(['a', 'b'])
            : textResponse('done', { input_tokens: 5, output_tokens: 5 });
        }
        // 'a' is asked first; fail whichever asks first.
        if (params.system.includes('You are a.')) throw apiError(400, 'bad request');
        return textResponse('b answered', { input_tokens: 5, output_tokens: 5 });
      },
    },
  };

  const { trace } = await runAgent({ anthropic, agents: WIDE_TEAM, agentId: 'boss', messages: [{ role: 'user', content: 'go' }] });
  // b still got through and is credited; a failed and isn't.
  assert.deepEqual(trace.map((t) => t.id), ['b']);
});

// --- Running out of room ---------------------------------------------------
// A real WhatsApp failure: the CEO was asked for a top ten, spent its entire
// output budget writing delegation requests, and came back with "I wasn't able
// to land on a final answer". It had understood the question perfectly — it
// was cut off mid-sentence and had no way to say so.

test('a turn that ends on max_tokens with no text still produces an answer', async () => {
  const calls = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        calls.push(params);
        // First call: the model spends its whole budget emitting tool calls
        // and never writes a word of prose. stop_reason is max_tokens, not
        // tool_use, so the loop treats the turn as finished.
        if (calls.length === 1) {
          return {
            stop_reason: 'max_tokens',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'consult_worker', input: { question: 'a very long question' } }],
            usage: { input_tokens: 50, output_tokens: 1024 },
          };
        }
        return textResponse('Here are the ten ideas, ranked.', { input_tokens: 60, output_tokens: 200 });
      },
    },
  };

  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'Exec', reportsTo: null, reports: ['worker'], systemPrompt: 'You are the boss.' },
    worker: { id: 'worker', title: 'Worker', department: 'Exec', reportsTo: 'boss', reports: [], systemPrompt: 'You are a worker.' },
  };

  const { text } = await runAgent({
    anthropic,
    agents,
    agentId: 'boss',
    messages: [{ role: 'user', content: 'Give me the top ten ideas.' }],
  });

  assert.equal(text, 'Here are the ten ideas, ranked.');
  assert.match(text, /ten ideas/);
});

test('the closing pass asks without tools, so it cannot delegate again', async () => {
  const calls = [];
  const anthropic = {
    messages: {
      create: async (params) => {
        calls.push(params);
        if (calls.length === 1) {
          return {
            stop_reason: 'max_tokens',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'consult_worker', input: {} }],
            usage: { input_tokens: 10, output_tokens: 1024 },
          };
        }
        return textResponse('Final answer.', { input_tokens: 10, output_tokens: 20 });
      },
    },
  };

  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'Exec', reportsTo: null, reports: ['worker'], systemPrompt: 'You are the boss.' },
    worker: { id: 'worker', title: 'Worker', department: 'Exec', reportsTo: 'boss', reports: [], systemPrompt: 'You are a worker.' },
  };

  await runAgent({ anthropic, agents, agentId: 'boss', messages: [{ role: 'user', content: 'Go.' }] });

  assert.ok(calls[0].tools?.length, 'the first call offers delegation tools');
  assert.equal(calls[1].tools, undefined, 'the closing call offers none — it must answer, not delegate');
  assert.match(
    JSON.stringify(calls[1].messages.at(-1)),
    /using what you already have/,
    'the closing call tells the agent to answer from what it gathered'
  );
});

test('when even the closing pass fails, the reply says what happened', async () => {
  const anthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'consult_worker', input: {} }],
        usage: { input_tokens: 10, output_tokens: 1024 },
      }),
    },
  };

  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'Exec', reportsTo: null, reports: ['worker'], systemPrompt: 'You are the boss.' },
    worker: { id: 'worker', title: 'Worker', department: 'Exec', reportsTo: 'boss', reports: [], systemPrompt: 'You are a worker.' },
  };

  const { text } = await runAgent({ anthropic, agents, agentId: 'boss', messages: [{ role: 'user', content: 'Go.' }] });

  // Names the real cause and what to do about it, rather than implying the
  // question was unclear.
  assert.match(text, /ran out of room/);
  assert.match(text, /smaller piece/);
});

test('an orchestrator gets room for a multi-department synthesis', async () => {
  const calls = [];
  const anthropic = {
    messages: { create: async (params) => { calls.push(params); return textResponse('ok', { input_tokens: 5, output_tokens: 5 }); } },
  };
  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'E', reportsTo: null, reports: ['aide'], systemPrompt: 'x' },
    aide: { id: 'aide', title: 'Aide', department: 'E', reportsTo: 'boss', reports: [], systemPrompt: 'y' },
  };

  await runAgent({ anthropic, agents, agentId: 'boss', messages: [{ role: 'user', content: 'hi' }] });

  assert.ok(calls[0].max_tokens >= 4096, `max_tokens was ${calls[0].max_tokens} — too small for a ranked list`);
});

test('a leaf gets a tighter budget, because sixteen of them set the wall clock', async () => {
  // A leaf's answer feeds someone else's synthesis; it is not the reply the
  // founder reads. Capping it doesn't force brevity, it removes the room to
  // ramble — and leaf generation dominates the latency of any real question.
  const calls = [];
  const anthropic = {
    messages: { create: async (params) => { calls.push(params); return textResponse('ok', { input_tokens: 5, output_tokens: 5 }); } },
  };

  await runAgent({ anthropic, agents: AGENTS, agentId: 'test_agent', messages: [{ role: 'user', content: 'hi' }] });

  assert.ok(calls[0].max_tokens < 4096, 'a leaf must not get the orchestrator budget');
  // Still enough for a specialist whose job is a list — a truncated security
  // review is a worse outcome than a slow one.
  assert.ok(calls[0].max_tokens >= 2000, `max_tokens was ${calls[0].max_tokens} — a findings list needs room`);
});

test('every agent turn is timed, so a slow turn names who took the time', async () => {
  const anthropic = {
    messages: { create: async () => textResponse('ok', { input_tokens: 5, output_tokens: 5 }) },
  };

  const { durationMs } = await runAgent({
    anthropic, agents: AGENTS, agentId: 'test_agent', messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(typeof durationMs, 'number');
  assert.ok(durationMs >= 0);
});

test('a consulted agent carries its own duration into the trace', async () => {
  // Twenty-one agents can be consulted in one turn; without this, "the team
  // is slow" is unanswerable.
  const anthropic = {
    messages: {
      create: async (params) => (params.tools?.length
        ? toolUseResponse('consult_aide', { task: 'look at this' })
        : textResponse('done', { input_tokens: 5, output_tokens: 5 })),
    },
  };
  const agents = {
    boss: { id: 'boss', title: 'Boss', department: 'E', reportsTo: null, reports: ['aide'], systemPrompt: 'x' },
    aide: { id: 'aide', title: 'Aide', department: 'E', reportsTo: 'boss', reports: [], systemPrompt: 'y' },
  };

  const { trace } = await runAgent({ anthropic, agents, agentId: 'boss', messages: [{ role: 'user', content: 'hi' }] });

  const consulted = trace.find((entry) => entry.id === 'aide');
  assert.ok(consulted, 'the consulted agent is in the trace');
  assert.equal(typeof consulted.ms, 'number');
});
