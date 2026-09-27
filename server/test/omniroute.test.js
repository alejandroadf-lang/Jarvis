// OmniRoute, the self-hosted AI gateway, as a provider and as the first backup.
//
// What is pinned: the URL the founder pastes is accepted in the forms people
// actually paste, a gateway reachable over plain http from the internet or
// without a key is refused (either one lets strangers spend the founder's
// provider quota), an out-of-credit Anthropic goes to OmniRoute before the
// single-provider backups, and an agent can be assigned to it from one
// variable.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { omniRouteBase, isOmniRouteConfigured, omniRouteProblem } from '../agents/omniroute.js';
import { runAgent } from '../agents/agentRunner.js';
import { resolveModelForAgent, MODELS, OMNIROUTE_TIER, DEFAULT_TIER } from '../agents/models.js';

const KEYS = ['OMNIROUTE_URL', 'OMNIROUTE_API_KEY', 'OMNIROUTE_MODEL', 'OPENAI_API_KEY', 'AGENT_MODEL_TIERS', 'JARVIS_DATA_DIR'];
const saved = {};
let originalFetch;
let tmpDir;

before(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-omniroute-test-'));
});

after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.JARVIS_DATA_DIR = tmpDir;
  global.fetch = async () => {
    throw new Error('a test tried to make a real request');
  };
});

test('the URL is accepted as a bare host, a /v1 base or the full completions URL', () => {
  for (const pasted of [
    'https://omniroute.up.railway.app',
    'https://omniroute.up.railway.app/',
    'https://omniroute.up.railway.app/v1',
    'https://omniroute.up.railway.app/v1/chat/completions',
  ]) {
    assert.equal(omniRouteBase(pasted), 'https://omniroute.up.railway.app/v1', pasted);
  }
  // Railway's private network is plain http and never leaves the project.
  assert.equal(omniRouteBase('http://omniroute.railway.internal:20128'), 'http://omniroute.railway.internal:20128/v1');
});

test('plain http over the internet and passwords in the URL are refused', () => {
  assert.equal(omniRouteBase('http://omniroute.example.com'), null);
  assert.equal(omniRouteBase('https://user:pass@omniroute.example.com'), null);
  assert.equal(omniRouteBase('omniroute.example.com'), null);
  process.env.OMNIROUTE_URL = 'http://omniroute.example.com';
  process.env.OMNIROUTE_API_KEY = 'k';
  assert.equal(isOmniRouteConfigured(), false);
  assert.match(omniRouteProblem(), /https/);
});

test('a gateway without a key is not used, and the reason says why', () => {
  process.env.OMNIROUTE_URL = 'https://omniroute.example.com';
  assert.equal(isOmniRouteConfigured(), false);
  assert.match(omniRouteProblem(), /OMNIROUTE_API_KEY.*anyone who finds it/);
});

const SOLO = {
  solo: { id: 'solo', title: 'Solo', department: 'Test', reportsTo: null, reports: [], systemPrompt: 'You are alone.' },
};

function stubGateway(calls) {
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Answered through the gateway.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    };
  };
}

test('an out-of-credit Anthropic goes to OmniRoute before the single-provider backups', async () => {
  process.env.OMNIROUTE_URL = 'https://omniroute.example.com/v1';
  process.env.OMNIROUTE_API_KEY = 'omni-key';
  process.env.OPENAI_API_KEY = 'also-configured';
  const calls = [];
  stubGateway(calls);
  const anthropic = {
    messages: {
      create: async () => {
        throw Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), { status: 400 });
      },
    },
  };

  const { text } = await runAgent({ anthropic, agents: SOLO, agentId: 'solo', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(text, 'Answered through the gateway.');
  assert.equal(calls.length, 1, 'one call, to the gateway, and OpenAI never asked');
  assert.equal(calls[0].url, 'https://omniroute.example.com/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer omni-key');
  assert.equal(calls[0].body.model, 'auto');
});

test('an agent can be assigned to OmniRoute, and falls back to Claude when it is not set up', () => {
  const leaf = { id: 'qa', reports: [], actions: [], serverTools: [] };
  process.env.AGENT_MODEL_TIERS = 'qa:router';
  assert.equal(resolveModelForAgent(leaf, false).model, MODELS[DEFAULT_TIER].model);

  process.env.OMNIROUTE_URL = 'https://omniroute.example.com';
  process.env.OMNIROUTE_API_KEY = 'omni-key';
  process.env.OMNIROUTE_MODEL = 'auto/cheap';
  const spec = resolveModelForAgent(leaf, false);
  assert.equal(spec.provider, 'omniroute');
  assert.equal(spec.model, 'auto/cheap');
});

// The gateway chooses the provider, so the price is unknown here. Metered
// high by default: a cap that trips early is recoverable, a cap that counts
// nothing is not.
test('OmniRoute is metered at the frontier price until the founder says otherwise', () => {
  assert.equal(MODELS[OMNIROUTE_TIER].outputPricePerMTok, MODELS[DEFAULT_TIER].outputPricePerMTok);
  process.env.OMNIROUTE_OUTPUT_PRICE_PER_MTOK = '0.5';
  try {
    assert.equal(MODELS[OMNIROUTE_TIER].outputPricePerMTok, 0.5);
  } finally {
    delete process.env.OMNIROUTE_OUTPUT_PRICE_PER_MTOK;
  }
});

test('INTEGRATIONS says when the gateway rejects the key, and when the URL is unusable', async () => {
  const { getIntegrationStatus } = await import('../integrations.js');
  process.env.OMNIROUTE_URL = 'https://omniroute.example.com';
  process.env.OMNIROUTE_API_KEY = 'wrong';
  global.fetch = async (url) => {
    if (String(url) === 'https://omniroute.example.com/v1/models') return { ok: false, status: 401 };
    throw new Error(`unexpected request to ${url}`);
  };
  const rejected = (await getIntegrationStatus()).omniroute;
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /Key rejected/);

  process.env.OMNIROUTE_URL = 'http://omniroute.example.com';
  const unusable = (await getIntegrationStatus()).omniroute;
  assert.equal(unusable.ok, false);
  assert.match(unusable.detail, /https/);
});
