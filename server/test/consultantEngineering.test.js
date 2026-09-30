// The code review reads structure and activity through the GitHub API and says
// what is missing. Pinned: the checklist finds each thing where it lives in a file
// tree, big files and test ratios are counted, an unreadable repo is reported as
// unread and not scored as bad, the level follows the essentials, and the email
// says plainly that it does not read the logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseTree, repoTargets, reviewCode, renderCodeReview, CHECKS } from '../consultant/engineering.js';

const f = (path, bytes = 1000) => ({ path, bytes });
const NOW = new Date('2026-10-10T03:00:00Z');

const FULL = [
  f('.github/workflows/ci.yml'), f('CLAUDE.md'), f('server/.env.example'), f('server/package-lock.json'), f('Dockerfile'), f('SECURITY.md'),
  f('server/index.js', 90_000), f('server/spend.js'), f('server/killSwitch.js'), f('server/telemetry.js'), f('server/eval/run.js'),
  f('server/test/a.test.js'), f('server/test/b.test.js'), f('ORG_STRUCTURE.md'), f('tsconfig.json'), f('.github/dependabot.yml'),
  ...Array.from({ length: 8 }, (_, i) => f(`server/lib${i}.js`)),
];

test('the checklist finds each thing where it lives, and counts tests and big files', () => {
  const a = analyseTree(FULL);
  const present = Object.fromEntries(a.checklist.map((c) => [c.key, c.present]));
  for (const k of ['ci', 'tests', 'agentDocs', 'envTemplate', 'lockfile', 'evals', 'observability', 'guardrails', 'dockerfile', 'security', 'updates', 'lint', 'runbook']) assert.equal(present[k], true, k);
  assert.equal(a.testFiles, 2);
  assert.equal(a.sourceFiles, 13, 'tests are not counted as source');
  assert.deepEqual(a.bigFiles, [{ path: 'server/index.js', kb: 90 }]);
  assert.equal(CHECKS.filter((c) => c[3]).length, 6, 'six essentials');
});

test('a bare repo is missing the essentials, and a similarly named file is not mistaken for one', () => {
  const a = analyseTree([f('index.js'), f('README.md'), f('notes/testing-ideas.md'), f('src/attest.js')]);
  const missing = a.checklist.filter((c) => !c.present).map((c) => c.key);
  for (const k of ['ci', 'tests', 'agentDocs', 'envTemplate', 'lockfile', 'evals']) assert.ok(missing.includes(k), k);
  assert.equal(a.testFiles, 0);
});

test('targets: an explicit list wins; otherwise the app\'s own repo plus each venture\'s, without duplicates', () => {
  assert.deepEqual(repoTargets({ CODE_REVIEW_REPOS: 'a/b, c/d' }, []).map((t) => `${t.owner}/${t.name}`), ['a/b', 'c/d']);
  const out = repoTargets(
    { RAILWAY_GIT_REPO_OWNER: 'me', RAILWAY_GIT_REPO_NAME: 'jarvis' },
    [{ status: 'active', title: 'Circadian', repo: { owner: 'me', name: 'circadian-api', branch: 'main' } }, { status: 'active', title: 'Same', repo: { owner: 'ME', name: 'Jarvis', branch: 'main' } }, { status: 'killed', title: 'Dead', repo: { owner: 'me', name: 'dead' } }],
  );
  assert.deepEqual(out.map((t) => t.name), ['jarvis', 'circadian-api']);
  assert.deepEqual(repoTargets({}, []), []);
});

function fakeGithub({ tree = FULL, ci = { conclusion: 'success' } } = {}) {
  const list = async ({ repo }) => (repo === 'gone' ? { files: [], truncated: false, state: 'no-such-ref' } : { files: tree, truncated: false, state: 'ok' });
  const get = async (p) => {
    if (p.includes('/check-runs')) return { check_runs: [{ status: 'completed', conclusion: ci.conclusion }, { status: 'completed', conclusion: 'success' }] };
    if (p.includes('/commits?')) return Array.from({ length: 9 }, () => ({}));
    if (p.includes('state=closed')) return [{ merged_at: '2026-10-08T00:00:00Z' }, { merged_at: '2026-10-01T00:00:00Z' }, { merged_at: '2026-08-01T00:00:00Z' }, { merged_at: null }];
    if (p.includes('state=open')) return [{}, {}];
    throw new Error('unexpected ' + p);
  };
  return { list, get };
}

test('a repo is reviewed into cited facts, a level from the essentials, and an activity read', async () => {
  const { list, get } = fakeGithub();
  const r = await reviewCode({ now: NOW, targets: [{ owner: 'me', name: 'jarvis', branch: 'main', label: 'the company\'s own code' }], get, list });
  assert.equal(r.repos.length, 1);
  assert.equal(r.repos[0].activity.commits14, 9);
  assert.equal(r.repos[0].activity.merged14, 2, 'only merges in the last 14 days');
  assert.equal(r.repos[0].activity.open, 2);
  assert.equal(r.repos[0].activity.ci.green, true);
  assert.equal(r.level, 4, 'all six essentials, green CI, work landing');
  assert.ok(r.facts.some((t) => /13 source files and 2 test files \(15 tests per 100 source files\)/.test(t)));
  assert.ok(r.facts.some((t) => /files too big to hold in one head: server\/index\.js \(90 KB\)/.test(t)));
  assert.ok(r.facts.some((t) => /9 commits and 2 merged pull requests in the last 14 days, 2 open; CI on main: all 2 checks pass/.test(t)));
});

test('failing CI and a bare repo lower the level; an unreadable repo is reported as unread, not as bad', async () => {
  const bare = fakeGithub({ tree: [f('index.js')], ci: { conclusion: 'failure' } });
  const r = await reviewCode({
    now: NOW,
    targets: [{ owner: 'me', name: 'bare', branch: 'main', label: 'bare' }, { owner: 'me', name: 'gone', branch: 'main', label: 'gone' }],
    get: bare.get,
    list: bare.list,
  });
  assert.ok(r.repos[0].activity.ci.green === false);
  assert.ok(r.level < 1.5);
  assert.match(r.repos[1].error, /branch main does not exist/);
  assert.ok(r.facts.some((t) => /gone \(me\/gone\) could not be read/.test(t)));
  assert.equal(r.repos.filter((x) => !x.error).length, 1, 'the unreadable repo does not drag the level down');
});

test('the email section lists present and missing things and says it does not read the logic', async () => {
  const { list, get } = fakeGithub({ tree: [f('.github/workflows/ci.yml'), f('a.js', 80_000)] });
  const r = await reviewCode({ now: NOW, targets: [{ owner: 'me', name: 'x', branch: 'main', label: 'x' }], get, list });
  const text = renderCodeReview(r);
  assert.match(text, /not at whether the logic is right/);
  assert.match(text, /\[present\] A CI workflow/);
  assert.match(text, /\[MISSING\] Automated tests/);
  assert.match(text, /\[MISSING\] Behaviour evals .*\n/);
  assert.match(text, /\(nice to have\)/);
  assert.match(text, /\[WATCH\] Very large files: a\.js 80 KB/);
  assert.match(renderCodeReview(null), /The code was not reviewed: GITHUB_TOKEN is not set/);
});
