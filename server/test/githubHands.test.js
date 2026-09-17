// The Contents API gives you one file per commit. Everything here is what
// that could not express: a change across several files landing together, a
// file being removed, a branch, a pull request, and an undo.
//
// The GitHub calls are stubbed. What is actually being tested is the shape of
// the requests — a null sha is how you delete, force:false is what stops a
// stale turn discarding someone else's commit — plus the gates on top, which
// is where the interesting design decisions live: a multi-file commit is
// checked once per path, and two of these tools deliberately do not require an
// approved daily plan.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitFiles, createBranch, openPullRequest, planRevert } from '../deploy/github.js';
import {
  createVenture,
  linkRepo,
  setDeploymentEnabled,
  authorizeDeploymentOfPaths,
  authorizePullRequest,
  authorizeRevert,
  recordPullRequest,
  listPullRequests,
} from '../finance/ventures.js';

let originalFetch;
let originalToken;
let tmpDir;

before(() => {
  originalFetch = global.fetch;
  originalToken = process.env.GITHUB_TOKEN;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hands-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
});

after(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.GITHUB_TOKEN = 'test-token';
  fs.rmSync(path.join(tmpDir, 'ventures.json'), { force: true });
});

// A stub that answers the git-data endpoints in the order commitFiles walks
// them, and records every request so the assertions can read the shapes.
function stubGit({ files = {}, commitFiles: commitFileList } = {}) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    const u = String(url);
    const json = (value) => ({ ok: true, json: async () => value });

    if (u.includes('/git/ref/heads/')) return json({ object: { sha: 'headsha' } });
    if (u.match(/\/git\/commits\/[a-z0-9]+$/)) return json({ tree: { sha: 'treesha' } });
    if (u.endsWith('/git/trees')) return json({ sha: 'newtreesha' });
    if (u.endsWith('/git/commits')) return json({ sha: 'commitsha', html_url: 'https://github.com/acme/app/commit/commitsha' });
    if (u.includes('/git/refs/heads/')) return json({ object: { sha: 'commitsha' } });
    if (u.endsWith('/git/refs')) return json({ ref: 'refs/heads/new' });
    if (u.endsWith('/pulls')) return json({ number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'A change', state: 'open' });
    if (u.match(/\/commits\/[a-z0-9]+$/)) {
      return json({ parents: [{ sha: 'parentsha' }], commit: { message: 'Bad change\n\nbody' }, files: commitFileList || [] });
    }
    if (u.includes('/contents/')) {
      const file = decodeURIComponent(u.split('/contents/')[1].split('?')[0]);
      if (!(file in files)) return { ok: false, status: 404, text: async () => 'Not Found' };
      return json({ content: Buffer.from(files[file], 'utf8').toString('base64') });
    }
    return { ok: false, status: 500, text: async () => `unstubbed ${u}` };
  };
  return calls;
}

function ventureWithRepo(allowedPaths = ['src/']) {
  const venture = createVenture({ title: 'App', oneLiner: 'x', proposedBy: 'venture_partner' });
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths, maxPerWeek: 20 });
  setDeploymentEnabled(venture.id, true);
  return venture;
}

// --- One commit, several files ------------------------------------------------

test('several files land as one commit, not one commit each', async () => {
  const calls = stubGit();
  const result = await commitFiles({
    owner: 'acme',
    repo: 'app',
    branch: 'main',
    message: 'Add the module and wire it up',
    changes: [
      { path: 'src/auth.py', content: 'def login(): ...' },
      { path: 'src/main.py', content: 'from auth import login' },
    ],
  });

  assert.equal(result.files, 2);
  assert.equal(result.commitSha, 'commitsha');
  const commits = calls.filter((c) => c.url.endsWith('/git/commits') && c.method === 'POST');
  assert.equal(commits.length, 1, 'two files should produce one commit');
  assert.equal(commits[0].body.parents[0], 'headsha');
});

test('a deletion is a null sha, which is the only way the API spells it', async () => {
  const calls = stubGit();
  await commitFiles({
    owner: 'acme',
    repo: 'app',
    branch: 'main',
    message: 'Drop the dead module',
    changes: [{ path: 'src/legacy.py', deleted: true }, { path: 'src/main.py', content: 'new' }],
  });

  const tree = calls.find((c) => c.url.endsWith('/git/trees')).body.tree;
  const removed = tree.find((e) => e.path === 'src/legacy.py');
  assert.equal(removed.sha, null);
  assert.equal('content' in removed, false, 'a delete entry must not also carry content');
  assert.equal(tree.find((e) => e.path === 'src/main.py').content, 'new');
});

test('the ref moves fast-forward only', async () => {
  // Without this a stale read followed by a slow turn silently discards
  // whatever landed in between, and "the commit I made an hour ago is gone"
  // is the one failure that would end the founder's trust in this entirely.
  const calls = stubGit();
  await commitFiles({ owner: 'acme', repo: 'app', branch: 'main', message: 'x', changes: [{ path: 'a', content: 'b' }] });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.force, false);
});

test('the same path twice in one commit is refused rather than resolved silently', async () => {
  stubGit();
  await assert.rejects(
    () =>
      commitFiles({
        owner: 'acme',
        repo: 'app',
        branch: 'main',
        message: 'x',
        changes: [{ path: 'src/a.py', content: '1' }, { path: 'src/a.py', deleted: true }],
      }),
    /appears twice/,
  );
});

test('an empty change set is refused', async () => {
  stubGit();
  await assert.rejects(() => commitFiles({ owner: 'acme', repo: 'app', branch: 'main', message: 'x', changes: [] }), /at least one/);
});

// --- Branches and pull requests -----------------------------------------------

test('a branch starts from the named branch head', async () => {
  const calls = stubGit();
  const result = await createBranch({ owner: 'acme', repo: 'app', branch: 'agents/fix', fromBranch: 'main' });
  assert.equal(result.created, true);
  const post = calls.find((c) => c.url.endsWith('/git/refs') && c.method === 'POST');
  assert.equal(post.body.ref, 'refs/heads/agents/fix');
  assert.equal(post.body.sha, 'headsha');
});

test('a branch that already exists is a resumable state, not a failure', async () => {
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/git/ref/heads/')) return { ok: true, json: async () => ({ object: { sha: 'headsha' } }) };
    if (u.match(/\/git\/commits\/[a-z0-9]+$/)) return { ok: true, json: async () => ({ tree: { sha: 't' } }) };
    if (u.endsWith('/git/refs') && options.method === 'POST') {
      return { ok: false, status: 422, text: async () => 'Reference already exists' };
    }
    return { ok: false, status: 500, text: async () => 'x' };
  };
  const result = await createBranch({ owner: 'acme', repo: 'app', branch: 'agents/fix' });
  assert.equal(result.created, false, 'the second turn of the same work must be able to continue');
});

test('a pull request targets the venture deploy branch', async () => {
  const calls = stubGit();
  const pr = await openPullRequest({ owner: 'acme', repo: 'app', head: 'agents/fix', base: 'main', title: 'A change', body: 'why' });
  assert.equal(pr.number, 7);
  const body = calls.find((c) => c.url.endsWith('/pulls')).body;
  assert.equal(body.head, 'agents/fix');
  assert.equal(body.base, 'main');
});

// --- Undo ---------------------------------------------------------------------

test('a revert restores what a commit changed and removes what it created', async () => {
  stubGit({
    commitFiles: [{ filename: 'src/config.py' }, { filename: 'src/new.py' }],
    // Only config.py existed in the parent; new.py was created by that commit.
    files: { 'src/config.py': 'TIMEOUT = 30' },
  });

  const plan = await planRevert({ owner: 'acme', repo: 'app', sha: 'badsha' });
  assert.deepEqual(plan.paths, ['src/config.py', 'src/new.py']);
  assert.deepEqual(plan.changes[0], { path: 'src/config.py', content: 'TIMEOUT = 30' });
  assert.deepEqual(plan.changes[1], { path: 'src/new.py', deleted: true });
  assert.equal(plan.subject, 'Bad change');
});

test('a commit with no parent cannot be reverted, and says why', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ parents: [], files: [{ filename: 'a' }] }) });
  await assert.rejects(() => planRevert({ owner: 'acme', repo: 'app', sha: 'firstsha' }), /no parent/);
});

// --- The gates ----------------------------------------------------------------

test('a multi-file commit is checked once per path, not once per commit', () => {
  // Otherwise six files ride in on the seventh's approval.
  const venture = ventureWithRepo(['src/']);
  assert.doesNotThrow(() => authorizeDeploymentOfPaths(venture.id, ['src/a.py', 'src/b.py']));
  assert.throws(
    () => authorizeDeploymentOfPaths(venture.id, ['src/a.py', 'infra/deploy.sh']),
    /outside the allowed scope/,
  );
});

test('a pull request still needs the repo linked and enabled', () => {
  const venture = createVenture({ title: 'App', oneLiner: 'x', proposedBy: 'venture_partner' });
  assert.throws(() => authorizePullRequest(venture.id, { paths: ['src/a.py'] }), /No repo linked/);
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  assert.throws(() => authorizePullRequest(venture.id, { paths: ['src/a.py'] }), /not enabled/);
  setDeploymentEnabled(venture.id, true);
  assert.doesNotThrow(() => authorizePullRequest(venture.id, { paths: ['src/a.py'] }));
});

test('a pull request obeys the path allowlist like everything else', () => {
  const venture = ventureWithRepo(['src/']);
  assert.throws(() => authorizePullRequest(venture.id, { paths: ['secrets/prod.env'] }), /outside the allowed scope/);
});

test('a revert refuses paths the founder never granted', () => {
  // A commit that reached outside the allowed scope was not made by this app,
  // so it is not this app's to undo.
  const venture = ventureWithRepo(['src/']);
  assert.throws(() => authorizeRevert(venture.id, { paths: ['infra/prod.tf'] }), /this app did not make that change/);
  assert.doesNotThrow(() => authorizeRevert(venture.id, { paths: ['src/config.py'] }));
});

test('pull requests are logged so the founder can see what is waiting', () => {
  const venture = ventureWithRepo();
  recordPullRequest(venture.id, {
    number: 7,
    url: 'https://github.com/acme/app/pull/7',
    title: 'A change',
    branch: 'agents/a-change',
    paths: ['src/a.py'],
    triggeredBy: 'daily_cycle',
    agentId: 'engineering_lead',
  });
  const [entry] = listPullRequests(venture.id);
  assert.equal(entry.number, 7);
  assert.equal(entry.triggeredBy, 'daily_cycle');
  assert.equal(entry.agentId, 'engineering_lead');
});
