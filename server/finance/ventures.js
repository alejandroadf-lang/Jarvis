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
