// The workspace integration writes to a real GitHub repo, so every test here
// stubs global.fetch — same pattern as deployGithub.test.js. What's worth
// pinning: the markdown is genuinely Obsidian-shaped (frontmatter, wikilinks,
// task checkboxes), it stays inert until configured, and it can never break
// the cycle that produced the report.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isWorkspaceConfigured,
  workspaceConfig,
  noteName,
  formatDailyReport,
  formatWeeklyReflection,
  formatVenture,
  publishDailyReport,
  readFounderSteering,
  FOUNDER_NOTE_PATH,
} from '../workspace/vault.js';

let tmpDir;
let originalFetch;
let savedError;
const KEYS = ['WORKSPACE_REPO_OWNER', 'WORKSPACE_REPO_NAME', 'WORKSPACE_REPO_BRANCH', 'GITHUB_TOKEN'];
const saved = {};

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vault-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  originalFetch = global.fetch;
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  global.fetch = originalFetch;
  console.error = savedError;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  global.fetch = originalFetch;
  savedError = console.error;
  console.error = () => {};
});

function configure() {
  process.env.WORKSPACE_REPO_OWNER = 'alex';
  process.env.WORKSPACE_REPO_NAME = 'brain';
  process.env.GITHUB_TOKEN = 't';
}

const REPORT = {
  date: '2026-03-05',
  business: { revenue: 1200, expenses: 200, net: 1000 },
  leadership: { reply: 'CTO: shipping steadily.' },
  studio: { reply: 'One idea cleared the bar.' },
  proposedVentureIds: ['v_1'],
  proposedVentureNames: ['Widget Co: Reports'],
  costUsd: 0.0812,
};

test('it stays inert until a workspace repo is named', () => {
  assert.equal(isWorkspaceConfigured(), false);
  assert.equal(workspaceConfig(), null);
  configure();
  assert.equal(isWorkspaceConfigured(), true);
  assert.deepEqual(workspaceConfig(), { owner: 'alex', repo: 'brain', branch: 'main' });
});

test('a daily report is Obsidian-shaped, not just markdown', () => {
  const md = formatDailyReport(REPORT);
  // Frontmatter becomes note properties Obsidian can filter and sort on.
  assert.match(md, /^---\n/);
  assert.match(md, /type: daily-report/);
  assert.match(md, /net: 1000/);
  assert.match(md, /tags: \[company\/daily\]/);
  // A wikilink is what puts this report on the graph next to the venture.
  assert.match(md, /\[\[Widget Co Reports\]\]/);
  assert.match(md, /CTO: shipping steadily\./);
});

test('a venture note leads with why an agent-run company wins, and uses real checkboxes', () => {
  const md = formatVenture({
    id: 'v_1',
    title: 'Widget Co',
    oneLiner: 'Widgets for people who need widgets',
    agentNativeEdge: 'Per-customer bespoke reports at a price no staffed firm can serve.',
    status: 'active',
    createdAt: '2026-03-05T00:00:00.000Z',
    milestones: [
      { title: 'Ship an MVP', status: 'done' },
      { title: 'Get first customer', status: 'pending' },
      { title: 'Hit $1k MRR', status: 'missed' },
    ],
  });
  assert.match(md, /## Why an agent-run company wins here/);
  assert.match(md, /no staffed firm can serve/);
  // Obsidian renders these as interactive tasks.
  assert.match(md, /- \[x\] Ship an MVP/);
  assert.match(md, /- \[ \] Get first customer/);
  assert.match(md, /- \[ \] Hit \$1k MRR — \*\*missed\*\*/);
  assert.match(md, /tags: \[venture\/active\]/);
});

test('a venture predating the agent-native bar says so instead of leaving a blank heading', () => {
  const md = formatVenture({ id: 'v_0', title: 'Old Co', status: 'active', milestones: [] });
  assert.match(md, /predates the agent-native bar/);
});

test('a killed venture records why, so the note explains itself later', () => {
  const md = formatVenture({ id: 'v_2', title: 'Dead Co', status: 'killed', killReason: 'market too small', milestones: [] });
  assert.match(md, /## Killed/);
  assert.match(md, /market too small/);
});

test('a weekly reflection carries the week it covers as a property', () => {
  const md = formatWeeklyReflection({ weekEnding: '2026-01-04', reportsConsidered: 7, reflection: 'Only one opportunity got followed up.' });
  assert.match(md, /week_ending: 2026-01-04/);
  assert.match(md, /Only one opportunity got followed up\./);
});

// Obsidian resolves [[links]] by note name, so a title that can't be a
// filename would silently produce a broken link.
test('note names survive characters a vault or a filesystem would reject', () => {
  assert.equal(noteName('Widget Co: Reports/Q3 *beta*'), 'Widget Co ReportsQ3 beta');
  assert.equal(noteName(''), 'Untitled');
  assert.equal(noteName(undefined), 'Untitled');
  assert.ok(noteName('x'.repeat(200)).length <= 80);
});

test('publishing commits the note to the configured repo and path', async () => {
  configure();
  let put = null;
  global.fetch = async (url, options) => {
    if (!options || options.method !== 'PUT') return { ok: false, status: 404, text: async () => '' };
    put = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ commit: { sha: 's1', html_url: 'u1' } }) };
  };

  assert.equal(await publishDailyReport(REPORT), true);
  assert.match(put.url, /repos\/alex\/brain\/contents\/Company\/Daily%20Reports\/2026-03-05\.md/);
  assert.match(Buffer.from(put.body.content, 'base64').toString('utf8'), /# Daily Report — 2026-03-05/);
});

// The cycle that produced the report has already done its real work. A repo
// that's gone, a bad token, a network blip — none may turn a saved report
// into a failed run.
test('a publish failure is reported, never thrown', async () => {
  configure();
  global.fetch = async () => {
    throw new Error('network is down');
  };
  assert.equal(await publishDailyReport(REPORT), false);
});

test('nothing is published while real actions are halted', async () => {
  configure();
  const killSwitch = await import('../killSwitch.js');
  let reached = false;
  global.fetch = async () => {
    reached = true;
    throw new Error('unreachable');
  };

  killSwitch.haltRealActions('stop everything');
  try {
    assert.equal(await publishDailyReport(REPORT), false);
    assert.equal(reached, false, 'the halt must stop the write before it goes out');
  } finally {
    killSwitch.resumeRealActions();
  }
});

test('the founder steering note comes back as context, with frontmatter stripped', async () => {
  configure();
  const note = '---\ntags: [steering]\n---\nFocus on the newsletter this month. Ignore the marketplace idea.';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ content: Buffer.from(note, 'utf8').toString('base64') }),
  });

  const text = await readFounderSteering();
  assert.match(text, /Focus on the newsletter this month/);
  // Frontmatter is metadata for Obsidian, not instruction for the company.
  assert.doesNotMatch(text, /tags: \[steering\]/);
  assert.match(text, new RegExp(FOUNDER_NOTE_PATH));
});

test('no steering note, no context — an absent file is a normal state', async () => {
  configure();
  global.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  assert.equal(await readFounderSteering(), '');
});

test('an empty steering note produces no context rather than an empty header', async () => {
  configure();
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ content: Buffer.from('---\ntags: [x]\n---\n   \n', 'utf8').toString('base64') }),
  });
  assert.equal(await readFounderSteering(), '');
});

test('unconfigured, nothing is read and nothing is written', async () => {
  global.fetch = async () => {
    throw new Error('should never be called');
  };
  assert.equal(await readFounderSteering(), '');
  assert.equal(await publishDailyReport(REPORT), false);
});
