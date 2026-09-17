// Ventures are ideas that made it out of the studio, logged by the Venture
// Partner agent (see server/agents/ideationTeam.js) and active from the
// moment they're logged.
//
// There is no funding step, because there is no capital to allocate. A
// venture used to be `proposed` until the founder greenlit it and a $100
// seed released a budget in staged tranches — a model that priced the one
// input this company doesn't buy. Agent labour is the work, and its cost is
// model spend, metered and capped in server/spend.js. So nothing here is
// gated on money.
//
// Milestones survive that change and matter more without it: they're the
// only structure left that says whether a venture is actually progressing
// rather than just existing. The CFO reports outcomes against them (see
// report_milestone_progress in server/agents/orgChart.js).
//
// What still requires an explicit human decision is real-world capability —
// a linked repo, an outreach allowlist — granted per venture from the
// Ventures panel and enforced by authorizeDeployment/authorizeOutreach
// below. Becoming active grants a venture none of that.

import { readJson, writeJson } from '../store.js';
import { assertRealActionsAllowed } from '../killSwitch.js';
import { assertInApprovedPlan } from '../dailyPlan.js';
import { assertProbeableUrl } from '../execute/probe.js';
import { requiresConsent } from '../outreachCompliance.js';

const FILE = 'ventures.json';

function load() {
  return readJson(FILE, { ventures: [] });
}

function save(data) {
  writeJson(FILE, data);
}

function findOrThrow(data, id) {
  const venture = data.ventures.find((v) => v.id === id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  return venture;
}

function normalizeMilestones(milestones) {
  const toMilestone = (m) =>
    typeof m === 'string' ? { title: m, status: 'pending' } : { title: String(m?.title || m), status: 'pending' };

  if (Array.isArray(milestones)) return milestones.map(toMilestone);
  if (milestones) return [toMilestone(milestones)];
  return [];
}

export function listVentures() {
  return load().ventures;
}

export function getVenture(id) {
  return load().ventures.find((v) => v.id === id) || null;
}

export function createVenture({
  title,
  oneLiner,
  problem,
  targetCustomer,
  businessModel,
  marketSize,
  pathToMillions,
  agentNativeEdge,
  milestones,
}) {
  const data = load();
  const venture = {
    id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: String(title || 'Untitled venture'),
    oneLiner: String(oneLiner || ''),
    problem: String(problem || ''),
    targetCustomer: String(targetCustomer || ''),
    businessModel: String(businessModel || ''),
    marketSize: String(marketSize || ''),
    pathToMillions: String(pathToMillions || ''),
    // Why an agent-run company wins at this specifically. Required by the
    // propose_venture tool, so it's the studio's answer rather than a
    // rationalisation added later — and it's read back into every agent's
    // context so execution stays pointed at the same edge that justified
    // starting it.
    agentNativeEdge: String(agentNativeEdge || ''),
    milestones: normalizeMilestones(milestones),
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  data.ventures.push(venture);
  save(data);
  return venture;
}

const MILESTONE_STATUSES = ['pending', 'done', 'missed'];

export function setMilestoneStatus(id, index, status, note) {
  if (!MILESTONE_STATUSES.includes(status)) {
    throw new Error(`Invalid milestone status: ${status}. Must be one of ${MILESTONE_STATUSES.join(', ')}`);
  }
  const data = load();
  const venture = findOrThrow(data, id);
  const milestone = venture.milestones[index];
  if (!milestone) throw new Error(`No milestone at index ${index} for "${venture.title}" — valid indexes are 0 to ${venture.milestones.length - 1}.`);
  milestone.status = status;
  milestone.note = note ? String(note) : milestone.note || '';
  milestone.updatedAt = new Date().toISOString();
  save(data);
  return venture;
}

export function killVenture(id, reason) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (venture.status === 'killed') throw new Error('Venture is already killed');
  venture.status = 'killed';
  venture.killedAt = new Date().toISOString();
  venture.killReason = String(reason || '');
  save(data);
  return venture;
}

// Real code deployment (see server/deploy/github.js and actionHandlers.js's
// handleDeployCode) is the one action in this app that reaches outside the
// simulation into a real, live system — an actual commit to an actual repo,
// visible to anyone with access to it, not something a founder can silently
// undo the way killing a venture or denying a tranche can. Rather than a
// per-action approval gate (which would make it no more autonomous than a
// tranche request), the founder grants a bounded scope once via linkRepo()
// and setDeploymentEnabled(), and every deploy inside that scope is
// authorized without asking again — but only inside it: a specific repo the
// founder already created, a path allowlist so an agent can't touch
// arbitrary files, and a weekly cap so a bug in the agent's judgment can't
// spam commits. authorizeDeployment() below is the enforcement point.

// Shared by both real-world action scopes below (deployment, outreach) —
// each enforces its own caps against its own log, but the windows mean the
// same thing either way.
const WEEKLY_CAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

// A weekly cap alone let a single unattended run spend the entire week's
// allowance in one pass — the daily cap is what actually keeps an autonomous
// cycle to a sane pace, and the cooldown catches the tighter failure a cap
// can't see: the same agent firing the same action repeatedly inside one
// turn because its reasoning looped.
//
// The defaults were 1/day and 3/week, chosen when a commit was a rare and
// precious thing. That is the wrong shape for a venture being built: the team
// shipped three files, spent the entire week in an afternoon, and then spent
// five turns failing to commit a fourth — reading "Weekly deployment cap
// reached" as a mechanical fault rather than a wall the founder could move,
// because the message never said so. Three files is not a week's work on a
// product that does not exist yet.
//
// Now: enough to build with, still bounded, and now counting commits rather
// than files (see countableTimes) so a well-structured change is not the
// expensive option. CAPS moves either number in one message.
const DEFAULT_MAX_PER_DAY = 4;
const DEFAULT_MAX_PER_WEEK = 20;
const MIN_MS_BETWEEN_ACTIONS = 60 * 1000;

// One commit is one act, however many files it touched.
//
// The deployment log records a row per path, because "what changed" wants every
// path. The cap asks a different question — how often did the team act — and
// counting rows made a well-structured seven-file commit seven times more
// expensive than the seven sloppy single-file commits it replaced. That
// punishes deploy_changes, which exists to encourage the opposite.
//
// Rows sharing a commitSha collapse to their earliest timestamp. Rows without
// one (an outreach send, an older deployment) each count for themselves.
function countableTimes(entries, timestampKey) {
  const byCommit = new Map();
  const loose = [];
  for (const entry of entries || []) {
    const time = new Date(entry?.[timestampKey]).getTime();
    if (!Number.isFinite(time)) continue;
    const sha = entry?.commitSha;
    if (!sha) {
      loose.push(time);
      continue;
    }
    byCommit.set(sha, Math.min(byCommit.get(sha) ?? Infinity, time));
  }
  return [...loose, ...byCommit.values()];
}

// The same arithmetic enforceRateLimits does, as data rather than as a throw.
//
// readiness.js needs to report every cap at once — "weekly fine, daily spent,
// cooldown clear" — and an authorizer that throws can only ever name the first
// thing it hits. Sharing the computation rather than copying it is what keeps
// the readiness report and the actual gate from disagreeing, which would be
// worse than having no report: a team told it is clear and then refused stops
// believing either.
export function rateLimitState({ entries, timestampKey, scope }) {
  const now = Date.now();
  const times = countableTimes(entries, timestampKey);

  const maxPerWeek = scope?.maxPerWeek ?? 0;
  const maxPerDay = scope?.maxPerDay || DEFAULT_MAX_PER_DAY;
  const inWeek = times.filter((time) => time >= now - WEEKLY_CAP_WINDOW_MS).length;
  const inDay = times.filter((time) => time >= now - DAILY_CAP_WINDOW_MS).length;
  const sinceLast = times.length ? now - Math.max(...times) : Infinity;

  return {
    inWeek,
    maxPerWeek,
    weekOk: inWeek < maxPerWeek,
    inDay,
    maxPerDay,
    dayOk: inDay < maxPerDay,
    cooldownMs: MIN_MS_BETWEEN_ACTIONS,
    cooldownRemainingMs: Math.max(0, MIN_MS_BETWEEN_ACTIONS - sinceLast),
    cooldownOk: sinceLast >= MIN_MS_BETWEEN_ACTIONS,
  };
}

// Exported for readiness.js, which reports the allowlist rather than tripping
// over it.
export function pathAllowed(repo, targetPath) {
  return Boolean(repo) && isPathAllowed(repo, targetPath);
}

function enforceRateLimits({ entries, timestampKey, scope, label }) {
  const now = Date.now();
  const times = countableTimes(entries, timestampKey);

  // Both messages name the way out. Every other gate in this file says what to
  // ask the founder for; these two said only that a number had been reached,
  // and an agent that hits a wall with no door reads it as a fault in itself —
  // which is how five turns went into re-attempting a commit that no amount of
  // re-attempting could land.
  const inWeek = times.filter((time) => time >= now - WEEKLY_CAP_WINDOW_MS).length;
  if (inWeek >= scope.maxPerWeek) {
    throw new Error(
      `Weekly ${label} cap reached (${inWeek} of ${scope.maxPerWeek} this week). ` +
        'The founder raises it with "CAPS <ventureId> <per day> <per week>", or this waits for the window to roll. ' +
        'Re-attempting will not change it.'
    );
  }

  const maxPerDay = scope.maxPerDay || DEFAULT_MAX_PER_DAY;
  const inDay = times.filter((time) => time >= now - DAILY_CAP_WINDOW_MS).length;
  if (inDay >= maxPerDay) {
    throw new Error(
      `Daily ${label} cap reached (${inDay} of ${maxPerDay} today). ` +
        'The founder raises it with "CAPS <ventureId> <per day> <per week>", or this waits for tomorrow. ' +
        'Re-attempting will not change it.'
    );
  }

  if (times.length > 0 && now - Math.max(...times) < MIN_MS_BETWEEN_ACTIONS) {
    throw new Error(
      `Too soon after the last ${label} — this venture has a ${MIN_MS_BETWEEN_ACTIONS / 1000}s cooldown between real actions. ` +
        'Wait it out; this one clears on its own. Do the next piece of work meanwhile rather than retrying.'
    );
  }
}

// Self-service deployment, inside a boundary the founder sets once.
//
// Linking a repo and enabling deploys were founder-only, which made every
// venture wait on a person for something the team could otherwise do in
// seconds. Removing the gate outright would have made the whole scope model
// decorative — an agent that grants itself a scope has no scope.
//
// So the gate moves rather than disappears. The founder names which repos
// are fair game, once, in AUTONOMOUS_DEPLOY_REPOS. Inside that set the CEO
// and CTO link, enable and ship without asking. Outside it, nothing, and no
// amount of reasoning gets past this function.
//
// Empty or unset means no change from before: founder-gated, as it was.
// Autonomy is something you turn on deliberately, not something you get by
// upgrading.
export function autonomousRepos() {
  return (process.env.AUTONOMOUS_DEPLOY_REPOS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function isAutonomyEnabled() {
  return autonomousRepos().length > 0;
}

/**
 * Throws unless the founder has pre-approved this exact repo for self-service.
 * Case-insensitive, because GitHub owners and repo names are.
 */
export function assertRepoIsPreApproved(owner, name, ventureId) {
  assertRealActionsAllowed();
  if (ventureId) {
    assertInApprovedPlan({ ventureId, action: 'link_venture_repo', target: `${owner}/${name}` });
  }
  const allowed = autonomousRepos();
  if (!allowed.length) {
    throw new Error(
      'Self-service deployment is off. The founder links repos and enables deployment, ' +
        'or sets AUTONOMOUS_DEPLOY_REPOS to hand that over.'
    );
  }
  const full = `${String(owner).trim()}/${String(name).trim()}`.toLowerCase();
  if (!allowed.includes(full)) {
    throw new Error(
      `"${full}" is not one of the repos the founder pre-approved (${allowed.join(', ')}). ` +
        'Ask them to add it rather than picking a different one.'
    );
  }
  return full;
}

export function linkRepo(id, { owner, name, branch, allowedPaths, maxPerWeek, maxPerDay }) {
  if (!owner || !name) throw new Error('owner and name are required to link a repo');
  const data = load();
  const venture = findOrThrow(data, id);
  const weekly = Math.max(1, Number(maxPerWeek) || DEFAULT_MAX_PER_WEEK);
  venture.repo = {
    owner: String(owner),
    name: String(name),
    branch: branch ? String(branch) : 'main',
    allowedPaths: Array.isArray(allowedPaths) ? allowedPaths.filter(Boolean).map(String) : [],
    enabled: false,
    maxPerWeek: weekly,
    // A daily cap above the weekly one would never bind, so clamp it.
    maxPerDay: Math.min(weekly, Math.max(1, Number(maxPerDay) || DEFAULT_MAX_PER_DAY)),
  };
  venture.deployments = venture.deployments || [];
  save(data);
  return venture;
}

// Change how often the team may commit, without touching anything else.
//
// Deliberately not "call linkRepo again with new caps": linkRepo resets
// `enabled` to false, so re-linking to raise a cap would silently switch
// deployments off — the founder would raise the limit and the team would
// stop shipping entirely, which is the opposite of the intent and would
// look like the cap change having broken something.
export function setDeploymentCaps(id, { maxPerDay, maxPerWeek }) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (!venture.repo) throw new Error(`Link a repo before setting deployment caps: the founder sends "LINK ${id} <owner/repo>".`);

  const weekly = Math.max(1, Number(maxPerWeek) || venture.repo.maxPerWeek || 3);
  venture.repo.maxPerWeek = weekly;
  // Same clamp as linkRepo: a daily cap above the weekly one never binds.
  venture.repo.maxPerDay = Math.min(weekly, Math.max(1, Number(maxPerDay) || venture.repo.maxPerDay || 1));
  save(data);
  return venture;
}

export function setDeploymentEnabled(id, enabled) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (!venture.repo) throw new Error(`Link a repo before enabling deployments: the founder sends "LINK ${id} <owner/repo>".`);
  venture.repo.enabled = Boolean(enabled);
  save(data);
  return venture;
}

function isPathAllowed(repo, targetPath) {
  return repo.allowedPaths.some(
    (allowed) => targetPath === allowed || targetPath.startsWith(allowed.replace(/\/?$/, '/'))
  );
}

// Throws with a specific, human-readable reason on any scope violation
// rather than silently narrowing the request — the founder set this scope
// deliberately, so a violation should be visible (surfaced back to the
// agent as a failed tool call, and from there to whoever's watching the
// conversation), not quietly no-opped.
//
// The global halt is checked first: when everything is stopped, the reason
// the agent gets back should be "everything is stopped", not whichever
// per-venture rule it would have hit next.
// How many commits may land without anyone finding out whether they work.
//
// run_checks existed and nothing required it, so "the tests pass" was a claim
// an agent could make about code no one had run. Worse, a red run stopped
// nothing: the team could keep committing on top of a broken build, and each
// commit made the eventual diagnosis harder.
//
// The gate is not "check before every commit" — that's impossible, since the
// code has to land before CI can run it. It's "don't go far without looking".
// A shorter leash after a failure, because commits piled on a known-red build
// are the ones most likely to be wrong.
// Read per call rather than frozen at import, matching autonomousRepos() and
// every other env-backed setting in this file. A limit that only takes effect
// after a restart is a limit whose value silently disagrees with the variable
// the founder just changed.
function maxDeploysWithoutChecks() {
  return Math.max(1, Number(process.env.MAX_DEPLOYS_WITHOUT_CHECKS) || 5);
}
function maxDeploysAfterFailure() {
  return Math.max(1, Number(process.env.MAX_DEPLOYS_AFTER_RED) || 3);
}

function lastRun(venture) {
  const runs = venture.runs || [];
  return runs.length ? runs[runs.length - 1] : null;
}

function deploysSinceLastRun(venture) {
  const run = lastRun(venture);
  const since = run ? Date.parse(run.startedAt) : 0;
  // Commits, not rows — the same unit the caps count, and for the same reason.
  // Counting rows made one well-structured seven-file commit read as seven and
  // trip a limit of five on its own, so the tool built to encourage coherent
  // changes was the tool most likely to lock the team out of committing again.
  return countableTimes(
    (venture.deployments || []).filter((d) => Date.parse(d.deployedAt) > since),
    'deployedAt',
  ).length;
}

/**
 * Throws when the team has committed too far without finding out whether the
 * build works. Exported for tests and for the same reason every other rule in
 * this file is enforced here: a prompt asking an agent to check its work is a
 * request, and this is not.
 */
export function assertChecksNotOverdue(venture) {
  const run = lastRun(venture);
  const since = deploysSinceLastRun(venture);
  const red = run && run.conclusion && run.conclusion !== 'success';
  const limit = red ? maxDeploysAfterFailure() : maxDeploysWithoutChecks();

  if (since < limit) return;

  if (red) {
    throw new Error(
      `The last check run on this venture failed (${run.conclusion}) and ${since} commit(s) have landed since ` +
        'without re-running it. Call run_checks now: either the fix worked, or you are building on a broken base ' +
        'and every further commit makes the cause harder to find.'
    );
  }
  throw new Error(
    `${since} commit(s) have landed without running the checks. Call run_checks before committing more — ` +
      '"the tests pass" is not something anyone knows yet.'
  );
}

export function authorizeDeployment(id, { path }) {
  assertRealActionsAllowed();
  assertInApprovedPlan({ ventureId: id, action: 'deploy_code', target: path });
  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  if (venture.status !== 'active') throw new Error(`Venture must be active to deploy (is ${venture.status}). Nothing will change this — a venture that is not active cannot act.`);
  if (!venture.repo) throw new Error('No repo linked to this venture yet — the founder needs to link one first.');
  if (!venture.repo.enabled) {
    throw new Error('Deployments are not enabled for this venture yet — the founder needs to turn them on.');
  }
  if (!isPathAllowed(venture.repo, path)) {
    throw new Error(
      `"${path}" is outside the allowed scope (${venture.repo.allowedPaths.join(', ') || 'no paths allowed'}). ` +
        'Work inside the allowed paths, or ask the founder to widen them with ' +
        `"LINK ${id} ${venture.repo.owner}/${venture.repo.name} <paths>" — naming this exact path.`
    );
  }
  enforceRateLimits({
    entries: venture.deployments,
    timestampKey: 'deployedAt',
    scope: venture.repo,
    label: 'deployment',
  });
  // Last, so a refusal names the interesting reason. Scope and caps are
  // configuration problems; this one is "you don't know if your code works".
  assertChecksNotOverdue(venture);
  return venture;
}

// A multi-file commit is still one deployment, so it passes the same door —
// but the door was built to check one path, and a seven-file change has seven.
// Checking only the first would let six ride in on the seventh's approval.
//
// So: the per-path gates run per path, and the cap runs once, for one commit.
// Running the cap per path was worse than redundant — each call read the same
// pre-commit state and saw room for one, so a changeset larger than the
// headroom was admitted whole and then recorded past the limit. Verified: four
// of headroom admitted a six-file commit and left seven against a cap of five.
export function authorizeDeploymentOfPaths(id, paths) {
  const list = [...new Set((paths || []).filter(Boolean).map(String))];
  if (!list.length) throw new Error('A commit needs at least one file change.');

  assertRealActionsAllowed();
  for (const path of list) assertInApprovedPlan({ ventureId: id, action: 'deploy_code', target: path });

  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  if (venture.status !== 'active') throw new Error(`Venture must be active to deploy (is ${venture.status}). Nothing will change this — a venture that is not active cannot act.`);
  if (!venture.repo) throw new Error('No repo linked to this venture yet — the founder needs to link one first.');
  if (!venture.repo.enabled) {
    throw new Error('Deployments are not enabled for this venture yet — the founder needs to turn them on.');
  }
  for (const path of list) {
    if (!isPathAllowed(venture.repo, path)) {
      throw new Error(
        `"${path}" is outside the allowed scope (${venture.repo.allowedPaths.join(', ') || 'no paths allowed'}). ` +
          'Work inside the allowed paths, or ask the founder to widen them with ' +
          `"LINK ${id} ${venture.repo.owner}/${venture.repo.name} <paths>" — naming this exact path.`
      );
    }
  }
  enforceRateLimits({
    entries: venture.deployments,
    timestampKey: 'deployedAt',
    scope: venture.repo,
    label: 'deployment',
  });
  assertChecksNotOverdue(venture);
  return venture;
}

// Opening a pull request is a real, public write to the founder's repo, so it
// needs the halt, the linked repo, the enabled flag and the path allowlist.
//
// It deliberately does NOT need an approved daily plan, and that is the whole
// design rather than an oversight. A PR is how work gets proposed; requiring
// a pre-approved plan in order to propose something means the only way to
// propose is to have already been approved, which is not a review step, it is
// a deadlock. The founder's answer to "why is the team constantly blocked"
// lives here: a plan gates what lands, a PR is what does not land yet.
//
// A PR also cannot start CI/CD on the deploy branch, cannot overwrite a file
// anyone is running, and is undone by closing a tab. It is the one real-world
// write in this app that is reversible by default.
export function authorizePullRequest(id, { paths }) {
  assertRealActionsAllowed();
  const list = [...new Set((paths || []).filter(Boolean).map(String))];
  if (!list.length) throw new Error('A pull request needs at least one file change.');
  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  if (venture.status !== 'active') throw new Error(`Venture must be active to open a pull request (is ${venture.status}). Nothing will change this — a venture that is not active cannot act.`);
  if (!venture.repo) throw new Error('No repo linked to this venture yet — the founder needs to link one first.');
  if (!venture.repo.enabled) {
    throw new Error('Repo writes are not enabled for this venture yet — the founder needs to turn them on.');
  }
  for (const path of list) {
    if (!isPathAllowed(venture.repo, path)) {
      throw new Error(
        `"${path}" is outside the allowed scope (${venture.repo.allowedPaths.join(', ') || 'no paths allowed'}). ` +
          'Work inside the allowed paths, or ask the founder to widen them with ' +
          `"LINK ${id} ${venture.repo.owner}/${venture.repo.name} <paths>" — naming this exact path.`
      );
    }
  }
  // Rate-limited on its own log rather than against the deploy caps. A team
  // that has to spend its one daily commit to open a PR will stop opening PRs
  // and go back to committing straight to the deploy branch, which is the
  // opposite of what this is for.
  enforceRateLimits({
    entries: venture.pullRequests || [],
    timestampKey: 'openedAt',
    scope: venture.repo,
    label: 'pull request',
  });
  return venture;
}

export function recordPullRequest(id, { number, url, title, branch, paths, triggeredBy, agentId }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.pullRequests = venture.pullRequests || [];
  const entry = {
    number: Number(number) || null,
    url: String(url || ''),
    title: String(title || ''),
    branch: String(branch || ''),
    paths: (paths || []).map(String),
    triggeredBy: triggeredBy === 'daily_cycle' ? 'daily_cycle' : 'interactive',
    agentId: agentId ? String(agentId) : null,
    openedAt: new Date().toISOString(),
  };
  venture.pullRequests.push(entry);
  save(data);
  return { venture, entry };
}

export function listPullRequests(id) {
  return [...(getVenture(id)?.pullRequests || [])].sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}

// Undoing a commit passes every gate a deploy passes except one: it does not
// need to be in the approved plan.
//
// That exception is the point of the function. The paths of a revert are not
// the agent's to choose — they are whatever the commit being undone touched —
// so no plan written this morning could have named them. Gating on the plan
// would therefore mean a bad commit stays live until tomorrow, which inverts
// what the gate is for: a revert shrinks the blast radius of something this
// company already did, it does not open a new one. Every other check still
// applies, including the allowlist, so a commit that reached outside the
// allowed scope cannot be undone through here either — correct, because this
// app did not make that change.
export function authorizeRevert(id, { paths }) {
  assertRealActionsAllowed();
  const list = [...new Set((paths || []).filter(Boolean).map(String))];
  if (!list.length) throw new Error('That commit changed no files, so there is nothing to put back.');
  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  if (venture.status !== 'active') throw new Error(`Venture must be active to revert (is ${venture.status}). Nothing will change this — a venture that is not active cannot act.`);
  if (!venture.repo) throw new Error('No repo linked to this venture yet — the founder needs to link one first.');
  if (!venture.repo.enabled) {
    throw new Error('Repo writes are not enabled for this venture yet — the founder needs to turn them on.');
  }
  for (const path of list) {
    if (!isPathAllowed(venture.repo, path)) {
      throw new Error(
        `That commit touched "${path}", which is outside the allowed scope ` +
          `(${venture.repo.allowedPaths.join(', ') || 'no paths allowed'}) — this app did not make that change ` +
          'and cannot undo it.'
      );
    }
  }
  // Counted against the deploy caps, because it is a commit and the caps exist
  // to bound how much the repo changes in a day. A revert loop is also a real
  // failure mode: two turns disagreeing about a file will undo each other
  // forever, and the cap is what stops it at a cost the founder set.
  enforceRateLimits({
    entries: venture.deployments,
    timestampKey: 'deployedAt',
    scope: venture.repo,
    label: 'deployment',
  });
  return venture;
}

// Running the tests is not deploying, and shares none of its limits: no
// allowlist (a workflow run touches no path), and not counted against the
// deploy caps, because a team that must spend its one daily commit to find
// out whether the last one worked will simply stop checking. What it does
// share is the halt and the requirement that a repo exists — there has to be
// somewhere to run — plus its own cooldown, which is the check that actually
// matters here: an agent whose reasoning loops will re-run a suite forever,
// and a runner costs minutes even when nothing changed.
const MIN_MS_BETWEEN_RUNS = 30 * 1000;

export function authorizeExecution(id) {
  assertRealActionsAllowed();
  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  if (venture.status !== 'active') throw new Error(`Venture must be active to run checks (is ${venture.status}). Nothing will change this — a venture that is not active cannot act.`);
  if (!venture.repo) throw new Error('No repo linked to this venture yet — the founder needs to link one first.');

  const times = (venture.runs || [])
    .map((run) => new Date(run.startedAt).getTime())
    .filter((time) => Number.isFinite(time));
  if (times.length > 0 && Date.now() - Math.max(...times) < MIN_MS_BETWEEN_RUNS) {
    const waitS = Math.ceil((MIN_MS_BETWEEN_RUNS - (Date.now() - Math.max(...times))) / 1000);
    throw new Error(
      `Too soon after the last check run — ${waitS}s left on the cooldown. Wait it out; it clears on its own.`
    );
  }
  return venture;
}

/**
 * Records a run whatever its outcome. A red run is the useful one: it is the
 * evidence that the team saw a failure, and without it "we ran the tests" is
 * only ever the agent's own account of events.
 */
export function recordRun(id, { workflow, runId, url, status, conclusion, failures, triggeredBy, agentId }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.runs = venture.runs || [];
  venture.runs.push({
    startedAt: new Date().toISOString(),
    workflow,
    runId: runId ? String(runId) : null,
    url: url || null,
    status: status || null,
    conclusion: conclusion || null,
    failures: failures || [],
    triggeredBy: triggeredBy || 'interactive',
    agentId: agentId || null,
  });
  save(data);
  return venture;
}

export function listRuns(id) {
  return getVenture(id)?.runs || [];
}

// `triggeredBy` records whether a real deploy happened during a live
// conversation ('interactive') or the unattended daily cycle
// ('daily_cycle') — see dailyMeeting.js's "Full autonomy" note. This is the
// one fact the allowlist/cap don't capture on their own: now that both
// paths can produce the exact same kind of entry, knowing which one fired
// matters for anyone reviewing the log after the fact.
export function recordDeployment(id, { path, message, commitSha, commitUrl, rationale, triggeredBy, agentId }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.deployments = venture.deployments || [];
  const entry = {
    path: String(path),
    message: String(message || ''),
    commitSha: String(commitSha || ''),
    commitUrl: String(commitUrl || ''),
    rationale: String(rationale || ''),
    triggeredBy: triggeredBy === 'daily_cycle' ? 'daily_cycle' : 'interactive',
    // Which agent actually made this commit. Recorded by the runner, never
    // claimed by the agent — the audit trail this app was missing, and the
    // basis for the profit share (see profitShare.js).
    agentId: agentId ? String(agentId) : null,
    deployedAt: new Date().toISOString(),
  };
  venture.deployments.push(entry);
  save(data);
  return { venture, entry };
}

// Real customer email (see actionHandlers.js's handleSendCustomerEmail) is
// the second action that reaches outside the simulation — same scope-grant
// model as deployment, applied to an actual outbound message instead of a
// commit. The founder sets an allowlist of recipients once (an exact
// address, or a whole domain via a leading "@") and a weekly cap;
// authorizeOutreach() below is the enforcement point every send passes
// through, the same shape as authorizeDeployment().

export function linkOutreachScope(id, { allowedRecipients, maxPerWeek, maxPerDay }) {
  const data = load();
  const venture = findOrThrow(data, id);
  const weekly = Math.max(1, Number(maxPerWeek) || 5);
  venture.outreach = {
    allowedRecipients: Array.isArray(allowedRecipients) ? allowedRecipients.filter(Boolean).map(String) : [],
    enabled: false,
    maxPerWeek: weekly,
    maxPerDay: Math.min(weekly, Math.max(1, Number(maxPerDay) || DEFAULT_MAX_PER_DAY)),
  };
  venture.sentEmails = venture.sentEmails || [];
  save(data);
  return venture;
}

export function setOutreachEnabled(id, enabled) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (!venture.outreach) throw new Error(`Set up an outreach scope first: the founder sends "OUTREACH ${id} <emails or @domains>".`);
  venture.outreach.enabled = Boolean(enabled);
  save(data);
  return venture;
}

// An allowed entry starting with "@" matches any address on that domain
// (e.g. "@acme.com" allows "anyone@acme.com"); anything else must match
// exactly — a single named contact, not a whole domain.
function isRecipientAllowed(outreach, to) {
  const address = String(to).toLowerCase();
  return outreach.allowedRecipients.some((allowed) => {
    const normalized = allowed.toLowerCase();
    return normalized.startsWith('@') ? address.endsWith(normalized) : address === normalized;
  });
}

export function authorizeOutreach(id, { to }) {
  assertRealActionsAllowed();
  assertInApprovedPlan({ ventureId: id, action: 'send_customer_email', target: to });
  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  if (venture.status !== 'active') throw new Error(`Venture must be active to send outreach (is ${venture.status}). Nothing will change this — a venture that is not active cannot act.`);
  if (!venture.outreach) {
    throw new Error('No outreach scope set up for this venture yet — the founder needs to set allowed recipients first.');
  }
  if (!venture.outreach.enabled) {
    throw new Error('Outreach is not enabled for this venture yet — the founder needs to turn it on.');
  }
  if (!isRecipientAllowed(venture.outreach, to)) {
    throw new Error(
      `"${to}" is outside the allowed recipients (${venture.outreach.allowedRecipients.join(', ') || 'none allowed'}).`
    );
  }
  // The allowlist says who may be written to. These two say who may not, and
  // they win: an unsubscribe is a legal instruction, not a preference, and a
  // German or Italian address without recorded consent is a fine waiting to
  // be triggered. Neither can be argued past by an agent.
  if (isBlocked(venture, to)) {
    const entry = blockEntry(venture, to);
    throw new Error(
      `"${to}" asked not to be contacted (${entry?.reason || 'blocked'}${entry?.at ? `, ${entry.at.slice(0, 10)}` : ''}). ` +
        'That is final unless the founder lifts it.'
    );
  }
  if (requiresConsent(to) && !hasConsent(venture, to)) {
    throw new Error(
      `"${to}" is in a jurisdiction that requires prior consent for B2B email. The founder records it with ` +
        `CONSENT ${venture.id} ${to} once they have it — there is no other way through.`
    );
  }
  enforceRateLimits({
    entries: venture.sentEmails,
    timestampKey: 'sentAt',
    scope: venture.outreach,
    label: 'outreach',
  });
  return venture;
}

// The outreach log answers "what did we send"; this answers "who is this
// person to us" — the question worth asking *before* drafting rather than
// after. Anthropic's Project Vend landed on the same conclusion the hard
// way: its agent only stopped repeating itself once it had a CRM to consult.
//
// History is derived from the sentEmails log rather than duplicated, so it
// can't drift out of sync with what was actually sent. Notes are the part
// that can't be derived: what the agent learned from a reply, which nothing
// else in this app records. Kept to the most recent few per contact — this
// is working memory for the next email, not an archive.
const NOTES_KEPT_PER_CONTACT = 5;

// What the team learned building this venture, kept where the next turn
// reads it.
//
// Honcho remembers the founder. Nothing remembered the *work*: an agent
// coming back to a venture started from the venture record and whatever is
// in the repo, never from "we tried X and it failed because Y". So the same
// dead end gets walked into twice, and the second walk looks exactly as
// confident as the first.
//
// Scoped to the venture rather than global, and capped, because a learning
// log that grows without limit stops being read — by the model as much as by
// a person.
const MAX_VENTURE_NOTES = 40;

export function recordVentureNote(id, { note, agentId }) {
  if (!note || !String(note).trim()) throw new Error('A note needs something in it.');
  const data = load();
  const venture = findOrThrow(data, id);
  venture.notes = venture.notes || [];
  venture.notes.push({
    at: new Date().toISOString(),
    agentId: agentId || null,
    note: String(note).trim(),
  });
  // Oldest first out: what was learned last week about an API that has since
  // been rewritten is worth less than what was learned an hour ago.
  if (venture.notes.length > MAX_VENTURE_NOTES) {
    venture.notes = venture.notes.slice(-MAX_VENTURE_NOTES);
  }
  save(data);
  return venture.notes[venture.notes.length - 1];
}

export function listVentureNotes(id) {
  return getVenture(id)?.notes || [];
}

export function recordContactNote(id, { email, note }) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) throw new Error('email is required to log a contact note');
  const text = String(note || '').trim();
  if (!text) throw new Error('note is required');

  const data = load();
  const venture = findOrThrow(data, id);
  venture.contactNotes = venture.contactNotes || {};
  const existing = venture.contactNotes[address] || [];
  venture.contactNotes[address] = [...existing, { note: text, at: new Date().toISOString() }].slice(
    -NOTES_KEPT_PER_CONTACT
  );
  save(data);
  return { venture, note: { email: address, note: text } };
}

// --- Consent and the blocklist -------------------------------------------------
//
// See server/outreachCompliance.js for the law. This is the record: who said
// yes, in writing, and who said stop.

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function recordConsent(id, email) {
  const address = normalizeEmail(email);
  if (!address.includes('@')) throw new Error('A consent record needs an email address.');
  const data = load();
  const venture = findOrThrow(data, id);
  venture.consents = venture.consents || {};
  venture.consents[address] = { at: new Date().toISOString() };
  save(data);
  return venture;
}

export function hasConsent(venture, email) {
  return Boolean(venture?.consents?.[normalizeEmail(email)]);
}

export function blockContact(id, email, reason = 'unsubscribed') {
  const address = normalizeEmail(email);
  if (!address.includes('@')) throw new Error('A block needs an email address.');
  const data = load();
  const venture = findOrThrow(data, id);
  venture.blocked = venture.blocked || {};
  // First refusal wins. A second "unsubscribe" does not move the date, and
  // the founder unblocking then re-blocking is two separate acts.
  if (!venture.blocked[address]) venture.blocked[address] = { reason: String(reason), at: new Date().toISOString() };
  save(data);
  return venture;
}

export function unblockContact(id, email) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (venture.blocked) delete venture.blocked[normalizeEmail(email)];
  save(data);
  return venture;
}

export function isBlocked(venture, email) {
  return Boolean(venture?.blocked?.[normalizeEmail(email)]);
}

function blockEntry(venture, email) {
  return venture?.blocked?.[normalizeEmail(email)] || null;
}

// --- Price, in code ------------------------------------------------------------
//
// "Pricing approved" was a sentence in a chat log. Until it is on the venture
// record nothing can compute what one customer is worth, a payment link cannot
// know what to charge, and the usage counters count units nobody has priced.
//
// Hybrid by construction: a monthly floor plus a per-unit rate, which is what
// the vertical-AI cohort converged on while accuracy was still being proven.
// Either half may be zero.
export function setPricing(id, { currency = 'EUR', floorMonthly = 0, unit = '', perUnit = 0 } = {}) {
  const data = load();
  const venture = findOrThrow(data, id);
  const floor = Number(floorMonthly);
  const rate = Number(perUnit);
  if (!Number.isFinite(floor) || floor < 0) throw new Error('floorMonthly must be a number >= 0');
  if (!Number.isFinite(rate) || rate < 0) throw new Error('perUnit must be a number >= 0');
  if (rate > 0 && !String(unit).trim()) throw new Error('A per-unit rate needs a unit name (page, call, document...)');
  venture.pricing = {
    currency: String(currency).toUpperCase().slice(0, 3),
    floorMonthly: floor,
    unit: String(unit || '').trim(),
    perUnit: rate,
    setAt: new Date().toISOString(),
  };
  save(data);
  return venture;
}

export function describePricing(venture) {
  const p = venture?.pricing;
  if (!p) return 'no price set';
  const parts = [];
  if (p.floorMonthly > 0) parts.push(`${p.currency} ${p.floorMonthly.toFixed(2)}/month`);
  if (p.perUnit > 0) parts.push(`${p.currency} ${p.perUnit} per ${p.unit}`);
  return parts.length ? parts.join(' + ') : 'free';
}

// What a customer at a given monthly volume is worth. The number the CFO
// could not compute before there was a price.
export function monthlyValue(venture, units = 0) {
  const p = venture?.pricing;
  if (!p) return 0;
  return p.floorMonthly + p.perUnit * Math.max(0, Number(units) || 0);
}

// --- Where "let's talk" lands --------------------------------------------------
export function setBookingUrl(id, url) {
  const data = load();
  const venture = findOrThrow(data, id);
  const value = String(url || '').trim();
  if (value && !/^https:\/\//.test(value)) throw new Error('The booking link must start with https://');
  venture.bookingUrl = value || null;
  save(data);
  return venture;
}

// --- The pipeline, not the notepad --------------------------------------------
//
// Contact notes are what an agent learned. This is where a deal stands, which
// is a different question with a different shape: a stage, a number, and the
// one thing that happens next.
export const PIPELINE_STAGES = ['lead', 'contacted', 'replied', 'call_booked', 'pilot', 'paying', 'lost'];

export function updatePipeline(id, { email, stage, dealValueMonthly, nextAction }) {
  const address = normalizeEmail(email);
  if (!address.includes('@')) throw new Error('email is required');
  const data = load();
  const venture = findOrThrow(data, id);
  venture.pipeline = venture.pipeline || {};
  const current = venture.pipeline[address] || {};
  const next = { ...current };
  if (stage !== undefined) {
    if (!PIPELINE_STAGES.includes(stage)) throw new Error(`stage must be one of: ${PIPELINE_STAGES.join(', ')}`);
    next.stage = stage;
  }
  if (dealValueMonthly !== undefined) {
    const value = Number(dealValueMonthly);
    if (!Number.isFinite(value) || value < 0) throw new Error('dealValueMonthly must be a number >= 0');
    next.dealValueMonthly = value;
  }
  if (nextAction !== undefined) next.nextAction = String(nextAction || '').trim();
  next.updatedAt = new Date().toISOString();
  venture.pipeline[address] = next;
  save(data);
  return { venture, entry: { email: address, ...next } };
}

export function pipelineSummary(id) {
  const venture = getVenture(id);
  const rows = Object.entries(venture?.pipeline || {});
  const byStage = {};
  let pipelineMonthly = 0;
  let payingMonthly = 0;
  for (const [, entry] of rows) {
    byStage[entry.stage || 'lead'] = (byStage[entry.stage || 'lead'] || 0) + 1;
    const value = entry.dealValueMonthly || 0;
    if (entry.stage === 'paying') payingMonthly += value;
    else if (entry.stage !== 'lost') pipelineMonthly += value;
  }
  return { contacts: rows.length, byStage, pipelineMonthly, payingMonthly };
}

// --- Objectives -----------------------------------------------------------------
//
// In Project Vend the supervisor's one tool was objectives and key results,
// and it was the tool that made the shop profitable. This company had the
// supervisor and not the tool.
export function setObjective(id, { key, target, by, setBy }) {
  const data = load();
  const venture = findOrThrow(data, id);
  const name = String(key || '').trim();
  if (!name) throw new Error('An objective needs a key — the thing being counted.');
  venture.objectives = venture.objectives || [];
  const entry = {
    key: name,
    target: String(target || '').trim(),
    by: String(by || '').trim() || null,
    setBy: setBy ? String(setBy) : null,
    setAt: new Date().toISOString(),
    status: 'open',
  };
  // One live objective per key. Setting it again replaces it, which is how
  // "sell 100 this week" becomes "sell 150 this week" without a graveyard.
  venture.objectives = venture.objectives.filter((o) => !(o.key === name && o.status === 'open'));
  venture.objectives.push(entry);
  save(data);
  return entry;
}

export function listObjectives(id, { openOnly = true } = {}) {
  const all = getVenture(id)?.objectives || [];
  return openOnly ? all.filter((o) => o.status === 'open') : all;
}

export function closeObjective(id, key, status = 'met') {
  const data = load();
  const venture = findOrThrow(data, id);
  let closed = 0;
  for (const o of venture.objectives || []) {
    if (o.key === key && o.status === 'open') {
      o.status = status;
      o.closedAt = new Date().toISOString();
      closed += 1;
    }
  }
  if (closed) save(data);
  return closed;
}

// --- Money that arrived ---------------------------------------------------------
export function recordPayment(id, { amount, currency, customerEmail, kind, reference, agentId }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.payments = venture.payments || [];
  const entry = {
    amount: Number(amount) || 0,
    currency: String(currency || 'EUR'),
    customerEmail: customerEmail ? normalizeEmail(customerEmail) : null,
    kind: kind || 'one_time',
    reference: reference || null,
    agentId: agentId || null,
    paidAt: new Date().toISOString(),
  };
  venture.payments.push(entry);
  // A payer is, by definition, at the paying stage.
  if (entry.customerEmail) {
    venture.pipeline = venture.pipeline || {};
    const current = venture.pipeline[entry.customerEmail] || {};
    venture.pipeline[entry.customerEmail] = { ...current, stage: 'paying', updatedAt: entry.paidAt };
  }
  save(data);
  return { venture, entry };
}

export function listPayments(id) {
  return [...(getVenture(id)?.payments || [])].sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1));
}

// Recognised monthly recurring revenue: subscriptions seen in the last 35
// days, plus what the pipeline says is paying. The number the studio gate
// reads, and the one a million is measured in.
export function monthlyRecurringRevenue() {
  const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
  let mrr = 0;
  for (const venture of load().ventures) {
    if (venture.status !== 'active') continue;
    const seen = new Set();
    for (const p of venture.payments || []) {
      if (p.kind !== 'monthly' || new Date(p.paidAt).getTime() < cutoff) continue;
      const key = p.customerEmail || p.reference;
      if (seen.has(key)) continue;
      seen.add(key);
      mrr += p.amount;
    }
  }
  return mrr;
}

export function listContacts(id) {
  const venture = getVenture(id);
  if (!venture) return [];

  const byAddress = new Map();
  for (const sent of venture.sentEmails || []) {
    const address = String(sent.to || '').toLowerCase();
    if (!address) continue;
    const entry = byAddress.get(address) || { email: address, emailCount: 0, lastSentAt: null, lastSubject: '' };
    entry.emailCount += 1;
    // `>=` rather than `>`: two sends can land in the same millisecond, and
    // the log is append-ordered, so on a tie the later entry is the newer one.
    if (!entry.lastSentAt || sent.sentAt >= entry.lastSentAt) {
      entry.lastSentAt = sent.sentAt;
      entry.lastSubject = sent.subject || '';
    }
    byAddress.set(address, entry);
  }

  // A contact can exist on notes alone — someone the founder or an agent
  // learned something about before anything was ever sent to them.
  for (const [address, notes] of Object.entries(venture.contactNotes || {})) {
    const entry = byAddress.get(address) || { email: address, emailCount: 0, lastSentAt: null, lastSubject: '' };
    entry.notes = notes;
    byAddress.set(address, entry);
  }

  for (const [address, deal] of Object.entries(venture.pipeline || {})) {
    const entry = byAddress.get(address) || { email: address, emailCount: 0, lastSentAt: null, lastSubject: '' };
    entry.pipeline = deal;
    byAddress.set(address, entry);
  }
  for (const [address, block] of Object.entries(venture.blocked || {})) {
    const entry = byAddress.get(address) || { email: address, emailCount: 0, lastSentAt: null, lastSubject: '' };
    entry.blocked = block;
    byAddress.set(address, entry);
  }

  return [...byAddress.values()].sort((a, b) => (a.lastSentAt || '') < (b.lastSentAt || '') ? 1 : -1);
}

// Same `triggeredBy` distinction as recordDeployment — which of the two
// paths that can now both send this exact kind of real email actually did.
export function recordOutreach(id, { to, subject, body, triggeredBy, agentId }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.sentEmails = venture.sentEmails || [];
  const entry = {
    to: String(to),
    subject: String(subject || ''),
    body: String(body || ''),
    triggeredBy: triggeredBy === 'daily_cycle' ? 'daily_cycle' : 'interactive',
    // Same audit trail as recordDeployment's agentId, for the same reason.
    agentId: agentId ? String(agentId) : null,
    sentAt: new Date().toISOString(),
  };
  venture.sentEmails.push(entry);
  save(data);
  return { venture, entry };
}

// --- The other half of a conversation ----------------------------------------
//
// Sending was six functions; receiving was zero. See server/inbox.js for the
// privacy argument — the short version is that the company may only hear from
// someone it has already written to, so the founder's outreach allowlist is
// also the only door into the founder's mailbox.
//
// These three functions are what makes that enforceable from the ventures
// side: who counts as a known sender, where a reply goes, and what came back.

// Every address this company has actually emailed, across every venture.
//
// Derived from the send log rather than from the allowlist itself, and that
// distinction matters: an allowlist of "@acme.com" would make every person at
// Acme a known sender the moment the founder granted the scope, including the
// ones the company never contacted. Deriving from what was sent means the set
// only grows when the company itself acts.
export function outreachRecipients() {
  const addresses = new Set();
  for (const venture of load().ventures) {
    for (const sent of venture.sentEmails || []) {
      const address = String(sent.to || '').trim().toLowerCase();
      if (address) addresses.add(address);
    }
  }
  return addresses;
}

// Which venture was this person written to from? Most recent send wins, so a
// contact who was approached about two ventures answers into the one that
// actually asked them something lately.
export function ventureForRecipient(address) {
  const wanted = String(address || '').trim().toLowerCase();
  if (!wanted) return null;
  let best = null;
  let bestAt = '';
  for (const venture of load().ventures) {
    for (const sent of venture.sentEmails || []) {
      if (String(sent.to || '').trim().toLowerCase() !== wanted) continue;
      if (!best || sent.sentAt >= bestAt) {
        best = venture;
        bestAt = sent.sentAt;
      }
    }
  }
  return best;
}

// Replies are deduped on messageId because a check is not a one-shot: the
// daily cycle runs every morning and the Sales Manager can call check_replies
// mid-turn, so the same message will be seen repeatedly. Recording it twice
// would have the agent answer the same prospect twice, which is exactly the
// failure the contact log exists to prevent.
export function recordReply(id, { from, fromName, subject, body, receivedAt, messageId }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.replies = venture.replies || [];
  const key = String(messageId || '');
  if (key && venture.replies.some((r) => r.messageId === key)) {
    return { venture, entry: null, duplicate: true };
  }
  const entry = {
    messageId: key || null,
    from: String(from || '').toLowerCase(),
    fromName: String(fromName || ''),
    subject: String(subject || ''),
    body: String(body || ''),
    receivedAt: receivedAt || new Date().toISOString(),
    // Unread until an agent has actually been handed it in a turn. This is
    // what lets the daily report say "two replies nobody has read" instead of
    // silently re-listing everything that ever arrived.
    readAt: null,
  };
  venture.replies.push(entry);
  save(data);
  return { venture, entry, duplicate: false };
}

export function listReplies(id, { unreadOnly = false } = {}) {
  const replies = getVenture(id)?.replies || [];
  const filtered = unreadOnly ? replies.filter((r) => !r.readAt) : replies;
  return [...filtered].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

// Marking read is a separate step from listing, so a turn that dies halfway
// through reading its mail doesn't lose the mail.
export function markRepliesRead(id, messageIds) {
  const wanted = new Set((messageIds || []).filter(Boolean).map(String));
  if (!wanted.size) return 0;
  const data = load();
  const venture = findOrThrow(data, id);
  const at = new Date().toISOString();
  let marked = 0;
  for (const reply of venture.replies || []) {
    if (!reply.readAt && wanted.has(String(reply.messageId))) {
      reply.readAt = at;
      marked += 1;
    }
  }
  if (marked) save(data);
  return marked;
}

// Across the whole portfolio — what the daily report needs to know without
// walking every venture itself.
export function unreadReplyCount() {
  let total = 0;
  for (const venture of load().ventures) {
    total += (venture.replies || []).filter((r) => !r.readAt).length;
  }
  return total;
}

// Where the venture is actually deployed, so the team can check its own work.
//
// Founder-set, because the alternative — an agent naming the host — is a
// server-side request forgery primitive (see execute/probe.js). This is the
// grant; there is no separate `enabled` flag, because setting the URL *is* the
// decision and a read-only GET against the founder's own public service is not
// the kind of irreversible act `enabled` exists to double-gate.
//
// Deliberately not in the daily plan either. Plan approval covers things that
// change the world: a commit, an email. Requiring it to *observe* whether the
// last commit worked would put the evidence behind the same door as the action,
// which is how this codebase has repeatedly ended up with a capability nobody
// could reach.
export function setServiceUrl(id, url) {
  const data = load();
  const venture = findOrThrow(data, id);
  // Validated here rather than at the edge so no caller can store a URL that
  // assertProbeableUrl would later refuse — a stored value that fails at probe
  // time is a grant that looks live and is not.
  const origin = assertProbeableUrl(url);
  venture.service = { origin, setAt: new Date().toISOString() };
  venture.probes = venture.probes || [];
  save(data);
  return venture;
}

export function clearServiceUrl(id) {
  const data = load();
  const venture = findOrThrow(data, id);
  delete venture.service;
  save(data);
  return venture;
}

const PROBE_WINDOW_MS = 60_000;
const MAX_PROBES_PER_WINDOW = 6;
// Kept short: this is the evidence for "is it up right now", and a long history
// of health checks is noise nobody reads. The deployment log is the record of
// what changed; this is the record of whether it worked.
const PROBES_KEPT = 10;

/**
 * The origin an agent is allowed to probe for this venture, or a thrown reason.
 *
 * Honours the kill switch: HALT means nothing leaves this server, and a carve-
 * out for "but this one is only a GET" makes that promise something the founder
 * has to reason about instead of rely on.
 *
 * Rate-limited per venture rather than capped per day. A health check is meant
 * to be cheap and repeatable — the thing worth preventing is a retry loop
 * hammering the venture's own service inside one turn, not a team that checks
 * its work often.
 */
export function authorizeProbe(id) {
  assertRealActionsAllowed();
  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found. Check the id against the business context — every active venture is listed there with its id.');
  if (!venture.service?.origin) {
    throw new Error(
      'No service URL is set for this venture, so there is nothing to check. Ask the founder for the deployed URL — ' +
        'you cannot choose it yourself, and a passing CI run is not evidence the service is up.'
    );
  }

  const recent = (venture.probes || []).filter(
    (probe) => Date.now() - Date.parse(probe.at) < PROBE_WINDOW_MS
  );
  if (recent.length >= MAX_PROBES_PER_WINDOW) {
    throw new Error(
      `Already checked ${recent.length} times in the last minute. Something is wrong with the service or with the ` +
        'path you are asking for, and checking again will return the same answer — read the last result instead.'
    );
  }
  return venture.service.origin;
}

export function recordProbe(id, { path, status, ok, ms, agentId }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.probes = venture.probes || [];
  venture.probes.unshift({
    at: new Date().toISOString(),
    path: String(path || '/'),
    status: Number(status) || 0,
    ok: Boolean(ok),
    ms: Number(ms) || 0,
    agentId: agentId || null,
  });
  venture.probes = venture.probes.slice(0, PROBES_KEPT);
  save(data);
  return venture.probes[0];
}

export function listProbes(id) {
  return getVenture(id)?.probes || [];
}
