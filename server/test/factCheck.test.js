// Does this company's own output survive being checked?
//
// Every fix shipped this week was made on published evidence about research
// agents, and none of it was measured here. The published band for claim-level
// citation support runs 39% to 77% — a fifty-three point spread — and this
// company had no idea where in it sat.
//
// The tests that matter most are the ones about *not* scoring well by accident:
// an unparseable judgement must not count as support, an unreachable source
// must not count as a failure of the claim, and "nothing could be judged" must
// never render as 0%.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let factCheck;
let ventures;
let reports;
let originalFetch;
const saved = {};
const KEYS = ['OPENROUTER_API_KEY', 'DAILY_SPEND_CAP_USD'];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-factcheck-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.DAILY_SPEND_CAP_USD = '100';
  originalFetch = global.fetch;
  factCheck = await import('../factCheck.js');
  ventures = await import('../finance/ventures.js');
  reports = await import('../dailyReports.js');
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

beforeEach(() => {
  for (const file of ['ventures.json', 'dailyReports.json']) fs.rmSync(path.join(tmpDir, file), { force: true });
  global.fetch = originalFetch;
});

// Page fetch and model judgement both go over fetch, told apart by the URL.
function respond({ page = 'The market reached EUR 6.4 billion in 2024.', verdict = 'SUPPORTED — the figure is on the page.' } = {}) {
  global.fetch = async (url) => {
    if (String(url).includes('openrouter') || String(url).includes('chat/completions')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { content: verdict } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    }
    return { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => `<p>${page}</p>` };
  };
}

// --- Finding the claims ---------------------------------------------------------------

test('a sentence that cites something becomes a claim paired with its source', () => {
  const found = factCheck.extractCitedClaims('The EU market was worth EUR 6.4 billion in 2024 (https://example.com/report).');
  assert.equal(found.length, 1);
  assert.match(found[0].claim, /6\.4 billion/);
  assert.equal(found[0].url, 'https://example.com/report');
  assert.doesNotMatch(found[0].claim, /https/, 'the url is not left inside the claim');
});

// A link on its own asserts nothing, and counting it would pad the denominator
// with things that cannot fail.
test('a bare link is a reference, not a claim', () => {
  assert.deepEqual(factCheck.extractCitedClaims('See https://example.com/other for more.'), []);
  assert.deepEqual(factCheck.extractCitedClaims('https://example.com'), []);
});

test('an uncited sentence is invisible to this check', () => {
  assert.deepEqual(factCheck.extractCitedClaims('The market is enormous and growing fast.'), []);
});

test('a full stop inside a domain does not split the sentence', () => {
  const found = factCheck.extractCitedClaims('Revenue tripled last year according to https://sub.example.co.uk/a.b page four.');
  assert.equal(found.length, 1);
  assert.match(found[0].url, /sub\.example\.co\.uk/);
});

test('claims are gathered from reports and venture records alike', () => {
  reports.saveDailyReport({
    date: '2026-09-18',
    generatedAt: new Date().toISOString(),
    leadership: { reply: 'Demand is proven by the waitlist of 400 (https://example.com/waitlist).', trace: [] },
    studio: { reply: '', trace: [] },
  });
  const venture = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
  ventures.recordVentureNote(venture.id, { note: 'Competitor pricing sits at EUR 49 per seat (https://example.com/pricing).' });

  const claims = factCheck.gatherCitedClaims();
  const wheres = claims.map((c) => c.where);
  assert.ok(wheres.some((w) => /daily report/.test(w)));
  assert.ok(wheres.some((w) => /note on/.test(w)));
});

// --- Judging one claim -----------------------------------------------------------------

test('a page that says it is SUPPORTED', async () => {
  respond();
  const result = await factCheck.checkCitedClaim({
    claim: 'the market reached EUR 6.4 billion in 2024',
    url: 'https://example.com/report',
    anthropic: {},
  });
  assert.equal(result.verdict, 'SUPPORTED');
  assert.equal(result.resolves, true);
});

test('a page that says something close but different is PARTIAL', async () => {
  respond({ verdict: 'PARTIAL — the page says 7.2 billion, not 6.4.' });
  const result = await factCheck.checkCitedClaim({ claim: 'EUR 6.4 billion', url: 'https://example.com/report', anthropic: {} });
  assert.equal(result.verdict, 'PARTIAL');
  assert.match(result.reason, /7\.2 billion/);
});

// Dimension one failing must not be scored as the claim being wrong.
test('a source that will not open is UNREACHABLE, not UNSUPPORTED', async () => {
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await factCheck.checkCitedClaim({ claim: 'anything at all here', url: 'https://gone.example/x', anthropic: {} });
  assert.equal(result.verdict, 'UNREACHABLE');
  assert.equal(result.resolves, false);
});

// The single most important line in the file: an answer nobody can parse is
// not a pass. Defaulting it to SUPPORTED would inflate the only number this
// exists to produce.
test('an unparseable judgement is never counted as support', async () => {
  respond({ verdict: 'Well, it depends how you look at it, really.' });
  const result = await factCheck.checkCitedClaim({ claim: 'the market reached X', url: 'https://example.com/r', anthropic: {} });
  assert.equal(result.verdict, 'UNJUDGED');
});

test('an unreachable judge does not become a verdict either', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('openrouter') || String(url).includes('chat/completions')) throw new Error('judge down');
    return { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => '<p>x</p>' };
  };
  const result = await factCheck.checkCitedClaim({ claim: 'some real claim here', url: 'https://example.com/r', anthropic: {} });
  assert.equal(result.verdict, 'UNJUDGED');
  assert.match(result.reason, /judge could not be reached/);
});

// --- The number ---------------------------------------------------------------------------

test('the support rate counts only what was actually judged', async () => {
  reports.saveDailyReport({
    date: '2026-09-18',
    generatedAt: new Date().toISOString(),
    leadership: {
      reply: [
        'The market reached EUR 6.4 billion in 2024 (https://example.com/a).',
        'Competitors charge EUR 49 per seat (https://example.com/b).',
      ].join('\n'),
      trace: [],
    },
    studio: { reply: '', trace: [] },
  });

  let call = 0;
  global.fetch = async (url) => {
    if (String(url).includes('openrouter') || String(url).includes('chat/completions')) {
      call += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ finish_reason: 'stop', message: { content: call === 1 ? 'SUPPORTED — yes.' : 'Hmm, unclear.' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    }
    return { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), text: async () => '<p>x</p>' };
  };

  const result = await factCheck.runFactCheck({ anthropic: {} });
  assert.equal(result.checked, 2);
  assert.equal(result.judged, 1, 'the unparseable one is not in the denominator');
  assert.equal(result.supportRate, 100);
});

// "0% supported" and "nothing was checkable" are different findings, and one of
// them is an indictment. They must not render the same.
test('nothing judgeable reports as null, never as zero percent', async () => {
  reports.saveDailyReport({
    date: '2026-09-18',
    generatedAt: new Date().toISOString(),
    leadership: { reply: 'A claim with a dead source (https://gone.example/x).', trace: [] },
    studio: { reply: '', trace: [] },
  });
  global.fetch = async () => {
    throw new Error('down');
  };

  const result = await factCheck.runFactCheck({ anthropic: {} });
  assert.equal(result.judged, 0);
  assert.equal(result.supportRate, null);
  assert.match(factCheck.describeFactCheck(result), /none of which could be judged/);
  assert.doesNotMatch(factCheck.describeFactCheck(result), /0%/);
});

test('the report reads against the published band', async () => {
  respond();
  reports.saveDailyReport({
    date: '2026-09-18',
    generatedAt: new Date().toISOString(),
    leadership: { reply: 'The market reached EUR 6.4 billion in 2024 (https://example.com/a).', trace: [] },
    studio: { reply: '', trace: [] },
  });
  const result = await factCheck.runFactCheck({ anthropic: {} });
  const text = factCheck.describeFactCheck(result);
  assert.match(text, /100%/);
  assert.match(text, /39% and 77%/, 'a bare percentage means nothing without the band');
});

// An uncited claim cannot be checked by anyone, including the team that made
// it — so an empty result is a finding rather than a blank.
test('no cited claims at all is reported as a finding', () => {
  assert.match(factCheck.describeFactCheck({ checked: 0 }), /cannot be checked by anyone/);
});
