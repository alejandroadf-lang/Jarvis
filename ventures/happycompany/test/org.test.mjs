import { test } from 'node:test';
import assert from 'node:assert/strict';
import { organisationSummary, recoveryEpisodes, strainedStreak, canSeeOrganisation, validateOrgSettings, median } from '../src/features/org.mjs';
import { strainCost, validateCostInputs } from '../src/lib/cost.mjs';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const weeks = (grades) => grades.map((g, i) => ({ week: `2026-W${String(30 + i).padStart(2, '0')}`, grade: g, score: g ? { A: 90, B: 75, C: 60, D: 45, E: 20 }[g] : null }));
const team = (name, grades, extra = {}) => {
  const w = weeks(grades);
  const last = w[w.length - 1];
  return { name, weeks: w, current: { grade: last.grade, score: last.score, hasData: true, suppressed: !last.grade, contributors: last.grade ? 6 : 0 }, completion: { committed: 2, done: 1, closed: 2 }, ...extra };
};

test('recovery episodes and the current strained streak', () => {
  assert.deepEqual(recoveryEpisodes(weeks(['B', 'D', 'E', 'C', 'D', 'B'])), [2, 1]);
  assert.deepEqual(recoveryEpisodes(weeks(['B', 'D', 'D'])), []); // not recovered yet
  assert.equal(strainedStreak(weeks(['B', 'D', null, 'E'])), 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('the summary counts coverage, sustainable share, recovery and action, and never ranks', () => {
  const s = organisationSummary([
    team('Zeta', ['B', 'B', 'D', 'D']),
    team('Alpha', ['C', 'E', 'E', 'E']),
    team('Mid', ['D', 'D', 'C', 'B']),
    team('Tiny', ['C', null]),
    { name: 'Idle', weeks: [], current: { hasData: false }, completion: { committed: 0, done: 0, closed: 0 } },
  ]);
  assert.equal(s.teams, 5);
  assert.equal(s.graded, 3);
  assert.equal(s.suppressed, 1);
  assert.deepEqual(s.grades, { A: 0, B: 1, C: 0, D: 1, E: 1 });
  assert.ok(Math.abs(s.sustainableShare - 1 / 3) < 1e-9);
  assert.equal(s.medianWeeksToRecover, 2);
  // Alphabetical, with how long, and no score or position.
  assert.deepEqual(s.needSupport, [{ name: 'Alpha', weeks: 3 }, { name: 'Zeta', weeks: 2 }]);
  assert.equal(s.strainedPeople, 12);
  assert.ok(!JSON.stringify(s.needSupport).includes('score'));
  assert.ok(Math.abs(s.actionCompletion - 0.5) < 1e-9);
});

test('most improved needs a real rise against the team’s own earlier weeks', () => {
  const s = organisationSummary([team('Up', ['E', 'E', 'D', 'D', 'C', 'B', 'B', 'A'])]);
  assert.equal(s.mostImproved.name, 'Up');
  assert.ok(s.mostImproved.rise >= 10);
  assert.equal(organisationSummary([team('Flat', ['B', 'B', 'B', 'B', 'B', 'B', 'B'])]).mostImproved, null);
});

test('access: administrators, or members of a named group, case-insensitive; nobody else', () => {
  assert.equal(canSeeOrganisation({ isAdmin: true }, {}), true);
  assert.equal(canSeeOrganisation({ isAdmin: false, groups: ['People-Ops'] }, { groups: ['people-ops'] }), true);
  assert.equal(canSeeOrganisation({ isAdmin: false, groups: ['engineering'] }, { groups: ['people-ops'] }), false);
  assert.equal(canSeeOrganisation({}, {}), false);
  assert.deepEqual(validateOrgSettings({ groups: 'hr\n hr \nsafety' }), { groups: ['hr', 'safety'] });
  assert.throws(() => validateOrgSettings({ groups: Array.from({ length: 21 }, (_, i) => `g${i}`) }), /at most 20/);
});

test('the cost estimator shows its arithmetic and refuses nonsense', () => {
  const r = strainCost({ people: 12, salary: 60000, replacementCostShare: 0.5, extraTurnover: 0.05, absenceDays: 3, workingDays: 220 });
  assert.equal(r.turnover, 18000);
  assert.equal(r.absence, Math.round(12 * 3 * (60000 / 220)));
  assert.equal(r.total, r.turnover + r.absence);
  assert.equal(r.formula.length, 2);
  assert.match(r.caveat, /Every assumption above is yours/);
  assert.throws(() => validateCostInputs({ people: 1, salary: -1, replacementCostShare: 0, extraTurnover: 0, absenceDays: 0, workingDays: 220 }), /salary/i);
  assert.throws(() => validateCostInputs({ people: 1, salary: 1, replacementCostShare: 0, extraTurnover: 2, absenceDays: 0, workingDays: 220 }), /between 0 and 1/);
  assert.throws(() => validateCostInputs({ people: 1, salary: 1, replacementCostShare: 0, extraTurnover: 0, absenceDays: 0, workingDays: 0 }), /Working days/);
});

test('the organisation view refuses anyone without access, and only admins may change who has it', async () => {
  const store = memoryStore();
  const jira = { projectName: async (k) => `Project ${k}` };
  const app = createApp({ store, jira, now: () => new Date('2026-09-30T12:00:00Z'), log: quiet });
  for (let p = 0; p < 6; p++) await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: `u${p}`, issue: { key: 'OPS-1', fields: { updated: '2026-09-29T10:00:00.000Z' } } });
  await assert.rejects(app.organisationView({ product: 'jira', viewer: { isAdmin: false, groups: ['hr'] } }), /site administrators and the groups they choose/);
  await assert.rejects(app.saveOrgSettings({ product: 'jira', viewer: { isAdmin: false }, settings: { groups: 'hr' } }), /Only site administrators/);
  await app.saveOrgSettings({ product: 'jira', viewer: { isAdmin: true }, settings: { groups: 'hr' } });
  const view = await app.organisationView({ product: 'jira', viewer: { isAdmin: false, groups: ['hr'] } });
  assert.equal(view.summary.teams, 1);
  assert.equal(view.canConfigure, false);
  assert.equal(view.orgSettings, undefined);
  const est = await app.estimateCost({ product: 'jira', viewer: { isAdmin: true }, inputs: { salary: 1, replacementCostShare: 0, extraTurnover: 0, absenceDays: 0, workingDays: 220 } });
  assert.equal(est.inputs.people, view.summary.strainedPeople);
});
