// The competitor benchmark: who is compared, how the ranking follows from the
// printed rubric, and what happens when there is nothing to compare. Pinned:
// the founder's list beats the search's, proposals are https-only and exclude our
// own host, the rank counts only competitors that could be probed, gaps name what
// the best competitor has that we lack, and a venture with no live URL is asked
// for one and not scored.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let cp;
let ventures;
let a;
let b;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-competitors-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  cp = await import('../consultant/competitors.js');
  ventures = await import('../finance/ventures.js');
  a = ventures.createVenture({ title: 'Alpha API', oneLiner: 'x', proposedBy: 'venture_partner' });
  b = ventures.createVenture({ title: 'Beta App', oneLiner: 'y', proposedBy: 'venture_partner' });
  ventures.setServiceUrl(a.id, 'https://alpha.example.com');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-10T03:00:00Z');
const okProbe = (url, over = {}) => ({ url, ok: true, ms: 100, https: true, hsts: false, securityHeaders: [], hasLlmsTxt: false, hasOpenApi: false, hasDocs: false, hasChangelog: false, latestRelease: null, releases90: 0, hasStatusPage: false, compliance: [], mentionsMcp: false, mentionsSdk: false, mentionsAi: false, mentionsWebhooks: false, ...over });

test('the founder\'s list beats the search, proposals are https-only and never our own site', async () => {
  const notes = [{ fm: { type: 'competitor-list', venture: 'alpha api' }, body: '# Track\n\n## Track\n\n- https://founder-pick.example.com\n- http://insecure.example.com\n- https://second.example.com/x\n' }];
  assert.deepEqual(cp.founderCompetitors(notes, { title: 'Alpha API' }).map((c) => c.url), ['https://founder-pick.example.com', 'https://second.example.com/x']);
  assert.equal(cp.founderCompetitors(notes, { title: 'Beta App' }), null);

  const asked = [];
  const probed = [];
  const out = await cp.refreshBenchmark({
    now: NOW,
    notes,
    discover: async ({ ventures: vs }) => {
      asked.push(vs.map((v) => v.title));
      return { [b.id]: [{ name: 'Rival', url: 'https://rival.example.com' }, { name: 'Insecure', url: 'http://nope.example.com' }, { name: 'Dup', url: 'https://rival.example.com/other' }, { name: 'Junk' }] };
    },
    probe: async (url) => { probed.push(url); return okProbe(url); },
  });
  assert.deepEqual(asked, [['Beta App']], 'the venture with a founder list is not searched for');
  const alpha = out.ventures.find((v) => v.id === a.id);
  const beta = out.ventures.find((v) => v.id === b.id);
  assert.deepEqual(alpha.competitors.map((c) => c.source), ['founder', 'founder']);
  assert.deepEqual(beta.competitors.map((c) => c.url), ['https://rival.example.com'], 'https only, one per host');
  assert.ok(probed.includes('https://alpha.example.com'), 'our own live URL is probed too');
});

test('ranks count only competitors that could be probed, and gaps name what the best one has', async () => {
  const probes = {
    'https://alpha.example.com': okProbe('https://alpha.example.com', { hasDocs: true, mentionsSdk: true }),
    'https://strong.example.com': okProbe('https://strong.example.com', { hasDocs: true, hasOpenApi: true, hasLlmsTxt: true, mentionsMcp: true, hasStatusPage: true, mentionsSdk: true, hsts: true }),
    'https://weak.example.com': okProbe('https://weak.example.com'),
  };
  const out = await cp.refreshBenchmark({
    now: NOW,
    notes: [{ fm: { type: 'competitor-list', venture: 'Alpha API' }, body: '## Track\n- https://strong.example.com\n- https://weak.example.com\n- https://down.example.com\n' }],
    discover: async () => ({}),
    probe: async (url) => probes[url] || { url, ok: false, reason: 'HTTP 403' },
  });
  const alpha = out.ventures.find((v) => v.id === a.id);
  assert.equal(alpha.rank.quality.of, 3, 'the site that could not be probed is not counted');
  assert.equal(alpha.rank.quality.rank, 2);
  assert.equal(alpha.rank.innovation.rank, 2);
  assert.ok(cp.gapsAgainstBest(alpha, 'innovation').some((l) => /llms\.txt/.test(l)));
  assert.ok(cp.gapsAgainstBest(alpha, 'quality').some((l) => /OpenAPI/.test(l)));

  const text = cp.renderBenchmark(out);
  assert.match(text, /Public signals only/);
  assert.match(text, /Alpha API \(you\)\s+quality \d+\/10\s+innovation \d+\/10/);
  assert.match(text, /down\.example\.com\s+could not be probed: HTTP 403/);
  assert.match(text, /Rank on quality: 2 of 3\. The best competitor has, and you were not seen to have: /);
  assert.match(text, /How the scores are made/);
  assert.match(text, /Publishes llms\.txt, so AI agents can read the site \(2\)/);

  const facts = cp.benchmarkFacts(out).join('\n');
  assert.match(facts, /Alpha API: tech quality on the public-signal rubric: \d+\/10, rank 2 of 3/);
  assert.match(facts, /listed by the founder/);
});

test('a venture with no live URL is asked for one and not scored; KPI rows follow the ranks', async () => {
  const out = cp.getBenchmark();
  const beta = out.ventures.find((v) => v.id === b.id);
  assert.equal(beta.own, null);
  assert.match(cp.renderBenchmark(out), /Beta App: no live URL is set, so it cannot be compared\. Send URL .* https:\/\/your-domain/);
  assert.match(cp.benchmarkFacts(out).join('\n'), /Beta App: no live URL is recorded/);

  const kpis = cp.benchmarkKpis(out);
  const q = kpis.find((k) => /quality against competitors \(Alpha API\)/.test(k.name));
  assert.match(q.display, /rank 2 of 3/);
  assert.ok(['watch', 'behind'].includes(q.status));
  assert.equal(kpis.find((k) => /\(Beta App\)/.test(k.name)).status, 'unmeasured');
  assert.match(cp.renderBenchmark(null), /No benchmark yet/);
});

test('the benchmark refreshes weekly, and a failed discovery leaves the venture with no competitors, not a crash', async () => {
  assert.equal(cp.benchmarkIsStale(new Date('2026-10-12T00:00:00Z')), false);
  assert.equal(cp.benchmarkIsStale(new Date('2026-10-20T00:00:00Z')), true);
  const out = await cp.refreshBenchmark({ now: NOW, notes: [], discover: async () => { throw new Error('search is down'); }, probe: async (url) => okProbe(url) });
  assert.ok(out.ventures.every((v) => v.competitors.length === 0));
});
