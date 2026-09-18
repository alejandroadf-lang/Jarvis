// The Studio's research capability.
//
// The audit behind these changes found the venture team could generate ideas
// and not check them: two of six agents held tools, capped at four lookups
// each, while the agents that size the market, falsify the case and make the
// call held none. These tests pin the fixes — and, more importantly, pin the
// two design decisions that are easy to undo by accident.
//
// The first is that the calculator and the claim verifier are *actions*, not
// Anthropic-hosted tools. A hosted tool cannot travel to another provider, so
// attaching one would silently promote both agents onto Anthropic and cost
// ~15x. The second is that the critic's model stays a different family from
// the rest of the studio, because the measured multi-agent failure is every
// role running on one model.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluate, formatNumber } from '../arithmetic.js';
import { toPlainText, excerptAround, isHttpUrl, fetchCitedPage } from '../claimVerify.js';
import { AGENTS as STUDIO_AGENTS } from '../agents/ideationTeam.js';
import { resolveModelForAgent } from '../agents/models.js';
import { WEB_SEARCH, WEB_FETCH } from '../agents/serverTools.js';

let tmpDir;
let handlers;
let originalFetch;
const saved = {};
const KEYS = ['SEARCH_MAX_USES', 'FETCH_MAX_USES', 'OPENROUTER_API_KEY'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-studio-research-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const key of KEYS) saved[key] = process.env[key];
  for (const key of KEYS) delete process.env[key];
  originalFetch = global.fetch;
  handlers = await import('../actionHandlers.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- The search budget ---------------------------------------------------------

test('the search tool version is current, not the stale pin', () => {
  // web_fetch was current while web_search sat eighteen months behind on the
  // single highest-leverage tool the company owns.
  assert.equal(WEB_SEARCH.type, 'web_search_20260209');
  assert.equal(WEB_FETCH.type, 'web_fetch_20260209');
});

test('the lookup budget is far above the four it was', () => {
  assert.ok(WEB_SEARCH.max_uses >= 10, `search budget is ${WEB_SEARCH.max_uses}`);
  assert.ok(WEB_FETCH.max_uses >= 8, `fetch budget is ${WEB_FETCH.max_uses}`);
});

test('the founder can move the budget without a deploy, and garbage falls back', () => {
  process.env.SEARCH_MAX_USES = '30';
  assert.equal(WEB_SEARCH.max_uses, 30, 'read at call time, not frozen at import');
  process.env.SEARCH_MAX_USES = 'lots';
  assert.equal(WEB_SEARCH.max_uses, 15);
  process.env.SEARCH_MAX_USES = '-4';
  assert.equal(WEB_SEARCH.max_uses, 15, 'a negative budget is not a budget');
  delete process.env.SEARCH_MAX_USES;
});

// --- The tier decisions these changes must not undo -------------------------------

test('the analyst and the critic keep their cheap, non-Anthropic model', () => {
  // The whole point of making these actions rather than hosted tools. If this
  // fails, someone attached a serverTool and silently moved two agents onto
  // the frontier model at roughly 15x the cost.
  process.env.OPENROUTER_API_KEY = 'test-key';
  for (const id of ['business_case_analyst', 'validation_critic']) {
    const spec = resolveModelForAgent(STUDIO_AGENTS[id], true);
    assert.notEqual(spec.provider, 'anthropic', `${id} was promoted to Anthropic`);
  }
  delete process.env.OPENROUTER_API_KEY;
});

test('both agents actually hold their new tool', () => {
  const names = (agent) => (agent.actions || []).map((action) => action.name);
  assert.deepEqual(names(STUDIO_AGENTS.business_case_analyst), ['calculate']);
  assert.deepEqual(names(STUDIO_AGENTS.validation_critic), ['verify_claim']);
});

test('the critic is told to check claims before forming an opinion', () => {
  const prompt = STUDIO_AGENTS.validation_critic.systemPrompt;
  assert.match(prompt, /verify_claim/);
  assert.match(prompt, /SUPPORTED/);
  assert.match(prompt, /Claims\s+first/i, 'the isolation instruction survives');
});

test('the venture partner hands the critic claims, not the pitch', () => {
  assert.match(STUDIO_AGENTS.venture_partner.systemPrompt, /numbered list with the URL/);
});

test('market sizing must be enumerable rather than a cited TAM', () => {
  const schema = STUDIO_AGENTS.venture_partner.actions.find((a) => a.name === 'propose_venture').input_schema;
  const description = schema.properties.marketSize.description;
  assert.match(description, /bottom-up/i);
  assert.match(description, /capture 1%/, 'the specific fallacy is named');
});

// --- The calculator ----------------------------------------------------------------

test('it does the arithmetic the model is measurably worst at', () => {
  assert.equal(evaluate('100 * 10000').value, 1_000_000);
  assert.equal(evaluate('149 + 0.02 * 5000').value, 249);
  assert.equal(evaluate('(100 + 20) * 3').value, 360);
  assert.equal(evaluate('2^10').value, 1024);
});

test('separators people actually write are accepted', () => {
  assert.equal(evaluate('1_000_000 / 10').value, 100_000);
  assert.equal(evaluate('1,000,000 / 10').value, 100_000);
});

// "500 * 20%" is how a conversion rate gets written in a business case. Reading
// % as an infix operator made that a syntax error, which is how a calculator
// ends up unused and the arithmetic goes back into the weights.
test('percent is postfix, the way a business case writes it', () => {
  assert.equal(evaluate('500 * 20%').value, 100);
  assert.equal(evaluate('20% * 500').value, 100);
  assert.equal(evaluate('100%').value, 1);
  assert.equal(evaluate('1000 * 2.5% * 12').value, 300);
});

test('it refuses rather than guesses', () => {
  for (const bad of ['', '1 +', '2 + (3', '10/0', 'x * 2']) {
    const result = evaluate(bad);
    assert.equal(result.ok, false, `"${bad}" should be refused`);
    assert.ok(result.error.length > 10, 'and the refusal says something useful');
  }
});

// The expression comes from a model. eval() on model output is remote code
// execution with extra steps, so the grammar knows only arithmetic.
test('nothing that is not arithmetic can get through', () => {
  for (const attack of [
    'process.exit(1)',
    'require("fs")',
    'globalThis',
    '__proto__',
    'fetch("http://evil.example")',
    'constructor.constructor("return 1")()',
  ]) {
    const result = evaluate(attack);
    assert.equal(result.ok, false, `"${attack}" must not evaluate`);
  }
});

test('an over-long expression is refused rather than parsed', () => {
  const result = evaluate('1+'.repeat(400) + '1');
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

test('the handler echoes the working so the number is auditable', () => {
  const reply = handlers.handleCalculate({ expression: '250 * 12', what: 'annual contract value' }, { agentId: 'business_case_analyst' });
  assert.match(reply, /3,000/);
  assert.match(reply, /annual contract value/);
});

test('a refused calculation names what to do instead', () => {
  const reply = handlers.handleCalculate({ expression: 'ten times four' }, { agentId: 'business_case_analyst' });
  assert.match(reply, /Could not calculate/);
  assert.match(reply, /\+ - \* \//, 'and says what the calculator does understand');
});

test('numbers come back readable, not as floating-point exhaust', () => {
  assert.equal(formatNumber(1000000), '1,000,000');
  assert.equal(formatNumber(83333.333333), '83,333.33');
});

// --- The claim verifier --------------------------------------------------------------

test('html becomes readable text with the scripts stripped', () => {
  const text = toPlainText('<html><style>b{}</style><h1>Pricing</h1><p>It costs $29 &amp; up.</p><script>steal()</script></html>');
  assert.match(text, /Pricing/);
  assert.match(text, /\$29 & up/);
  assert.doesNotMatch(text, /steal|b\{\}/);
});

// The measured gap is between "the source is on-topic" — which models already
// achieve — and "the source contains this figure", which they fail. Centring
// the excerpt on the claim's own terms is what makes the second checkable.
test('the excerpt centres on the claim, not the top of the page', () => {
  const page = `${'navigation link '.repeat(1500)}The market was worth 6.4 billion in 2024.${' filler '.repeat(3000)}`;
  const excerpt = excerptAround(page, 'market worth 6.4 billion in 2024');
  assert.match(excerpt, /6\.4 billion/);
});

test('a short page is returned whole', () => {
  assert.equal(excerptAround('Short page.', 'anything'), 'Short page.');
});

test('only http(s) sources are openable', () => {
  assert.equal(isHttpUrl('https://example.com'), true);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
});

test('a source that will not open is a verdict, not a crash', async () => {
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const reply = await handlers.handleVerifyClaim(
    { claim: 'the market was worth EUR 6.4B', url: 'https://gone.example/report' },
    { agentId: 'validation_critic' }
  );
  assert.match(reply, /UNSUPPORTED/);
  assert.match(reply, /Do not soften/);
  global.fetch = originalFetch;
});

test('an HTTP error is reported as unsupported with its status', async () => {
  global.fetch = async () => ({ ok: false, status: 404, headers: new Map() });
  const result = await fetchCitedPage('https://example.com/missing');
  assert.equal(result.ok, false);
  assert.match(result.error, /404/);
  global.fetch = originalFetch;
});

test('a claim with no url is refused before any fetch', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be reached');
  };
  const reply = await handlers.handleVerifyClaim({ claim: 'something' }, { agentId: 'validation_critic' });
  assert.match(reply, /unsupported by definition/);
  assert.equal(called, false);
  global.fetch = originalFetch;
});

test('a fetched page comes back with the three-verdict instruction attached', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/html']]),
    text: async () => '<p>The market reached EUR 6.4 billion in 2024.</p>',
  });
  const reply = await handlers.handleVerifyClaim(
    { claim: 'the market was worth EUR 6.4 billion in 2024', url: 'https://example.com/report' },
    { agentId: 'validation_critic' }
  );
  assert.match(reply, /6\.4 billion/);
  assert.match(reply, /SUPPORTED, UNSUPPORTED or PARTIAL/);
  assert.match(reply, /being on-topic is not support/);
  global.fetch = originalFetch;
});

test('a non-text source is refused rather than fed to the model as noise', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/pdf']]),
    text: async () => '%PDF-1.7 binary',
  });
  const result = await fetchCitedPage('https://example.com/report.pdf');
  assert.equal(result.ok, false);
  assert.match(result.error, /application\/pdf/);
  global.fetch = originalFetch;
});
