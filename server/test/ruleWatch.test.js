// The rules watcher fetches URLs that come from pages agents can edit, so the
// fetch itself is the thing to pin: public https only, every address and every
// redirect checked. Then the behaviour: the first look is a baseline, a change
// is flagged once, what the web said lands in quarantine screened line by line,
// and the founder's own edit to the rule page wins over the flag.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeVault, configureVault, KEYS } from './helpers/fakeVault.js';

let tmpDir;
let originalFetch;
const saved = {};
let rw;
let vaultIndex;
let fp;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-rulewatch-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  rw = await import('../workspace/ruleWatch.js');
  vaultIndex = await import('../workspace/vaultIndex.js');
  fp = await import('../workspace/founderPages.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  vaultIndex.invalidateIndex();
  global.fetch = originalFetch;
});

const res = (status, body = '', type = 'text/html', headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => ({ 'content-type': type, ...headers })[k.toLowerCase()] ?? null },
  text: async () => body,
});
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('only public addresses count as public', () => {
  for (const ok of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(rw.isPublicAddress(ok), true, ok);
  for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(rw.isPublicAddress(bad), false, bad);
  }
});

test('the fetch refuses anything but a public https page, and re-checks every redirect', async () => {
  const never = async () => { throw new Error('must not be fetched'); };
  const refuse = (url, why, opts = {}) => assert.rejects(rw.safeFetchText(url, { fetchImpl: never, lookup: publicDns, ...opts }), why);
  await refuse('http://developer.whoop.com/terms', /only https/);
  await refuse('https://169.254.169.254/latest/meta-data', /IP address/);
  await refuse('https://[::1]/x', /IP address/);
  await refuse('https://localhost/x', /not a public host/);
  await refuse('https://intranet/x', /not a public host/);
  await refuse('https://db.internal/x', /not a public host/);
  await refuse('https://example.com:8080/x', /standard port/);
  await refuse('https://user:pw@example.com/x', /credentials/);
  await refuse('https://example.com/x', /public address/, { lookup: async () => [{ address: '10.0.0.5', family: 4 }] });
  await refuse('https://example.com/x', /public address/, { lookup: async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }] });

  // A public page that redirects somewhere private is refused at the second hop.
  const lookup = async (h) => [{ address: h === 'evil.example.com' ? '10.0.0.5' : '93.184.216.34' }];
  const fetchImpl = async (u) => (u.startsWith('https://ok.example.com') ? res(302, '', 'text/html', { location: 'https://evil.example.com/steal' }) : res(200, 'secret'));
  await assert.rejects(rw.safeFetchText('https://ok.example.com/a', { fetchImpl, lookup }), /public address/);

  // A chain of public redirects works, up to a limit.
  let hops = 0;
  const chain = async () => { hops += 1; return hops < 3 ? res(301, '', 'text/html', { location: `/next${hops}` }) : res(200, '<p>terms page</p>'); };
  assert.equal(await rw.safeFetchText('https://example.com/a', { fetchImpl: chain, lookup: publicDns }), '<p>terms page</p>');
  await assert.rejects(rw.safeFetchText('https://example.com/a', { fetchImpl: async () => res(301, '', 'text/html', { location: '/again' }), lookup: publicDns }), /too many redirects/);
  await assert.rejects(rw.safeFetchText('https://example.com/a', { fetchImpl: async () => res(200, 'x', 'application/pdf'), lookup: publicDns }), /not a text page/);
  await assert.rejects(rw.safeFetchText('https://example.com/a', { fetchImpl: async () => res(404), lookup: publicDns }), /HTTP 404/);
});

test('readable lines drop markup and scripts, and a diff reports what was added and removed', () => {
  const lines = rw.extractLines('<html><head><style>p{}</style></head><body><script>alert(1)</script><h1>API Terms</h1><p>You may not sell &amp; resell access.</p><ul><li>Rule one</li><li>Rule two</li></ul><!-- hidden --></body></html>');
  assert.deepEqual(lines, ['API Terms', 'You may not sell & resell access.', 'Rule one', 'Rule two']);
  const d = rw.diffLines(lines, ['API Terms', 'You may not sell & resell access.', 'Rule one', 'Rule THREE']);
  assert.deepEqual(d, { added: ['Rule THREE'], removed: ['Rule two'] });
  assert.deepEqual(rw.diffLines(lines, lines.map((l) => l.toUpperCase())), { added: [], removed: [] }, 'case alone is not a change');
});

function ruleNote(vault, url = 'https://developer.whoop.com/api-terms-of-use/') {
  vault.files['Company/Rules/WHOOP API terms.md'] = `---\ntype: rule\nstatus: needs-legal-read\n---\n# WHOOP API terms\n\n## Sources\n\n- ${url}\n- http://insecure.example.com/ignored\n`;
}

test('the first look is a baseline; a change is flagged once, quarantined, screened, and the founder is told', async () => {
  configureVault();
  const vault = fakeVault();
  ruleNote(vault);
  let page = '<p>You may not train models on WHOOP data.</p><p>Access can be suspended.</p>';
  const fetchImpl = async () => res(200, page);
  const messages = [];
  const run = async () => {
    vaultIndex.invalidateIndex();
    const notes = await vaultIndex.loadNotes({});
    return rw.watchRules({ notes, now: new Date('2026-10-10T03:00:00Z'), fetchImpl, lookup: publicDns, notify: async (m) => { messages.push(m); } });
  };

  const first = await run();
  assert.equal(first.checked, 1, 'the http source is never fetched');
  assert.equal(first.changed.length, 0);
  assert.equal(vault.puts.length, 0, 'a baseline writes nothing');
  assert.equal(messages.length, 0);

  assert.equal((await run()).changed.length, 0, 'no change, no alert');

  page = '<p>You may not train models on WHOOP data.</p><p>Access may be suspended without notice.</p><p>Contact legal@whoop.example for exceptions.</p>';
  const third = await run();
  assert.equal(third.changed.length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /WHOOP API terms/);

  const change = Object.keys(vault.files).find((p) => p.startsWith('Inbox/untrusted/') && /Rule changed/.test(p));
  assert.ok(change, 'the change note is in quarantine');
  assert.match(vault.files[change], /status: quarantined/);
  assert.match(vault.files[change], /trust: 0/);
  assert.match(vault.files[change], /Access may be suspended without notice\./);
  assert.doesNotMatch(vault.files[change], /legal@whoop\.example/, 'a line the write gate refuses is not copied');
  assert.match(vault.files['Company/Rules/WHOOP API terms.md'], /status: source-changed/);
  assert.match(vault.files['Company/Rules/WHOOP API terms.md'], /source_changed: 2026-10-10/);

  assert.equal((await run()).changed.length, 0, 'the new text is the new baseline: no repeat alert');
  assert.equal(messages.length, 1);

  // Today puts it in front of the founder.
  vaultIndex.invalidateIndex();
  const notes = await vaultIndex.loadNotes({});
  assert.match(fp.buildToday({ notes, decisions: [], now: new Date('2026-10-10T03:00:00Z') }), /\[\[WHOOP API terms\]\] \(source-changed/);
});

test('a founder edit made a moment ago wins over the flag, and repeated failures are reported once', async () => {
  configureVault();
  const vault = fakeVault();
  ruleNote(vault, 'https://example.org/edit-race');
  let page = '<p>Original wording of the clause.</p>';
  const notify = async () => {};
  const runOnce = async (fetchImpl, mutate) => {
    vaultIndex.invalidateIndex();
    const notes = await vaultIndex.loadNotes({});
    if (mutate) mutate();
    return rw.watchRules({ notes, now: new Date('2026-10-11T03:00:00Z'), fetchImpl, lookup: publicDns, notify });
  };
  await runOnce(async () => res(200, page));
  page = '<p>Changed wording of the clause.</p>';
  const edited = '---\ntype: rule\nstatus: reviewed\n---\n# WHOOP API terms\n\n## Sources\n\n- https://example.org/edit-race\n\nfounder wrote this\n';
  const out = await runOnce(async () => res(200, page), () => { vault.files['Company/Rules/WHOOP API terms.md'] = edited; });
  assert.equal(out.changed.length, 1);
  assert.equal(vault.files['Company/Rules/WHOOP API terms.md'], edited, "the founder's edit is not overwritten by the flag");

  ruleNote(vault, 'https://example.org/down');
  const down = async () => res(500);
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await runOnce(down));
  assert.equal(results.filter((r) => r.failed.length).length, 1, 'reported once, on the third failure');
  assert.match(results[2].failed[0].reason, /HTTP 500/);
});
