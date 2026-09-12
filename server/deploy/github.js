import { readSecret, hasSecret } from '../env.js';
// Thin wrapper around GitHub's Contents API for committing a single real
// file change to a real repo — the actual mechanism behind "real code
// deployment" (see finance/ventures.js's authorizeDeployment/recordDeployment
// for the guardrails around when this is allowed to run at all).
//
// Deliberately minimal: one file, one commit, straight to a branch. No repo
// creation, no arbitrary shell/build execution, no multi-file changesets —
// the scope this app grants an agent is "edit specific files in a specific,
// already-existing repo," not "run arbitrary code on real infrastructure."
// If the target repo has CI/CD already wired to that branch (Vercel/Railway
// auto-deploy on push, say), then this commit *is* the deploy; if not, it's
// still a real, permanent, publicly-visible change to a real repo — that's
// what makes this a genuine escalation from every other action in this app.
//
// Guarded entirely by GITHUB_TOKEN: without it configured, isGithubConfigured()
// returns false and callers should refuse rather than attempt a request, so
// there's never a half-configured state that looks like it might work.

const GITHUB_API = 'https://api.github.com';

export function isGithubConfigured() {
  return hasSecret('GITHUB_TOKEN');
}

async function githubRequest(path, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${readSecret('GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    // Carry the code so callers can tell "this file doesn't exist yet", which
    // is a normal state, from "the token is wrong", which is not. Without it
    // every failure looks identical and a misconfigured repo reads as an
    // empty one.
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Returns the current file's blob sha (needed to update rather than create),
// or null when the file doesn't exist yet at that path/branch.
async function getExistingFileSha({ owner, repo, branch, path }) {
  try {
    const file = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${branch}`);
    return file.sha || null;
  } catch {
    return null;
  }
}

/**
 * Creates or updates a single file with one real commit.
 * @returns {Promise<{commitSha: string, commitUrl: string}>}
 */
/**
 * Reads a file's text, or null when it isn't there.
 *
 * The counterpart to commitFile: the workspace integration (see
 * ../workspace/vault.js) is an integration rather than an export precisely
 * because what the founder writes in Obsidian or VS Code can come back the
 * other way. A missing file is expected — the founder hasn't written that
 * note yet — so it returns null, while a real failure still throws.
 */
export async function readFile({ owner, repo, branch, path }) {
  try {
    const file = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${branch}`);
    if (!file?.content) return null;
    return Buffer.from(file.content, 'base64').toString('utf8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function commitFile({ owner, repo, branch, path, content, message }) {
  const sha = await getExistingFileSha({ owner, repo, branch, path });
  const result = await githubRequest(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  return {
    commitSha: result.commit?.sha || '',
    commitUrl: result.commit?.html_url || '',
  };
}
