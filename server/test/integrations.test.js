// The point of the probes is to tell apart four states that used to look
// identical from outside: not configured, key rejected, key valid but out of
// credit, and working. Each of those needs its own honest answer, since the
// first three all currently manifest as "the app seems fine but the feature
// isn't happening."

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getIntegrationStatus } from '../integrations.js';
import { __setClientForTests } from '../memory/honcho.js';

let tmpDir;
const saved = {};
const KEYS = ['OPENROUTER_API_KEY', 'HONCHO_API_KEY', 'ANTHROPIC_API_KEY', 'SMTP_HOST', 'REPORT_EMAIL_TO', 'GITHUB_TOKEN'];
let originalFetch;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-integrations-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  global.fetch = originalFetch;
  __setClientForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  __setClientForTests(null);
  global.fetch = originalFetch;
});

function honchoStub({ shouldThrow = false } = {}) {
  return {
    peer: async (id) => {
      if (shouldThrow) throw new Error('invalid api key');
      return { id };
    },
  };
}

test('nothing configured reports configured:false and never claims a failure', async () => {
  const status = await getIntegrationStatus();
  for (const name of ['openrouter', 'honcho', 'email', 'github']) {
    assert.equal(status[name].configured, false, `${name} should read as unconfigured`);
    // ok:null, not false — "you haven't set this up" is not "this is broken".
    assert.equal(status[name].ok, null, `${name} should not be reported as failing when it was never set up`);
    assert.ok(status[name].detail.length > 0);
  }
  assert.match(status.openrouter.detail, /every agent runs on Claude/i);
});

test('a working OpenRouter key reads as ok and names the model it unlocks', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  global.fetch = async (url, options) => {
    assert.match(url, /openrouter\.ai\/api\/v1\/key/);
    assert.equal(options.headers.Authorization, 'Bearer k');
    return { ok: true, status: 200, json: async () => ({ data: { usage: 1.5, limit_remaining: 8.5 } }) };
  };

  const { openrouter } = await getIntegrationStatus();
  assert.equal(openrouter.configured, true);
  assert.equal(openrouter.ok, true);
  assert.match(openrouter.detail, /hermes-4-70b/);
  assert.match(openrouter.detail, /\$1\.50 used/);
});

test('a rejected OpenRouter key says so, and says what it means', async () => {
  process.env.OPENROUTER_API_KEY = 'bad';
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });

  const { openrouter } = await getIntegrationStatus();
  assert.equal(openrouter.ok, false);
  // The consequence matters more than the status code: the app looks fine
  // and just quietly costs more.
  assert.match(openrouter.detail, /falling back to Claude/i);
});

// The nastiest of the four states: the key is genuinely valid, so a naive
// auth check passes, but the paid model still can't run.
test('a valid OpenRouter key with no credit is reported as not working', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { usage: 5, limit_remaining: 0 } }) });

  const { openrouter } = await getIntegrationStatus();
  assert.equal(openrouter.ok, false);
  assert.match(openrouter.detail, /out of credit/i);
});

test('an unreachable OpenRouter is a failure, not a silent pass', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  const { openrouter } = await getIntegrationStatus();
  assert.equal(openrouter.ok, false);
  assert.match(openrouter.detail, /Couldn't reach OpenRouter/);
});

test('a working Honcho key reads as ok and sets the expectation that memory is gradual', async () => {
  process.env.HONCHO_API_KEY = 'k';
  __setClientForTests(honchoStub());

  const { honcho } = await getIntegrationStatus();
  assert.equal(honcho.ok, true);
  assert.match(honcho.detail, /asynchronously|over several conversations/i);
});

test('a rejected Honcho key surfaces the reason instead of swallowing it', async () => {
  process.env.HONCHO_API_KEY = 'bad';
  __setClientForTests(honchoStub({ shouldThrow: true }));

  const { honcho } = await getIntegrationStatus();
  assert.equal(honcho.ok, false);
  assert.match(honcho.detail, /invalid api key/);
});

test('one broken integration does not stop the others being reported', async () => {
  process.env.OPENROUTER_API_KEY = 'k';
  process.env.HONCHO_API_KEY = 'k';
  process.env.ANTHROPIC_API_KEY = 'k';
  global.fetch = async () => {
    throw new Error('down');
  };
  __setClientForTests(honchoStub());

  const status = await getIntegrationStatus();
  assert.equal(status.openrouter.ok, false);
  assert.equal(status.honcho.ok, true);
  assert.equal(status.anthropic.configured, true);
});

// --- A probe that poses a question it is already holding the answer to ---

test('when the Gemini model is unavailable, the probe names ones that are', async () => {
  // It said "set GEMINI_MODEL to a name it can" while holding the list of
  // names it can. That sends the founder off to find an answer this function
  // already has — the same shape of unhelpfulness as a 404 that could have
  // said "you cannot see this repo".
  const savedKey = process.env.GEMINI_API_KEY;
  const savedModel = process.env.GEMINI_MODEL;
  const savedFetch = global.fetch;
  process.env.GEMINI_API_KEY = 'k';
  process.env.GEMINI_MODEL = 'gemini-2.0-flash';
  global.fetch = async (url) =>
    String(url).includes('generativelanguage')
      ? {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              // Present on every account and useless here: accepted as a
              // model name, then failing at the moment an agent is consulted.
              { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
            ],
          }),
        }
      : { ok: false, status: 404, text: async () => '' };

  try {
    const { getIntegrationStatus } = await import('../integrations.js');
    const { gemini } = await getIntegrationStatus();
    assert.equal(gemini.ok, false);
    assert.match(gemini.detail, /gemini-flash-latest/, 'a name that would actually work');
    assert.doesNotMatch(gemini.detail, /embedding/, 'and not one that would be accepted then fail');
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = savedModel;
  }
});
