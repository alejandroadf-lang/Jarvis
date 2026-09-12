// A turn fanning out across twenty-one agents can take many minutes, and a
// founder holding a phone reads that as broken long before it is. So a
// conversational turn stops widening at a deadline and answers with what it
// has, and the question it could not do justice to is queued to be done
// properly and delivered when it lands.
//
// The point is not making hard questions fast. It is stopping a hard question
// from looking like a failure, and stopping the rushed answer to it from
// passing as the considered one.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agents/agentRunner.js';

let tmpDir;
let dives;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dives-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  dives = await import('../deepDives.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(path.join(tmpDir, 'deepDives.json'), JSON.stringify({ dives: [] }));
});

// --- The deadline -----------------------------------------------------------

const TEAM = {
  boss: { id: 'boss', title: 'Boss', department: 'E', reportsTo: null, reports: ['aide'], systemPrompt: 'x' },
  aide: { id: 'aide', title: 'Aide', department: 'E', reportsTo: 'boss', reports: [], systemPrompt: 'y' },
};

function delegatingAnthropic(onCall = () => {}) {
  let calls = 0;
  return {
    messages: {
      create: async (params) => {
        calls += 1;
        onCall(calls);
        // Keeps asking for another consultation, forever, unless stopped.
        if (params.tools?.length) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `tu_${calls}`, name: 'consult_aide', input: { task: 'look' } }],
            usage: { input_tokens: 5, output_tokens: 5 },
          };
        }
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'what I have so far' }],
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      },
    },
  };
}

test('a turn past its deadline answers with what it has rather than being cut off', async () => {
  const { text, ranOutOfTime } = await runAgent({
    anthropic: delegatingAnthropic(),
    agents: TEAM,
    agentId: 'boss',
    messages: [{ role: 'user', content: 'a big question' }],
    deadlineAt: Date.now() - 1, // already past
  });

  // Cutting an agent off mid-thought produces nothing useful; stopping it
  // from consulting three more people produces a shorter answer.
  assert.equal(ranOutOfTime, true);
  assert.equal(text, 'what I have so far');
});

test('the first round always runs, however tight the deadline', async () => {
  // An answer that is late beats no answer at all.
  let calls = 0;
  const { text } = await runAgent({
    anthropic: delegatingAnthropic(() => { calls += 1; }),
    agents: TEAM,
    agentId: 'boss',
    messages: [{ role: 'user', content: 'hi' }],
    deadlineAt: Date.now() - 10_000,
  });

  assert.ok(calls > 0, 'round zero is not skippable');
  assert.ok(text);
});

test('a turn inside its deadline is not marked as rushed', async () => {
  const anthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'considered answer' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    },
  };

  const { text, ranOutOfTime } = await runAgent({
    anthropic,
    agents: TEAM,
    agentId: 'boss',
    messages: [{ role: 'user', content: 'hi' }],
    deadlineAt: Date.now() + 60_000,
  });

  assert.equal(ranOutOfTime, false);
  assert.equal(text, 'considered answer');
});

test('no deadline means no limit, which is what a deep dive runs under', async () => {
  const anthropic = {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'full answer' }],
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    },
  };

  const { ranOutOfTime } = await runAgent({
    anthropic, agents: TEAM, agentId: 'boss', messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(ranOutOfTime, false);
});

// --- The queue --------------------------------------------------------------

test('a queued dive keeps everything needed to answer and deliver it later', () => {
  const dive = dives.enqueue({
    question: 'How do we monetize the burnout scorer?',
    sessionId: 'whatsapp-66854882740',
    deliverTo: '66854882740',
    reason: 'ran past the conversational deadline',
  });

  assert.equal(dive.status, 'queued');
  assert.equal(dive.deliverTo, '66854882740');
  // Same session, so the deeper answer lands in the conversation that asked.
  assert.equal(dive.sessionId, 'whatsapp-66854882740');
});

test('an empty question is refused rather than queued', () => {
  assert.throws(() => dives.enqueue({ question: '   ' }), /needs a question/);
});

test('the queue is worked in order', () => {
  dives.enqueue({ question: 'first' });
  dives.enqueue({ question: 'second' });

  assert.equal(dives.nextQueued().question, 'first');
});

test('a dive already running is never handed out again', () => {
  // A restart mid-dive would otherwise re-run it, and these are expensive.
  const dive = dives.enqueue({ question: 'expensive' });
  dives.markRunning(dive.id);

  assert.equal(dives.nextQueued(), null, 'it stays visible as stuck rather than quietly repeating');
  assert.equal(dives.getDeepDive(dive.id).status, 'running');
});

test('completing one stores the answer and takes it out of the queue', () => {
  const dive = dives.enqueue({ question: 'q' });
  dives.markRunning(dive.id);
  dives.complete(dive.id, 'the full answer');

  const done = dives.getDeepDive(dive.id);
  assert.equal(done.status, 'done');
  assert.equal(done.answer, 'the full answer');
  assert.ok(done.finishedAt);
  assert.equal(dives.queueDepth(), 0);
});

test('a failure keeps the reason, since nothing else will have it', () => {
  const dive = dives.enqueue({ question: 'q' });
  dives.markRunning(dive.id);
  dives.fail(dive.id, 'credit balance too low');

  const failed = dives.getDeepDive(dive.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /credit balance/);
});

test('queue depth counts only what is waiting', () => {
  const a = dives.enqueue({ question: 'a' });
  dives.enqueue({ question: 'b' });
  dives.markRunning(a.id);

  assert.equal(dives.queueDepth(), 1);
});

test('the newest are listed first, which is what anyone checking wants', () => {
  dives.enqueue({ question: 'older' });
  dives.enqueue({ question: 'newer' });

  assert.equal(dives.listDeepDives()[0].question, 'newer');
});
