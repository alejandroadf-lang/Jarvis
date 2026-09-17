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

// --- Hands that can do more than one thing ------------------------------------
//
// commitFile above writes exactly one file per commit, which quietly shaped
// how this company could work. A change that spans seven files became seven
// commits, and a turn that died at the fourth left the repo in a state that
// compiled in nobody's imagination: half a refactor, pushed, on the branch a
// deploy watches. There was also no way to remove a file, no way to work on a
// branch, no way to propose a change rather than land it, and no way to undo.
//
// The Contents API cannot express any of that. The git data API can: build a
// tree, hang a commit off it, move the ref. Same token, same guardrails, same
// authorizeDeployment gate at the call site — a wider hand, not a wider grant.

// GitHub's file mode for a regular file. Trees also carry 100755 (executable),
// 040000 (directory), 160000 (submodule) and 120000 (symlink); this module
// writes ordinary files only, and a change that needs a submodule is not one
// an agent should be making unattended.
const BLOB_MODE = '100644';

async function headOf({ owner, repo, branch }) {
  const ref = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commitSha = ref?.object?.sha;
  if (!commitSha) throw new Error(`Branch "${branch}" has no commit to build on.`);
  const commit = await githubRequest(`/repos/${owner}/${repo}/git/commits/${commitSha}`);
  return { commitSha, treeSha: commit?.tree?.sha };
}

/**
 * One commit, any number of files, created or deleted together.
 *
 * `changes` is a list of `{ path, content }` to write and `{ path, deleted: true }`
 * to remove. The whole set lands as a single commit or none of it does, which
 * is the entire point: a reviewer reading the history sees one change with one
 * message, and a failure halfway through leaves the branch exactly as it was
 * rather than half-refactored.
 *
 * @returns {Promise<{commitSha: string, commitUrl: string, files: number}>}
 */
export async function commitFiles({ owner, repo, branch, changes, message }) {
  const entries = Array.isArray(changes) ? changes.filter((c) => c && c.path) : [];
  if (!entries.length) throw new Error('A commit needs at least one file change.');

  const duplicate = entries.map((c) => c.path).find((p, i, all) => all.indexOf(p) !== i);
  if (duplicate) {
    // Two entries for one path is a contradiction the tree API resolves
    // silently by last-write-wins, which is how a "delete this and rewrite it"
    // turns into whichever one the agent happened to list second.
    throw new Error(`"${duplicate}" appears twice in the same commit — decide what that file should be.`);
  }

  const { commitSha, treeSha } = await headOf({ owner, repo, branch });

  const tree = entries.map((change) =>
    change.deleted
      // A null sha against an existing path is how the git data API spells
      // "remove this". There is no other way to delete through the API, and
      // nothing in this app could do it at all before now.
      ? { path: change.path, mode: BLOB_MODE, type: 'blob', sha: null }
      : {
          path: change.path,
          mode: BLOB_MODE,
          type: 'blob',
          content: String(change.content ?? ''),
        },
  );

  const newTree = await githubRequest(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: treeSha, tree }),
  });

  const commit = await githubRequest(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: newTree.sha, parents: [commitSha] }),
  });

  // Fast-forward only. Without `force: false` a stale read followed by a slow
  // turn would silently discard whatever landed in between — and "the commit
  // I made an hour ago is gone" is the one failure mode that would make the
  // founder stop trusting this entirely.
  await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    files: entries.length,
  };
}

/**
 * Starts a branch from another branch's current head.
 *
 * The reason this matters is not git hygiene. Every real change this company
 * has ever made went straight onto the branch a deploy watches, because that
 * was the only branch the code could name. A branch is what makes "show me
 * first" possible at all.
 */
export async function createBranch({ owner, repo, branch, fromBranch = 'main' }) {
  const { commitSha } = await headOf({ owner, repo, branch: fromBranch });
  try {
    await githubRequest(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha }),
    });
    return { branch, fromBranch, commitSha, created: true };
  } catch (err) {
    // A branch that already exists is the normal state on the second turn of
    // the same piece of work, not a failure. Treating it as one would make
    // resuming impossible.
    if (err.status === 422) return { branch, fromBranch, commitSha, created: false };
    throw err;
  }
}

/**
 * Opens a pull request.
 *
 * This is the capability that changes what autonomy means here. Until now
 * every option was binary: the agent commits to the deploy branch, or it
 * writes a paragraph describing what it would have committed. A PR is the
 * third thing — real, complete, reviewable work that has not landed yet.
 */
export async function openPullRequest({ owner, repo, head, base = 'main', title, body }) {
  const pr = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, head, base, body: body || '' }),
  });
  return { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state };
}

/**
 * Works out what undoing one commit would mean, without doing it.
 *
 * Split from the commit itself on purpose. The paths a revert touches are not
 * the agent's to choose — they are whatever that commit changed — so the
 * caller has to learn them from GitHub before it can check them against the
 * founder's allowlist. Computing first and committing second means the
 * allowlist is checked against the truth rather than against a claim.
 *
 * Scoped to those paths rather than resetting the branch to the parent. A hard
 * reset would also discard everything that landed afterwards, which is a much
 * larger act than "undo that" and not what anyone asking for an undo means.
 * The tradeoff is real: if a later commit also edited one of these files, the
 * revert overwrites that later edit. So the paths come back with the plan, and
 * the caller says so.
 */
export async function planRevert({ owner, repo, sha }) {
  const commit = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
  const parent = commit?.parents?.[0]?.sha;
  if (!parent) throw new Error(`Commit ${sha} has no parent — there is no earlier state to go back to.`);

  const touched = (commit.files || []).map((f) => f.filename).filter(Boolean);
  if (!touched.length) throw new Error(`Commit ${sha} changed no files, so there is nothing to put back.`);

  const changes = [];
  for (const path of touched) {
    const before = await readFile({ owner, repo, branch: parent, path });
    // Absent in the parent means that commit created it, so undoing it means
    // removing it — which is why delete support had to exist first.
    changes.push(before === null ? { path, deleted: true } : { path, content: before });
  }

  return {
    changes,
    paths: touched,
    parent,
    subject: (commit.commit?.message || sha).split('\n')[0],
  };
}
