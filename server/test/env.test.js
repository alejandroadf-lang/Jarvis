// A key set to whitespace used to read as configured. That defeated the very
// fallback meant to prevent it: the tier did not collapse to the default
// model, the request went out as `Authorization: Bearer ` with nothing after
// it, and OpenRouter answered "Missing Authentication header" — which reads
// as a broken integration rather than an unset variable, and sent the team
// hunting for a tool that did not exist.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readSecret, hasSecret } from '../env.js';
import { isOpenRouterConfigured } from '../agents/openrouter.js';
import { isGithubConfigured } from '../deploy/github.js';
import { isExecutionConfigured } from '../execute/githubActions.js';
import { resolveModelForAgent, MODELS, DEFAULT_TIER, OPENAI_TIER } from '../agents/models.js';

const KEYS = ['OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];
const saved = {};

before(() => { for (const k of KEYS) saved[k] = process.env[k]; });
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });

test('whitespace is not a credential', () => {
  process.env.OPENROUTER_API_KEY = '   ';
  assert.equal(hasSecret('OPENROUTER_API_KEY'), false);
  assert.equal(isOpenRouterConfigured(), false);
});

test('an empty string is not a credential', () => {
  // What a variables panel leaves behind when someone types a value and
  // clears it again.
  process.env.GITHUB_TOKEN = '';
  assert.equal(isGithubConfigured(), false);
  assert.equal(isExecutionConfigured(), false);
});

test('a newline-padded key still works', () => {
  // Copy-paste into a dashboard field routinely brings one along.
  process.env.OPENROUTER_API_KEY = '\n sk-or-v1-real \n';
  assert.equal(readSecret('OPENROUTER_API_KEY'), 'sk-or-v1-real');
  assert.equal(isOpenRouterConfigured(), true);
});

test('a quoted key is unwrapped, because pasting the quotes is common', () => {
  process.env.GITHUB_TOKEN = '"ghp_realtoken"';
  assert.equal(readSecret('GITHUB_TOKEN'), 'ghp_realtoken');

  process.env.OPENAI_API_KEY = "'sk-real'";
  assert.equal(readSecret('OPENAI_API_KEY'), 'sk-real');
});

test('an unset variable reads as empty rather than the string "undefined"', () => {
  assert.equal(readSecret('DEFINITELY_NOT_SET_ANYWHERE'), '');
  assert.equal(hasSecret('DEFINITELY_NOT_SET_ANYWHERE'), false);
});

test('a blank key collapses the tier to the default model', () => {
  // The whole point. Before this, a blank key left the tier active and the
  // agent died on a 401 instead of quietly running on the better model.
  process.env.OPENAI_API_KEY = '  ';
  const leaf = { id: 'leaf', reports: [], actions: [], serverTools: [], modelTier: OPENAI_TIER };

  assert.equal(resolveModelForAgent(leaf, false), MODELS[DEFAULT_TIER]);
});

test('a real key keeps the tier', () => {
  process.env.OPENAI_API_KEY = 'sk-real';
  const leaf = { id: 'leaf', reports: [], actions: [], serverTools: [], modelTier: OPENAI_TIER };

  assert.equal(resolveModelForAgent(leaf, false).provider, 'openai');
});
