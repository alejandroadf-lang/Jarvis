import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutcomes, outcomeSummary, rankCheck, predictiveCheck, strainGap, OUTCOME_MIN_HEADCOUNT } from '../src/lib/outcomes.mjs';
import { evidenceMarkdown } from '../src/lib/evidence.mjs';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const jira = (keys) => ({ product: 'jira', knownScopes: keys.map((k) => `jira:${k}`) });

test('parsing: header skipped, comma, semicolon with decimal comma, tab; keys case-insensitive', () => {
  const r = parseOutcomes('team,headcount,absence %,leavers\nops,20,4.5,1\nWEB,12,3,', jira(['OPS', 'WEB']));
  assert.deepEqual(r.rows, [
    { scope: 'jira:OPS', headcount: 20, absenceRate: 4.5, leavers: 1 },
    { scope: 'jira:WEB', headcount: 12, absenceRate: 3, leavers: null },
  ]);
  assert.deepEqual(parseOutcomes('Team;Köpfe;Krankenstand;Abgänge\nOPS;20;4,5%;2', jira(['OPS'])).rows[0], { scope: 'jira:OPS', headcount: 20, absenceRate: 4.5, leavers: 2 });
  assert.equal(parseOutcomes('OPS;20;4.5;0', jira(['OPS'])).rows[0].absenceRate, 4.5, 'a dot still works with semicolons');
  assert.equal(parseOutcomes('OPS\t20\t4.56\t0', jira(['OPS'])).rows[0].absenceRate, 4.6, 'stored to one decimal');
  assert.equal(parseOutcomes('123,15,2', { product: 'confluence', knownScopes: ['confluence:123'] }).rows[0].scope, 'confluence:123');
});

test('parsing: small teams are never stored, unknown teams and bad figures are named', () => {
  const r = parseOutcomes(`OPS,${OUTCOME_MIN_HEADCOUNT - 1},10,0\nWEB,30,2,1`, jira(['OPS', 'WEB']));
  assert.deepEqual(r.dropped, ['OPS']);
  assert.deepEqual(r.rows.map((x) => x.scope), ['jira:WEB']);
  assert.ok(!JSON.stringify(r.rows).includes('OPS'));
  assert.throws(() => parseOutcomes('OPS,9,10,0', jira(['OPS'])), /No team with 10 or more/);
  assert.throws(() => parseOutcomes('OPS,20,4,0\nHR,20,4,0', jira(['OPS'])), /does not count HR/);
  assert.throws(() => parseOutcomes('OPS,20,4,0\nops,20,4,0', jira(['OPS'])), /appears twice/);
  assert.throws(() => parseOutcomes('OPS,twenty,4,0', jira(['OPS'])), /Line 1: headcount/);
  assert.throws(() => parseOutcomes('OPS,20,140,0', jira(['OPS'])), /percentage from 0 to 100/);
  assert.throws(() => parseOutcomes('OPS,20,4,21', jira(['OPS'])), /no larger than the headcount/);
  assert.throws(() => parseOutcomes('OPS" OR 1=1,20,4,0', jira(['OPS'])), /not a Jira project key/);
  assert.throws(() => parseOutcomes('', jira(['OPS'])), /Paste one row per team/);
});

test('organisation figures are weighted by headcount', () => {
  const s = outcomeSummary({ quarter: '2026-Q3', rows: [{ scope: 'a', headcount: 30, absenceRate: 2, leavers: 3 }, { scope: 'b', headcount: 10, absenceRate: 6, leavers: 1 }] });
  assert.deepEqual(s, { quarter: '2026-Q3', teams: 2, headcount: 40, absenceRate: 3, quarterlyTurnover: 10 });
  assert.equal(outcomeSummary(null), null);
});

const teams = ['A', 'B', 'C', 'D', 'E', 'F'];
const scoresOf = (means) => Object.fromEntries(teams.map((t, i) => [`jira:${t}`, { mean: means[i], graded: 12, strained: means[i] < 50 ? 10 : 0 }]));
const recordOf = (rates, quarter = '2026-Q4') => ({ quarter, rows: teams.map((t, i) => ({ scope: `jira:${t}`, headcount: 20, absenceRate: rates[i], leavers: i % 2 })) });

test('the check: better grades with less absence, read from the quarter before when there is one', () => {
  const prior = scoresOf([90, 80, 70, 45, 40, 30]);
  const record = recordOf([2, 2.5, 3, 5, 6, 7]);
  assert.deepEqual(rankCheck(prior, record), { teams: 6, rho: -1 });
  assert.deepEqual(rankCheck(prior, { rows: record.rows.slice(0, 4) }), { teams: 4, rho: null });
  const c = predictiveCheck({ quarter: '2026-Q4', sameScores: null, priorScores: prior, record });
  assert.equal(c.quarterBefore.rho, -1);
  assert.match(c.verdict, /less sickness absence/);
  assert.match(predictiveCheck({ quarter: '2026-Q4', sameScores: null, priorScores: null, record }).verdict, /Needs at least 5 teams/);
  assert.match(predictiveCheck({ quarter: 'q', priorScores: scoresOf([30, 40, 45, 70, 80, 90]), record }).verdict, /does not track/);
});

test('the strain gap needs three teams on each side, so no team’s rate can be read off', () => {
  const prior = scoresOf([90, 80, 70, 45, 40, 30]);
  const gap = strainGap(prior, recordOf([2, 2, 2, 6, 6, 6]));
  assert.deepEqual(gap.strained, { teams: 3, absenceRate: 6 });
  assert.deepEqual(gap.sustainable, { teams: 3, absenceRate: 2 });
  assert.equal(gap.suggestedAbsenceDays, 8.8); // 4 points of 220 working days
  assert.match(gap.caveat, /not proof/);
  assert.equal(strainGap(scoresOf([90, 80, 70, 60, 40, 30]), recordOf([2, 2, 2, 2, 6, 6])), null, 'two strained teams: nothing shown');
  assert.equal(strainGap(null, recordOf([2, 2, 2, 6, 6, 6])), null);
});

test('the evidence text carries the outcomes, or says none were imported', () => {
  const base = { title: 'P', organisation: null, generatedAt: '2026-10-02T00:00:00Z', methodVersion: 'x', product: 'jira', weeks: ['2026-W27', '2026-W39'], scope: { teams: 1, teamWeeks: 1, suppressedShare: 0 }, grades: {}, sustainableShare: 1, medianWeeksToRecover: null, needSupport: [], hazards: [], actions: { teams: 0, committed: 0, done: 0, closed: 0, completion: null }, participation: { consultationRecorded: false, pulseTeams: 0, responses: 0, statements: [] }, frameworks: [], iso45001: [], governance: { settingsChanges: 0, switchedOff: [] }, limits: { note: '', notMeasured: [] }, useBan: '' };
  assert.match(evidenceMarkdown({ ...base, outcomes: { absenceRate: 3.1, teams: 6, headcount: 120, quarterlyTurnover: 2.5 } }), /Sickness absence 3.1% across 6 teams and 120 people; 2.5% of people left/);
  assert.match(evidenceMarkdown({ ...base, outcomes: null }), /No absence or leaver figures imported/);
  assert.doesNotMatch(evidenceMarkdown(base), /Outcomes/);
});

test('the import: administrators only, closed quarters only, audited, and nothing per team on the page', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: () => new Date('2027-01-10T09:00:00Z'), log: quiet });
  await store.set('scopes', [...teams, 'G'].map((t) => ({ scope: `jira:${t}`, product: 'jira', firstSeen: '2026-01-01T00:00:00.000Z' })));
  await store.set('qscores:jira:2026-Q3', scoresOf([90, 80, 70, 45, 40, 30]));
  const text = teams.map((t, i) => `${t},20,${[2, 2, 2, 6, 6, 6][i]},${i % 2}`).join('\n');
  const admin = { isAdmin: true };

  await assert.rejects(app.importOutcomes({ product: 'jira', viewer: { isAdmin: false, groups: ['hr'] }, quarter: '2026-Q4', text }), /Only site administrators/);
  await assert.rejects(app.importOutcomes({ product: 'jira', viewer: admin, quarter: '2027-Q1', text }), /has not ended yet/);
  await assert.rejects(app.importOutcomes({ product: 'jira', viewer: admin, quarter: '2023-Q1', text }), /older than the three years/);
  await assert.rejects(app.importOutcomes({ product: 'jira', viewer: admin, quarter: 'Q4', text }), /like 2026-Q3/);

  const r = await app.importOutcomes({ product: 'jira', viewer: admin, quarter: '2026-Q4', text: `${text}\nG,5,30,1`, by: '557058:hr' });
  assert.equal(r.teams, 6);
  assert.deepEqual(r.dropped, ['G'], 'a team of five is refused, not stored');
  assert.equal(r.replaced, false);
  assert.equal((await app.importOutcomes({ product: 'jira', viewer: admin, quarter: '2026-Q4', text })).replaced, true);
  const log = await app.auditEntries('org:jira');
  assert.ok(log.some((e) => e.event === 'outcomes.import' && e.by && e.by !== '557058:hr'));

  await app.saveOrgSettings({ product: 'jira', viewer: admin, settings: { groups: 'hr' } });
  const view = await app.organisationView({ product: 'jira', viewer: { isAdmin: false, groups: ['hr'] } });
  assert.equal(view.outcomes.latest.absenceRate, 4);
  assert.equal(view.outcomes.check.quarterBefore.rho, -0.88); // tied rates: three at 2%, three at 6%
  assert.equal(view.outcomes.gap.suggestedAbsenceDays, 8.8);
  assert.ok(!JSON.stringify(view.outcomes).includes('jira:'), 'no team appears in the outcomes');
});
