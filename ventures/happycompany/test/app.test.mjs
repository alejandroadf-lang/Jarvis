import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, validateSettings } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';
import { MIN_GROUP } from '../src/lib/privacy.mjs';

const quiet = { warn() {}, error() {}, log() {} };

function jiraEvent(actor, at, key = 'OPS-1') {
  return { eventType: 'avi:jira:updated:issue', atlassianId: actor, issue: { key, fields: { updated: at } } };
}

// `now` is fixed so weeks are stable: Wednesday 2026-09-30, week 40.
const NOW = '2026-09-30T12:00:00Z';
const clock = (iso = NOW) => () => new Date(iso);

test('an event lands in the actor’s local day bucket under a pseudonym', async () => {
  const store = memoryStore();
  const jira = { userTimeZone: async () => 'Asia/Bangkok' };
  const app = createApp({ store, jira, now: clock(), log: quiet });

  const result = await app.onJiraEvent(jiraEvent('557058:abc', '2026-09-28T16:10:00.000Z'));
  assert.deepEqual(result, { counted: true, scope: 'jira:OPS', day: '2026-09-28', hour: 23 });

  const bucket = await store.get('day:jira:OPS:2026-09-28');
  assert.equal(bucket.total, 1);
  assert.equal(bucket.afterHours, 1);
  assert.equal(Object.keys(bucket.byActor).length, 1);
  assert.ok(!JSON.stringify([...store.data.entries()]).includes('557058'));
  assert.deepEqual(await store.get('scopes'), [{ scope: 'jira:OPS', product: 'jira' }]);
  assert.equal((await app.onJiraEvent({ eventType: 'avi:jira:viewed:issue' })).counted, false);
});

test('the time zone lookup is cached and falls back to the team zone', async () => {
  const store = memoryStore();
  let lookups = 0;
  const jira = {
    userTimeZone: async (id) => {
      lookups += 1;
      if (id === 'hidden') return null;
      if (id === 'broken') throw new Error('boom');
      return 'America/New_York';
    },
  };
  const app = createApp({ store, jira, now: clock(), log: quiet });
  await app.onJiraEvent(jiraEvent('u1', '2026-09-28T16:10:00.000Z'));
  await app.onJiraEvent(jiraEvent('u1', '2026-09-28T17:10:00.000Z'));
  assert.equal(lookups, 1);
  // 16:10Z is 12:10 in New York: working hours.
  assert.equal((await store.get('day:jira:OPS:2026-09-28')).afterHours, 0);
  const hidden = await app.onJiraEvent(jiraEvent('hidden', '2026-09-28T23:30:00.000Z'));
  assert.equal(hidden.hour, 23); // team zone is UTC by default
  const broken = await app.onJiraEvent(jiraEvent('broken', '2026-09-28T23:30:00.000Z'));
  assert.equal(broken.hour, 23);
});

test('a Confluence event without a space is looked up, and dropped if that fails', async () => {
  const store = memoryStore();
  const confluence = { spaceIdFor: async ({ contentId }) => (contentId === '31' ? '123' : null) };
  const app = createApp({ store, confluence, now: clock(), log: quiet });
  const ok = await app.onConfluenceEvent({ eventType: 'avi:confluence:created:comment', atlassianId: 'u', comment: { id: '31' } });
  assert.equal(ok.scope, 'confluence:123');
  const lost = await app.onConfluenceEvent({ eventType: 'avi:confluence:created:comment', atlassianId: 'u', comment: { id: '32' } });
  assert.equal(lost.counted, false);
});

async function populate(app, { people, weeks }) {
  // `weeks` full weeks ending with week 40 (Monday 2026-09-28): each person
  // active every weekday at 10:00 UTC, which is working hours in the UTC
  // team zone the defaults use.
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 5; d++) {
      const day = new Date(Date.UTC(2026, 8, 28 - 7 * w + d)).toISOString().slice(0, 10);
      for (let p = 0; p < people; p++) {
        await app.onJiraEvent(jiraEvent(`person-${p}`, `${day}T10:00:00.000Z`));
      }
    }
  }
}

test('team health is suppressed below the minimum group and graded above it', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: clock(), log: quiet });

  await populate(app, { people: MIN_GROUP - 1, weeks: 1 });
  let report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  assert.equal(report.current.suppressed, true);
  assert.equal(report.current.score, null);
  assert.equal(report.current.contributors, MIN_GROUP - 1);

  await populate(app, { people: MIN_GROUP + 1, weeks: 1 });
  report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  assert.equal(report.current.suppressed, false);
  assert.equal(report.current.week, '2026-W40');
  assert.equal(report.current.grade, 'A');
  assert.equal(report.current.dimensions.hours.status, 'good');
  assert.equal(report.weeks.length, 13);
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes('byActor'));
  assert.ok(!serialised.includes('person-'));
});

test('late nights pull the grade down and the trend notices', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: clock(), log: quiet });
  // Five calm weeks, then a hard week (every person, every night).
  await populate(app, { people: 6, weeks: 6 });
  for (let d = 0; d < 5; d++) {
    const day = `2026-09-${28 + d}`.replace('2026-09-31', '2026-10-01').replace('2026-09-32', '2026-10-02');
    for (let p = 0; p < 6; p++) {
      await app.onJiraEvent(jiraEvent(`person-${p}`, `${day}T22:30:00.000Z`));
      await app.onJiraEvent(jiraEvent(`person-${p}`, `${day}T23:30:00.000Z`));
    }
  }
  const report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  assert.equal(report.current.week, '2026-W40');
  // Two of every three actions are after hours: that indicator bottoms out,
  // and the dimension (with a clean weekend) sits at "watch".
  const afterHours = report.current.dimensions.hours.indicators.find((i) => i.key === 'afterHoursShare');
  assert.equal(afterHours.status, 'act');
  assert.equal(afterHours.score, 0);
  assert.equal(report.current.dimensions.hours.status, 'watch');
  assert.equal(report.trend.direction, 'down');
  assert.ok(report.current.score < report.weeks.at(-2).score);
  assert.ok(report.weeks.filter((w) => w.score !== null).length >= 6);
});

test('the daily rollup aggregates completed weeks, snapshots open work and enforces retention', async () => {
  const store = memoryStore();
  const jira = {
    openIssues: async (key) => (key === 'OPS' ? [...Array(10)].map((_, i) => ({ assignee: `p${i % 3}`, overdue: i < 2 })) : []),
  };
  const app = createApp({ store, jira, now: clock(), log: quiet });
  await populate(app, { people: 6, weeks: 2 });
  // Something old enough to be expired, and a stale time zone entry.
  await store.set('day:jira:OPS:2026-08-01', { total: 1, afterHours: 0, weekend: 0, byActor: { x: 1 }, kinds: {} });
  await store.set('wk:jira:OPS:2025-W01', { week: '2025-W01', metrics: { total: 1 } });
  await store.set('tz:old', { zone: 'UTC', until: '2026-01-01' });

  const summary = await app.dailyRollup();
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.weeksRolled, 1); // week 39 is complete; week 40 is in progress
  assert.equal(summary.snapshots, 1);
  const rolled = await store.get('wk:jira:OPS:2026-W39');
  assert.equal(rolled.metrics.contributors, 6);
  assert.equal(rolled.metrics.byActor, undefined);
  assert.equal(await store.get('day:jira:OPS:2026-08-01'), undefined);
  assert.equal(await store.get('wk:jira:OPS:2025-W01'), undefined);
  assert.equal(await store.get('tz:old'), undefined);
  const snapshot = await store.get('wip:jira:OPS:2026-09-30');
  assert.equal(snapshot.openTotal, 10);
  assert.equal(snapshot.people, 3);
  assert.ok(!JSON.stringify(snapshot).includes('p0'));

  // Idempotent: a second run rolls nothing new.
  assert.equal((await app.dailyRollup()).weeksRolled, 0);

  // The page now uses the snapshot for the workload dimension.
  const report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  const overdue = report.current.dimensions.workload.indicators.find((i) => i.key === 'overdueShare');
  assert.equal(overdue.value, 0.2);
  assert.deepEqual(report.current.openWork, { day: '2026-09-30', openTotal: 10, unassigned: 0, people: 3 });
});

test('a rollup failure on one project does not stop the others', async () => {
  const store = memoryStore();
  const jira = {
    openIssues: async (key) => {
      if (key === 'BAD') throw new Error('search exploded');
      return [];
    },
  };
  const app = createApp({ store, jira, now: clock(), log: quiet });
  await app.onJiraEvent(jiraEvent('u', NOW, 'BAD-1'));
  await app.onJiraEvent(jiraEvent('u', NOW, 'OPS-1'));
  const summary = await app.dailyRollup();
  assert.deepEqual(summary.errors, [{ scope: 'jira:BAD', message: 'search exploded' }]);
  assert.equal(summary.snapshots, 1);
});

test('settings are validated, admin-gated in Jira, and change how new activity is classified', async () => {
  const store = memoryStore();
  let admin = false;
  const jira = { canAdminister: async () => admin };
  const app = createApp({ store, jira, now: clock(), log: quiet });
  const place = { scope: 'jira:OPS', product: 'jira', projectKey: 'OPS' };

  await assert.rejects(app.saveSettings({ ...place, settings: { timeZone: 'Asia/Bangkok' } }), /Only project administrators/);
  admin = true;
  await assert.rejects(app.saveSettings({ ...place, settings: { timeZone: 'Nowhere/Land' } }), /timeZone must be an IANA zone/);
  await assert.rejects(app.saveSettings({ ...place, settings: { quietStart: 25 } }), /quietStart/);
  await assert.rejects(app.saveSettings({ ...place, settings: { quietStart: 7, quietEnd: 7 } }), /must differ/);
  await assert.rejects(app.saveSettings({ ...place, settings: { weekendDays: '1,2,3,4' } }), /more than three/);

  const saved = await app.saveSettings({ ...place, settings: { timeZone: 'Asia/Bangkok', quietStart: '19', quietEnd: '8', weekendDays: '5,6' } });
  assert.equal(saved.timeZone, 'Asia/Bangkok');
  assert.deepEqual(saved.weekendDays, [5, 6]);
  assert.equal(saved.quietStart, 19);

  // Friday 12:30 Bangkok is now a weekend day, and 19:30 is after hours.
  await app.onJiraEvent(jiraEvent('u', '2026-10-02T05:30:00.000Z'));
  const bucket = await store.get('day:jira:OPS:2026-10-02');
  assert.equal(bucket.weekend, 1);
  assert.equal(bucket.afterHours, 0);

  // Confluence has no admin check in v1; the validation still applies.
  const conf = createApp({ store, now: clock(), log: quiet });
  await assert.rejects(conf.saveSettings({ scope: 'confluence:1', product: 'confluence', settings: { quietEnd: -1 } }), /quietEnd/);
  assert.deepEqual(validateSettings({}).weekendDays, [6, 0]);
});

test('a page outside a project or space is refused', async () => {
  const app = createApp({ store: memoryStore(), now: clock(), log: quiet });
  await assert.rejects(app.teamHealth({ scope: null }), /only works inside/);
  await assert.rejects(app.saveSettings({ scope: null, settings: {} }), /only works inside/);
});
