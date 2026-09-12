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

const FILE = 'ventures.json';

function load() {
  return readJson(FILE, { ventures: [] });
}

function save(data) {
  writeJson(FILE, data);
}

function findOrThrow(data, id) {
  const venture = data.ventures.find((v) => v.id === id);
  if (!venture) throw new Error('Venture not found');
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
  if (!milestone) throw new Error(`No milestone at index ${index} for "${venture.title}"`);
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
// turn because its reasoning looped. One per day is the deliberate default
// for a venture whose founder didn't pick a number: enough for the daily
// cycle to act every day, not enough for a bad day to compound.
const DEFAULT_MAX_PER_DAY = 1;
const MIN_MS_BETWEEN_ACTIONS = 60 * 1000;

function enforceRateLimits({ entries, timestampKey, scope, label }) {
  const now = Date.now();
  const times = (entries || [])
    .map((entry) => new Date(entry[timestampKey]).getTime())
    .filter((time) => Number.isFinite(time));

  const inWeek = times.filter((time) => time >= now - WEEKLY_CAP_WINDOW_MS).length;
  if (inWeek >= scope.maxPerWeek) {
    throw new Error(`Weekly ${label} cap reached (${scope.maxPerWeek}/week) for this venture.`);
  }

  const maxPerDay = scope.maxPerDay || DEFAULT_MAX_PER_DAY;
  const inDay = times.filter((time) => time >= now - DAILY_CAP_WINDOW_MS).length;
  if (inDay >= maxPerDay) {
    throw new Error(`Daily ${label} cap reached (${maxPerDay}/day) for this venture.`);
  }

  if (times.length > 0 && now - Math.max(...times) < MIN_MS_BETWEEN_ACTIONS) {
    throw new Error(
      `Too soon after the last ${label} — this venture has a ${MIN_MS_BETWEEN_ACTIONS / 1000}s cooldown between real actions.`
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
  const weekly = Math.max(1, Number(maxPerWeek) || 3);
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

export function setDeploymentEnabled(id, enabled) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (!venture.repo) throw new Error('Link a repo before enabling deployments for this venture');
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
export function authorizeDeployment(id, { path }) {
  assertRealActionsAllowed();
  assertInApprovedPlan({ ventureId: id, action: 'deploy_code', target: path });
  const venture = getVenture(id);
  if (!venture) throw new Error('Venture not found');
  if (venture.status !== 'active') throw new Error(`Venture must be active to deploy (is ${venture.status})`);
  if (!venture.repo) throw new Error('No repo linked to this venture yet — the founder needs to link one first.');
  if (!venture.repo.enabled) {
    throw new Error('Deployments are not enabled for this venture yet — the founder needs to turn them on.');
  }
  if (!isPathAllowed(venture.repo, path)) {
    throw new Error(
      `"${path}" is outside the allowed scope (${venture.repo.allowedPaths.join(', ') || 'no paths allowed'}).`
    );
  }
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
  if (!venture) throw new Error('Venture not found');
  if (venture.status !== 'active') throw new Error(`Venture must be active to run checks (is ${venture.status})`);
  if (!venture.repo) throw new Error('No repo linked to this venture yet — the founder needs to link one first.');

  const times = (venture.runs || [])
    .map((run) => new Date(run.startedAt).getTime())
    .filter((time) => Number.isFinite(time));
  if (times.length > 0 && Date.now() - Math.max(...times) < MIN_MS_BETWEEN_RUNS) {
    const waitS = Math.ceil((MIN_MS_BETWEEN_RUNS - (Date.now() - Math.max(...times))) / 1000);
    throw new Error(`Too soon after the last check run — ${waitS}s left on the cooldown.`);
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
  if (!venture.outreach) throw new Error('Set up an outreach scope before enabling it for this venture');
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
  if (!venture) throw new Error('Venture not found');
  if (venture.status !== 'active') throw new Error(`Venture must be active to send outreach (is ${venture.status})`);
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
