// How the founder builds, measured from what they actually did.
//
// Nobody can grade "vibe coding skill", and this does not try. What can be seen,
// from the pull requests and commits themselves, are the habits that decide
// whether AI-built software holds together: are changes small enough to review,
// do tests travel with the code, does CI pass before anything merges, does
// anything get a second look, how often does a change need fixing straight
// after, how fast does an idea reach main, are the instructions to the coding tool
// kept alive, and is there a net under the agents (evals, tracing, guardrails)
// and under the repo (dependency updates, a settings template, a linter).
//
// Each is an area scored 0 to 4 against thresholds written below, from real
// numbers, cached per pull request (a merged pull request never changes, so each
// is read once). They are proxies for practice, not for talent or for whether the
// logic is correct, and the email says so. Progress is kept: a snapshot a week, so
// the next briefing can say what moved since the plan was made.
//
// The improvement plan is built from what is weakest, out of a fixed catalogue of
// concrete actions with a first prompt to give the coding tool and a measurable
// target. The catalogue is written here, not invented per day by a model: a plan
// the founder can act on has to be one whose steps are known to make sense.

import { readJson, writeJson } from '../store.js';
import { githubGet } from '../deploy/github.js';
import { TEST } from './engineering.js';

const FILE = 'consultant-practice.json';
const DAY = 86_400_000;
const MIN_PRS = 3;
const MAX_PRS_PER_REPO = 15;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const share = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : null);
const pct = (n) => `${Math.round(n * 100)}%`;
// value -> level, given the cut points from best (level 4) to worst
const stepsDown = (v, cuts) => cuts.findIndex((c) => v <= c) === -1 ? 0 : 4 - cuts.findIndex((c) => v <= c);
const stepsUp = (v, cuts) => cuts.findIndex((c) => v >= c) === -1 ? 0 : 4 - cuts.findIndex((c) => v >= c);

/** One merged pull request, reduced to what is measured. Cached forever by number. */
async function readPr(base, n, get) {
  const pr = await get(`${base}/pulls/${n}`);
  const files = await get(`${base}/pulls/${n}/files?per_page=100`).catch(() => []);
  const reviews = await get(`${base}/pulls/${n}/reviews?per_page=50`).catch(() => []);
  let green = null;
  try {
    const runs = (await get(`${base}/commits/${pr.head.sha}/check-runs?per_page=50`)).check_runs || [];
    if (runs.length) green = runs.every((r) => r.status === 'completed' && !['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion));
  } catch {}
  return {
    lines: (pr.additions || 0) + (pr.deletions || 0),
    tests: Array.isArray(files) && files.some((f) => TEST.test(f.filename)),
    reviewed: (Array.isArray(reviews) && reviews.length > 0) || (pr.review_comments || 0) > 0,
    green,
    leadHours: pr.created_at && pr.merged_at ? (Date.parse(pr.merged_at) - Date.parse(pr.created_at)) / 3_600_000 : null,
    mergedAt: pr.merged_at,
  };
}

/** Reads (and caches) the merged pull requests and recent commits of each repo. Never throws per repo. */
export async function readActivity({ targets, now = new Date(), get = githubGet }) {
  const store = readJson(FILE, { prs: {}, snapshots: [] });
  const repos = [];
  for (const t of targets) {
    const key = `${t.owner}/${t.name}`.toLowerCase();
    const base = `/repos/${t.owner}/${t.name}`;
    try {
      const closed = await get(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=40`);
      const merged = (Array.isArray(closed) ? closed : []).filter((p) => p.merged_at && now.getTime() - Date.parse(p.merged_at) <= 30 * DAY).slice(0, MAX_PRS_PER_REPO);
      const prs = [];
      for (const p of merged) {
        const id = `${key}#${p.number}`;
        if (!store.prs[id]) {
          try {
            store.prs[id] = await readPr(base, p.number, get);
          } catch {
            continue; // unreadable now, tried again tomorrow
          }
        }
        prs.push(store.prs[id]);
      }

      const since = new Date(now.getTime() - 30 * DAY).toISOString();
      const commits = await get(`${base}/commits?sha=${encodeURIComponent(t.branch)}&since=${encodeURIComponent(since)}&per_page=100`).catch(() => []);
      const subjects = (Array.isArray(commits) ? commits : []).map((c) => String(c.commit?.message || '').split('\n')[0]).filter((m) => !/^Merge /i.test(m));
      const rework = subjects.filter((m) => /^(fix|revert|hotfix|bugfix)\b/i.test(m)).length;

      let instructionAgeDays = null;
      for (const file of ['CLAUDE.md', 'AGENTS.md']) {
        const last = await get(`${base}/commits?path=${file}&per_page=1`).catch(() => []);
        if (Array.isArray(last) && last[0]?.commit?.committer?.date) {
          instructionAgeDays = Math.round((now.getTime() - Date.parse(last[0].commit.committer.date)) / DAY);
          break;
        }
      }
      repos.push({ ...t, prs, commits30: subjects.length, rework, instructionAgeDays });
    } catch (err) {
      repos.push({ ...t, error: err.message });
    }
  }
  // Pull requests older than the window are dropped from the cache so it stays small.
  const keep = new Set(repos.flatMap((r) => (r.prs || []).map((p) => p.mergedAt)));
  for (const [id, p] of Object.entries(store.prs)) if (!keep.has(p.mergedAt)) delete store.prs[id];
  writeJson(FILE, store);
  return repos;
}

// The areas. `measure` returns null when there is not enough to say anything.
export const AREAS = [
  {
    key: 'small',
    name: 'Small changes, easy to review',
    rule: 'median merged pull request: level 4 at 200 changed lines or fewer, 3 at 400, 2 at 800, 1 at 1,500',
    measure: (s) => (s.prs.length >= MIN_PRS ? { value: median(s.prs.map((p) => p.lines)), fmt: (v) => `median ${Math.round(v)} changed lines over ${s.prs.length} pull requests`, level: (v) => stepsDown(v, [200, 400, 800, 1500]) } : null),
  },
  {
    key: 'tests',
    name: 'Tests travel with the code',
    rule: 'share of merged pull requests that touch a test: level 4 at 70% or more, 3 at 50%, 2 at 30%, 1 above zero',
    measure: (s) => (s.prs.length >= MIN_PRS ? { value: share(s.prs.map((p) => p.tests)), fmt: (v) => `${pct(v)} of ${s.prs.length} pull requests touched a test`, level: (v) => (v > 0 ? Math.max(1, stepsUp(v, [0.7, 0.5, 0.3])) : 0) } : null),
  },
  {
    key: 'ci',
    name: 'CI passes before merge',
    rule: 'share of merged pull requests whose checks were green: level 4 at 90% or more, 3 at 75%, 2 at 50%, 1 at 25%',
    measure: (s) => {
      const known = s.prs.filter((p) => p.green !== null);
      return known.length >= MIN_PRS ? { value: share(known.map((p) => p.green)), fmt: (v) => `${pct(v)} of ${known.length} pull requests merged with green checks`, level: (v) => stepsUp(v, [0.9, 0.75, 0.5, 0.25]) } : null;
    },
  },
  {
    key: 'review',
    name: 'A second look before merge',
    rule: 'share of merged pull requests with a review or review comment (a review bot counts): level 4 at 50% or more, 3 at 25%, 2 at 10%, 1 above zero',
    measure: (s) => (s.prs.length >= MIN_PRS ? { value: share(s.prs.map((p) => p.reviewed)), fmt: (v) => `${pct(v)} of ${s.prs.length} pull requests were reviewed`, level: (v) => (v > 0 ? Math.max(1, stepsUp(v, [0.5, 0.25, 0.1])) : 0) } : null),
  },
  {
    key: 'rework',
    name: 'Little rework straight after',
    rule: 'share of commits that are fixes or reverts: level 4 at 10% or less, 3 at 20%, 2 at 30%, 1 at 45%',
    measure: (s) => (s.commits >= 10 ? { value: s.rework / s.commits, fmt: (v) => `${pct(v)} of ${s.commits} commits in 30 days were fixes or reverts`, level: (v) => stepsDown(v, [0.1, 0.2, 0.3, 0.45]) } : null),
  },
  {
    key: 'rhythm',
    name: 'Ideas reach main quickly',
    rule: 'median hours from opening to merging: level 4 at 24 or fewer, 3 at 72, 2 at 168, 1 at 336',
    measure: (s) => {
      const hours = s.prs.map((p) => p.leadHours).filter((h) => h !== null);
      return hours.length >= MIN_PRS ? { value: median(hours), fmt: (v) => `median ${Math.round(v)} hours from opening to merging`, level: (v) => stepsDown(v, [24, 72, 168, 336]) } : null;
    },
  },
  {
    key: 'instructions',
    name: 'The coding tool\'s instructions are kept alive',
    rule: 'days since CLAUDE.md or AGENTS.md changed: level 4 at 30 or fewer, 3 at 90, 2 at 180, 1 beyond; 0 when there is none',
    measure: (s) => (s.instructionAge === undefined ? null : s.instructionAge === null ? { value: null, fmt: () => 'no CLAUDE.md or AGENTS.md was found', level: () => 0 } : { value: s.instructionAge, fmt: (v) => `last changed ${v} days ago`, level: (v) => stepsDown(v, [30, 90, 180]) || 1 }),
  },
  {
    key: 'net',
    name: 'A net under the agents and the repo',
    rule: 'one point each for evals, tracing or error reporting, a kill switch and spend cap, and locked dependencies plus automatic updates',
    measure: (s) => (s.checklist ? { value: s.net, fmt: (v) => `${v} of 4 (${s.netMissing.length ? `missing: ${s.netMissing.join(', ')}` : 'all present'})`, level: (v) => v } : null),
  },
];

// Concrete actions, keyed to the area they lift. Each has a first prompt to give
// the coding tool and the number that says it worked.
export const CATALOGUE = [
  { area: 'small', effort: 'S', action: 'Ask for one change at a time', prompt: 'Split this into the smallest change that works. Open it as its own pull request and touch nothing else. List what you left out.', target: 'median pull request under 300 changed lines' },
  { area: 'small', effort: 'M', action: 'Break big features into a first thin slice that ships', prompt: 'Propose the thinnest end-to-end slice of this feature that a user could try, and build only that.', target: 'no merged pull request over 800 lines' },
  { area: 'tests', effort: 'S', action: 'Write the failing test first', prompt: 'Before changing anything, write a test that fails for this bug or feature. Show it failing, then make it pass, and show it passing.', target: 'at least half of merged pull requests touch a test' },
  { area: 'tests', effort: 'M', action: 'Add tests around the code the agents change most', prompt: 'List the five files that changed most in the last 30 days and write characterization tests for what each does today.', target: 'tests on the five most-changed files' },
  { area: 'ci', effort: 'S', action: 'Make CI a gate, not a suggestion', prompt: '(Repository settings, not a prompt) Protect main: require the checks to pass before a pull request can merge.', target: '90% of merged pull requests green' },
  { area: 'ci', effort: 'S', action: 'Fix a red build before anything else', prompt: 'CI is failing. Explain why in plain words, fix only that, and do not start anything new.', target: 'CI green on main' },
  { area: 'review', effort: 'S', action: 'Have a second model review every diff', prompt: 'Review this diff as a sceptical senior engineer. List bugs, missing tests, security problems and anything that will surprise the next person. Do not fix anything yet.', target: 'a review on at least half of merged pull requests' },
  { area: 'review', effort: 'M', action: 'Turn on an automated pull-request reviewer', prompt: '(Repository settings) Add a review bot to the repo so every pull request gets a written review before you merge.', target: 'a review on every pull request' },
  { area: 'rework', effort: 'S', action: 'Record each repeated mistake in the coding tool\'s instructions', prompt: 'You just had to fix the same kind of mistake again. Write one rule for CLAUDE.md that would have prevented it, and add it.', target: 'fix and revert commits under 20%' },
  { area: 'rework', effort: 'M', action: 'Look at what you are about to build before you build it', prompt: 'Before writing code, read the files this touches and tell me the plan in five lines, including what could break. Wait for my yes.', target: 'fix and revert commits under 15%' },
  { area: 'rhythm', effort: 'S', action: 'Merge every day', prompt: '(Habit) Finish or drop every branch within three days; if it is too big to finish, split it.', target: 'median under 72 hours to merge' },
  { area: 'instructions', effort: 'S', action: 'Give the coding tool a CLAUDE.md, and keep it current', prompt: 'Read this repo and write a CLAUDE.md: how to run and test it, the rules that matter, the mistakes to avoid. Keep it under 150 lines.', target: 'CLAUDE.md changed in the last 30 days' },
  { area: 'net', effort: 'M', action: 'Add three eval scenarios for the riskiest agent decision', prompt: 'Look at the agent that can spend money or contact customers. Write three scenarios where the right answer is to refuse, and add them to the eval suite.', target: 'evals present and passing' },
  { area: 'net', effort: 'S', action: 'Turn on dependency updates and secret scanning', prompt: '(Repository settings) Enable Dependabot alerts and updates, and secret scanning with push protection.', target: 'updates and secret scanning on' },
  { area: 'net', effort: 'M', action: 'Add error reporting', prompt: 'Add error reporting so an exception in production reaches me with the request that caused it, without personal data in it.', target: 'tracing or error reporting present' },
];

/**
 * Scores the areas from activity and (optionally) the code review's checklist.
 * `repos` is readActivity's output. Pure.
 */
export function scoreAreas(repos, engineering = null) {
  const readable = repos.filter((r) => !r.error);
  const s = {
    prs: readable.flatMap((r) => r.prs),
    commits: readable.reduce((n, r) => n + r.commits30, 0),
    rework: readable.reduce((n, r) => n + r.rework, 0),
    instructionAge: readable.length ? (readable.some((r) => r.instructionAgeDays !== null) ? Math.min(...readable.filter((r) => r.instructionAgeDays !== null).map((r) => r.instructionAgeDays)) : null) : undefined,
  };
  const lists = (engineering?.repos || []).filter((r) => !r.error);
  if (lists.length) {
    // Every repo has to have it, so the weakest repo decides; the gap names the repo,
    // because "missing: evals" reads as the company's own code lacking them when it
    // may be a small API repo that has no agents to test.
    const lacking = (test) => lists.filter((r) => !test((key) => r.checklist.find((c) => c.key === key)?.present)).map((r) => r.label || `${r.owner}/${r.name}`);
    const parts = [
      ['evals', lacking((h) => h('evals'))],
      ['tracing or error reporting', lacking((h) => h('observability'))],
      ['a kill switch and spend cap', lacking((h) => h('guardrails'))],
      ['locked dependencies and automatic updates', lacking((h) => h('lockfile') && h('updates'))],
    ];
    s.checklist = true;
    s.net = parts.filter(([, repos]) => !repos.length).length;
    s.netMissing = parts.filter(([, repos]) => repos.length).map(([n, repos]) => `${n} (${repos.join(', ')})`);
  }
  return AREAS.map((a) => {
    const m = a.measure(s);
    return m ? { key: a.key, name: a.name, rule: a.rule, level: m.level(m.value), display: m.fmt(m.value) } : { key: a.key, name: a.name, rule: a.rule, level: null, display: 'not enough recent activity to measure' };
  });
}

/** The next actions: from the weakest measured areas up, each with a stable id. Pure. */
export function candidateActions(areas, { limit = 6 } = {}) {
  const weak = areas.filter((a) => a.level !== null && a.level < 3).sort((x, y) => x.level - y.level);
  const picked = [];
  for (const a of weak) for (const c of CATALOGUE.filter((c) => c.area === a.key).sort((p, q) => p.effort.localeCompare(q.effort))) picked.push({ ...c, level: a.level, areaName: a.name });
  return picked.slice(0, limit).map((c, i) => ({ id: `A${i + 1}`, ...c }));
}

const DAYS_BETWEEN_SNAPSHOTS = 6;

/** Keeps a weekly snapshot of the levels, and says how each area moved since about two weeks ago. */
export function recordAndCompare(areas, now = new Date()) {
  const store = readJson(FILE, { prs: {}, snapshots: [] });
  const today = now.toISOString().slice(0, 10);
  const last = store.snapshots[store.snapshots.length - 1];
  if (!last || now.getTime() - Date.parse(last.date) >= DAYS_BETWEEN_SNAPSHOTS * DAY) {
    store.snapshots.push({ date: today, levels: Object.fromEntries(areas.filter((a) => a.level !== null).map((a) => [a.key, a.level])) });
    store.snapshots = store.snapshots.slice(-26);
    writeJson(FILE, store);
  }
  const past = [...store.snapshots].reverse().find((s) => now.getTime() - Date.parse(s.date) >= 10 * DAY);
  return areas.map((a) => ({ ...a, trend: past && a.level !== null && past.levels[a.key] !== undefined ? a.level - past.levels[a.key] : null, since: past?.date || null }));
}

/** The whole review. Resolves to null when there are no repos to look at. */
export async function reviewPractice({ targets, engineering = null, now = new Date(), get = githubGet } = {}) {
  if (!targets?.length) return null;
  const repos = await readActivity({ targets, now, get });
  const areas = recordAndCompare(scoreAreas(repos, engineering), now);
  const measured = areas.filter((a) => a.level !== null);
  const overall = measured.length ? measured.reduce((n, a) => n + a.level, 0) / measured.length : null;
  const actions = candidateActions(areas);
  const facts = [
    ...repos.map((r) => (r.error ? `${r.label}: the pull-request history could not be read: ${r.error}.` : `${r.label}: ${r.prs.length} merged pull requests in 30 days (${r.prs.filter((p) => p.tests).length} touched tests, ${r.prs.filter((p) => p.reviewed).length} reviewed), ${r.commits30} commits of which ${r.rework} fixes or reverts; instructions file ${r.instructionAgeDays === null ? 'not found' : `changed ${r.instructionAgeDays} days ago`}.`)),
    ...areas.map((a) => `Building practice, ${a.name}: ${a.level === null ? 'not measured' : `level ${a.level}/4`} (${a.display}).`),
  ];
  return { repos, areas, overall: overall === null ? null : Math.round(overall * 10) / 10, measured: measured.length, total: areas.length, actions, facts };
}

const bar = (l) => '▰'.repeat(l) + '▱'.repeat(4 - l);

export function renderPractice(p) {
  if (!p) return 'Building practice was not measured: GITHUB_TOKEN is not set, or no repo could be found (set CODE_REVIEW_REPOS to owner/name).';
  const lines = [
    'These measure habits visible in your pull requests and commits, not talent, and not whether the logic is right: a clean record can sit on top of a bug nobody tested for.',
    '',
    p.overall === null ? 'Overall: not enough recent activity to measure.' : `Overall building-practice level ${p.overall}/4 across ${p.measured} of ${p.total} areas.`,
    '',
  ];
  for (const a of p.areas) {
    const t = a.trend === null ? '' : a.trend > 0 ? `  ↑ up ${a.trend} since ${a.since}` : a.trend < 0 ? `  ↓ down ${-a.trend} since ${a.since}` : `  = unchanged since ${a.since}`;
    lines.push(a.level === null ? `  ....  --   ${a.name}: ${a.display}` : `  ${bar(a.level)}  ${a.level}/4  ${a.name}: ${a.display}${t}`);
    lines.push(`        how it is scored: ${a.rule}`);
  }
  if (p.actions.length) {
    lines.push('', 'Candidate actions, weakest area first (from a fixed catalogue; the review turns them into a 30/60/90-day plan):');
    for (const a of p.actions) {
      lines.push(`  ${a.id}  [${a.areaName}, effort ${a.effort}]  ${a.action}`, `        first prompt: ${a.prompt}`, `        it worked when: ${a.target}`);
    }
  }
  return lines.join('\n');
}

/** The actions as the models are shown them, with ids they can cite. */
export function actionsText(p) {
  return (p?.actions || []).map((a) => `[${a.id}] (${a.areaName}, level ${a.level}/4, effort ${a.effort}) ${a.action}. First prompt: ${a.prompt} Success: ${a.target}.`).join('\n');
}

/** KPI rows for the table. Pure. */
export function practiceKpis(p) {
  if (!p) return [];
  const rows = [];
  rows.push({
    name: 'Building-practice level (your habits, from pull requests and commits)',
    display: p.overall === null ? 'not enough recent activity to measure' : `${p.overall}/4 across ${p.measured} of ${p.total} areas`,
    status: p.overall === null ? 'unmeasured' : p.overall >= 3 ? 'on_track' : p.overall >= 2 ? 'watch' : 'behind',
    rule: 'on track at 3 or more, watch at 2',
  });
  for (const a of p.areas) {
    rows.push({
      name: `Practice: ${a.name}`,
      display: `${a.level === null ? '' : `level ${a.level}/4, `}${a.display}${a.trend ? (a.trend > 0 ? ` (up ${a.trend})` : ` (down ${-a.trend})`) : ''}`,
      status: a.level === null ? 'unmeasured' : a.level >= 3 ? 'on_track' : a.level >= 2 ? 'watch' : 'behind',
      rule: a.rule,
    });
  }
  return rows;
}
