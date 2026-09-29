import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';
import { USE_BAN } from '../src/lib/transparency.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const dayOf = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const ev = (actor, at, key, extra = {}) => ({ eventType: 'avi:jira:updated:issue', atlassianId: actor, issue: { id: key.replace('-', ''), key, fields: { updated: at } }, ...extra });
const place = { scope: 'jira:OPS', product: 'jira', projectKey: 'OPS' };

async function strainedWeek(app, { people = 6, weeksBack = 0, late = true } = {}) {
  for (let d = 0; d < 5; d++) {
    const day = dayOf(2026, 8, 28 - 7 * weeksBack + d);
    for (let p = 0; p < people; p++) {
      await app.onJiraEvent(ev(`557058:${p}`, `${day}T10:00:00.000Z`, `OPS-${p}`));
      if (late) await app.onJiraEvent(ev(`557058:${p}`, `${day}T23:00:00.000Z`, `OPS-${p}`));
    }
  }
}

function appAt(iso, store = memoryStore()) {
  return { store, app: createApp({ store, now: () => new Date(iso), log: quiet }) };
}

test('the page offers the path to the next grade, the loop, badges and the transparency text', async () => {
  const { app } = appAt('2026-09-30T12:00:00Z');
  await strainedWeek(app);
  const r = await app.teamHealth(place);
  assert.ok(r.current.actions.length >= 1);
  assert.equal(r.path.grade, r.current.grade);
  assert.ok(r.path.levers.length >= 1);
  assert.deepEqual(r.loop.committed, []);
  assert.equal(r.loop.completion.rate, null);
  assert.equal(r.transparency.useBan, USE_BAN);
  assert.match(r.transparency.rules[0], /fewer than 5 active people/);
  assert.ok(Array.isArray(r.badges));
});

test('commit, then close next week: the completion rate and the streak follow', async () => {
  const store = memoryStore();
  let { app } = appAt('2026-09-30T12:00:00Z', store);
  await strainedWeek(app);
  const first = await app.teamHealth(place);
  const keys = first.current.actions.slice(0, 2).map((a) => a.key);
  await app.commitActions({ ...place, keys });
  await assert.rejects(app.commitActions({ ...place, keys: ['reopenRate', 'made-up'] }), /Only this week’s suggestions/);
  const committed = await app.teamHealth(place);
  assert.deepEqual(committed.loop.committed.map((i) => i.key), keys);

  // A week later: last week's actions are waiting to be closed.
  ({ app } = appAt('2026-10-07T12:00:00Z', store));
  await strainedWeek(app, { weeksBack: -1 });
  const next = await app.teamHealth(place);
  assert.equal(next.loop.toClose.length, 1);
  assert.equal(next.loop.toClose[0].week, '2026-W40');
  await app.closeAction({ ...place, week: '2026-W40', key: keys[0], done: true });
  await app.closeAction({ ...place, week: '2026-W40', key: keys[1], done: false });
  await assert.rejects(app.closeAction({ ...place, week: '2026-W40', key: 'reopenRate', done: true }), /was not committed/);
  await assert.rejects(app.closeAction({ ...place, week: '2026-W20', key: keys[0], done: true }), /up to three weeks/);
  const after = await app.teamHealth(place);
  assert.deepEqual(after.loop.completion, { committed: 2, done: 1, closed: 2, rate: 0.5 });
  assert.deepEqual(after.loop.toClose, []);
  assert.equal(after.loop.streak.length, 1);

  // The audit trail records what the team did, and names nobody.
  const log = await app.auditEntries('jira:OPS');
  assert.deepEqual(log.map((e) => e.event), ['actions.commit', 'actions.close', 'actions.close']);
  assert.ok(log.every((e) => e.by === null));
  assert.ok(!JSON.stringify(log).includes('557058'));
});

test('at most three committed actions a week, and nothing to commit without a grade', async () => {
  const { app } = appAt('2026-09-30T12:00:00Z');
  await assert.rejects(app.commitActions({ ...place, keys: ['afterHoursShare'] }), /no grade this week/);
  await strainedWeek(app);
  const r = await app.teamHealth(place);
  await app.commitActions({ ...place, keys: r.current.actions.map((a) => a.key) });
  const again = await app.teamHealth(place);
  assert.ok(again.loop.committed.length <= 3);
});

test('freeze weeks: two a quarter', async () => {
  const store = memoryStore();
  let { app } = appAt('2026-09-30T12:00:00Z', store);
  await app.freezeWeek(place);
  await assert.rejects(app.freezeWeek(place), /at most two weeks a quarter/);
  ({ app } = appAt('2026-10-07T12:00:00Z', store));
  await app.freezeWeek(place);
  ({ app } = appAt('2026-10-14T12:00:00Z', store));
  await assert.rejects(app.freezeWeek(place), /at most two weeks a quarter/);
});

test('a team may raise its own threshold to 10, never lower it below 5, and the change is audited under a pseudonym', async () => {
  const store = memoryStore();
  const jira = { canAdminister: async () => true };
  const app = createApp({ store, jira, now: () => new Date('2026-09-30T12:00:00Z'), log: quiet });
  await strainedWeek(app, { people: 7 });
  assert.equal((await app.teamHealth(place)).current.suppressed, false);
  await assert.rejects(app.saveSettings({ ...place, settings: { minGroup: 4 } }), /minGroup must be a whole number from 5 to 10/);
  await assert.rejects(app.saveSettings({ ...place, settings: { minGroup: 11 } }), /minGroup/);
  await app.saveSettings({ ...place, settings: { minGroup: 8 }, by: '557058:admin' });
  const r = await app.teamHealth(place);
  assert.equal(r.current.suppressed, true);
  assert.equal(r.minGroup, 8);
  assert.match(r.transparency.rules[0], /fewer than 8/);
  const [entry] = await app.auditEntries('jira:OPS');
  assert.equal(entry.event, 'settings.save');
  assert.ok(entry.detail.changed.includes('minGroup'));
  assert.match(entry.by, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(entry).includes('557058'));
});

test('a collapse in late work with steady output raises a check, not an accusation', async () => {
  const store = memoryStore();
  const jira = { statusCategories: async () => ({ 3: 'indeterminate', 10001: 'done' }) };
  const app = createApp({ store, jira, now: () => new Date('2026-09-30T12:00:00Z'), log: quiet });
  const resolve = { changelog: { items: [{ field: 'status', from: '3', to: '10001' }] } };
  // Four weeks with lots of late work and ~10 items resolved a week...
  for (let back = 4; back >= 1; back--) {
    await strainedWeek(app, { weeksBack: back });
    for (let i = 0; i < 10; i++) await app.onJiraEvent(ev('557058:0', `${dayOf(2026, 8, 29 - 7 * back)}T11:00:00.000Z`, `OPS-${100 + i}`, resolve));
  }
  // ...then a week with no late work and the same output.
  await strainedWeek(app, { weeksBack: 0, late: false });
  for (let i = 0; i < 10; i++) await app.onJiraEvent(ev('557058:0', '2026-09-29T11:00:00.000Z', `OPS-${200 + i}`, resolve));
  const r = await app.teamHealth(place);
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].key, 'offHoursDrop');
  assert.match(r.checks[0].text, /well done/);
});
