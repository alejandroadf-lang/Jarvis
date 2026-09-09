// Ventures are ideas that made it out of the studio: first logged as a
// `proposed` business case by the Venture Partner agent (see
// server/agents/ideationTeam.js), then `active` once the founder greenlights
// them and the treasury allocates budget (see the /api/ventures/:id/greenlight
// route in index.js).

import { readJson, writeJson } from './store.js';

const FILE = 'ventures.json';

function load() {
  return readJson(FILE, { ventures: [] });
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
    milestones: Array.isArray(milestones)
      ? milestones.map(String)
      : milestones
        ? [String(milestones)]
        : [],
    status: 'proposed',
    createdAt: new Date().toISOString(),
  };
  data.ventures.push(venture);
  writeJson(FILE, data);
  return venture;
}

export function activateVenture(id) {
  const data = load();
  const venture = data.ventures.find((v) => v.id === id);
  if (!venture) throw new Error('Venture not found');
  if (venture.status !== 'proposed') throw new Error(`Venture is already ${venture.status}`);
  venture.status = 'active';
  venture.activatedAt = new Date().toISOString();
  writeJson(FILE, data);
  return venture;
}
