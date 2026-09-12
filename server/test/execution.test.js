// The company could write code and ship it, and never find out whether it
// worked. "The tests pass" was a claim nobody could check — including the
// agent making it. These cover the gate in front of execution and the shape
// of what comes back, because a result an agent can't act on is no better
// than no result.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;
let handlers;
let originalFetch;
const KEYS = ['GITHUB_TOKEN', 'REAL_ACTIONS_DISABLED', 'EXECUTION_POLL_MS'];
const saved = {};

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-exec-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  for (const k of KEYS) saved[k] = process.env[k];
  // Nothing here is really waiting on GitHub.
  process.env.EXECUTION_POLL_MS = '1';
  originalFetch = global.fetch;
  ventures = await import('../finance/ventures.js');
  handlers = await import('../actionHandlers.js');
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
  fs.writeFileSync(path.join(tmpDir, 'ventures.json'), JSON.stringify({ ventures: [] }));
  fs.writeFileSync(path.join(tmpDir, 'killSwitch.json'), JSON.stringify({ halted: false }));
  delete process.env.REAL_ACTIONS_DISABLED;
  process.env.GITHUB_TOKEN = 'gh-token';
  global.fetch = originalFetch;
});

function makeVenture({ withRepo = true } = {}) {
  const v = ventures.createVenture({
    title: 'Doc Intelligence',
    thesis: 'Per-tenant RAG with cited answers.',
    milestones: ['v1 shipped'],
  });
  if (withRepo) {
    ventures.linkRepo(v.id, { owner: 'acme', name: 'doc-intel', branch: 'main', allowedPaths: ['src/'] });
  }
  return v;
}

// Stands in for the GitHub REST API across the dispatch/find/poll/jobs
// sequence a single run_checks call makes.
function stubGitHub({ conclusion = 'success', jobs = [], runAppears = true } = {}) {
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method || 'GET' });

    if (u.includes('/dispatches')) return { ok: true, status: 204, text: async () => '' };
    if (u.includes('/runs?branch=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workflow_runs: runAppears
            ? [{ id: 9001, created_at: new Date().toISOString(), html_url: 'https://github.com/acme/doc-intel/actions/runs/9001' }]
            : [],
        }),
      };
    }
    if (u.includes('/actions/runs/9001/jobs')) return { ok: true, status: 200, json: async () => ({ jobs }) };
    if (u.includes('/actions/runs/9001')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 9001, status: 'completed', conclusion, html_url: 'https://github.com/acme/doc-intel/actions/runs/9001' }),
      };
    }
    throw new Error(`unexpected request: ${u}`);
  };
  return calls;
}

test('a venture with no repo is told the founder must link one', async () => {
  const v = makeVenture({ withRepo: false });

  const reply = await handlers.handleRunChecks({ ventureId: v.id });

  assert.match(reply, /No repo linked/);
});

test('the kill switch stops execution like every other real action', async () => {
  const v = makeVenture();
  process.env.REAL_ACTIONS_DISABLED = 'true';

  const reply = await handlers.handleRunChecks({ ventureId: v.id });

  assert.match(reply, /Could not run checks/);
});

test('a green run reports success with the run URL as evidence', async () => {
  const v = makeVenture();
  stubGitHub({ conclusion: 'success' });

  const reply = await handlers.handleRunChecks({ ventureId: v.id, workflow: 'ci.yml' });

  assert.match(reply, /passed/);
  assert.match(reply, /actions\/runs\/9001/, 'the founder must be able to open the run themselves');
});

test('a red run names the failing job and step, not just "failure"', async () => {
  const v = makeVenture();
  stubGitHub({
    conclusion: 'failure',
    jobs: [
      { name: 'lint', conclusion: 'success', steps: [] },
      {
        name: 'test',
        conclusion: 'failure',
        steps: [
          { name: 'Install', conclusion: 'success' },
          { name: 'npm test', conclusion: 'failure' },
        ],
        html_url: 'https://github.com/acme/doc-intel/runs/1',
      },
    ],
  });

  const reply = await handlers.handleRunChecks({ ventureId: v.id });

  // A bare conclusion gives an agent nothing to act on.
  assert.match(reply, /failed/);
  assert.match(reply, /test/);
  assert.match(reply, /npm test/);
  assert.doesNotMatch(reply, /\blint\b.*failure/, 'a passing job must not be reported as failing');
  assert.match(reply, /do not report this as passing/i);
});

test('a dispatch with no run appearing explains the missing trigger', async () => {
  const v = makeVenture();
  stubGitHub({ runAppears: false });

  // This is the first thing anyone hits when wiring a repo up, and the error
  // GitHub gives for it is useless on its own.
  const reply = await handlers.handleRunChecks({ ventureId: v.id });

  assert.match(reply, /workflow_dispatch/);
});

test('every run is recorded — a red one especially', async () => {
  const v = makeVenture();
  stubGitHub({ conclusion: 'failure', jobs: [{ name: 'test', conclusion: 'failure', steps: [] }] });

  await handlers.handleRunChecks({ ventureId: v.id }, 'interactive', { agentId: 'engineering_lead' });

  const [run] = ventures.listRuns(v.id);
  assert.equal(run.conclusion, 'failure');
  assert.equal(run.agentId, 'engineering_lead');
  assert.equal(run.runId, '9001');
});

test('the cooldown stops an agent re-running a suite in a loop', async () => {
  const v = makeVenture();
  stubGitHub({ conclusion: 'success' });

  await handlers.handleRunChecks({ ventureId: v.id });
  const second = await handlers.handleRunChecks({ ventureId: v.id });

  assert.match(second, /Too soon after the last check run/);
});

test('running checks does not consume the deploy budget', async () => {
  // A team that must spend its one daily commit to learn whether the last one
  // worked will stop checking. These are separate limits on purpose.
  const v = makeVenture();
  stubGitHub({ conclusion: 'success' });

  await handlers.handleRunChecks({ ventureId: v.id });

  ventures.setDeploymentEnabled(v.id, true);
  const venture = ventures.authorizeDeployment(v.id, { path: 'src/index.ts' });
  assert.ok(venture, 'a deploy is still authorised after a check run');
});

test('without a token there is no execution environment, and it says so', async () => {
  const v = makeVenture();
  delete process.env.GITHUB_TOKEN;

  const reply = await handlers.handleRunChecks({ ventureId: v.id });

  assert.match(reply, /no execution environment/);
});

test('list_checks names the workflows instead of making agents guess', async () => {
  const v = makeVenture();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      workflows: [
        { name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
        { name: 'Old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
      ],
    }),
  });

  const reply = await handlers.handleListChecks({ ventureId: v.id });

  assert.match(reply, /ci\.yml/);
  assert.doesNotMatch(reply, /old\.yml/, 'a disabled workflow cannot be run and must not be offered');
});

test('an empty repo is told to commit a workflow first', async () => {
  const v = makeVenture();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ workflows: [] }) });

  const reply = await handlers.handleListChecks({ ventureId: v.id });

  assert.match(reply, /\.github\/workflows\/ci\.yml/);
});
