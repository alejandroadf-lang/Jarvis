// The briefing improving itself. Pinned: the model check compares what is
// configured with what each provider's own list says (newer, missing, unlisted,
// unreachable) and never switches anything; the briefing's health comes from its
// own record; the improvement list is chosen by code from fixed rules with stable
// ids; the founder's notes are stored through the write gate and shown back; the
// technology shelf is verified like the others and the founder's own pages come
// first; and BRIEFING FEEDBACK is a command of its own, not DIGEST.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let scout;
let review;
let pb;
let commands;
let store;
const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-selfreview-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  scout = await import('../consultant/modelScout.js');
  review = await import('../consultant/selfReview.js');
  pb = await import('../consultant/playbook.js');
  commands = await import('../channels/founderCommands.js');
  store = await import('../store.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  store.writeJson('consultant-feedback.json', { items: [] });
  store.writeJson('consultant-models.json', null);
});

const T = (iso) => Date.parse(iso) / 1000;
const OPENAI = { name: 'OpenAI', family: /^(gpt-|o\d)/ };

test('newer models on the account are found by creation date, other kinds of model are ignored', () => {
  const list = [
    { id: 'gpt-4o-mini', created: T('2024-07-18') },
    { id: 'gpt-5-mini', created: T('2026-08-01') },
    { id: 'gpt-5', created: T('2026-06-01') },
    { id: 'text-embedding-4', created: T('2026-09-01') },
    { id: 'gpt-realtime', created: T('2026-09-05') },
    { id: 'gpt-3.5-turbo', created: T('2023-03-01') },
  ];
  const r = scout.compareModels(OPENAI, 'gpt-4o-mini', list);
  assert.equal(r.found, true);
  assert.equal(r.createdOn, '2024-07-18');
  assert.deepEqual(r.newer.map((n) => n.id), ['gpt-5-mini', 'gpt-5'], 'newest first, no embeddings or realtime');
});

test('a configured model missing from the list is reported as possibly retired, and the newest of its kind says so', () => {
  const list = [{ id: 'gpt-5', created: T('2026-06-01') }];
  const gone = scout.compareModels(OPENAI, 'gpt-4o-mini', list);
  assert.equal(gone.found, false);
  assert.deepEqual(gone.newer, [], 'with no date for the configured model nothing can be called newer');
  assert.match(scout.scoutFacts({ results: [{ provider: 'OpenAI', ...gone }] })[0], /gpt-4o-mini is not in the account's list, so it may have been renamed or retired/);
  const newest = scout.compareModels(OPENAI, 'gpt-5', list);
  assert.match(scout.scoutFacts({ results: [{ provider: 'OpenAI', ...newest }] })[0], /is the newest of its kind on this account/);
});

test('Gemini is compared by version of the same kind, and OpenRouter by the same maker', () => {
  const gem = scout.compareModels({ name: 'Gemini', family: /^gemini-/ }, 'gemini-2.0-flash', [
    { id: 'gemini-2.0-flash' }, { id: 'gemini-2.5-flash' }, { id: 'gemini-3-flash' }, { id: 'gemini-3-pro' }, { id: 'gemini-2.5-pro' },
  ]);
  assert.deepEqual(gem.newer.map((n) => n.id).sort(), ['gemini-2.5-flash', 'gemini-3-flash'], 'a pro model is not a newer flash');
  const or = scout.compareModels({ name: 'OpenRouter', family: null }, 'nousresearch/hermes-3', [
    { id: 'nousresearch/hermes-3', created: T('2024-08-01') },
    { id: 'nousresearch/hermes-4', created: T('2025-08-01') },
    { id: 'someone/else-9', created: T('2026-01-01') },
  ]);
  assert.deepEqual(or.newer.map((n) => n.id), ['nousresearch/hermes-4']);
});

test('only providers with keys are asked, a failing one is reported not fatal, the result is cached weekly, and it changes nothing', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
  process.env.OPENAI_API_KEY = 'sk-x';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('openai')) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-5', created_at: '2026-05-01T00:00:00Z' }, { id: 'claude-opus-5-5', created_at: '2026-09-01T00:00:00Z' }] }) };
  };
  const tiers = { frontier: { model: 'claude-sonnet-5' }, assistant: { model: 'gpt-4o-mini' } };
  const out = await scout.scoutModels({ fetchImpl, now: new Date('2026-10-10T00:00:00Z'), env: process.env, tiers: { ...tiers } });
  assert.equal(out.results.length, 2, 'Gemini, Grok and DeepSeek have no keys, so they are not asked');
  assert.ok(calls.every((u) => /anthropic|openai/.test(u)));
  const claude = out.results.find((r) => r.provider === 'Anthropic');
  assert.deepEqual(claude.newer.map((n) => n.id), ['claude-opus-5-5']);
  assert.match(out.results.find((r) => r.provider === 'OpenAI').error, /HTTP 401/);
  assert.match(scout.scoutFacts(out).join('\n'), /Model check, OpenAI: could not list/);

  assert.equal(scout.modelScoutIsStale(new Date('2026-10-12T00:00:00Z')), false);
  assert.equal(scout.modelScoutIsStale(new Date('2026-10-20T00:00:00Z')), true);
  assert.equal(scout.getModelScout().checkedAt, '2026-10-10T00:00:00.000Z');
});

test('the briefing\'s health comes from its own record', () => {
  const history = [
    { date: '2026-10-08', usd: 0.5, unknownCitations: 1, citations: 19 },
    { date: '2026-10-09', usd: 0.7, unknownCitations: 3, citations: 17 },
    { date: '2026-10-10', usd: 0.6, unknownCitations: 0, citations: 20 },
  ];
  const h = review.briefingHealth({ history, today: { unmeasuredKpis: 9, kpiTotal: 24, singleModel: false, drafters: 3, sources: { company: { read: 3, unread: 1 }, technology: { read: 0, unread: 0 } } } });
  assert.equal(h.recentCount, 3);
  assert.equal(h.avgUsd.toFixed(2), '0.60');
  assert.equal(h.unknownTotal, 4);
  const text = h.facts.join('\n');
  assert.match(text, /3 briefings sent so far, averaging \$0\.60 each over the last 3/);
  assert.match(text, /9 of 24 KPIs could not be measured/);
  assert.match(text, /4 of 60 citations pointed at nothing/);
  assert.match(text, /3 models were asked to review today/);
  assert.match(text, /company: 3 read, 1 unreadable; technology: 0 read, 0 unreadable/);
});

test('improvements are chosen by fixed rules, in a stable order, each an action', () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-0${i + 1}`, usd: 0.72, unknownCitations: 4, citations: 16 }));
  const today = { unmeasuredKpis: 9, kpiTotal: 24, singleModel: true, drafters: 1, sources: { company: { read: 1, unread: 4 }, technology: { read: 0, unread: 0 } } };
  const health = review.briefingHealth({ history, today });
  const scoutResult = { results: [
    { provider: 'OpenAI', configured: 'gpt-4o-mini', found: true, createdOn: '2024-07-18', newer: [{ id: 'gpt-5-mini', created: '2026-08-01' }] },
    { provider: 'Grok', configured: 'grok-4.3', found: false, newer: [] },
    { provider: 'DeepSeek', configured: 'deepseek-chat', error: 'HTTP 500' },
  ] };
  const c = review.improvementCandidates({ health, today, scout: scoutResult, feedback: [{ date: '2026-10-09', text: 'shorter please' }], budgetUsd: 0.75 });
  const texts = c.map((x) => x.text).join('\n');
  assert.deepEqual(c.map((x) => x.id), c.map((_, i) => `B${i + 1}`));
  assert.match(c[0].text, /^Add a second and third model .* OPENAI_API_KEY/);
  assert.match(texts, /OpenAI lists newer models than gpt-4o-mini: gpt-5-mini\. .*INPUT and OUTPUT price variables/);
  assert.match(texts, /Grok's list no longer shows grok-4\.3/);
  assert.doesNotMatch(texts, /DeepSeek/, 'a provider that could not be asked produces no advice about its models');
  assert.match(texts, /9 of 24 KPIs are NOT MEASURED/);
  assert.match(texts, /More sources on the company shelf could not be read than were read/);
  assert.match(texts, /The technology shelf has not been read yet/);
  assert.match(texts, /averages \$0\.72 against a \$0\.75 budget/);
  assert.match(texts, /More than one citation in ten/);
  assert.match(texts, /latest note on the briefing \(2026-10-09\): "shorter please"/);
  assert.equal(review.improvementsText(c).split('\n').length, c.length);
});

test('with a healthy briefing there is little to fix, and with no feedback it asks for some', () => {
  const history = Array.from({ length: 5 }, (_, i) => ({ date: `2026-10-0${i + 1}`, usd: 0.4, unknownCitations: 0, citations: 20 }));
  const today = { unmeasuredKpis: 0, kpiTotal: 24, singleModel: false, drafters: 3, sources: { company: { read: 4, unread: 1 } } };
  const c = review.improvementCandidates({ health: review.briefingHealth({ history, today }), today, scout: null, feedback: [], budgetUsd: 0.75 });
  assert.equal(c.length, 1);
  assert.match(c[0].text, /BRIEFING FEEDBACK/);
});

test('the founder\'s notes are stored, capped, gated and shown back', () => {
  assert.equal(review.addFeedback('  ').ok, false);
  const secret = review.addFeedback('use this key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(secret.ok, false, 'a pasted credential is refused, not stored');
  assert.match(secret.reason, /Not saved/);
  for (let i = 0; i < 25; i += 1) assert.equal(review.addFeedback(`note number ${i}`, new Date('2026-10-10T00:00:00Z')).ok, true);
  assert.equal(review.getFeedback().length, 20);
  assert.equal(review.getFeedback().at(-1).text, 'note number 24');
  assert.equal(review.feedbackText(review.getFeedback(), { limit: 2 }), '- 2026-10-10: note number 23\n- 2026-10-10: note number 24');
});

test('BRIEFING FEEDBACK is its own command; DIGEST still starts a briefing', async () => {
  assert.deepEqual(commands.parseFounderCommand('BRIEFING FEEDBACK: shorter and KPIs first'), { kind: 'briefing_feedback', text: 'shorter and KPIs first' });
  assert.equal(commands.parseFounderCommand('briefing feedback keep the tone').text, 'keep the tone');
  assert.equal(commands.parseFounderCommand('briefing').kind, 'digest');
  assert.equal(commands.parseFounderCommand('briefing feedback').kind, 'briefing_feedback');
  const reply = await commands.runFounderCommand({ kind: 'briefing_feedback', text: 'Put the KPIs first' }, {});
  assert.match(reply, /^Noted\./);
  assert.equal(review.getFeedback().at(-1).text, 'Put the KPIs first');
  assert.match(await commands.runFounderCommand({ kind: 'briefing_feedback', text: '' }, {}), /Say what to change/);
  assert.match(commands.__helpForTests, /BRIEFING FEEDBACK <text>/);
});

test('the technology shelf has its own file, prefix and question, and the founder\'s pages come first', async () => {
  assert.equal(pb.TOPICS.tech.prefix, 'T');
  assert.notEqual(pb.TOPICS.tech.file, pb.TOPICS.company.file);
  const prompt = pb.discoveryPrompt(new Date('2026-10-10T00:00:00Z'), 'tech');
  assert.match(prompt, /last 60 days/);
  assert.match(prompt, /new or retired language models/);
  assert.match(prompt, /MCP/);

  const page = `<p>${'The lab announced a new model with lower prices is available today and retired the old one. '.repeat(8)}</p>`;
  const member = { name: 'Claude', tier: 'frontier', create: async () => ({ content: [{ type: 'text', text: JSON.stringify([{ claim: 'A cheaper model shipped.', quote: 'a new model with lower prices is available today', type: 'first_hand_revenue' }]) }], usage: { input_tokens: 10, output_tokens: 10 } }) };
  const fetched = [];
  const out = await pb.refreshPlaybook({
    topic: 'tech',
    member,
    now: new Date('2026-10-10T03:00:00Z'),
    extraPages: [{ url: 'https://mine.example.com/changelog', publisher: 'chosen by the founder' }, { url: 'http://insecure.example.com/x' }],
    discover: async () => [{ url: 'https://mine.example.com/changelog' }, { url: 'https://lab.example.com/news' }],
    fetchText: async (url) => { fetched.push(url); return page; },
    publish: async () => true,
  });
  assert.deepEqual(fetched, ['https://mine.example.com/changelog', 'https://lab.example.com/news'], 'the founder\'s page first, once; an http page never');
  assert.deepEqual(out.items.map((i) => i.id), ['T1', 'T2']);
  assert.equal(pb.getPlaybook('tech').items.length, 2);
  assert.equal(pb.getPlaybook('company')?.items?.length ?? 0, 0, 'the other shelves are untouched');
});

test('a model that did not answer becomes an improvement with the fix its own error names', () => {
  const members = [
    { name: 'Claude', ok: false, error: 'an empty answer (stopped: max_tokens)' },
    { name: 'OpenAI', ok: true, model: 'gpt-4o-mini' },
    { name: 'Gemini', ok: false, error: 'Gemini request failed (429): You exceeded your current quota, please check your plan and billing details.' },
    { name: 'DeepSeek', ok: false, error: 'DeepSeek request failed (402): {"error":{"message":"Insufficient Balance"}}' },
    { name: 'Hermes (OpenRouter)', ok: false, error: 'OpenRouter request failed (402): Insufficient credits. This account never purchased credits.' },
    { name: 'Grok', ok: false, error: 'Grok request failed (401): Incorrect API key provided' },
  ];
  const c = review.panelImprovements(members, 6);
  assert.deepEqual(c.map((x) => x.id), ['B7', 'B8', 'B9', 'B10', 'B11', 'B12']);
  const t = c.map((x) => x.text);
  assert.match(t[0], /^Claude returned no text \(an empty answer \(stopped: max_tokens\)\)/);
  assert.match(t[1], /^Gemini is over its quota or rate limit.*remove GEMINI_API_KEY/);
  assert.match(t[2], /^DeepSeek refused the request because the account has no balance.*remove DEEPSEEK_API_KEY/);
  assert.match(t[3], /^Hermes \(OpenRouter\) refused the request because the account has no balance.*OPENROUTER_API_KEY/);
  assert.match(t[4], /^Grok rejected its key.*XAI_API_KEY/);
  assert.match(t[5], /^Only OpenAI wrote today's review, so it was not an independent panel and nothing was merged/);
  assert.deepEqual(review.panelImprovements([{ name: 'Claude', ok: true }, { name: 'OpenAI', ok: true }, { name: 'Claude (merge)', ok: true }]), [], 'nothing to fix when they all answered');
});

test('the health line says how many models were asked, not how many independently reviewed', () => {
  const h = review.briefingHealth({ history: [], today: { singleModel: false, drafters: 5 } });
  assert.match(h.facts.join('\n'), /5 models were asked to review today/);
  assert.doesNotMatch(h.facts.join('\n'), /independently/);
});
