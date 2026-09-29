import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, validateSettings } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';
import { MIN_GROUP } from '../src/lib/privacy.mjs';

const quiet = { warn() {}, error() {}, log() {} };

function jiraEvent(actor, at, key = 'OPS-1', extra = {}) {
  return { eventType: 'avi:jira:updated:issue', atlassianId: actor, issue: { id: key.replace('-', ''), key, fields: { updated: at } }, ...extra };
}

// `now` is fixed so weeks are stable: Wednesday 2026-09-30, week 40.
const NOW = '2026-09-30T12:00:00Z';
const clock = (iso = NOW) => () => new Date(iso);
const dayOf = (year, monthIndex, day) => new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);

test('an event lands in the actor’s local day bucket under a pseudonym, with its item hashed', async () => {
  const store = memoryStore();
  const jira = { userTimeZone: async () => 'Asia/Bangkok' };
  const app = createApp({ store, jira, now: clock(), log: quiet });

  const result = await app.onJiraEvent(jiraEvent('557058:abc', '2026-09-28T16:10:00.000Z'));
  assert.deepEqual(result, { counted: true, scope: 'jira:OPS', day: '2026-09-28', hour: 23 });

  const bucket = await store.get('day:jira:OPS:2026-09-28');
  assert.equal(bucket.total, 1);
  assert.equal(bucket.afterHours, 1);
  assert.equal(bucket.late, 1);
  const people = Object.values(bucket.people);
  assert.equal(people.length, 1);
  assert.deepEqual(people[0].hours, [23]);
  assert.equal(people[0].items.length, 1);
  const stored = JSON.stringify([...store.data.entries()]);
  assert.ok(!stored.includes('557058'));
  assert.ok(!stored.includes('OPS1')); // the issue id is hashed too
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

test('status changes across the Done line become resolved and reopened, using a cached status catalogue', async () => {
  const store = memoryStore();
  let fetches = 0;
  const jira = {
    statusCategories: async () => {
      fetches += 1;
      return { 1: 'new', 3: 'indeterminate', 10001: 'done' };
    },
  };
  const app = createApp({ store, jira, now: clock(), log: quiet });
  const change = (from, to) => ({ changelog: { items: [{ field: 'status', from, to }] } });
  await app.onJiraEvent(jiraEvent('u', NOW, 'OPS-1', change('3', '10001')));
  await app.onJiraEvent(jiraEvent('u', NOW, 'OPS-2', change('10001', '3')));
  await app.onJiraEvent(jiraEvent('u', NOW, 'OPS-3', change('1', '3')));
  await app.onJiraEvent(jiraEvent('u', NOW, 'OPS-4', change('3', '999'))); // unknown status: stays an update
  const bucket = await store.get('day:jira:OPS:2026-09-30');
  assert.deepEqual(bucket.kinds, { resolved: 1, reopened: 1, updated: 2 });
  assert.equal(fetches, 1); // once; an unknown id does not refetch again the same day
});

test('a mention lands on the mentioned person and is not an action', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: clock(), log: quiet });
  const r = await app.onJiraEvent({ eventType: 'avi:jira:mentioned:issue', atlassianId: 'author', issue: { key: 'OPS-9' }, mentionedAccountIds: ['a', 'b'], comment: { created: NOW } });
  assert.deepEqual(r, { counted: true, scope: 'jira:OPS', day: '2026-09-30', mentions: 2 });
  const bucket = await store.get('day:jira:OPS:2026-09-30');
  assert.equal(bucket.total, 0);
  assert.deepEqual(
    Object.values(bucket.people).map((p) => p.mentions),
    [1, 1],
  );
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

async function populate(app, { people, weeks, actor = (p) => `557058:${p}` }) {
  // `weeks` full weeks ending with week 40 (Monday 2026-09-28): each person
  // active every weekday at 10:00 UTC on their own issue, which is working
  // hours in the UTC team zone the defaults use.
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 5; d++) {
      const day = dayOf(2026, 8, 28 - 7 * w + d);
      for (let p = 0; p < people; p++) await app.onJiraEvent(jiraEvent(actor(p), `${day}T10:00:00.000Z`, `OPS-${p + 1}`));
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
  assert.deepEqual(report.current.actions, []);
  assert.equal(report.weeks.length, 13);
  assert.equal(report.weeks.filter((w) => w.dimensions).length, 1); // only the current week carries the detail
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes('"people"'));
  assert.ok(!serialised.includes('557058'));
  assert.deepEqual(report.indicatorKeys.slice(0, 2), ['afterHoursShare', 'lateShare']);
});

test('late nights, long days and fragmentation pull the grade down, the trend notices, and the actions say what to do', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: clock(), log: quiet });
  // Five calm weeks, then a hard week: everyone at 08:00, in bursts through
  // the day on many issues, and again at 22:30 and 23:30.
  await populate(app, { people: 6, weeks: 6 });
  for (let d = 0; d < 5; d++) {
    const day = dayOf(2026, 8, 28 + d);
    for (let p = 0; p < 6; p++) {
      for (const hour of ['08', '11', '14', '17', '22', '23']) await app.onJiraEvent(jiraEvent(`557058:${p}`, `${day}T${hour}:30:00.000Z`, `OPS-${hour}${p}`));
    }
  }
  const report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  assert.equal(report.current.week, '2026-W40');
  const hours = report.current.dimensions.hours;
  const by = (key) => hours.indicators.find((i) => i.key === key);
  assert.equal(by('lateShare').status, 'act');
  assert.equal(by('longSpanShare').status, 'act'); // 08:00 to 23:00 every day
  assert.equal(by('weekendShare').status, 'good');
  assert.equal(hours.status, 'act');
  const frag = report.current.dimensions.fragmentation;
  assert.equal(frag.indicators.find((i) => i.key === 'burstyShare').status, 'act');
  assert.equal(frag.indicators.find((i) => i.key === 'itemsMedian').value, 7);
  assert.equal(report.trend.direction, 'down');
  assert.equal(report.current.actions.length, 3);
  assert.ok(report.current.actions.every((a) => a.action.length > 10));
  assert.ok(report.current.score < report.weeks.at(-2).score);
});

test('streaks and rests: a team that works every day is flagged, the people record remembers a week away', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: clock(), log: quiet });
  // Six people, every single day (weekends included) for three weeks.
  for (let back = 20; back >= 0; back--) {
    const day = dayOf(2026, 8, 30 - back);
    for (let p = 0; p < 6; p++) await app.onJiraEvent(jiraEvent(`557058:${p}`, `${day}T10:00:00.000Z`, `OPS-${p}`));
  }
  const report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  const streak = report.current.dimensions.hours.indicators.find((i) => i.key === 'streakShare');
  assert.equal(streak.value, 1);
  assert.equal(streak.status, 'act');
  const rest = report.current.dimensions.hours.indicators.find((i) => i.key === 'noRestShare');
  assert.equal(rest.value, null); // nobody has 90 days of history yet

  // Pretend the people record is old: five of six never rested, one did.
  const record = {};
  const [a, b, c, d, e, f] = Object.keys((await store.get('day:jira:OPS:2026-09-30')).people);
  for (const who of [a, b, c, d, e]) record[who] = { firstSeen: '2026-01-05', lastSeen: '2026-09-30', lastRest: null };
  record[f] = { firstSeen: '2026-01-05', lastSeen: '2026-09-30', lastRest: '2026-08-14' };
  await store.set('people:jira:OPS', record);
  const again = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  const rest2 = again.current.dimensions.hours.indicators.find((i) => i.key === 'noRestShare');
  assert.ok(Math.abs(rest2.value - 5 / 6) < 1e-9);
  assert.equal(rest2.status, 'act');
  assert.match(rest2.action, /vacation with Jira in it/);
});

test('the daily rollup keeps the people record, aggregates completed weeks, snapshots open work and enforces retention', async () => {
  const store = memoryStore();
  const jira = {
    openIssues: async (key) =>
      key === 'OPS'
        ? [...Array(10)].map((_, i) => ({ assignee: `p${i % 3}`, overdue: i < 2, inProgress: i % 2 === 0, high: i < 5, due: i < 6 ? '2026-10-09' : '2026-11-20' }))
        : [],
  };
  const app = createApp({ store, jira, now: clock(), log: quiet });
  await populate(app, { people: 6, weeks: 2 });
  // Something old enough to be expired, and a stale time zone entry.
  await store.set('day:jira:OPS:2026-08-01', { total: 1, afterHours: 0, weekend: 0, byActor: { x: 1 }, kinds: {} });
  await store.set('wk:jira:OPS:2025-W01', { week: '2025-W01', metrics: { total: 1 } });
  await store.set('tz:old', { zone: 'UTC', until: '2026-01-01' });

  const summary = await app.dailyRollup();
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.weeksRolled, 1); // week 39 is complete; week 40 is in progress
  assert.equal(summary.snapshots, 1);
  const rolled = await store.get('wk:jira:OPS:2026-W39');
  assert.equal(rolled.metrics.contributors, 6);
  assert.equal(rolled.metrics.people, undefined);
  assert.equal(rolled.metrics.streakShare, 0);
  assert.equal(await store.get('day:jira:OPS:2026-08-01'), undefined);
  assert.equal(await store.get('wk:jira:OPS:2025-W01'), undefined);
  assert.equal(await store.get('tz:old'), undefined);
  const people = await store.get('people:jira:OPS');
  assert.equal(Object.keys(people).length, 6);
  assert.equal(Object.values(people)[0].firstSeen, '2026-09-21');
  const snapshot = await store.get('wip:jira:OPS:2026-09-30');
  assert.equal(snapshot.openTotal, 10);
  assert.equal(snapshot.people, 3);
  assert.equal(snapshot.highPriorityShare, 0.5);
  assert.equal(snapshot.dueCrunch, 1.2); // two windows, 6 and 4
  assert.ok(!JSON.stringify(snapshot).includes('p0'));

  // Idempotent: a second run rolls nothing new.
  assert.equal((await app.dailyRollup()).weeksRolled, 0);

  // The page now uses the snapshot for workload and deadline pressure.
  const report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  const find = (dim, key) => report.current.dimensions[dim].indicators.find((i) => i.key === key);
  assert.equal(find('workload', 'overdueShare').value, 0.2);
  assert.equal(find('deadline', 'highPriorityShare').status, 'act');
  assert.equal(find('workload', 'wipMean').value, 1.7);
  assert.deepEqual(report.current.openWork, { day: '2026-09-30', openTotal: 10, unassigned: 0, unassignedOverdue: 0, people: 3 });
  assert.ok(report.notes.some((n) => n.includes('No closed sprints')));
  assert.equal(find('workload', 'carryOverShare').value, null);
});

test('sprints are polled once, and the multi-week indicators derive from the weekly metrics', async () => {
  const store = memoryStore();
  let sprintFetches = 0;
  const jira = {
    openIssues: async () => [...Array(10)].map((_, i) => ({ assignee: `p${i % 3}`, overdue: false, inProgress: false, high: false, due: i < 8 ? '2026-10-20' : null })),
    boards: async () => [{ id: '7' }],
    closedSprints: async () => [{ id: '2', startDate: '2026-09-14T00:00:00Z', completeDate: '2026-09-28T09:00:00Z' }],
    sprintIssues: async () => {
      sprintFetches += 1;
      return [
        ...Array.from({ length: 6 }, () => ({ done: true, created: '2026-09-10T00:00:00Z', resolved: '2026-09-20T00:00:00Z' })),
        { done: false, created: '2026-09-10T00:00:00Z', resolved: null },
        { done: false, created: '2026-09-22T00:00:00Z', resolved: null },
      ];
    },
    statusCategories: async () => ({ 1: 'new', 3: 'indeterminate', 10001: 'done' }),
  };
  const app = createApp({ store, jira, now: clock(), log: quiet });

  // Eight calm baseline weeks, then a week with three times the activity,
  // due dates moved on most updates, and more created than resolved.
  await populate(app, { people: 6, weeks: 9 });
  const change = (field, from, to) => ({ changelog: { items: [{ field, from, to }] } });
  for (let d = 0; d < 5; d++) {
    const day = dayOf(2026, 8, 28 + d);
    for (let p = 0; p < 6; p++) {
      await app.onJiraEvent(jiraEvent(`557058:${p}`, `${day}T11:00:00.000Z`, `OPS-${p}`, change('duedate', '2026-10-01', '2026-10-08')));
      await app.onJiraEvent({ eventType: 'avi:jira:created:issue', atlassianId: `557058:${p}`, issue: { id: `9${d}${p}`, key: `OPS-9${d}${p}`, fields: { updated: `${day}T12:00:00.000Z` } } });
      if (p < 2) await app.onJiraEvent(jiraEvent(`557058:${p}`, `${day}T13:00:00.000Z`, `OPS-${p}`, change('status', '3', '10001')));
    }
  }

  const first = await app.dailyRollup();
  assert.equal(first.sprints, 1);
  assert.equal((await app.dailyRollup()).sprints, 0);
  assert.equal(sprintFetches, 1);
  assert.deepEqual(await store.get('sprintsSeen:jira:OPS'), ['2']);

  const report = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  const find = (dim, key) => report.current.dimensions[dim].indicators.find((i) => i.key === key);
  assert.equal(report.current.week, '2026-W40');
  assert.equal(find('workload', 'carryOverShare').value, 0.25);
  assert.equal(find('deadline', 'unplannedShare').value, 0.125);
  assert.ok(find('deadline', 'loadSurge').value >= 2.5, String(find('deadline', 'loadSurge').value));
  assert.equal(find('deadline', 'loadSurge').status, 'act');
  assert.equal(find('workload', 'inflowRatio').value, 3); // 30 created, 10 resolved
  assert.equal(find('deadline', 'dueMoveRate').value, 3.75); // 30 moves over 8 dated items
  // Several indicators bottom out this week; the three actions are the first three at zero.
  assert.equal(report.current.actions.length, 3);
  assert.ok(report.current.actions.some((a) => ['loadSurge', 'dueMoveRate', 'inflowRatio'].includes(a.key)));
  // Earlier weeks have no sprint within the fallback window and no baseline yet.
  assert.ok(report.weeks.length === 13);
  assert.ok(!report.notes.some((n) => n.includes('No closed sprints')));
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
  await assert.rejects(app.saveSettings({ ...place, settings: { holidays: '2026-13-45' } }), /holidays must be dates/);
  await assert.rejects(app.saveSettings({ ...place, settings: { longSpanHours: 4 } }), /longSpanHours/);
  await assert.rejects(app.saveSettings({ ...place, settings: { signals: { nonsense: false } } }), /unknown signal/);

  const saved = await app.saveSettings({
    ...place,
    settings: { timeZone: 'Asia/Bangkok', quietStart: '19', quietEnd: '8', weekendDays: '5,6', holidays: '2026-10-13, 2026-12-05', longSpanHours: '10', signals: { mentionsPerPersonDay: false, reopenRate: true } },
  });
  assert.equal(saved.timeZone, 'Asia/Bangkok');
  assert.deepEqual(saved.weekendDays, [5, 6]);
  assert.deepEqual(saved.holidays, ['2026-10-13', '2026-12-05']);
  assert.equal(saved.quietStart, 19);
  assert.equal(saved.longSpanHours, 10);
  assert.deepEqual(saved.signals, { mentionsPerPersonDay: false });

  // Friday 12:30 Bangkok is now a weekend day, 19:30 is after hours, and the
  // Thai holiday on 13 October counts as a rest day.
  await app.onJiraEvent(jiraEvent('u', '2026-10-02T05:30:00.000Z'));
  const friday = await store.get('day:jira:OPS:2026-10-02');
  assert.equal(friday.weekend, 1);
  assert.equal(friday.afterHours, 0);
  await app.onJiraEvent(jiraEvent('u', '2026-10-13T03:00:00.000Z'));
  assert.equal((await store.get('day:jira:OPS:2026-10-13')).weekend, 1);

  // A switched-off signal is missing from the card.
  await populate(app, { people: 6, weeks: 1 });
  const report = await app.teamHealth(place);
  assert.equal(report.current.dimensions.fragmentation.indicators.some((i) => i.key === 'mentionsPerPersonDay'), false);
  assert.equal(report.current.dimensions.rework.indicators.some((i) => i.key === 'reopenRate'), true);

  // Confluence gates on space administrators the same way.
  let spaceAdmin = false;
  const conf = createApp({ store, confluence: { canAdminister: async () => spaceAdmin }, now: clock(), log: quiet });
  const space = { scope: 'confluence:1', product: 'confluence', spaceId: '1' };
  await assert.rejects(conf.saveSettings({ ...space, settings: { timeZone: 'Europe/Berlin' } }), /Only space administrators/);
  spaceAdmin = true;
  await assert.rejects(conf.saveSettings({ ...space, settings: { quietEnd: -1 } }), /quietEnd/);
  assert.equal((await conf.saveSettings({ ...space, settings: { timeZone: 'Europe/Berlin' } })).timeZone, 'Europe/Berlin');
  assert.deepEqual(validateSettings({}).weekendDays, [6, 0]);
  assert.deepEqual(validateSettings({}).holidays, []);
});

test('a page outside a project or space is refused', async () => {
  const app = createApp({ store: memoryStore(), now: clock(), log: quiet });
  await assert.rejects(app.teamHealth({ scope: null }), /only works inside/);
  await assert.rejects(app.saveSettings({ scope: null, settings: {} }), /only works inside/);
});
