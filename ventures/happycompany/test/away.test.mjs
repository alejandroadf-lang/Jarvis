import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysInRange, updateAway, awayWorkStats, MIN_AWAY_PEOPLE } from '../src/lib/away.mjs';
import { DEFAULT_SETTINGS } from '../src/lib/signals.mjs';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const TODAY = '2026-09-30';

test('ranges: valid dates, in order, not too far back or ahead, not too long', () => {
  assert.deepEqual(daysInRange('2026-10-01', '2026-10-03', TODAY), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.throws(() => daysInRange('2026-10-3', '2026-10-05', TODAY), /YYYY-MM-DD/);
  assert.throws(() => daysInRange('2026-02-30', '2026-03-01', TODAY), /YYYY-MM-DD/);
  assert.throws(() => daysInRange('2026-10-05', '2026-10-01', TODAY), /before the first/);
  assert.throws(() => daysInRange('2026-08-01', '2026-08-02', TODAY), /can no longer be marked/);
  assert.throws(() => daysInRange('2027-12-01', '2027-12-02', TODAY), /up to a year ahead/);
  assert.throws(() => daysInRange('2026-10-01', '2026-12-31', TODAY), /at most 60 days/);
});

test('the stored list: sorted, unique, past retention dropped, capped', () => {
  assert.deepEqual(updateAway(['2026-10-02', '2026-08-01'], { add: ['2026-10-01', '2026-10-02'] }, TODAY), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(updateAway(['2026-10-01', '2026-10-02'], { remove: ['2026-10-01'] }, TODAY), ['2026-10-02']);
  const many = Array.from({ length: 201 }, (_, i) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10));
  assert.throws(() => updateAway([], { add: many }, TODAY), /At most 200 days/);
});

const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
const rowsWith = (activeByDay) => week.map((day) => ({ day, bucket: { people: Object.fromEntries((activeByDay[day] || []).map((p) => [p, { n: 1 }])) } }));

test('the share: away workdays on which the person still worked, weekends ignored, shown only with three people away', () => {
  const away = { a: week.slice(0, 5), b: week.slice(0, 5), c: week }; // c also "away" on the weekend
  const rows = rowsWith({ '2026-09-22': ['a'], '2026-09-24': ['a'], '2026-09-26': ['c'] });
  const s = awayWorkStats(rows, away, week, DEFAULT_SETTINGS);
  assert.deepEqual(s, { awayPeople: 3, awayDays: 15, awayActive: 2, awayWorkShare: 2 / 15 });

  const two = awayWorkStats(rows, { a: away.a, b: away.b }, week, DEFAULT_SETTINGS);
  assert.equal(two.awayPeople, MIN_AWAY_PEOPLE - 1);
  assert.equal(two.awayWorkShare, null, 'with two people away, a share would say who worked');

  // Holidays are rest days too; days not yet counted (the future) are left out.
  const holiday = awayWorkStats(rows, away, week, { ...DEFAULT_SETTINGS, holidays: ['2026-09-21'] });
  assert.equal(holiday.awayDays, 12);
  assert.equal(awayWorkStats(rows.slice(0, 2), away, week, DEFAULT_SETTINGS).awayDays, 6);
});

test('each person sees and changes only their own days, stored under a pseudonym', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: () => new Date(`${TODAY}T12:00:00Z`), log: quiet });
  await app.markAway({ accountId: '557058:alice', from: '2026-10-05', to: '2026-10-09' });
  await app.markAway({ accountId: '557058:bob', from: '2026-10-12', to: '2026-10-12' });
  assert.deepEqual((await app.myAway({ accountId: '557058:alice' })).days, ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepEqual((await app.myAway({ accountId: '557058:bob' })).days, ['2026-10-12']);
  assert.deepEqual((await app.myAway({ accountId: '557058:carol' })).days, []);
  assert.ok(!JSON.stringify([...store.data]).includes('557058'), 'no account id in storage');
  assert.equal((await app.auditEntries('away')).length, 0, 'no audit line says who was away');

  const after = await app.markAway({ accountId: '557058:alice', from: '2026-10-07', to: '2026-10-09', away: false });
  assert.deepEqual(after.days, ['2026-10-05', '2026-10-06']);
  await app.markAway({ accountId: '557058:bob', from: '2026-10-12', to: '2026-10-12', away: false });
  assert.equal([...store.data.keys()].filter((k) => k.startsWith('away:')).length, 1, 'an empty list is deleted');
  await assert.rejects(app.markAway({ accountId: null, from: '2026-10-05', to: '2026-10-05' }), /Sign in/);
});

test('the team card shows work on days marked away, and the nightly run drops old days', async () => {
  const store = memoryStore();
  let clock = new Date('2026-09-28T12:00:00Z');
  const app = createApp({ store, now: () => clock, log: quiet });
  // Week 39 (21–25 September): seven people, three of them marked away all week;
  // person 0 still worked on two of those days.
  for (let p = 0; p < 3; p++) await app.markAway({ accountId: `557058:${p}`, from: '2026-09-21', to: '2026-09-25' });
  // Everyone worked the week before, so all seven are known to the team.
  for (let p = 0; p < 7; p++) await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: `557058:${p}`, issue: { id: `1${p}`, key: `OPS-${p}`, fields: { updated: '2026-09-15T10:00:00.000Z' } } });
  for (let d = 0; d < 5; d++) {
    const day = week[d];
    const active = [3, 4, 5, 6, ...(d === 1 || d === 3 ? [0] : [])];
    for (const p of active) await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: `557058:${p}`, issue: { id: `1${p}`, key: `OPS-${p}`, fields: { updated: `${day}T10:00:00.000Z` } } });
  }
  const team = await app.computeTeam({ scope: 'jira:OPS', product: 'jira' });
  const w39 = team.weeks.find((w) => w.week === '2026-W39');
  const indicator = Object.values(w39.card.dimensions).flatMap((d) => d.indicators).find((i) => i.key === 'awayWorkShare');
  assert.equal(indicator.value, 2 / 15);
  assert.equal(indicator.label, 'Work on days marked away');
  const health = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  assert.ok(health.transparency.rules.some((r) => /seen by you alone/.test(r)));

  clock = new Date('2026-10-20T03:00:00Z');
  await app.dailyRollup();
  assert.equal([...store.data.keys()].filter((k) => k.startsWith('away:')).length, 0, 'days past the 21-day window are gone');
});
