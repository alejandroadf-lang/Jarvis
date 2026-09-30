// The KPI table is arithmetic over the company's records with this company's own
// thresholds. Pinned: a KPI with no data says NOT MEASURED (and that is counted),
// thresholds decide the status, the stage follows the ladder, every KPI cites a
// fact, and the email never presents these thresholds as industry benchmarks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let sc;
let kp;
let ventures;
let store;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-kpis-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  sc = await import('../consultant/scorecard.js');
  kp = await import('../consultant/kpis.js');
  ventures = await import('../finance/ventures.js');
  store = await import('../store.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const build = (o = {}) => {
  const now = o.now || new Date();
  const card = sc.buildScorecard({ now, notes: [] });
  return { card, k: kp.buildKpis(card, { now, engineering: o.engineering || null }) };
};
const by = (k, name) => k.kpis.find((x) => x.name.startsWith(name));

test('with nothing recorded most KPIs say NOT MEASURED, and the count is a finding', () => {
  const { k } = build();
  assert.match(k.stage, /^Pre-revenue: building/);
  assert.equal(by(k, 'Reply rate').status, 'unmeasured');
  assert.equal(by(k, 'Agent behaviour evals').status, 'unmeasured');
  assert.equal(by(k, 'API use').status, 'unmeasured');
  assert.equal(by(k, 'Activation').status, 'unmeasured');
  assert.equal(by(k, 'Recurring revenue').status, 'behind');
  assert.ok(k.total - k.measured >= 4);
  const text = kp.renderKpis(k);
  assert.match(text, /cannot be measured yet, which is itself a gap: you cannot steer by a number you do not collect/);
  assert.match(text, /They are not industry benchmarks/);
  assert.match(text, /\[NOT MEASURED\]/);
});

test('revenue, coverage and customers-needed follow from price and pipeline', () => {
  const a = ventures.createVenture({ title: 'Duty of Care', oneLiner: 'x', proposedBy: 'venture_partner' });
  ventures.setPricing(a.id, { currency: 'EUR', floorMonthly: 3500 });
  for (let i = 0; i < 12; i++) ventures.updatePipeline(a.id, { handle: `p${i}`, source: 'https://example.com/list', stage: i === 0 ? 'paying' : 'contacted', dealValueMonthly: 3500 });
  const { k, card } = build();

  const need = by(k, 'Customers the goal needs');
  assert.match(need.display, /Duty of Care: 1 of 24 at EUR 3500\/month/, 'ceil(83,333 / 3,500) = 24');
  assert.equal(need.status, 'watch');
  assert.equal(by(k, 'Recurring revenue').status, 'watch');
  assert.match(by(k, 'Recurring revenue').display, /€3,500 a month, 4% of the €83,333 a month/);
  // open pipeline is 11 x 3,500 = 38,500 against the 6,500 still to find for €10k
  assert.match(by(k, 'Pipeline coverage').display, /5\.9x the €6,500 still to find/);
  assert.equal(by(k, 'Pipeline coverage').status, 'on_track');
  assert.equal(by(k, 'Buyers identified').status, 'on_track');
  assert.equal(k.stage, 'Early revenue');
  assert.ok(k.kpis.every((x) => /^E\d+$/.test(x.evidence) && card.facts.some((f) => f.id === x.evidence)), 'every KPI cites a fact that exists');
});

test('outreach volume, reply rate, activation and evals move status by their thresholds', () => {
  const v = ventures.listVentures()[0];
  for (let i = 0; i < 12; i++) ventures.recordOutreach(v.id, { to: `x${i}@example.com`, subject: 's', body: 'b', triggeredBy: 'interactive', agentId: 'sales' });
  store.writeJson('posthog-circadian.json', { at: new Date().toISOString(), weeks: { this: { app_opened: { devices: 40 }, plan_made: { devices: 20 } }, before: {} }, returning: 12 });
  store.writeJson('evalRuns.json', { runs: [{ at: new Date().toISOString(), startedAt: '2026-10-01', scenarioId: null, ok: true, results: [{ agentId: 'ceo', pass: true }, { agentId: 'cto', pass: true }, { agentId: 'cfo', pass: false }, { agentId: 'cmo', pass: true }] }] });
  const { k } = build();

  assert.equal(by(k, 'Outreach sent').status, 'watch', '12 emails is under the 25 threshold');
  assert.equal(by(k, 'Reply rate').status, 'behind', '12 emails, no replies');
  assert.match(by(k, 'Activation').display, /50% \(20 of 40 devices\)/);
  assert.equal(by(k, 'Activation').status, 'on_track');
  assert.equal(by(k, 'Coming back').status, 'on_track');
  assert.match(by(k, 'Agent behaviour evals').display, /3 of 4 scenarios \(75%\)/);
  assert.equal(by(k, 'Agent behaviour evals').status, 'watch');
});

test('with a code review, delivery KPIs appear; without one they do not', () => {
  assert.ok(!build().k.kpis.some((x) => x.group === 'Delivery'));
  const engineering = {
    level: 3,
    facts: ['repo: 10 source files.'],
    repos: [{ label: 'the company\'s own code', owner: 'me', name: 'jarvis', checklist: [{ key: 'ci', essential: true, present: true }, { key: 'tests', essential: true, present: true }, { key: 'evals', essential: true, present: false }], activity: { merged14: 6, ci: { green: false, failed: 1, pending: 0, total: 5 } } }],
  };
  const { k } = build({ engineering });
  assert.equal(by(k, 'Pull requests merged').status, 'on_track');
  assert.equal(by(k, 'CI passing').status, 'behind');
  assert.match(by(k, 'CI passing').display, /1 failing/);
  assert.equal(by(k, 'Engineering essentials').display, '2 of 3');
  assert.equal(by(k, 'Engineering essentials').status, 'watch');
});

test('KPI health counts only measured KPIs, and the model is given citable ids', () => {
  const { k } = build();
  const measured = k.kpis.filter((x) => x.status !== 'unmeasured');
  const expected = measured.reduce((n, x) => n + ({ on_track: 1, watch: 0.5, behind: 0 })[x.status], 0) / measured.length;
  assert.equal(k.health, expected);
  const facts = kp.kpiFactsText(k);
  assert.match(facts, /^\[K1\] Recurring revenue: /);
  assert.match(facts, /this company's threshold: /);
});

test('a pipeline nobody has been contacted in is never on track, and a price in another currency is marked as not converted', () => {
  // Earlier tests in this file left ventures with contacted deals; only this one should count.
  for (const v of ventures.listVentures().filter((x) => x.status === 'active')) ventures.killVenture(v.id, 'test isolation');
  const a = ventures.createVenture({ title: 'Cold List', oneLiner: 'x', proposedBy: 'venture_partner' });
  ventures.setPricing(a.id, { currency: 'USD', floorMonthly: 29 });
  for (let i = 0; i < 12; i++) ventures.updatePipeline(a.id, { handle: `cold${i}`, source: 'https://example.com/list', stage: 'lead', dealValueMonthly: 3500 });
  const { k } = build();
  const cov = by(k, 'Pipeline coverage');
  assert.match(cov.display, /but nobody has been contacted yet, so none of it is qualified/);
  assert.equal(cov.status, 'watch', 'well over 3x on paper, but every contact is an untouched lead');
  assert.match(by(k, 'Customers the goal needs').display, /at USD 29\/month \(not converted to €\)/);
});
