// What the founder reads and answers in the vault: Today.md, the decision inbox,
// dashboards, the rules register, the manifest guard and the weekly check.
// Everything runs against test/helpers/fakeVault.js.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeVault, configureVault, KEYS } from './helpers/fakeVault.js';

let tmpDir;
let originalFetch;
const saved = {};
let fp;
let guard;
let lint;
let ventures;
let vaultIndex;
let notebook;
let lessons;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-founderpages-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
  fp = await import('../workspace/founderPages.js');
  guard = await import('../workspace/marketplaceGuard.js');
  lint = await import('../workspace/vaultLint.js');
  ventures = await import('../finance/ventures.js');
  vaultIndex = await import('../workspace/vaultIndex.js');
  notebook = await import('../workspace/notebook.js');
  lessons = await import('../workspace/lessons.js');
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

const NOW = new Date('2026-10-10T03:00:00Z');
const note = (path, fm, body = 'x') => ({ path, sha: 's', text: `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`, fm, body });

test('Today is one short page: money, what needs the founder, what is overdue, rules due', () => {
  ventures.createVenture({ title: 'Today Co', oneLiner: 'x', proposedBy: 'venture_partner' });
  const page = fp.buildToday({
    now: NOW,
    decisions: [{ decision: 'pending', title: 'Raise API price', expires: '2026-10-14' }],
    notes: [
      note('Company/Pipeline/Acme.md', { type: 'prospect', next_action_due: '2026-10-01', status: 'lead' }),
      note('Company/Support/Ticket 1.md', { type: 'support', status: 'open', priority: 'critical', opened: '2026-10-08T09:00:00Z' }),
      note('Company/Support/Ticket 2.md', { type: 'support', status: 'open', priority: 'critical', opened: '2026-10-10T01:00:00Z' }),
      note('Company/Rules/WHOOP API terms.md', { type: 'rule', status: 'needs-legal-read', review_by: '2026-10-20' }),
    ],
  });
  assert.ok(page.length <= 1500);
  assert.match(page, /^# Today — 2026-10-10/);
  assert.match(page, /## Money[\s\S]*Today Co: paying \$0\/mo/);
  assert.match(page, /Decide: Raise API price \(by 2026-10-14\)/);
  assert.match(page, /\[\[Acme\]\] \(was due 2026-10-01\)/);
  assert.match(page, /\[\[Ticket 1\]\] \(\d+h OVERDUE\)/);
  assert.match(page, /\[\[Ticket 2\]\] \(\d+h left\)/);
  assert.match(page, /\[\[WHOOP API terms\]\] \(needs-legal-read/);
  assert.match(page, /Notebook: /);
});

test('an unanswered decision expires as a no, an answer is remembered, and both reach the context', async () => {
  configureVault();
  const vault = fakeVault({
    'Inbox/Decisions/2026-10-01 Old ask.md': '---\ntype: decision-request\ndecision: pending\nexpires: 2026-10-05\ncreated: 2026-10-01\n---\nq',
    'Inbox/Decisions/2026-10-02 Answered.md': '---\ntype: decision-request\ndecision: approved\nexpires: 2026-10-09\ncreated: 2026-10-02\n---\nq',
    'Inbox/Decisions/2026-10-08 Open ask.md': '---\ntype: decision-request\ndecision: pending\nexpires: 2026-10-20\ncreated: 2026-10-08\n---\nq',
  });
  const notes = await vaultIndex.loadNotes({});
  await fp.syncDecisions(notes, { now: NOW });
  assert.match(vault.files['Inbox/Decisions/2026-10-01 Old ask.md'], /decision: expired/);
  assert.match(vault.files['Inbox/Decisions/2026-10-02 Answered.md'], /decision: approved/, 'an answer is never touched');
  const ctx = fp.buildDecisionsContext();
  assert.match(ctx, /EXPIRED: Old ask/);
  assert.match(ctx, /APPROVED: Answered/);
  assert.match(ctx, /Still waiting on the founder[\s\S]*PENDING: Open ask/);
});

test('the daily refresh writes Today, Index, the log, dashboards and the rules, and never overwrites the founder', async () => {
  configureVault();
  const vault = fakeVault({
    'Dashboards/Lessons.base': '# the founder changed this view\n',
    'Company/Rules/WHOOP API terms.md': '---\ntype: rule\nstatus: reviewed\n---\nthe founder read it and wrote this\n',
  });
  ventures.createVenture({ title: 'Circadian', oneLiner: 'x', proposedBy: 'venture_partner' });
  const out = await fp.refreshFounderPages({ now: NOW });
  assert.deepEqual(out.done, ['Today', 'Index', 'Vault Log', 'Dashboards']);
  assert.match(vault.files['Today.md'], /# Today — 2026-10-10/);
  assert.match(vault.files['Index.md'], /# Index/);
  assert.match(vault.files['Company/Vault Log.md'], /# Vault log/);

  assert.equal(vault.files['Dashboards/Lessons.base'], '# the founder changed this view\n', 'an existing dashboard is left alone');
  assert.match(vault.files['Dashboards/Decisions.base'], /file\.inFolder\("Inbox\/Decisions"\)/);
  assert.match(vault.files['Dashboards/Pipeline.base'], /type: table/);

  assert.equal(vault.files['Company/Rules/WHOOP API terms.md'], '---\ntype: rule\nstatus: reviewed\n---\nthe founder read it and wrote this\n', 'an existing rule is left alone');
  const gdpr = vault.files['Company/Rules/Health data under GDPR.md'];
  assert.match(gdpr, /status: needs-legal-read/);
  assert.match(gdpr, /## Verbatim clause/);
  assert.match(gdpr, /source_quality: search summary, not the source/);

  const putsBefore = vault.puts.length;
  await fp.refreshFounderPages({ now: NOW });
  const created = vault.puts.slice(putsBefore).map((p) => p.path);
  assert.ok(!created.some((p) => p.startsWith('Dashboards/') || p.startsWith('Company/Rules/')), 'seeded pages are created once');
});

test('without the vault configured the refresh does nothing', async () => {
  assert.deepEqual(await fp.refreshFounderPages({ now: NOW }), { skipped: 'vault not configured' });
});

test('a manifest change that adds a remote, web trigger or egress goes to the decision inbox', async () => {
  assert.deepEqual(guard.manifestRisks({ newText: 'modules:\n  jira:issuePanel: []\n', baseText: '' }), []);
  assert.deepEqual(guard.manifestRisks({ newText: 'remotes:\n  - key: x\n', baseText: 'modules: {}\n' }), ['a remote']);
  assert.deepEqual(guard.manifestRisks({ newText: 'remotes:\n  - key: x\n', baseText: 'remotes:\n  - key: x\n' }), [], 'already there is not new');
  assert.deepEqual(
    guard.manifestRisks({ newText: 'permissions:\n  external:\n    fetch: {}\n  webtrigger:\n', baseText: '' }).sort(),
    ['a web trigger', 'an external (egress) permission'],
  );

  configureVault();
  const vault = fakeVault({ 'ventures/happycompany/manifest.yml': 'modules: {}\n' });
  const v = ventures.createVenture({ title: 'Guard Co', oneLiner: 'x', proposedBy: 'venture_partner' });
  ventures.linkRepo(v.id, { owner: 'acme', name: 'forge', allowedPaths: ['ventures/happycompany/'] });
  const venture = ventures.getVenture(v.id);

  const none = await guard.guardManifestChange({ venture, changes: [{ path: 'ventures/happycompany/src/a.js', content: 'x' }], pr: { number: 9, title: 't', url: 'https://github.com/acme/forge/pull/9' }, agentId: 'cto' });
  assert.equal(none, null);

  const reply = await guard.guardManifestChange({
    venture,
    changes: [{ path: 'ventures/happycompany/manifest.yml', content: 'modules: {}\nremotes:\n  - key: api\n' }],
    pr: { number: 9, title: 'Add a backend', url: 'https://github.com/acme/forge/pull/9' },
    agentId: 'cto',
  });
  assert.match(reply, /^Sent to the founder's inbox as "Inbox\/Decisions\//);
  const p = Object.keys(vault.files).find((k) => k.startsWith('Inbox/Decisions/'));
  assert.match(vault.files[p], /decision: pending/);
  assert.match(vault.files[p], /Runs on Atlassian/);
});

test('the weekly check finds broken links, orphans, stale and overdue items, and edits nothing', async () => {
  const found = lint.lintNotes(
    [
      note('Company/Pipeline/Acme.md', { type: 'prospect', next_action_due: '2026-10-01', status: 'lead' }, 'See [[Missing Page]] and [[Company Note]].'),
      note('Company/Entities/Lonely.md', { type: 'entity' }),
      note('Company/Entities/NoType.md', {}),
      note('Company/Lessons/2026-07-01 Old.md', { type: 'lesson', status: 'candidate', created: '2026-07-01', expires: '2026-09-01' }),
      note('Company/Lessons/2026-09-01 Split.md', { type: 'lesson', status: 'disputed', created: '2026-09-01', expires: '2026-12-01' }),
      note('Company/Rules/Late.md', { type: 'rule', review_by: '2026-10-01' }),
      note('Inbox/Decisions/2026-10-08 Soon.md', { type: 'decision-request', decision: 'pending', expires: '2026-10-12' }),
      note('Company/Company Note.md', {}),
    ],
    { now: NOW },
  );
  assert.deepEqual(found.broken, ['Acme → [[Missing Page]]']);
  assert.ok(found.orphans.includes('Lonely'), 'an unlinked page in an agent zone is an orphan');
  assert.deepEqual(found.noFrontmatter, ['Company/Entities/NoType.md']);
  assert.match(found.expired[0], /2026-07-01 Old \(expired 2026-09-01\)/);
  assert.deepEqual(found.disputed, ['2026-09-01 Split']);
  assert.match(found.staleCandidates[0], /unconfirmed since 2026-07-01/);
  assert.match(found.rulesLate[0], /Late/);
  assert.match(found.decisionsLate[0], /Soon/);
  assert.deepEqual(found.prospectsLate, ['Acme']);

  configureVault();
  const vault = fakeVault({ 'Company/Entities/Solo.md': '---\ntype: entity\n---\nx' });
  const before = { ...vault.files };
  const out = await lint.runVaultLint({ now: NOW, runAgentImpl: async () => { throw new Error('should not run: fewer than three trusted lessons'); } });
  assert.ok(out);
  const report = vault.files['Company/Lint/2026-10-10.md'];
  assert.match(report, /# Vault check — 2026-10-10/);
  assert.match(report, /Not run \(fewer than three trusted lessons\)/);
  for (const [p, c] of Object.entries(before)) assert.equal(vault.files[p], c, `${p} was not edited by the check`);
});

test('with three trusted lessons the check asks the model once about contradictions', async () => {
  configureVault();
  const vault = fakeVault();
  for (const [i, t] of ['A one', 'B two', 'C three'].entries()) {
    await notebook.runNotebookTool('write_lesson', { title: t, lesson: `Claim ${i}.`, evidence: `PR #${10 + i}` }, { agentId: 'cmo' });
  }
  const paths = Object.keys(vault.files).filter((p) => p.startsWith('Company/Lessons/'));
  for (const p of paths) vault.files[p] = vault.files[p].replace('status: candidate', 'status: trusted');
  vaultIndex.invalidateIndex();
  let asked = 0;
  await lint.runVaultLint({ now: NOW, runAgentImpl: async (a) => { asked += 1; assert.match(a.messages[0].content, /\[\[.*A one\]\]/); return { text: '- [[A one]] vs [[B two]]: they disagree.' }; } });
  assert.equal(asked, 1);
  assert.match(vault.files['Company/Lint/2026-10-10.md'], /\[\[A one\]\] vs \[\[B two\]\]/);
  assert.equal(lessons.lessonMetrics().trusted, 3);
});
