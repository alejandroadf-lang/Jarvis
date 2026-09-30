// The building-practice KPIs are habits read from pull requests and commits.
// Pinned: each area scores from its printed thresholds, too little activity is
// "not measured" and not zero, a merged pull request is read once and cached,
// the weakest areas produce the candidate actions in order, a snapshot a week
// gives a trend, and an unreadable repo does not take the others down.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let pr;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-practice-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  pr = await import('../consultant/practice.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-10T03:00:00Z');
const hoursAgo = (h, from = NOW) => new Date(from.getTime() - h * 3_600_000).toISOString();

/** A fake GitHub for one repo. `prs`: [{n, lines, tests, reviewed, green, leadHours, mergedHoursAgo}] */
function fakeRepo({ prs = [], commits = [], instructionsHoursAgo = null, now = NOW, counts = {} }) {
  return async (p) => {
    counts[p] = (counts[p] || 0) + 1;
    if (p.includes('/pulls?state=closed')) return prs.map((x) => ({ number: x.n, merged_at: hoursAgo(x.mergedHoursAgo ?? 48, now) }));
    const detail = p.match(/\/pulls\/(\d+)$/);
    if (detail) {
      const x = prs.find((q) => q.n === +detail[1]);
      return { additions: x.lines, deletions: 0, head: { sha: `sha${x.n}` }, created_at: hoursAgo((x.mergedHoursAgo ?? 48) + x.leadHours, now), merged_at: hoursAgo(x.mergedHoursAgo ?? 48, now), review_comments: 0 };
    }
    const files = p.match(/\/pulls\/(\d+)\/files/);
    if (files) return prs.find((q) => q.n === +files[1]).tests ? [{ filename: 'src/a.js' }, { filename: 'test/a.test.js' }] : [{ filename: 'src/a.js' }];
    const reviews = p.match(/\/pulls\/(\d+)\/reviews/);
    if (reviews) return prs.find((q) => q.n === +reviews[1]).reviewed ? [{ state: 'COMMENTED' }] : [];
    const checks = p.match(/\/commits\/sha(\d+)\/check-runs/);
    if (checks) return { check_runs: [{ status: 'completed', conclusion: prs.find((q) => q.n === +checks[1]).green ? 'success' : 'failure' }] };
    if (p.includes('path=CLAUDE.md')) return instructionsHoursAgo === null ? [] : [{ commit: { committer: { date: hoursAgo(instructionsHoursAgo, now) } } }];
    if (p.includes('path=AGENTS.md')) return [];
    if (p.includes('/commits?sha=')) return commits.map((m) => ({ commit: { message: m } }));
    throw new Error(`unexpected ${p}`);
  };
}
const target = (name) => ({ owner: 'me', name, branch: 'main', label: name });
const PLENTY = Array.from({ length: 12 }, (_, i) => (i < 9 ? 'Add a feature' : 'Fix a thing'));

test('good habits score at the top of every area they can be measured on', async () => {
  const prs = [1, 2, 3, 4].map((n) => ({ n, lines: 150, tests: true, reviewed: true, green: true, leadHours: 10 }));
  const p = await pr.reviewPractice({ targets: [target('good')], now: NOW, get: fakeRepo({ prs, commits: [...Array(18).fill('Add x'), 'Fix y'], instructionsHoursAgo: 24 * 5 }) });
  const level = Object.fromEntries(p.areas.map((a) => [a.key, a.level]));
  assert.deepEqual(level, { small: 4, tests: 4, ci: 4, review: 4, rework: 4, rhythm: 4, instructions: 4, net: null });
  assert.equal(p.measured, 7);
  assert.equal(p.overall, 4);
  assert.match(p.areas[0].display, /median 150 changed lines over 4 pull requests/);
  assert.deepEqual(p.actions, [], 'nothing is weak, so nothing is proposed');
});

test('weak habits score low, and the candidate actions start with the weakest area', async () => {
  const prs = [1, 2, 3, 4].map((n) => ({ n, lines: 1200, tests: false, reviewed: false, green: false, leadHours: 400 }));
  const p = await pr.reviewPractice({ targets: [target('weak')], now: NOW, get: fakeRepo({ prs, commits: [...Array(6).fill('Fix bug'), ...Array(6).fill('Revert x'), 'Add y'], instructionsHoursAgo: null }) });
  const level = Object.fromEntries(p.areas.map((a) => [a.key, a.level]));
  assert.equal(level.small, 1);
  assert.equal(level.tests, 0);
  assert.equal(level.ci, 0);
  assert.equal(level.review, 0);
  assert.equal(level.rework, 0);
  assert.equal(level.rhythm, 0);
  assert.equal(level.instructions, 0);
  assert.ok(p.overall < 1);

  assert.ok(p.actions.length > 0 && p.actions.length <= 6);
  assert.deepEqual(p.actions.map((a) => a.id), p.actions.map((_, i) => `A${i + 1}`));
  assert.ok(p.actions[0].level === 0, 'the weakest area comes first');
  assert.ok(p.actions.every((a, i) => i === 0 || a.level >= p.actions[i - 1].level), 'in order of weakness');
  assert.ok(p.actions.every((a) => a.action && a.prompt && a.target), 'each has a first prompt and a measure of success');
  assert.match(pr.actionsText(p), /^\[A1\] \(/);
});

test('too little recent activity is "not measured", never zero', async () => {
  const prs = [{ n: 1, lines: 50, tests: true, reviewed: true, green: true, leadHours: 5 }];
  const p = await pr.reviewPractice({ targets: [target('quiet')], now: NOW, get: fakeRepo({ prs, commits: ['Add x'] }) });
  for (const key of ['small', 'tests', 'ci', 'review', 'rework', 'rhythm']) assert.equal(p.areas.find((a) => a.key === key).level, null, key);
  assert.match(p.areas[0].display, /not enough recent activity/);
  assert.ok(pr.practiceKpis(p).every((k) => k.status !== 'on_track' || !/small/i.test(k.name)));
});

test('a merged pull request is read once and cached, not fetched again tomorrow', async () => {
  const counts = {};
  const prs = [1, 2, 3].map((n) => ({ n, lines: 100, tests: true, reviewed: true, green: true, leadHours: 5 }));
  const get = fakeRepo({ prs, commits: PLENTY, counts });
  await pr.reviewPractice({ targets: [target('cached')], now: NOW, get });
  const first = counts['/repos/me/cached/pulls/1'];
  assert.equal(first, 1);
  await pr.reviewPractice({ targets: [target('cached')], now: NOW, get });
  assert.equal(counts['/repos/me/cached/pulls/1'], 1, 'the second review reads nothing new about pull request 1');
  assert.equal(counts['/repos/me/cached/pulls?state=closed&sort=updated&direction=desc&per_page=40'], 2, 'but it does look for new ones');
});

test('a weekly snapshot gives a trend, and the trend says since when', async () => {
  // A clean history: the earlier tests in this file recorded snapshots of their own.
  (await import('../store.js')).writeJson('consultant-practice.json', { prs: {}, snapshots: [] });
  const name = 'trend';
  const t0 = new Date('2026-11-01T03:00:00Z');
  const weak = [1, 2, 3].map((n) => ({ n, lines: 1200, tests: false, reviewed: false, green: true, leadHours: 10 }));
  const first = await pr.reviewPractice({ targets: [target(name)], now: t0, get: fakeRepo({ prs: weak, commits: PLENTY, now: t0 }) });
  assert.equal(first.areas.find((a) => a.key === 'small').trend, null, 'no history yet');

  const t1 = new Date('2026-11-20T03:00:00Z');
  const better = [11, 12, 13].map((n) => ({ n, lines: 150, tests: true, reviewed: false, green: true, leadHours: 10 }));
  const second = await pr.reviewPractice({ targets: [target(name)], now: t1, get: fakeRepo({ prs: better, commits: PLENTY, now: t1 }) });
  const small = second.areas.find((a) => a.key === 'small');
  assert.equal(small.level, 4);
  assert.equal(small.trend, 3, 'from level 1 to level 4');
  assert.equal(small.since, '2026-11-01');
  assert.match(pr.renderPractice(second), /↑ up 3 since 2026-11-01/);
});

test('an unreadable repo is reported and the others still count', async () => {
  const prs = [1, 2, 3].map((n) => ({ n, lines: 100, tests: true, reviewed: true, green: true, leadHours: 5 }));
  const ok = fakeRepo({ prs, commits: PLENTY });
  const get = async (p) => {
    if (p.includes('/repos/me/gone/')) throw new Error('GitHub API GET failed: 404');
    return ok(p);
  };
  const p = await pr.reviewPractice({ targets: [target('mixed'), target('gone')], now: NOW, get });
  assert.ok(p.repos.find((r) => r.name === 'gone').error);
  assert.equal(p.areas.find((a) => a.key === 'tests').level, 4);
  assert.ok(p.facts.some((f) => /gone: the pull-request history could not be read/.test(f)));
  assert.equal(await pr.reviewPractice({ targets: [], now: NOW }), null);
});

test('the net under the agents comes from the code review checklist, and the email shows how each area is scored', async () => {
  const prs = [1, 2, 3].map((n) => ({ n, lines: 100, tests: true, reviewed: true, green: true, leadHours: 5 }));
  const engineering = { repos: [{ label: 'the company\'s own code', checklist: [{ key: 'evals', present: true }, { key: 'observability', present: false }, { key: 'guardrails', present: true }, { key: 'lockfile', present: true }, { key: 'updates', present: false }] }] };
  const p = await pr.reviewPractice({ targets: [target('net')], engineering, now: NOW, get: fakeRepo({ prs, commits: PLENTY }) });
  const net = p.areas.find((a) => a.key === 'net');
  assert.equal(net.level, 2);
  assert.match(net.display, /missing: tracing or error reporting \(the company's own code\), locked dependencies and automatic updates \(the company's own code\)/);
  assert.ok(p.actions.some((a) => a.area === 'net'));

  const text = pr.renderPractice(p);
  assert.match(text, /habits visible in your pull requests and commits, not talent/);
  assert.match(text, /how it is scored: median merged pull request: level 4 at 200/);
  assert.match(text, /first prompt: /);
  assert.match(text, /it worked when: /);
  const kpis = pr.practiceKpis(p);
  assert.match(kpis[0].name, /Building-practice level/);
  assert.equal(kpis.find((k) => /Practice: A net/.test(k.name)).status, 'watch');
  assert.match(pr.renderPractice(null), /was not measured: GITHUB_TOKEN is not set/);
});

test('the net names which repo lacks each thing, so one small repo does not read as the whole company lacking it', async () => {
  const prs = [1, 2, 3].map((n) => ({ n, lines: 100, tests: true, reviewed: true, green: true, leadHours: 5 }));
  const all = (present) => ['evals', 'observability', 'guardrails', 'lockfile', 'updates'].map((key) => ({ key, present }));
  const engineering = { repos: [{ label: 'the company\'s own code', checklist: all(true) }, { label: 'CircadianAPI\'s repo', checklist: all(false).map((c) => (c.key === 'lockfile' ? { ...c, present: true } : c)) }] };
  const p = await pr.reviewPractice({ targets: [target('net')], engineering, now: NOW, get: fakeRepo({ prs, commits: PLENTY }) });
  const net = p.areas.find((a) => a.key === 'net');
  assert.equal(net.level, 0);
  assert.match(net.display, /missing: evals \(CircadianAPI's repo\), tracing or error reporting \(CircadianAPI's repo\), a kill switch and spend cap \(CircadianAPI's repo\), locked dependencies and automatic updates \(CircadianAPI's repo\)/);
  assert.doesNotMatch(net.display, /the company's own code\)/, 'the repo that has them is not blamed');
});
