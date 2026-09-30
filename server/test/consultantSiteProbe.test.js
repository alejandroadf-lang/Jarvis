// The probe measures the same public signals for everyone, and only claims what it
// found. Pinned: a soft-404 that returns the home page is not a docs page, dates
// in a changelog are read in both common formats, the two rubrics add up from
// their printed items, and an unreachable site scores nothing and says why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeSite, scoreProbe, datesIn, QUALITY_RUBRIC, INNOVATION_RUBRIC, describeProbe } from '../consultant/siteProbe.js';

const NOW = new Date('2026-10-10T03:00:00Z');
const HOME = '<html><body><h1>Acme API</h1><p>Our AI agents handle travel. npm install acme-sdk. SOC 2 and GDPR compliant. See our integrations and webhooks.</p></body></html>';

const headers = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
const page = (status, text = '', h = {}, ms = 120, url) => ({ status, text, headers: headers(h), ms, url });

function site(routes, homeHeaders = {}) {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') return page(200, HOME, homeHeaders, 120, url);
    const r = routes[u.pathname];
    return r ? page(200, r, {}, 100, url) : page(404, '', {}, 50, url);
  };
}

test('dates are read in both common changelog formats', () => {
  const t = datesIn('v2.1 — 2026-09-30\nv2.0 — September 12, 2026\nv1.9 - Aug 3 2026 and Jan. 5, 2026');
  assert.equal(t.length, 4);
  assert.ok(t.includes(Date.UTC(2026, 8, 30)) && t.includes(Date.UTC(2026, 8, 12)) && t.includes(Date.UTC(2026, 7, 3)) && t.includes(Date.UTC(2026, 0, 5)));
});

test('a well-equipped site earns points only for what was found on it', async () => {
  const routes = {
    '/llms.txt': '# Acme\n> Docs for agents\nhttps://acme.example.com/docs '.repeat(3),
    '/openapi.json': '{"openapi": "3.1.0", "info": {}}',
    '/docs': 'Documentation. '.repeat(200),
    '/changelog': 'Changelog\n2026-10-01 added x\n2026-09-20 added y\n2026-09-05 added z\n2026-08-25 fixed w\n2026-01-01 old',
    '/status': 'All systems operational. Uptime 99.99%. '.repeat(3),
    '/security': 'We are SOC 2 Type II and ISO 27001 certified. '.repeat(30),
  };
  const probe = await probeSite('https://acme.example.com/', { fetchPage: site(routes, { 'strict-transport-security': 'max-age=1', 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }), now: NOW });
  assert.equal(probe.ok, true);
  assert.equal(probe.hasLlmsTxt, true);
  assert.equal(probe.hasOpenApi, true);
  assert.equal(probe.hasDocs, true);
  assert.equal(probe.hasStatusPage, true);
  assert.equal(probe.releases90, 4, 'four entries in the last 90 days, not the January one');
  assert.equal(probe.latestRelease, '2026-10-01');
  assert.deepEqual(probe.compliance.sort(), ['GDPR', 'ISO 27001', 'SOC 2']);
  assert.equal(probe.securityHeaders.length, 4);

  const s = scoreProbe(probe);
  assert.equal(s.quality.of, 10);
  assert.equal(s.quality.score, 10, 'every quality signal present');
  assert.equal(s.innovation.score, 8, 'llms 2 + openapi 1 + cadence 2 + ai 1 + sdk 1 + integrations 1; no MCP');
  assert.equal(s.quality.items.reduce((n, i) => n + (i.got ? i.pts : 0), 0), s.quality.score);
  assert.equal(QUALITY_RUBRIC.reduce((n, r) => n + r[2], 0), 10);
  assert.equal(INNOVATION_RUBRIC.filter((r) => r[0] !== 'recent').reduce((n, r) => n + r[2], 0), 10, 'the innovation rubric tops out at ten');
});

test('a site that returns its home page for every path is not credited with docs, changelog or status', async () => {
  const soft = async (url) => page(200, HOME, {}, 80, url);
  const probe = await probeSite('https://soft.example.com/', { fetchPage: soft, now: NOW });
  assert.equal(probe.hasDocs, false);
  assert.equal(probe.hasChangelog, false);
  assert.equal(probe.hasStatusPage, false);
  assert.equal(probe.hasOpenApi, false);
  assert.equal(probe.hasLlmsTxt, false, 'html is not an llms.txt');
});

test('an unreachable site scores nothing and says why, and MCP is credited from a mention', async () => {
  const dead = await probeSite('https://dead.example.com/', { fetchPage: async () => { throw new Error('the host does not resolve to a public address'); }, now: NOW });
  assert.deepEqual([dead.ok, dead.reason], [false, 'the host does not resolve to a public address']);
  assert.equal(scoreProbe(dead).quality.score, 0);
  assert.match(describeProbe('Dead', dead), /could not be probed: the host does not resolve/);

  const error = await probeSite('https://err.example.com/', { fetchPage: async (u) => page(503, '', {}, 10, u), now: NOW });
  assert.equal(error.reason, 'HTTP 503');

  const withMcp = await probeSite('https://mcp.example.com/', { fetchPage: site({ '/docs': ('Connect through our MCP server. ' + 'Guide. '.repeat(400)) }), now: NOW });
  assert.equal(withMcp.mentionsMcp, true);
  assert.ok(scoreProbe(withMcp).innovation.items.find((i) => i.key === 'mcp').got);
  assert.match(describeProbe('Acme', withMcp), /MCP mentioned/);
});
