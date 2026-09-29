import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodOf, previousPeriod, validateResponse, emptyTally, addToTally, itemMean, cbiScore, publicResults, itemsFor, PULSE_ITEMS, CBI_ITEMS } from '../src/lib/pulse.mjs';
import { spearman, validationSummary } from '../src/lib/validation.mjs';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';

const quiet = { warn() {}, error() {}, log() {} };

test('periods and their predecessors', () => {
  assert.equal(periodOf('2026-09-30', 'monthly'), '2026-09');
  assert.equal(periodOf('2026-09-30', 'quarterly'), '2026-Q3');
  assert.equal(previousPeriod('2026-01'), '2025-12');
  assert.equal(previousPeriod('2026-Q1'), '2025-Q4');
  assert.equal(previousPeriod('2026-Q3'), '2026-Q2');
});

test('the pulse covers all six HSE Management Standards plus a calibration check', () => {
  const standards = new Set(PULSE_ITEMS.map((i) => i.standard));
  for (const s of ['Demands', 'Control', 'Support', 'Relationships', 'Role', 'Change', 'Calibration']) assert.ok(standards.has(s), s);
  assert.equal(itemsFor({ validation: true }).length, PULSE_ITEMS.length + CBI_ITEMS.length);
  assert.equal(CBI_ITEMS.length, 7);
});

test('responses are validated; skipped statements are allowed', () => {
  const items = itemsFor();
  assert.deepEqual(validateResponse({ hours: 2, match: '' }, items), { hours: 2 });
  assert.throws(() => validateResponse({ hours: 6 }, items), /1 to 5/);
  assert.throws(() => validateResponse({ nope: 3 }, items), /unknown statement/);
  assert.throws(() => validateResponse({}, items), /at least one/);
});

test('tallies keep counts only, and the CBI is scored 0–100 with item 4 reversed', () => {
  const t = emptyTally();
  const allHigh = Object.fromEntries(CBI_ITEMS.map((i) => [i.key, i.reverse ? 1 : 5]));
  addToTally(t, allHigh);
  addToTally(t, allHigh);
  assert.equal(t.n, 2);
  assert.deepEqual(t.items.cbi1, [0, 0, 0, 0, 2]);
  assert.equal(cbiScore(t), 100);
  const low = emptyTally();
  addToTally(low, Object.fromEntries(CBI_ITEMS.map((i) => [i.key, i.reverse ? 5 : 1])));
  assert.equal(cbiScore(low), 0);
  assert.equal(itemMean([0, 1, 0, 1, 0]), 3);
  assert.equal(cbiScore(emptyTally()), null);
});

test('results are hidden below the minimum group, per statement too', () => {
  const t = emptyTally();
  for (let i = 0; i < 5; i++) addToTally(t, { hours: 2, ...(i < 3 ? { respect: 5 } : {}) });
  const r = publicResults(t, itemsFor(), 5);
  assert.equal(r.shown, true);
  assert.deepEqual(r.items.map((i) => i.key), ['hours']); // respect had only 3 answers
  assert.equal(publicResults(t, itemsFor(), 6).shown, false);
});

test('Spearman and the validation verdicts', () => {
  assert.equal(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
  assert.match(validationSummary([{ gradeScore: 80, cbi: 20 }]).verdict, /at least 5 teams/);
  const strong = validationSummary([90, 80, 70, 60, 50].map((g, i) => ({ gradeScore: g, cbi: 10 + i * 10 })));
  assert.equal(strong.rho, -1);
  assert.match(strong.verdict, /Strong agreement/);
  const none = validationSummary([90, 80, 70, 60, 50].map((g, i) => ({ gradeScore: g, cbi: 50 - i * 10 })));
  assert.match(none.verdict, /No agreement/);
});

function place(key = 'OPS') {
  return { scope: `jira:${key}`, product: 'jira', projectKey: key };
}

test('answering the pulse: once per person per period, stored only as counts, results only after the period closes', async () => {
  const store = memoryStore();
  let when = '2026-09-10T12:00:00Z';
  const jira = { canAdminister: async () => true };
  const app = createApp({ store, jira, now: () => new Date(when), log: quiet });
  await assert.rejects(app.answerPulse({ ...place(), accountId: 'u1', answers: { hours: 2 } }), /not switched on/);
  await app.saveSettings({ ...place(), settings: { pulse: 'monthly' } });

  for (let i = 0; i < 6; i++) await app.answerPulse({ ...place(), accountId: `557058:${i}`, answers: { hours: 2, respect: 4 } });
  await assert.rejects(app.answerPulse({ ...place(), accountId: '557058:0', answers: { hours: 5 } }), /already answered/);

  const during = await app.teamHealth({ ...place(), accountId: '557058:0' });
  assert.equal(during.pulse.answered, true);
  assert.equal(during.pulse.answersSoFar, 6);
  assert.equal(during.pulse.results.shown, false); // August has no answers; September is still open

  // Nothing stored anywhere links an answer to a person.
  const everything = JSON.stringify([...store.data.entries()]);
  assert.ok(!everything.includes('557058'));
  const voted = await store.get('pulsevoted:jira:OPS:2026-09');
  assert.equal(voted.length, 6);
  assert.deepEqual(Object.keys(await store.get('pulse:jira:OPS:2026-09')).sort(), ['items', 'n']);

  when = '2026-10-02T12:00:00Z';
  const after = await app.teamHealth({ ...place(), accountId: '557058:0' });
  assert.equal(after.pulse.answered, false); // a new period
  assert.equal(after.pulse.closedPeriod, '2026-09');
  assert.equal(after.pulse.results.shown, true);
  assert.equal(after.pulse.results.items.find((i) => i.key === 'hours').mean, 2);

  // The rollup deletes last period's "already answered" list.
  await app.dailyRollup();
  assert.equal(await store.get('pulsevoted:jira:OPS:2026-09'), undefined);
  assert.ok(await store.get('pulse:jira:OPS:2026-09'));
  const log = await app.auditEntries('jira:OPS');
  assert.equal(log.filter((e) => e.event === 'pulse.answer').length, 6);
  assert.ok(log.every((e) => e.by === null && !('answers' in e.detail)));
});

test('a good grade that the team’s pulse contradicts raises a check', async () => {
  const store = memoryStore();
  let when = '2026-09-10T12:00:00Z';
  const app = createApp({ store, jira: { canAdminister: async () => true }, now: () => new Date(when), log: quiet });
  await app.saveSettings({ ...place(), settings: { pulse: 'monthly' } });
  for (let i = 0; i < 6; i++) await app.answerPulse({ ...place(), accountId: `u${i}`, answers: { hours: 1 } });
  when = '2026-10-01T12:00:00Z';
  for (let d = 0; d < 2; d++) for (let p = 0; p < 6; p++) {
    await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: `u${p}`, issue: { key: 'OPS-1', fields: { updated: `2026-09-${29 + d}T10:00:00.000Z` } } });
  }
  const r = await app.teamHealth(place());
  assert.ok(r.current.score >= 70);
  assert.ok(r.checks.some((c) => c.key === 'pulseDisagrees'));
});
