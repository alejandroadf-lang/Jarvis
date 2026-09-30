// The daily briefing, end to end with every outside thing injected: what goes in
// the email (the model's review first, then the code-computed numbers, the facts,
// the sources and how it was produced), that it goes once a day, that it says
// when the panel was not independent, and that it can only fail quietly.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let digest;
let store;
let ventures;
const ENV = ['SMTP_HOST', 'REPORT_EMAIL_TO', 'CONSULTANT_AUTOFIX_DISABLED', 'CONSULTANT_DIGEST_DISABLED', 'CONSULTANT_BUDGET_USD', 'WORKSPACE_REPO_OWNER', 'WORKSPACE_REPO_NAME', 'GITHUB_TOKEN'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-digest-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of ENV) saved[k] = process.env[k];
  digest = await import('../consultant/digest.js');
  store = await import('../store.js');
  ventures = await import('../finance/ventures.js');
  ventures.createVenture({ title: 'Digest Co', oneLiner: 'x', proposedBy: 'venture_partner' });
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  // The digest tests are about the email; corrections have their own tests below.
  process.env.CONSULTANT_AUTOFIX_DISABLED = 'true';
  store.writeJson('consultant-fixes.json', { enabled: true, lastRunDate: null, runs: [], attempts: {} });
  store.writeJson('consultant-benchmark.json', { refreshedAt: '2026-10-10T01:00:00.000Z', ventures: [] });
  store.writeJson('consultant.json', { lastDate: null, history: [] });
  store.writeJson('consultant-playbook-vibe.json', {
    refreshedAt: '2026-10-10T01:00:00.000Z',
    items: [{ id: 'V1', url: 'https://vibe.example.com/tests', publisher: 'A Lab', title: 'T', retrievedAt: '2026-10-10', claim: 'Tests catch what the agent breaks.', quote: 'agents break things quietly without tests', type: 'first_hand_revenue' }],
    unread: [],
  });
  store.writeJson('consultant-playbook-tech.json', { refreshedAt: '2026-10-10T01:00:00.000Z', items: [], unread: [] });
  store.writeJson('consultant-models.json', { checkedAt: '2026-10-10T01:00:00.000Z', results: [] });
  store.writeJson('consultant-feedback.json', { items: [] });
  store.writeJson('consultant-playbook.json', {
    refreshedAt: '2026-10-10T01:00:00.000Z',
    items: [{ id: 'P1', url: 'https://good.example.com/a', publisher: 'A Founder', title: 'T', retrievedAt: '2026-10-10', claim: 'Flat pricing worked.', quote: 'charged a flat monthly fee from day one', type: 'first_hand_revenue' }],
    unread: [{ url: 'https://blocked.example.com/b', publisher: 'A Firm', reason: 'HTTP 403' }],
  });
});

const NOW = new Date('2026-10-10T03:00:00Z');
const member = (name, tier, reply) => ({ name, tier, create: async (p) => ({ content: [{ type: 'text', text: typeof reply === 'function' ? reply(p) : reply }], usage: { input_tokens: 2000, output_tokens: 600 } }) });
const review = (p) => (/independent reviews/.test(p.messages[0].content) ? '## Verdict\nNo product is live yet [E1]. Flat pricing worked for others [P1]. Invented [E99].\n## Where the reviewers disagreed\n- none' : '## Verdict\nDraft [E1]');
const panel = () => [member('Claude', 'frontier', review), member('OpenAI', 'assistant', '## Verdict\nOpenAI [E1]')];

test('the email leads with the review, then the code-computed numbers, facts, sources and how it was made', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  const sent = [];
  const out = await digest.runConsultantDigest({ now: NOW, members: panel(), refresh: async () => {}, send: async (m) => { sent.push(m); }, publish: async () => true });

  assert.equal(out.sent, true);
  assert.equal(out.emailed, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^Your AI-company briefing 2026-10-10: readiness \d(\.\d)?\/4/);
  const t = sent[0].text;
  assert.match(t, /^# Your AI-company briefing, 2026-10-10\n\n## Verdict\nNo product is live yet \[E1\]/);
  assert.match(t, /Invented \[\?\]/, 'an invented citation is replaced');
  assert.ok(t.indexOf('## Verdict') < t.indexOf('## KPIs and maturity'), 'the review comes first');
  assert.match(t, /## KPIs and maturity \(computed by code/);
  assert.match(t, /Company stage: /);
  assert.match(t, /KPI health: \d+%/);
  assert.match(t, /not industry benchmarks/);
  assert.match(t, /## Readiness scorecard \(also computed by code\)[\s\S]*Binding constraint:/);
  assert.match(t, /## Code review: what is in place and what is missing\n\nThe code was not reviewed/);
  assert.match(t, /## The facts behind the numbers\n\n\[E1\]/);
  assert.match(t, /## Sources read and verified[\s\S]*- https:\/\/good\.example\.com\/a[\s\S]*- https:\/\/vibe\.example\.com\/tests/);
  assert.match(t, /Could not be read or verified[\s\S]*blocked\.example\.com\/b: HTTP 403/);
  assert.match(t, /2 models each reviewed the company alone \(Claude, claude-sonnet-5; OpenAI, /);
  assert.match(t, /1 pointed at nothing and were replaced with \[\?\]/);
  assert.match(t, /Cost: \$0\.\d+ for the review \(budget \$0\.75\)/);
  assert.match(sent[0].subject, /KPI health \d+%/);
  assert.match(t, /not produced by, or endorsed by, any of them/);
});

test('it goes once a day, force sends again, and the state remembers', async () => {
  const run = (o = {}) => digest.runConsultantDigest({ now: NOW, members: panel(), refresh: async () => {}, send: async () => {}, publish: async () => true, ...o });
  assert.equal((await run()).sent, true);
  const again = await run();
  assert.deepEqual([again.sent, again.reason], [false, 'already sent today']);
  assert.equal((await run({ force: true })).sent, true);
  assert.equal(digest.lastDigest().date, '2026-10-10');
  assert.equal((await run({ now: new Date('2026-10-11T03:00:00Z') })).sent, true, 'a new day sends');
});

test('with one model the email says it is not an independent panel', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  const sent = [];
  await digest.runConsultantDigest({ now: NOW, members: [member('Claude', 'frontier', '## Verdict\nAlone [E1]')], refresh: async () => {}, send: async (m) => { sent.push(m); } });
  assert.match(sent[0].text, /NOT an independent panel/);
  assert.match(sent[0].text, /Set more model keys/);
});

test('it can be switched off, has a budget with a default, and does nothing to fail loudly', async () => {
  process.env.CONSULTANT_DIGEST_DISABLED = 'true';
  assert.match((await digest.runConsultantDigest({ now: NOW, members: panel() })).reason, /CONSULTANT_DIGEST_DISABLED/);
  delete process.env.CONSULTANT_DIGEST_DISABLED;

  assert.equal(digest.digestBudgetUsd(), 0.75);
  process.env.CONSULTANT_BUDGET_USD = '2';
  assert.equal(digest.digestBudgetUsd(), 2);
  process.env.CONSULTANT_BUDGET_USD = 'nonsense';
  assert.equal(digest.digestBudgetUsd(), 0.75);

  const errors = [];
  const savedErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const failed = await digest.runConsultantDigest({ now: NOW, members: [member('Claude', 'frontier', () => { throw new Error('the API is down'); })], refresh: async () => {} });
  console.error = savedErr;
  assert.equal(failed.sent, false);
  assert.match(failed.reason, /no model produced a review .*the API is down/);
  assert.equal(digest.lastDigest(), null, 'a failed briefing is not recorded as sent');
});

test('without email it still writes the vault note; with neither it says it emailed nothing', async () => {
  process.env.WORKSPACE_REPO_OWNER = 'alex';
  process.env.WORKSPACE_REPO_NAME = 'brain';
  process.env.GITHUB_TOKEN = 't';
  const published = [];
  global.fetch = async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
  const out = await digest.runConsultantDigest({ now: NOW, members: panel(), refresh: async () => {}, publish: async (p, c) => { published.push({ p, c }); return true; } });
  assert.equal(out.emailed, false);
  assert.equal(out.published, true);
  assert.equal(published[0].p, 'Company/Consultant/2026-10-10.md');
  assert.match(published[0].c, /type: consultant-digest/);
  assert.match(published[0].c, /## KPIs and maturity/);
  assert.match(published[0].c, /kpi_health: \d+/);
});

test('a stale reading list is refreshed first, per topic, and a fresh one is not', async () => {
  const topics = [];
  const run = (o) => digest.runConsultantDigest({ members: panel(), send: async () => {}, publish: async () => true, force: true, refresh: async ({ topic }) => { topics.push(topic); }, ...o });
  await run({ now: new Date('2026-10-12T03:00:00Z') });
  assert.deepEqual(topics, [], 'two days old is fresh for both');
  await run({ now: new Date('2026-10-30T03:00:00Z') });
  assert.deepEqual(topics, ['company', 'vibe', 'tech'], 'three weeks old is not');
});

test('the code review and the coding sources reach the email, and their citations are valid', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  const sent = [];
  const engineering = {
    level: 2.5,
    facts: ['the company\'s own code (me/jarvis): 200 source files and 20 test files.'],
    repos: [{ label: 'the company\'s own code', owner: 'me', name: 'jarvis', checklist: [{ key: 'ci', label: 'A CI workflow that runs the tests on every push', essential: true, present: true }, { key: 'evals', label: 'Behaviour evals that would notice an agent getting worse', essential: true, present: false }], bigFiles: [{ path: 'server/index.js', kb: 90 }], activity: { merged14: 6, ci: { green: true, failed: 0, pending: 0, total: 5 } } }],
  };
  const reply = (p) => (/independent reviews/.test(p.messages[0].content) ? '## Vibe-coding coach\nAdd evals [E1] and keep tests [V1]. KPI [K1]. Bogus [V9] [K99].' : '## Draft [E1]');
  await digest.runConsultantDigest({ now: NOW, members: [member('Claude', 'frontier', reply), member('OpenAI', 'assistant', '## Draft [E1]')], refresh: async () => {}, review: async () => engineering, send: async (m) => { sent.push(m); } });
  const t = sent[0].text;
  assert.match(t, /Add evals \[E\d+\] and keep tests \[V1\]\. KPI \[K1\]\. Bogus \[\?\] \[\?\]\./);
  assert.match(t, /2 pointed at nothing/);
  assert.match(t, /the company's own code \(me\/jarvis\)\n  \[present\] A CI workflow/);
  assert.match(t, /\[MISSING\] Behaviour evals/);
  assert.match(t, /\[WATCH\] Very large files: server\/index\.js 90 KB/);
  assert.match(t, /Engineering and code health/);
  assert.match(t, /Pull requests merged in 14 days: 6 across 1 repos/);
});

test('the benchmark and the practice review reach the email, the KPIs and the citations', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  const okProbe = (url, over = {}) => ({ url, ok: true, ms: 100, https: true, hsts: false, securityHeaders: [], hasLlmsTxt: false, hasOpenApi: false, hasDocs: true, hasChangelog: false, latestRelease: null, releases90: 0, hasStatusPage: false, compliance: [], mentionsMcp: false, mentionsSdk: false, mentionsAi: false, mentionsWebhooks: false, ...over });
  const { scoreProbe } = await import('../consultant/siteProbe.js');
  const own = okProbe('https://digest.example.com');
  const rival = okProbe('https://rival.example.com', { hasOpenApi: true, hasLlmsTxt: true, mentionsMcp: true, hsts: true });
  store.writeJson('consultant-benchmark.json', {
    refreshedAt: '2026-10-10T01:00:00.000Z',
    ventures: [{ id: 'v1', title: 'Digest Co', own: { url: own.url, probe: own, scores: scoreProbe(own) }, competitors: [{ name: 'Rival', url: rival.url, source: 'search', probe: rival, scores: scoreProbe(rival) }], rank: { quality: { rank: 2, of: 2, own: 2, best: 4 }, innovation: { rank: 2, of: 2, own: 0, best: 5 } } }],
  });
  const practice = {
    repos: [], overall: 1.5, measured: 2, total: 8, facts: ['the company\'s own code: 6 merged pull requests in 30 days (1 touched tests, 0 reviewed).'],
    areas: [{ key: 'tests', name: 'Tests travel with the code', level: 1, display: '17% of 6 pull requests touched a test', rule: 'share of merged pull requests that touch a test', trend: -1, since: '2026-09-26' }],
    actions: [{ id: 'A1', area: 'tests', areaName: 'Tests travel with the code', level: 1, effort: 'S', action: 'Write the failing test first', prompt: 'Before changing anything, write a test that fails.', target: 'at least half of merged pull requests touch a test' }],
  };
  const sent = [];
  const reply = (p) => (/independent reviews/.test(p.messages[0].content) ? '## Plan\nStart with A1 [A1] because tests are weak [K1]. Rival has an OpenAPI file [E1]. Invented [A7].' : '## Draft [E1]');
  await digest.runConsultantDigest({ now: NOW, members: [member('Claude', 'frontier', reply), member('OpenAI', 'assistant', '## Draft [E1]')], refresh: async () => {}, practiceReview: async () => practice, send: async (m) => { sent.push(m); } });
  const t = sent[0].text;
  assert.match(t, /## Technology against competitors \(public signals/);
  assert.match(t, /Digest Co \(you\)\s+quality \d+\/10\s+innovation \d+\/10/);
  assert.match(t, /Rank on quality: 2 of 2/);
  assert.match(t, /## Your building practice: KPIs, trend and the actions that would lift them/);
  assert.match(t, /↓ down 1 since 2026-09-26/);
  assert.match(t, /A1  \[Tests travel with the code, effort S\]  Write the failing test first/);
  assert.match(t, /first prompt: Before changing anything, write a test that fails\./);
  assert.match(t, /Technology quality against competitors \(Digest Co\): 2\/10, rank 2 of 2 \(best 4\/10\)/);
  assert.match(t, /Practice: Tests travel with the code: level 1\/4/);
  assert.match(t, /Start with A1 \[A1\] because tests are weak \[K\d+\]\./);
  assert.match(t, /Invented \[\?\]\./, 'an action id that does not exist is caught');
});

test('corrections are listed in the email, start after it has gone, are reported in a second email, and never fail the briefing', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  delete process.env.CONSULTANT_AUTOFIX_DISABLED;
  const order = [];
  const sent = [];
  const record = { ran: true, date: '2026-10-10', outcomes: [{ id: 'F1', status: 'done', title: 'Digest Co: A price is set', note: 'a decision is in the inbox' }], prs: [{ venture: 'Digest Co', title: 'Add llms.txt', url: 'https://github.com/me/x/pull/3' }], usd: 0.31 };
  const out = await digest.runConsultantDigest({
    now: NOW,
    members: panel(),
    refresh: async () => {},
    send: async (m) => { order.push('email'); sent.push(m); },
    autofix: async ({ selected }) => { order.push(`autofix:${selected.map((s) => s.id).join(',')}`); return record; },
  });
  assert.ok(order[0] === 'email' && order[1].startsWith('autofix:F1'), 'the briefing goes out first, then the corrections start');
  const [briefing, followUp] = sent;
  assert.match(briefing.text, /## Corrections the team starts on its own, without asking you/);
  assert.match(briefing.text, /Starting now, after this email/);
  assert.match(briefing.text, /F1  \[(decision|task|pr|draft)\]/);
  assert.match(briefing.text, /pull requests only, never merged/);
  assert.match(followUp.subject, /^Corrections started 2026-10-10: 1 done, 0 asked, 1 pull requests/);
  assert.match(followUp.text, /Pull requests opened \(never merged; you or CI decide\)[\s\S]*Add llms\.txt https:\/\/github\.com\/me\/x\/pull\/3/);
  assert.ok(out.usd >= 0.31);
  assert.equal(out.corrections.ran, true);

  // A session that throws does not fail the briefing.
  store.writeJson('consultant.json', { lastDate: null, history: [] });
  store.writeJson('consultant-fixes.json', { enabled: true, lastRunDate: null, runs: [record], attempts: {} });
  const errors = [];
  const saved = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const sent2 = [];
  const again = await digest.runConsultantDigest({ now: new Date('2026-10-11T03:00:00Z'), members: panel(), refresh: async () => {}, send: async (m) => { sent2.push(m); }, autofix: async () => { throw new Error('the session crashed'); } });
  console.error = saved;
  assert.equal(again.sent, true);
  assert.equal(again.corrections.ran, false);
  assert.match(sent2[0].text, /What the last run \(2026-10-10\) did:[\s\S]*F1  DONE  Digest Co: A price is set/, 'yesterday\'s outcome is in today\'s briefing');
  assert.equal(sent2.length, 1, 'no second email when nothing ran');
});

test('with corrections switched off the email says nothing is being started', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  const sent = [];
  let called = false;
  await digest.runConsultantDigest({ now: NOW, members: panel(), refresh: async () => {}, send: async (m) => { sent.push(m); }, autofix: async () => { called = true; return { ran: true, outcomes: [], prs: [] }; } });
  assert.match(sent[0].text, /Automatic corrections are OFF \(AUTOFIX ON turns them on\), so nothing below is being started\./);
  assert.equal(called, false);
});

test('the briefing reviews itself: health, the model check, the founder\'s notes and improvements cited as [B#]', async () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.REPORT_EMAIL_TO = 'me@example.com';
  const selfReview = await import('../consultant/selfReview.js');
  selfReview.addFeedback('Put the KPIs first and keep it shorter');
  store.writeJson('consultant-playbook-tech.json', {
    refreshedAt: '2026-10-10T01:00:00.000Z',
    items: [{ id: 'T1', url: 'https://labs.example.com/release', publisher: 'A Lab', title: 'Release', retrievedAt: '2026-10-10', claim: 'A newer model is out.', quote: 'a new model with lower prices is available', type: 'first_hand_revenue' }],
    unread: [],
  });
  store.writeJson('consultant-models.json', {
    checkedAt: '2026-10-09T01:00:00.000Z',
    results: [{ provider: 'OpenAI', configured: 'gpt-4o-mini', found: true, createdOn: '2024-07-18', newer: [{ id: 'gpt-5-mini', created: '2026-08-01' }] }],
  });
  const seen = [];
  const sent = [];
  const reply = (p) => { seen.push(p.messages[0].content); return /independent reviews/.test(p.messages[0].content) ? '## How to improve this briefing\nA newer model exists [T1] and the panel is thin [B1]. Bogus [B99].' : '## Draft [E1]'; };
  await digest.runConsultantDigest({ now: NOW, members: [member('Claude', 'frontier', reply), member('OpenAI', 'assistant', reply)], refresh: async () => {}, send: async (m) => { sent.push(m); } });
  const t = sent[0].text;
  assert.match(t, /## How to improve this briefing/);
  assert.match(t, /Model check, OpenAI: configured gpt-4o-mini \(created 2024-07-18\); newer on this account: gpt-5-mini/);
  assert.match(t, /\[B\d+\] OpenAI lists newer models than gpt-4o-mini: gpt-5-mini/);
  assert.match(t, /Your recent notes on the briefing:\n- 2026-\d\d-\d\d: Put the KPIs first and keep it shorter/);
  assert.match(t, /A newer model exists \[T1\] and the panel is thin \[B1\]\. Bogus \[\?\]\./);
  assert.match(t, /Read by the server \(.*\)[\s\S]*labs\.example\.com\/release/);
  assert.ok(seen[0].includes('Put the KPIs first and keep it shorter'), 'the founder\'s note reaches the models');
  assert.ok(seen[0].includes('[T1] A newer model is out.'));
  const state = store.readJson('consultant.json', {});
  assert.equal(typeof state.history[0].unmeasuredKpis, 'number');
});

test('a stale model check runs once, and its failure never stops the briefing', async () => {
  store.writeJson('consultant-models.json', { checkedAt: '2026-09-01T00:00:00.000Z', results: [] });
  let calls = 0;
  const out = await digest.runConsultantDigest({ now: NOW, members: panel(), refresh: async () => {}, send: async () => {}, publish: async () => true, modelScan: async () => { calls += 1; throw new Error('provider down'); } });
  assert.equal(calls, 1);
  assert.equal(out.sent, true);
});

test('the sources the founder listed are read first, on the right shelf', async () => {
  const notes = [{ path: 'Library/Briefing sources.md', fm: { type: 'briefing-sources' }, body: '## company\n- https://mine.example.com/a\n## tech\n- https://mine.example.com/changelog\n' }];
  const selfReview = await import('../consultant/selfReview.js');
  assert.deepEqual(selfReview.founderSources(notes, 'tech').map((p) => p.url), ['https://mine.example.com/changelog']);
  assert.deepEqual(selfReview.founderSources(notes, 'company').map((p) => p.url), ['https://mine.example.com/a']);
  assert.deepEqual(selfReview.founderSources(notes, 'vibe'), []);
  assert.deepEqual(selfReview.founderSources([], 'tech'), []);
});
