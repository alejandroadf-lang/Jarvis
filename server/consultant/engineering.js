// A look at the code from the outside, for someone building a company with AI
// coding tools.
//
// The founder builds this company by describing what they want to an AI and
// accepting what comes back. That works until it does not, and what tends to
// go wrong is not the feature: it is that nothing checks it. No tests that fail
// when the agent breaks something, no evals that notice an agent's judgement
// drifting, no way to see what happened, a single file of two thousand lines
// nobody, human or model, can hold in their head.
//
// So this looks for those things in each repo, through the GitHub API, and
// reports what is there and what is missing. It reads structure and activity
// (does a CI workflow exist, does the latest run pass, how many tests per
// source file, what is the biggest file, how many pull requests were merged in
// a fortnight). It does not read the code's logic and cannot say a function is
// right; the email says so. Every finding is a checkable fact with a number.
//
// Fail-quiet per repo: a repo that cannot be read is reported as unread.

import { githubGet, listFiles, isGithubConfigured } from '../deploy/github.js';
import { listVentures } from '../finance/ventures.js';

const DAY = 86_400_000;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rb|java|rs|php)$/i;
export const TEST = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:go|py)$/i;
const BIG_FILE_BYTES = 60_000; // roughly 1,500 lines

// What an AI-agent company needs around its code, and how to see it in a file tree.
// `essential` ones count toward the level; the rest are reported.
export const CHECKS = [
  ['ci', 'A CI workflow that runs the tests on every push', (f) => f.some((p) => /^\.github\/workflows\/.+\.ya?ml$/i.test(p)), true],
  ['tests', 'Automated tests', (f) => f.some((p) => TEST.test(p)), true],
  ['agentDocs', 'Instructions for the AI coding tool (CLAUDE.md, AGENTS.md)', (f) => f.some((p) => /(^|\/)(claude|agents)\.md$|^\.cursorrules$/i.test(p)), true],
  ['envTemplate', 'A template of the settings the app needs (.env.example)', (f) => f.some((p) => /(^|\/)\.env\.(example|sample|template)$/i.test(p)), true],
  ['lockfile', 'Locked dependency versions', (f) => f.some((p) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|requirements\.txt|go\.sum|Gemfile\.lock)$/i.test(p)), true],
  ['evals', 'Behaviour evals that would notice an agent getting worse', (f) => f.some((p) => /(^|\/)evals?(\/|[^/]*\.(js|py|ts)$)/i.test(p)), true],
  ['observability', 'Tracing or error reporting, to see what happened', (f) => f.some((p) => /telemetry|otel|tracing|sentry|observab/i.test(p)), false],
  ['guardrails', 'A kill switch and a spending cap', (f) => f.some((p) => /kill.?switch/i.test(p)) && f.some((p) => /(^|\/)spend/i.test(p)), false],
  ['dockerfile', 'A Dockerfile, so it runs the same everywhere', (f) => f.some((p) => /(^|\/)dockerfile$/i.test(p)), false],
  ['security', 'A security policy (SECURITY.md)', (f) => f.some((p) => /(^|\/)security\.md$/i.test(p)), false],
  ['updates', 'Automatic dependency updates (Dependabot or Renovate)', (f) => f.some((p) => /(^|\/)(dependabot\.ya?ml|renovate\.json5?)$/i.test(p)), false],
  ['lint', 'A linter or type checker configured', (f) => f.some((p) => /(^|\/)(tsconfig\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?js|ruff\.toml|\.flake8|mypy\.ini)$/i.test(p)), false],
  ['runbook', 'Written architecture or runbook notes', (f) => f.some((p) => /(^|\/)(architecture|runbook|org_structure)[^/]*\.md$|^docs\//i.test(p)), false],
];

/** Where to look: CODE_REVIEW_REPOS, else this app's own repo (Railway sets it) plus each venture's linked repo. */
export function repoTargets(env = process.env, ventures = listVentures()) {
  const seen = new Set();
  const out = [];
  const add = (owner, name, branch, label) => {
    if (!owner || !name) return;
    const key = `${owner}/${name}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ owner, name, branch: branch || 'main', label: label || `${owner}/${name}` });
  };
  const configured = String(env.CODE_REVIEW_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length) {
    for (const c of configured) {
      const [owner, name] = c.split('/');
      add(owner, name);
    }
    return out.slice(0, 4);
  }
  add(env.RAILWAY_GIT_REPO_OWNER, env.RAILWAY_GIT_REPO_NAME, env.RAILWAY_GIT_BRANCH, 'the company\'s own code');
  for (const v of ventures.filter((x) => x.status === 'active' && x.repo)) add(v.repo.owner, v.repo.name, v.repo.branch, `${v.title}'s repo`);
  return out.slice(0, 4);
}

/** The findings for one file tree. Pure. */
export function analyseTree(entries) {
  const paths = entries.map((e) => e.path);
  const source = entries.filter((e) => SOURCE.test(e.path) && !TEST.test(e.path));
  const tests = entries.filter((e) => TEST.test(e.path));
  const big = [...source].filter((e) => e.bytes >= BIG_FILE_BYTES).sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  return {
    checklist: CHECKS.map(([key, label, test, essential]) => ({ key, label, essential, present: test(paths) })),
    sourceFiles: source.length,
    testFiles: tests.length,
    testsPerSource: source.length ? tests.length / source.length : 0,
    bigFiles: big.map((e) => ({ path: e.path, kb: Math.round(e.bytes / 1000) })),
  };
}

async function activity(target, now, get) {
  const since = new Date(now.getTime() - 14 * DAY).toISOString();
  const base = `/repos/${target.owner}/${target.name}`;
  const out = { commits14: null, merged14: null, open: null, ci: null };
  try {
    const commits = await get(`${base}/commits?sha=${encodeURIComponent(target.branch)}&since=${encodeURIComponent(since)}&per_page=100`);
    out.commits14 = Array.isArray(commits) ? commits.length : null;
  } catch {}
  try {
    const prs = await get(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
    out.merged14 = Array.isArray(prs) ? prs.filter((p) => p.merged_at && Date.parse(p.merged_at) >= now.getTime() - 14 * DAY).length : null;
  } catch {}
  try {
    const open = await get(`${base}/pulls?state=open&per_page=50`);
    out.open = Array.isArray(open) ? open.length : null;
  } catch {}
  try {
    const runs = await get(`${base}/commits/${encodeURIComponent(target.branch)}/check-runs?per_page=50`);
    const list = runs?.check_runs || [];
    if (list.length) {
      const failed = list.filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion)).length;
      const pending = list.filter((r) => r.status !== 'completed').length;
      out.ci = { total: list.length, failed, pending, green: failed === 0 && pending === 0 };
    }
  } catch {}
  return out;
}

/**
 * Reviews every target. `get` and `list` are injectable for tests. Resolves to
 * { repos, level, facts, checklist }, or null when GitHub is not configured or
 * there is nothing to look at.
 */
export async function reviewCode({ now = new Date(), targets = repoTargets(), get = githubGet, list = listFiles } = {}) {
  if (!isGithubConfigured() && get === githubGet) return null;
  if (!targets.length) return null;
  const repos = [];
  const facts = [];
  for (const t of targets) {
    try {
      const tree = await list({ owner: t.owner, repo: t.name, branch: t.branch, limit: 3000 });
      if (!tree.files.length) throw new Error(tree.state === 'no-such-ref' ? `branch ${t.branch} does not exist` : 'the repo has no files');
      const a = analyseTree(tree.files);
      const act = await activity(t, now, get);
      repos.push({ ...t, ...a, activity: act, truncated: tree.truncated });

      const missing = a.checklist.filter((c) => !c.present);
      facts.push(
        `${t.label} (${t.owner}/${t.name}): ${a.sourceFiles} source files and ${a.testFiles} test files (${a.sourceFiles ? `${(a.testsPerSource * 100).toFixed(0)}` : 0} tests per 100 source files)${tree.truncated ? ', tree truncated so counts are a floor' : ''}.`,
        `${t.label}: present: ${a.checklist.filter((c) => c.present).map((c) => c.key).join(', ') || 'none'}. Missing: ${missing.map((c) => c.key).join(', ') || 'none'}.`,
        `${t.label}: ${a.bigFiles.length ? `files too big to hold in one head: ${a.bigFiles.map((f) => `${f.path} (${f.kb} KB)`).join(', ')}` : 'no source file over about 1,500 lines'}.`,
        `${t.label}: ${act.commits14 ?? 'unknown'} commits and ${act.merged14 ?? 'unknown'} merged pull requests in the last 14 days, ${act.open ?? 'unknown'} open; CI on ${t.branch}: ${act.ci ? (act.ci.green ? `all ${act.ci.total} checks pass` : `${act.ci.failed} failing, ${act.ci.pending} pending of ${act.ci.total}`) : 'no check runs found'}.`,
      );
    } catch (err) {
      repos.push({ ...t, error: err.message });
      facts.push(`${t.label} (${t.owner}/${t.name}) could not be read: ${err.message}.`);
    }
  }

  // The level: how many of the essentials are in place, plus whether CI passes
  // and whether work is landing. 0 to 4; the arithmetic is the whole method.
  const readable = repos.filter((r) => !r.error);
  const levels = readable.map((r) => {
    const essentials = r.checklist.filter((c) => c.essential);
    const have = essentials.filter((c) => c.present).length;
    return Math.min(4, (have / essentials.length) * 3 + (r.activity.ci?.green ? 0.5 : 0) + (r.activity.merged14 > 0 ? 0.5 : 0));
  });
  const level = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0;
  return { repos, level, facts };
}

/** The checklist as it appears in the email. Pure. */
export function renderCodeReview(review) {
  if (!review) return 'The code was not reviewed: GITHUB_TOKEN is not set, or no repo could be found (set CODE_REVIEW_REPOS to owner/name).';
  const lines = ['This looks at structure and activity, not at whether the logic is right: a passing test suite and a clean checklist say nothing about a bug nobody wrote a test for.', ''];
  for (const r of review.repos) {
    if (r.error) {
      lines.push(`${r.label}: could not be read (${r.error}).`, '');
      continue;
    }
    lines.push(`${r.label} (${r.owner}/${r.name})`);
    for (const c of r.checklist) lines.push(`  ${c.present ? '[present]' : '[MISSING]'} ${c.label}${c.essential ? '' : ' (nice to have)'}`);
    if (r.bigFiles.length) lines.push(`  [WATCH] Very large files: ${r.bigFiles.map((f) => `${f.path} ${f.kb} KB`).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}
