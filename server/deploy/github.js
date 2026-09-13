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

/**
 * Every file path in the repo, in one call.
 *
 * readFile answers "what is in this file". Nothing answered "what files are
 * there", which sounds like a convenience and is not: a wrong guess at a path
 * came back as `null` — rendered to the agent as "that file does not exist" —
 * and an agent reading that concludes the file has not been written yet when
 * the truth is that it is ten characters away under a different name. That is
 * the same shape as the three confident wrong diagnoses this company has
 * already produced: an absent observation promoted to a cause.
 *
 * The git trees API rather than walking Contents per directory, because one
 * request is the whole point — a recursive walk over a repo would be a dozen
 * calls and a budget an agent's turn does not have.
 *
 * Two states that look like failures and are not, so they come back as data:
 * a repo with no commits yet (409), and a ref that does not exist (404). The
 * distinction between those two matters more than either on its own — "the
 * repo is empty" and "that branch is not called main" lead to opposite next
 * actions, and collapsing them is exactly the mistake this function exists to
 * stop.
 */
export async function listFiles({ owner, repo, branch, limit = 300 }) {
  const ref = encodeURIComponent(branch || 'main');
  try {
    const data = await githubRequest(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
    const blobs = (data?.tree || [])
      .filter((entry) => entry?.type === 'blob' && entry.path)
      .map((entry) => ({ path: String(entry.path), bytes: Number(entry.size) || 0 }))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      files: blobs.slice(0, limit),
      total: blobs.length,
      // GitHub truncates its own response on a large tree; either that or our
      // own cap means the caller is not seeing everything, and saying so is
      // the difference between a partial list and a wrong one.
      truncated: Boolean(data?.truncated) || blobs.length > limit,
      state: 'ok',
    };
  } catch (err) {
    if (err.status === 409) return { files: [], total: 0, truncated: false, state: 'empty' };
    if (err.status === 404) return { files: [], total: 0, truncated: false, state: 'no-such-ref' };
    throw err;
  }
}
