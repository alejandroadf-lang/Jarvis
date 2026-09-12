// The execution environment. Agents write code, and this is how they find out
// whether it works.
//
// GitHub Actions rather than a sandbox service, for three reasons:
//
//   1. The code is already there. A venture's repo is where deploy_code
//      commits, so the thing under test is the thing that shipped — not a
//      copy an agent pasted into a sandbox, which can differ in exactly the
//      way that hides a bug.
//   2. Isolation is someone else's problem, solved properly. A runner is a
//      fresh VM that cannot reach this server, its data directory, or the
//      founder's credentials. Running `npm test` in this container would put
//      venture code next to the company's own secrets.
//   3. The result is evidence. A check run has a URL, a conclusion and logs
//      that outlive the conversation. "I ran the tests and they passed" from
//      an agent is a claim; a run id is a fact.
//
// What this is not: a general code interpreter. An agent cannot run arbitrary
// commands here — only the workflows committed to the repo, which are
// themselves reviewable code under the venture's allowedPaths. That
// constraint is the point. If a venture later needs true arbitrary execution,
// it wants a sandbox service behind this same interface, not a hole in this
// one.

const GITHUB_API = 'https://api.github.com';

// A test suite that takes longer than this is one nobody will wait on inside
// a conversation, so the agent is told to check back rather than blocking a
// turn for minutes.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// Overridable so the tests, which stub the API and have nothing to wait for,
// don't spend half a minute sleeping between polls that answer instantly.
const POLL_INTERVAL_MS = Number(process.env.EXECUTION_POLL_MS) > 0 ? Number(process.env.EXECUTION_POLL_MS) : 5000;

export function isExecutionConfigured() {
  return Boolean(process.env.GITHUB_TOKEN);
}

async function githubRequest(path, options = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  // workflow_dispatch answers 204 with an empty body.
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Starts a workflow run. Returns nothing useful — GitHub's dispatch endpoint
 * does not tell you which run it created, which is why findRunAfter() exists.
 */
export async function dispatchWorkflow({ owner, repo, workflow, ref, inputs }) {
  await githubRequest(
    `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    { method: 'POST', body: JSON.stringify({ ref, inputs: inputs || {} }) }
  );
}

/**
 * Finds the run this dispatch started.
 *
 * GitHub gives no handle back from a dispatch, so the only way to identify
 * the run is "the newest one on this workflow and branch created at or after
 * we asked". Runs also take a moment to appear, hence the retries: treating
 * an empty list as failure would report every successful dispatch as broken.
 */
export async function findRunAfter({ owner, repo, workflow, branch, since, attempts = 6 }) {
  for (let i = 0; i < attempts; i++) {
    const data = await githubRequest(
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
        `?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=10`
    );
    const run = (data?.workflow_runs || []).find((r) => new Date(r.created_at).getTime() >= since - 5000);
    if (run) return run;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

export async function getRun({ owner, repo, runId }) {
  return githubRequest(`/repos/${owner}/${repo}/actions/runs/${runId}`);
}

/**
 * Waits for a run to finish. Returns the run either way — a timeout is not an
 * error, it's "still going", and the agent is told where to look.
 */
export async function waitForRun({ owner, repo, runId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  let run = await getRun({ owner, repo, runId });

  while (run.status !== 'completed' && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    run = await getRun({ owner, repo, runId });
  }
  return run;
}

/**
 * Which jobs and steps failed. This is what makes a red run actionable: a
 * conclusion of "failure" tells an agent nothing it can fix, while "the
 * 'test' job failed at step 'npm test'" points at the work.
 */
export async function failureSummary({ owner, repo, runId }) {
  const data = await githubRequest(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=30`);
  const failed = (data?.jobs || []).filter((job) => job.conclusion && job.conclusion !== 'success' && job.conclusion !== 'skipped');

  return failed.map((job) => ({
    job: job.name,
    conclusion: job.conclusion,
    failedSteps: (job.steps || [])
      .filter((step) => step.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped')
      .map((step) => step.name),
    url: job.html_url,
  }));
}

/** Every workflow the repo has, so an agent can be told what it may run. */
export async function listWorkflows({ owner, repo }) {
  const data = await githubRequest(`/repos/${owner}/${repo}/actions/workflows?per_page=50`);
  return (data?.workflows || [])
    .filter((w) => w.state === 'active')
    .map((w) => ({ name: w.name, file: (w.path || '').split('/').pop(), path: w.path }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
