// What is already in the repo, as a fact in the room.
//
// A week of this company's life went into writing an auth layer that was
// already committed. It surfaced afterwards as a "bonus find" in a status
// report: "full API-key auth + FastAPI layer already exists — nobody had
// flagged it."
//
// Nobody could have. `list_repo_files` had existed for a while, but a tool
// only helps an agent that already suspects it needs one, and an agent about
// to write a file from scratch has no reason to suspect anything. That is the
// same shape as every other instance of this company's recurring failure: the
// capability was present and the door was one nobody thought to open.
//
// So the manifest stops being an answer to a question and becomes context.
// These tests pin that, and pin the distinction the whole thing turns on: an
// unreachable repo must never read as an empty one, because "empty" means
// "go ahead and build it".

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


let tmpDir;
let context;
let ventures;
let originalFetch;
let savedToken;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-manifest-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  originalFetch = global.fetch;
  context = await import('../finance/context.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
  global.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
  global.fetch = originalFetch;
});

// Mocked at the fetch boundary rather than at the module: ES module exports
// cannot be redefined, and this way the real tree parsing runs too.
function respondTree(tree, { truncated = false } = {}) {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tree, truncated }) });
}

function respondStatus(status) {
  global.fetch = async () => ({ ok: false, status, text: async () => 'nope' });
}

function blob(path) {
  return { type: 'blob', path, size: 10 };
}

function ventureWithRepo() {
  const venture = ventures.createVenture({ title: 'CircadianAPI', milestones: ['ship'] });
  ventures.linkRepo(venture.id, { owner: 'acme', name: 'circadian', allowedPaths: ['src/'] });
  return venture;
}

function listing(paths) {
  respondTree(paths.map(blob));
}

// --- Who sees it -------------------------------------------------------------------

test('only the agents who build are given the manifest', () => {
  const get = (id) => context.buildPerAgentContext(id, { repoManifests: 'THE-MANIFEST' });
  for (const id of ['engineering_lead', 'cto', 'solutions_architect']) {
    assert.match(get(id), /THE-MANIFEST/, `${id} should see what is already built`);
  }
  // Every other agent pays tokens for it and does nothing with it.
  for (const id of ['cfo', 'cmo', 'sales_commercial_manager', 'ceo']) {
    assert.doesNotMatch(get(id), /THE-MANIFEST/, `${id} does not need the file list`);
  }
});

test('with no manifest passed, context is exactly what it was before', () => {
  assert.doesNotMatch(context.buildPerAgentContext('engineering_lead'), /WHAT IS ALREADY IN THE REPOS/);
});

// --- What it says ------------------------------------------------------------------

test('no linked repo means no section rather than an empty heading', async () => {
  ventures.createVenture({ title: 'Unlinked', milestones: ['ship'] });
  assert.equal(await context.buildRepoManifests(), '');
});

test('the files are listed, with the instruction that makes them useful', async () => {
  ventureWithRepo();
  listing(['README.md', 'src/auth.py', 'src/main.py']);

  const manifest = await context.buildRepoManifests();
  assert.match(manifest, /src\/auth\.py/);
  assert.match(manifest, /acme\/circadian/);
  assert.match(manifest, /read_repo_file/, 'and says what to do when the thing is already there');
  assert.match(manifest, /3 files/);
});

// The actual regression, named. With this on screen, "let us build auth.py" is
// not a sentence anyone can write.
test('the file that cost a week appears by name', async () => {
  ventureWithRepo();
  listing(['src/auth.py', 'src/main.py']);
  const manifest = await context.buildRepoManifests();
  const forEngineering = context.buildPerAgentContext('engineering_lead', { repoManifests: manifest });
  assert.match(forEngineering, /src\/auth\.py/);
});

test('a truncated listing says so, so absence is not read as proof', async () => {
  ventureWithRepo();
  respondTree([blob('src/a.py')], { truncated: true });
  assert.match(await context.buildRepoManifests(), /truncated; there are more/);
});

// --- The distinction the whole thing turns on ---------------------------------------

test('a genuinely empty repo says so plainly', async () => {
  ventureWithRepo();
  respondStatus(409); // GitHub's answer for a repo with no commits
  const manifest = await context.buildRepoManifests();
  assert.match(manifest, /exists and is empty/);
  assert.match(manifest, /Nothing has been built yet/);
});

// "I could not look" and "there is nothing there" are the same sentence to a
// reader, and one of them authorises building it again.
test('an unreachable repo is never reported as an empty one', async () => {
  ventureWithRepo();
  respondStatus(502);

  const manifest = await context.buildRepoManifests();
  assert.match(manifest, /could not be listed/);
  assert.match(manifest, /502/);
  assert.match(manifest, /not as empty/, 'the difference is stated, not implied');
  assert.doesNotMatch(manifest, /Nothing has been built yet/);
});

test('a wrong branch is reported as a wrong branch, not as nothing built', async () => {
  ventureWithRepo();
  respondStatus(404);
  const manifest = await context.buildRepoManifests();
  assert.match(manifest, /does not exist/);
  assert.match(manifest, /list of nothing, not an empty repo/);
});

test('one repo failing does not lose the others', async () => {
  const first = ventureWithRepo();
  const second = ventures.createVenture({ title: 'Duty-of-Care', milestones: ['ship'] });
  ventures.linkRepo(second.id, { owner: 'acme', name: 'duty', allowedPaths: ['src/'] });

  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 502, text: async () => 'boom' };
    return { ok: true, status: 200, json: async () => ({ tree: [blob('src/ok.py')] }) };
  };

  const manifest = await context.buildRepoManifests();
  assert.match(manifest, /could not be listed/);
  assert.match(manifest, /src\/ok\.py/);
  assert.ok(first.id && second.id);
});

test('a killed venture is not listed', async () => {
  const venture = ventureWithRepo();
  listing(['src/a.py']);
  ventures.killVenture(venture.id, 'not working');
  assert.equal(await context.buildRepoManifests(), '');
});
