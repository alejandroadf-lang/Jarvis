// Ventures are ideas that made it out of the studio: first logged as a
// `proposed` business case by the Venture Partner agent (see
// server/agents/ideationTeam.js), then `active` once the founder greenlights
// them and the treasury allocates budget (see the /api/ventures/:id/greenlight
// route in index.js).
//
// Funding is staged, not a single upfront check: a venture's initial
// `budgetRequested` funds only its first milestone. Beyond that, the CFO
// (see server/agents/orgChart.js) reports milestone outcomes and requests
// follow-on tranches as the founder tells it what actually happened; each
// tranche still needs the founder's approval (see the
// /api/ventures/:id/tranche/* routes) before it hits the treasury — nothing
// here moves budget on its own.

import { readJson, writeJson } from '../store.js';

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
  budgetRequested,
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
    budgetRequested: Math.max(0, Number(budgetRequested) || 0),
    milestones: normalizeMilestones(milestones),
    pendingTranche: null,
    tranches: [],
    status: 'proposed',
    createdAt: new Date().toISOString(),
  };
  data.ventures.push(venture);
  save(data);
  return venture;
}

export function activateVenture(id) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (venture.status !== 'proposed') throw new Error(`Venture is already ${venture.status}`);
  venture.status = 'active';
  venture.activatedAt = new Date().toISOString();
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

export function requestTranche(id, { amount, description }) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('amount must be a positive number');
  }
  const data = load();
  const venture = findOrThrow(data, id);
  if (venture.status !== 'active') {
    throw new Error(`Venture must be active to request a tranche (is ${venture.status})`);
  }
  if (venture.pendingTranche) {
    throw new Error('A tranche request is already pending for this venture');
  }
  venture.pendingTranche = {
    amount: numericAmount,
    description: String(description || ''),
    requestedAt: new Date().toISOString(),
  };
  save(data);
  return venture;
}

export function approveTranche(id) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (!venture.pendingTranche) throw new Error('No pending tranche request for this venture');
  const tranche = { ...venture.pendingTranche, approvedAt: new Date().toISOString() };
  venture.pendingTranche = null;
  venture.tranches.push(tranche);
  save(data);
  return { venture, tranche };
}

export function denyTranche(id) {
  const data = load();
  const venture = findOrThrow(data, id);
  if (!venture.pendingTranche) throw new Error('No pending tranche request for this venture');
  venture.pendingTranche = null;
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
  venture.pendingTranche = null;
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
// each enforces its own weekly cap against its own log, but "a week" means
// the same rolling window either way.
const WEEKLY_CAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function linkRepo(id, { owner, name, branch, allowedPaths, maxPerWeek }) {
  if (!owner || !name) throw new Error('owner and name are required to link a repo');
  const data = load();
  const venture = findOrThrow(data, id);
  venture.repo = {
    owner: String(owner),
    name: String(name),
    branch: branch ? String(branch) : 'main',
    allowedPaths: Array.isArray(allowedPaths) ? allowedPaths.filter(Boolean).map(String) : [],
    enabled: false,
    maxPerWeek: Math.max(1, Number(maxPerWeek) || 3),
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

function deploysInLastWeek(venture) {
  const cutoff = Date.now() - WEEKLY_CAP_WINDOW_MS;
  return (venture.deployments || []).filter((d) => new Date(d.deployedAt).getTime() >= cutoff).length;
}

// Throws with a specific, human-readable reason on any scope violation
// rather than silently narrowing the request — the founder set this scope
// deliberately, so a violation should be visible (surfaced back to the
// agent as a failed tool call, and from there to whoever's watching the
// conversation), not quietly no-opped.
export function authorizeDeployment(id, { path }) {
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
  if (deploysInLastWeek(venture) >= venture.repo.maxPerWeek) {
    throw new Error(`Weekly deployment cap reached (${venture.repo.maxPerWeek}/week) for this venture.`);
  }
  return venture;
}

export function recordDeployment(id, { path, message, commitSha, commitUrl, rationale }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.deployments = venture.deployments || [];
  const entry = {
    path: String(path),
    message: String(message || ''),
    commitSha: String(commitSha || ''),
    commitUrl: String(commitUrl || ''),
    rationale: String(rationale || ''),
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

export function linkOutreachScope(id, { allowedRecipients, maxPerWeek }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.outreach = {
    allowedRecipients: Array.isArray(allowedRecipients) ? allowedRecipients.filter(Boolean).map(String) : [],
    enabled: false,
    maxPerWeek: Math.max(1, Number(maxPerWeek) || 5),
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

function outreachInLastWeek(venture) {
  const cutoff = Date.now() - WEEKLY_CAP_WINDOW_MS;
  return (venture.sentEmails || []).filter((e) => new Date(e.sentAt).getTime() >= cutoff).length;
}

export function authorizeOutreach(id, { to }) {
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
  if (outreachInLastWeek(venture) >= venture.outreach.maxPerWeek) {
    throw new Error(`Weekly outreach cap reached (${venture.outreach.maxPerWeek}/week) for this venture.`);
  }
  return venture;
}

export function recordOutreach(id, { to, subject, body }) {
  const data = load();
  const venture = findOrThrow(data, id);
  venture.sentEmails = venture.sentEmails || [];
  const entry = {
    to: String(to),
    subject: String(subject || ''),
    body: String(body || ''),
    sentAt: new Date().toISOString(),
  };
  venture.sentEmails.push(entry);
  save(data);
  return { venture, entry };
}
