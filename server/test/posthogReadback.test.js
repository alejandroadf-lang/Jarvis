// Circadian's PostHog numbers, read back. The request shape is pinned because
// it could only be confirmed from search results, not from PostHog's own docs
// (the page was blocked), so a wrong key or host must fail with a message that
// names the fix, and a failing second query must not lose the totals.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ph;
let fp;
const KEYS = ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID', 'POSTHOG_APP_HOST'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-posthog-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  ph = await import('../posthogReadback.js');
  fp = await import('../workspace/founderPages.js');
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
});

const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
const configure = () => {
  process.env.POSTHOG_PERSONAL_API_KEY = 'phx_secret';
  process.env.POSTHOG_PROJECT_ID = '12345';
};

// what PostHog returns for the first query: [event, week, events, devices]
const TOTALS = [
  ['app_opened', 'this', 90, 40], ['app_opened', 'before', 60, 30],
  ['plan_made', 'this', 30, 18], ['plan_made', 'before', 10, 8],
  ['reminders_on', 'this', 6, 5],
  ['whoop_connected', 'this', 2, 2],
  ['$exception', 'this', 3, 2],
];

test('it needs the personal key and the project id, and says nothing without them', async () => {
  assert.equal(ph.isPosthogReadConfigured(), false);
  assert.equal(await ph.refreshPosthog({ fetchImpl: async () => { throw new Error('must not be called'); } }), null);
  assert.equal(ph.buildPosthogContext() === '' || typeof ph.buildPosthogContext() === 'string', true);
  process.env.POSTHOG_PERSONAL_API_KEY = 'phx_secret';
  assert.equal(ph.isPosthogReadConfigured(), false, 'the project id is needed too');
});

test('it asks the app host with the personal key as a bearer token, in HogQL, and summarises the answer', async () => {
  configure();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return calls.length === 1 ? json(200, { results: TOTALS }) : json(200, { results: [[4]] });
  };
  const snap = await ph.refreshPosthog({ fetchImpl });

  assert.equal(calls[0].url, 'https://us.posthog.com/api/projects/12345/query/');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer phx_secret');
  assert.equal(calls[0].body.query.kind, 'HogQLQuery');
  assert.match(calls[0].body.query.query, /from events/);
  assert.match(calls[0].body.query.query, /'plan_made'/);
  assert.doesNotMatch(calls[0].body.query.query, /person|\$ip|email/i, 'counts only');

  assert.equal(snap.returning, 4);
  const line = ph.buildPosthogContext();
  assert.match(line, /40 devices opened it ↑/);
  assert.match(line, /18 made a plan \(30 plans\) ↑/);
  assert.match(line, /5 turned reminders on/);
  assert.match(line, /2 connected WHOOP/);
  assert.match(line, /4 devices made a plan on two or more days/);
  assert.match(line, /3 errors/);
  assert.match(line, /anonymous counts/);
});

test('the EU app host is honoured, a refused key names the fix, and a failing second query keeps the totals', async () => {
  configure();
  process.env.POSTHOG_APP_HOST = 'https://eu.posthog.com/';
  let url = '';
  await ph.refreshPosthog({ fetchImpl: async (u) => { url = u; return json(200, { results: TOTALS }); } });
  assert.equal(url, 'https://eu.posthog.com/api/projects/12345/query/');

  const errors = [];
  const savedErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const refused = await ph.refreshPosthog({ fetchImpl: async () => json(401, {}) });
  assert.equal(refused, null);
  assert.ok(errors.some((e) => /personal API key with the Query Read permission, not the phc_ project key/.test(e)));

  let n = 0;
  const snap = await ph.refreshPosthog({ fetchImpl: async () => (++n === 1 ? json(200, { results: TOTALS }) : json(500, {})) });
  console.error = savedErr;
  assert.equal(snap.returning, null, 'the second query failed');
  assert.match(ph.buildPosthogContext(), /40 devices opened it/);
  assert.doesNotMatch(ph.buildPosthogContext(), /two or more days/);
});

test('the usage line reaches Today.md, below what needs the founder', async () => {
  configure();
  await ph.refreshPosthog({ fetchImpl: async () => json(200, { results: TOTALS }) });
  const page = fp.buildToday({ notes: [], decisions: [{ decision: 'pending', title: 'Raise API price', expires: '2026-10-14' }], now: new Date('2026-10-10T03:00:00Z') });
  assert.match(page, /## Use\nCircadian, 7 days: 40 devices opened it/);
  assert.ok(page.indexOf('## Needs you') < page.indexOf('## Use'), 'if the page is cut to fit, the usage goes first');
  assert.ok(page.length <= 1500);
});
