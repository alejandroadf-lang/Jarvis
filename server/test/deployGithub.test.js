import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { commitFile, isGithubConfigured } from '../deploy/github.js';

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

test('isGithubConfigured reflects whether GITHUB_TOKEN is set', () => {
  process.env.GITHUB_TOKEN = 'test-token';
  assert.equal(isGithubConfigured(), true);
  delete process.env.GITHUB_TOKEN;
  assert.equal(isGithubConfigured(), false);
});

test('commitFile creates a new file (no existing sha) with a base64-encoded body', async () => {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options?.method === undefined) {
      // GET for existing file sha — simulate "doesn't exist yet"
      return { ok: false, status: 404, text: async () => 'Not Found' };
    }
    return {
      ok: true,
      json: async () => ({ commit: { sha: 'newsha', html_url: 'https://github.com/acme/landing/commit/newsha' } }),
    };
  };

  const result = await commitFile({
    owner: 'acme',
    repo: 'landing',
    branch: 'main',
    path: 'content/home.md',
    content: '# Hello',
    message: 'add home page',
  });

  assert.equal(result.commitSha, 'newsha');
  assert.equal(result.commitUrl, 'https://github.com/acme/landing/commit/newsha');

  const putCall = calls.find((c) => c.options?.method === 'PUT');
  assert.ok(putCall);
  const body = JSON.parse(putCall.options.body);
  assert.equal(body.content, Buffer.from('# Hello', 'utf8').toString('base64'));
  assert.equal(body.branch, 'main');
  assert.equal(body.sha, undefined);
  assert.match(putCall.url, /\/repos\/acme\/landing\/contents\/content\/home\.md/);
});

test('commitFile includes the existing sha when updating a file that already exists', async () => {
  global.fetch = async (url, options) => {
    if (options?.method === undefined) {
      return { ok: true, json: async () => ({ sha: 'oldsha' }) };
    }
    return { ok: true, json: async () => ({ commit: { sha: 'updatedsha', html_url: 'https://x/commit/updatedsha' } }) };
  };

  const result = await commitFile({
    owner: 'acme',
    repo: 'landing',
    branch: 'main',
    path: 'content/home.md',
    content: '# Updated',
    message: 'update home page',
  });

  assert.equal(result.commitSha, 'updatedsha');
});

test('commitFile throws with status and body on a failed request', async () => {
  global.fetch = async (url, options) => {
    if (options?.method === undefined) {
      return { ok: false, status: 404, text: async () => 'Not Found' };
    }
    return { ok: false, status: 403, text: async () => 'Forbidden' };
  };

  await assert.rejects(
    () =>
      commitFile({
        owner: 'acme',
        repo: 'landing',
        branch: 'main',
        path: 'content/home.md',
        content: 'x',
        message: 'x',
      }),
    /403/
  );
});

test('githubRequest sends the Authorization header derived from GITHUB_TOKEN', async () => {
  let seenAuth;
  global.fetch = async (url, options) => {
    seenAuth = options.headers.Authorization;
    if (options?.method === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, json: async () => ({ commit: { sha: 's', html_url: 'u' } }) };
  };

  await commitFile({ owner: 'acme', repo: 'landing', branch: 'main', path: 'a.txt', content: 'x', message: 'x' });
  assert.equal(seenAuth, 'Bearer test-token');
});
