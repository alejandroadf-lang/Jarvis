// Being able to see what is in the repo.
//
// The team could read a file by path and commit a file by path, and had no way
// to find out what paths existed. That reads as a missing convenience and was
// not: a guessed path came back as `null`, rendered to the agent as "that file
// does not exist", and an agent acting on that writes the file fresh on top of
// a working version sitting under a name one character different. It is the
// same shape as every confident wrong diagnosis this company has produced — an
// absent observation promoted to a cause — and `diagnosing-a-blocker` lists
// exactly this case as one of the three.
//
// So what these tests protect is mostly the distinctions the answer has to
// keep. A listing that collapsed "no commits yet" and "no such branch" into
// "empty" would be a more convenient API and would reintroduce the bug at one
// remove, because those two lead to opposite next actions.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { listFiles } from '../deploy/github.js';

let originalFetch;
let originalToken;

before(() => {
  originalFetch = global.fetch;
  originalToken = process.env.GITHUB_TOKEN;
});

after(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

beforeEach(() => {
  process.env.GITHUB_TOKEN = 'test-token';
});

function treeResponse(tree, truncated = false) {
  return async () => ({ ok: true, json: async () => ({ tree, truncated }) });
}

test('listFiles returns blob paths sorted, and ignores directory entries', async () => {
  global.fetch = treeResponse([
    { type: 'blob', path: 'src/engine.py', size: 4120 },
    { type: 'tree', path: 'src' },
    { type: 'blob', path: '.github/workflows/ci.yml', size: 311 },
    { type: 'blob', path: 'README.md', size: 98 },
  ]);

  const result = await listFiles({ owner: 'acme', repo: 'circadian-api', branch: 'main' });

  assert.deepEqual(
    result.files.map((f) => f.path),
    ['.github/workflows/ci.yml', 'README.md', 'src/engine.py']
  );
  assert.equal(result.total, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.state, 'ok');
  // Size comes along because "is that file a stub or real" is the next
  // question after "does it exist", and it is free here.
  assert.equal(result.files.find((f) => f.path === 'src/engine.py').bytes, 4120);
});

test('it asks for the whole tree in one request rather than walking directories', async () => {
  let requested = '';
  global.fetch = async (url) => {
    requested = String(url);
    return { ok: true, json: async () => ({ tree: [] }) };
  };

  await listFiles({ owner: 'acme', repo: 'circadian-api', branch: 'feature/x' });

  assert.match(requested, /\/git\/trees\//, 'the trees API, not Contents per directory');
  assert.match(requested, /recursive=1/);
  // A branch with a slash in it has to survive the URL, or every non-trivial
  // branch name reads back as "no such ref".
  assert.match(requested, /feature%2Fx/);
});

// The two states that look like errors and are answers. Kept apart because
// the next action differs completely: write the first file, versus stop and
// tell the founder the linked branch is wrong.
test('a repo with no commits is "empty", not an error', async () => {
  global.fetch = async () => ({ ok: false, status: 409, text: async () => 'Git Repository is empty.' });

  const result = await listFiles({ owner: 'acme', repo: 'fresh', branch: 'main' });
  assert.equal(result.state, 'empty');
  assert.deepEqual(result.files, []);
});

test('a branch that does not exist is distinguished from an empty repo', async () => {
  global.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });

  const result = await listFiles({ owner: 'acme', repo: 'real', branch: 'master' });
  assert.equal(result.state, 'no-such-ref');
  assert.notEqual(result.state, 'empty', 'collapsing these two reintroduces the bug this tool exists to fix');
});

test('a real failure still throws rather than reading as an empty repo', async () => {
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Bad credentials' });

  await assert.rejects(
    () => listFiles({ owner: 'acme', repo: 'real', branch: 'main' }),
    /401/,
    'a bad token must not look like a repo with nothing in it'
  );
});

test('truncation is reported, whether it is GitHub truncating or our own cap', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ type: 'blob', path: `f${i}.py`, size: 1 }));

  global.fetch = treeResponse(many);
  const capped = await listFiles({ owner: 'a', repo: 'b', branch: 'main', limit: 2 });
  assert.equal(capped.files.length, 2);
  assert.equal(capped.total, 5);
  assert.equal(capped.truncated, true, 'our own cap still means the caller is not seeing everything');

  global.fetch = treeResponse(many, true);
  const theirs = await listFiles({ owner: 'a', repo: 'b', branch: 'main' });
  assert.equal(theirs.truncated, true, "GitHub's own truncation flag has to survive too");
});
