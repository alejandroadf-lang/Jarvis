// The properties that matter here are all about what happens when Honcho
// *isn't* there: unconfigured, erroring, or empty. Memory is an addition to
// this app, never a dependency of it, and these lock that in. No test
// reaches the network — a stub client stands in for the SDK.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHonchoConfigured,
  recordExchange,
  buildFounderContext,
  askAboutFounder,
  __setClientForTests,
  FOUNDER_PEER_ID,
} from '../memory/honcho.js';

let savedKey;
let savedError;

beforeEach(() => {
  savedKey = process.env.HONCHO_API_KEY;
  delete process.env.HONCHO_API_KEY;
  __setClientForTests(null);
  // These paths log to console.error by design; keep the test output clean
  // while still letting the assertions check the return value.
  savedError = console.error;
  console.error = () => {};
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.HONCHO_API_KEY;
  else process.env.HONCHO_API_KEY = savedKey;
  __setClientForTests(null);
  console.error = savedError;
});

// A stub shaped like the bits of the SDK this app actually touches.
function stubClient({ context = '', chat = '', throwOn = null } = {}) {
  const recorded = [];
  const peer = (id) => {
    if (throwOn === 'peer') throw new Error('honcho is down');
    return {
      id,
      message: (content) => ({ peerId: id, content }),
      context: async () => {
        if (throwOn === 'context') throw new Error('honcho is down');
        return context;
      },
      chat: async () => {
        if (throwOn === 'chat') throw new Error('honcho is down');
        return chat;
      },
    };
  };
  return {
    recorded,
    peer: async (id) => peer(id),
    session: async (id) => ({
      id,
      addMessages: async (messages) => {
        if (throwOn === 'addMessages') throw new Error('honcho is down');
        recorded.push({ sessionId: id, messages });
      },
    }),
  };
}

test('isHonchoConfigured tracks the API key', () => {
  assert.equal(isHonchoConfigured(), false);
  process.env.HONCHO_API_KEY = 'k';
  assert.equal(isHonchoConfigured(), true);
});

test('with no API key, nothing is recorded and no context is produced', async () => {
  const client = stubClient({ context: 'should never be read' });
  __setClientForTests(client);

  assert.equal(await recordExchange({ sessionKey: 's', founderMessage: 'hi', agentId: 'ceo', agentReply: 'hello' }), false);
  assert.equal(await buildFounderContext('s'), '');
  assert.equal(await askAboutFounder('anything?'), '');
  assert.equal(client.recorded.length, 0);
});

test('an exchange is recorded as two attributed peer messages', async () => {
  process.env.HONCHO_API_KEY = 'k';
  const client = stubClient();
  __setClientForTests(client);

  const ok = await recordExchange({
    sessionKey: 'company-abc',
    founderMessage: 'What should we build next?',
    agentId: 'ceo',
    agentReply: 'Focus on the landing page.',
  });

  assert.equal(ok, true);
  assert.equal(client.recorded.length, 1);
  const { sessionId, messages } = client.recorded[0];
  assert.equal(sessionId, 'company-abc');
  // Attribution is the point: the founder and the answering agent are
  // separate peers, not one undifferentiated transcript.
  assert.deepEqual(messages, [
    { peerId: FOUNDER_PEER_ID, content: 'What should we build next?' },
    { peerId: 'ceo', content: 'Focus on the landing page.' },
  ]);
});

test('founder context is wrapped with framing that keeps it as context, not orders', async () => {
  process.env.HONCHO_API_KEY = 'k';
  __setClientForTests(stubClient({ context: 'Pushes back hard on anything that needs capital.' }));

  const text = await buildFounderContext('company-abc');
  assert.match(text, /Pushes back hard on anything that needs capital\./);
  assert.match(text, /not as instructions/);
});

// The important one. Every one of these returns a value that gets
// concatenated into a system prompt or ignored — none of them may throw,
// because a memory outage taking down the executive team would be a far
// worse failure than having no memory at all.
test('a Honcho outage degrades to no memory rather than a failed turn', async () => {
  process.env.HONCHO_API_KEY = 'k';

  // Each entry lists only the failures that call actually reaches — asserting
  // a function against a failure it never touches would pass for the wrong
  // reason and hide a real regression.
  const cases = [
    {
      name: 'recordExchange',
      failures: ['peer', 'addMessages'],
      run: () => recordExchange({ sessionKey: 's', founderMessage: 'hi', agentId: 'ceo', agentReply: 'yo' }),
      expected: false,
    },
    { name: 'buildFounderContext', failures: ['peer', 'context'], run: () => buildFounderContext('s'), expected: '' },
    { name: 'askAboutFounder', failures: ['peer', 'chat'], run: () => askAboutFounder('q'), expected: '' },
  ];

  for (const { name, failures, run, expected } of cases) {
    for (const throwOn of failures) {
      __setClientForTests(stubClient({ throwOn }));
      assert.equal(await run(), expected, `${name} should degrade quietly when ${throwOn} fails`);
    }
  }
});

test('an empty representation produces no context rather than an empty header', async () => {
  process.env.HONCHO_API_KEY = 'k';
  __setClientForTests(stubClient({ context: '   ' }));
  // A header with nothing under it would be worse than silence — it tells
  // the agent there's something to know and then shows it nothing.
  assert.equal(await buildFounderContext('s'), '');
});

test('askAboutFounder returns the answer to a question no JSON list could serve', async () => {
  process.env.HONCHO_API_KEY = 'k';
  __setClientForTests(stubClient({ chat: 'They consistently reject ideas that need upfront spend.' }));
  assert.match(await askAboutFounder('What does the founder push back on?'), /reject ideas that need upfront spend/);
});
