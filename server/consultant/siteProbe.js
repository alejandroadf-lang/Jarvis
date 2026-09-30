// What a product looks like from the outside, measured the same way for everyone.
//
// "Is our technology as good as our competitors'?" cannot be answered from the
// inside: their code is not ours to read. What can be measured, identically for
// us and for each of them, is what is publicly observable: does the site answer
// quickly and over a hardened connection, is there documentation, a machine-
// readable API description, a status page, a changelog that shows the product is
// alive, an SDK, a mention of the compliance a buyer asks about; and, for a
// product that will be used by other people's AI agents, whether it is legible to
// them: an llms.txt, an MCP server, an OpenAPI file.
//
// So this fetches a handful of well-known paths on each site (public https only,
// with the same address and redirect checks as everything else that fetches a
// URL from outside) and scores what it finds against two rubrics, each out of
// ten and printed in full. The rubrics are ours and deliberately simple: they are
// a way to compare like with like, not a verdict on anyone's engineering, and
// the email says so. A signal absent from a page is "not found here", never
// "does not exist": a competitor may document elsewhere.

import { safeFetchPage } from '../workspace/ruleWatch.js';

const DAY = 86_400_000;
const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

const PATHS = {
  llms: ['/llms.txt'],
  openapi: ['/openapi.json', '/openapi.yaml', '/swagger.json'],
  docs: ['/docs', '/developers', '/documentation'],
  changelog: ['/changelog', '/releases', '/whats-new', '/updates'],
  status: ['/status'],
  trust: ['/security', '/trust'],
  mcp: ['/.well-known/mcp.json', '/.well-known/mcp'],
};

const SECURITY_HEADERS = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options'];
const COMPLIANCE = /\b(SOC ?2|ISO ?27001|ISO ?31030|GDPR|HIPAA|PCI[- ]DSS)\b/i;

/** Dates found in a page, as timestamps. Pure. */
export function datesIn(text) {
  const found = [];
  for (const m of String(text).matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) found.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  for (const m of String(text).matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}),? (20\d{2})\b/gi)) {
    found.push(Date.UTC(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]));
  }
  return found.filter((t) => Number.isFinite(t));
}

const headerOf = (headers, name) => (headers?.get ? headers.get(name) : null);

async function tryPaths(origin, paths, fetchPage, valid) {
  for (const p of paths) {
    try {
      const page = await fetchPage(origin + p, { tolerant: true });
      if (page.status === 200 && valid(page)) return { path: p, page };
    } catch {
      // A path that will not load is a path that is not there.
    }
  }
  return null;
}

/**
 * Probes one site. Resolves to a plain object of observations, or { url, ok:false, reason }.
 * `fetchPage` is injectable for tests.
 */
export async function probeSite(url, { fetchPage = safeFetchPage, now = new Date() } = {}) {
  let home;
  try {
    home = await fetchPage(url, { tolerant: true });
  } catch (err) {
    return { url, ok: false, reason: err.message };
  }
  if (home.status < 200 || home.status >= 300) return { url, ok: false, reason: `HTTP ${home.status}` };

  const origin = new URL(home.url).origin;
  const homeText = home.text;
  const looksLikeHome = (t) => t.slice(0, 500) === homeText.slice(0, 500);

  const llms = await tryPaths(origin, PATHS.llms, fetchPage, (p) => p.text.length > 50 && !/<html/i.test(p.text));
  const openapi = await tryPaths(origin, PATHS.openapi, fetchPage, (p) => /"?openapi"?\s*:|swagger/i.test(p.text.slice(0, 2000)));
  const docs = await tryPaths(origin, PATHS.docs, fetchPage, (p) => p.text.length > 1500 && !looksLikeHome(p.text));
  const changelog = await tryPaths(origin, PATHS.changelog, fetchPage, (p) => datesIn(p.text).length > 0 && !looksLikeHome(p.text));
  const status = await tryPaths(origin, PATHS.status, fetchPage, (p) => /operational|uptime|incident|all systems/i.test(p.text) && !looksLikeHome(p.text));
  const trust = await tryPaths(origin, PATHS.trust, fetchPage, (p) => p.text.length > 800 && !looksLikeHome(p.text));
  const mcpWellKnown = await tryPaths(origin, PATHS.mcp, fetchPage, (p) => p.text.length > 5 && !/<html/i.test(p.text));

  const dates = changelog ? datesIn(changelog.page.text).filter((t) => t <= now.getTime() + DAY) : [];
  const corpus = [homeText, docs?.page.text || '', trust?.page.text || ''].join('\n');
  const headers = SECURITY_HEADERS.filter((h) => headerOf(home.headers, h));

  return {
    url,
    ok: true,
    ms: home.ms,
    https: new URL(home.url).protocol === 'https:',
    hsts: Boolean(headerOf(home.headers, 'strict-transport-security')),
    securityHeaders: headers,
    hasLlmsTxt: Boolean(llms),
    hasOpenApi: Boolean(openapi),
    hasDocs: Boolean(docs),
    hasChangelog: Boolean(changelog),
    latestRelease: dates.length ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : null,
    releases90: dates.filter((t) => now.getTime() - t <= 90 * DAY).length,
    hasStatusPage: Boolean(status),
    compliance: [...new Set([...corpus.matchAll(new RegExp(COMPLIANCE.source, 'gi'))].map((m) => m[0].toUpperCase().replace(/\s+/g, ' ')))],
    mentionsMcp: Boolean(mcpWellKnown) || /\bMCP\b|model context protocol/i.test(corpus),
    mentionsSdk: /\bSDK\b|npm install|pip install|go get /i.test(corpus),
    mentionsAi: /\b(AI|LLM|agents?|copilot|machine learning)\b/.test(homeText),
    mentionsWebhooks: /webhook|integrations?\b/i.test(corpus),
  };
}

// The two rubrics, each out of ten. `pts` is what a signal is worth; the whole
// table is printed in the email so nobody has to trust a number they cannot read.
export const QUALITY_RUBRIC = [
  ['reachable', 'Answers over https', 1, (p) => p.ok && p.https],
  ['fast', 'Home page answers in under 1.5 seconds from our server', 1, (p) => p.ok && p.ms < 1500],
  ['hsts', 'Forces https (HSTS)', 1, (p) => p.hsts],
  ['headers', 'Three or more of five security headers', 1, (p) => p.securityHeaders?.length >= 3],
  ['docs', 'Public documentation', 1, (p) => p.hasDocs],
  ['openapi', 'A machine-readable API description (OpenAPI)', 1, (p) => p.hasOpenApi],
  ['status', 'A public status page', 1, (p) => p.hasStatusPage],
  ['compliance', 'Names a compliance framework (SOC 2, ISO 27001, GDPR…)', 1, (p) => p.compliance?.length > 0],
  ['changelog', 'A dated changelog', 1, (p) => p.hasChangelog],
  ['sdk', 'Shows an SDK or install command', 1, (p) => p.mentionsSdk],
];

export const INNOVATION_RUBRIC = [
  ['llms', 'Publishes llms.txt, so AI agents can read the site', 2, (p) => p.hasLlmsTxt],
  ['mcp', 'Offers or documents an MCP server for AI agents', 2, (p) => p.mentionsMcp],
  ['openapi', 'Machine-readable API an agent can call', 1, (p) => p.hasOpenApi],
  ['cadence', 'Ships often: four or more dated changelog entries in 90 days', 2, (p) => p.releases90 >= 4],
  ['recent', 'Ships at all: at least one dated entry in 90 days', 1, (p) => p.releases90 >= 1 && p.releases90 < 4],
  ['ai', 'Says what its AI does on the home page', 1, (p) => p.mentionsAi],
  ['sdk', 'Ships an SDK', 1, (p) => p.mentionsSdk],
  ['integrations', 'Documents webhooks or integrations', 1, (p) => p.mentionsWebhooks],
];

function score(rubric, probe) {
  const items = rubric.map(([key, label, pts, test]) => ({ key, label, pts, got: probe.ok && Boolean(test(probe)) }));
  return { score: items.filter((i) => i.got).reduce((n, i) => n + i.pts, 0), of: 10, items };
}

/** Both scores for one probe. An unreachable site scores nothing and says why. Pure. */
export function scoreProbe(probe) {
  return { quality: score(QUALITY_RUBRIC, probe), innovation: score(INNOVATION_RUBRIC, probe) };
}

export function describeProbe(name, probe) {
  if (!probe.ok) return `${name} (${probe.url}) could not be probed: ${probe.reason}.`;
  return `${name} (${probe.url}): answered in ${probe.ms} ms; ${probe.securityHeaders.length} of 5 security headers${probe.hsts ? ', HSTS' : ''}; docs ${probe.hasDocs ? 'found' : 'not found'}; OpenAPI ${probe.hasOpenApi ? 'found' : 'not found'}; llms.txt ${probe.hasLlmsTxt ? 'found' : 'not found'}; MCP ${probe.mentionsMcp ? 'mentioned' : 'not found'}; changelog ${probe.hasChangelog ? `found, latest ${probe.latestRelease || 'undated'}, ${probe.releases90} entries in 90 days` : 'not found'}; status page ${probe.hasStatusPage ? 'found' : 'not found'}; compliance named: ${probe.compliance.join(', ') || 'none found'}.`;
}
