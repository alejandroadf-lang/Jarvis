import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const NOW = '2026-09-30T12:00:00.000Z';

// Six pages of one issue each. Every issue: six people each changed it on a
// weekday of week 38 (14-18 September), plus activity the backfill must not
// take: one change from before the window, one after the app began counting.
function historyPages() {
  return Array.from({ length: 6 }, (_, i) => ({
    issues: [
      {
        id: String(100 + i),
        key: `OPS-${100 + i}`,
        labels: i === 5 ? ['happy-company'] : [], // the app's own digest: skipped
        created: '2026-09-14T09:00:00.000+0000',
        creator: 'creator',
        histories: [
          ...Array.from({ length: 6 }, (_, p) => ({ author: `557058:${p}`, created: `2026-09-${14 + (i % 5)}T10:00:00.000+0000`, items: [{ field: 'status', from: '1', to: '3' }] })),
          { author: '557058:0', created: '2026-09-01T10:00:00.000+0000', items: [] }, // before the window
          { author: '557058:0', created: '2026-09-30T12:30:00.000+0000', items: [] }, // already counted live
        ],
        comments: [{ author: '557058:1', created: '2026-09-16T11:00:00.000+0000' }],
      },
    ],
    nextPageToken: i < 5 ? `p${i + 1}` : null,
  }));
}

function fakeJira({ admin = true } = {}) {
  const pages = historyPages();
  const calls = [];
  return {
    calls,
    canAdminister: async () => admin,
    recentHistory: async (projectKey, { nextPageToken }) => {
      calls.push(nextPageToken);
      return pages[nextPageToken ? Number(nextPageToken.slice(1)) : 0];
    },
  };
}

test('backfill: admins only, Jira only, once per project, and never for a project counted longer than the window', async () => {
  const store = memoryStore();
  const app = createApp({ store, jira: fakeJira({ admin: false }), now: () => new Date(NOW), log: quiet });
  await assert.rejects(app.requestBackfill({ scope: 'jira:OPS', product: 'jira', projectKey: 'OPS' }), /Only project administrators/);
  await assert.rejects(app.requestBackfill({ scope: 'confluence:1', product: 'confluence' }), /only available in Jira/);

  const app2 = createApp({ store, jira: fakeJira(), now: () => new Date(NOW), log: quiet });
  const first = await app2.requestBackfill({ scope: 'jira:OPS', product: 'jira', projectKey: 'OPS', by: '557058:admin' });
  assert.equal(first.cutoff, NOW);
  assert.deepEqual(await app2.requestBackfill({ scope: 'jira:OPS', product: 'jira', projectKey: 'OPS' }), first, 'a second request changes nothing');
  assert.ok((await app2.auditEntries('jira:OPS')).some((e) => e.event === 'backfill.request' && e.by && e.by !== '557058:admin'));

  await store.set('scopes', [{ scope: 'jira:OLD', product: 'jira', firstSeen: '2026-08-01T00:00:00.000Z' }]);
  await assert.rejects(app2.requestBackfill({ scope: 'jira:OLD', product: 'jira', projectKey: 'OLD' }), /more than 21 days/);
});

test('backfill: reads a few pages a night, takes only the window before counting began, and holds weeks until done', async () => {
  const store = memoryStore();
  const jira = fakeJira();
  const app = createApp({ store, jira, now: () => new Date(NOW), log: quiet });
  // The app began counting now: this live event is not history.
  await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: '557058:0', issue: { id: '1', key: 'OPS-1', fields: { updated: NOW } } });
  await app.requestBackfill({ scope: 'jira:OPS', product: 'jira', projectKey: 'OPS' });

  let r = await app.dailyRollup();
  assert.deepEqual(jira.calls, [null, 'p1', 'p2', 'p3', 'p4', 'p5']);
  // Per issue: the creation, six changes and one comment. The out-of-window
  // and after-cutoff changes are not counted.
  assert.equal(r.backfilled, 5 * 8, 'six pages in one night; the sixth is the digest and skipped');
  const state = await store.get('backfill:jira:OPS');
  assert.equal(state.done, true);
  assert.equal(state.issues, 5, 'the digest issue is not counted');
  assert.equal(state.events, 5 * 8);
  assert.ok(await store.get('wk:jira:OPS:2026-W38'), 'the week rolls once history is in');
  assert.ok((await app.auditEntries('jira:OPS')).some((e) => e.event === 'backfill.done' && e.detail.events === 40));
  assert.equal((await app.dailyRollup()).backfilled, 0, 'done means done');

  const health = await app.teamHealth({ scope: 'jira:OPS', product: 'jira' });
  const w38 = health.weeks.find((w) => w.week === '2026-W38');
  assert.equal(w38.suppressed, false, 'six people from history make week 38 visible on day one');
  assert.deepEqual(health.backfill, { status: 'done', issues: 5, events: 40 });
  assert.ok(health.notes.some((n) => n.includes('read from Jira issue history')), 'the team is told');
  const fresh = createApp({ store: memoryStore(), jira: fakeJira(), now: () => new Date(NOW), log: quiet });
  assert.deepEqual((await fresh.teamHealth({ scope: 'jira:NEW', product: 'jira' })).backfill, { status: 'available', days: 21 });
  const noHistory = createApp({ store: memoryStore(), now: () => new Date(NOW), log: quiet });
  assert.equal((await noHistory.teamHealth({ scope: 'jira:NEW', product: 'jira' })).backfill, null);
});

test('backfill: weeks wait while history comes in, but never more than three nights, and a stuck backfill stops', async () => {
  const store = memoryStore();
  let clock = new Date(NOW);
  let fail = true;
  const pages = historyPages();
  const jira = {
    canAdminister: async () => true,
    recentHistory: async (_k, { nextPageToken }) => {
      if (!nextPageToken) return pages[0];
      if (fail) throw new Error('Jira 503');
      return pages[Number(nextPageToken.slice(1))];
    },
  };
  const app = createApp({ store, jira, now: () => clock, log: quiet });
  await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: '557058:0', issue: { id: '1', key: 'OPS-1', fields: { updated: NOW } } });
  await app.requestBackfill({ scope: 'jira:OPS', product: 'jira', projectKey: 'OPS' });

  let r = await app.dailyRollup();
  assert.equal(r.errors[0].step, 'backfill');
  assert.equal(await store.get('wk:jira:OPS:2026-W38'), undefined, 'held while history is still coming in');
  assert.equal((await store.get('backfill:jira:OPS')).issues, 1, 'the page read before the failure is kept');

  // Third night after the request: still held.
  clock = new Date('2026-10-03T12:00:00.000Z');
  r = await app.dailyRollup();
  assert.equal(r.errors.length, 1);
  assert.equal(await store.get('wk:jira:OPS:2026-W38'), undefined);

  // Fourth: the backfill stops with what it has, and weeks roll.
  clock = new Date('2026-10-04T12:00:00.000Z');
  r = await app.dailyRollup();
  const state = await store.get('backfill:jira:OPS');
  assert.equal(state.stopped, true);
  assert.equal(r.errors.length, 0);
  assert.ok(await store.get('wk:jira:OPS:2026-W38'), 'weeks roll again once the backfill has stopped');
  assert.ok((await app.auditEntries('jira:OPS')).some((e) => e.event === 'backfill.stopped'));
  assert.equal((await app.teamHealth({ scope: 'jira:OPS', product: 'jira' })).backfill.status, 'stopped');
});
