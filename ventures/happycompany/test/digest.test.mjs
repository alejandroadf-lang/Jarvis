import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDigest, escapeHtml } from '../src/lib/digest.mjs';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';
import { scorecard } from '../src/lib/score.mjs';
import { USE_BAN } from '../src/lib/transparency.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const dayOf = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const ev = (actor, at, key, extra = {}) => ({ eventType: 'avi:jira:updated:issue', atlassianId: actor, issue: { id: key.replace('-', ''), key, fields: { updated: at } }, ...extra });

test('the digest says the grade, the three things and the use ban, and escapes HTML', () => {
  const card = scorecard({ total: 300, contributors: 6, afterHoursShare: 0.3, lateShare: 0.12, weekendShare: 0.02, topShare: 0.2 }, null);
  const d = composeDigest({ teamName: 'Ops <Core>', week: '2026-W40', card, trend: { delta: -6, direction: 'down' }, toClose: [{ week: '2026-W39', items: [{}, {}] }] });
  assert.match(d.title, /^Working conditions, Ops <Core>, week 2026-W40: [A-E] \(\d+\/100\)$/);
  assert.ok(d.paragraphs.some((p) => /worsening \(-6/.test(p)));
  assert.ok(d.paragraphs.some((p) => p.startsWith('• ')));
  assert.ok(d.paragraphs.some((p) => /2 committed actions are waiting/.test(p)));
  assert.ok(d.paragraphs.at(-1).includes(USE_BAN));
  assert.ok(d.html.includes('Ops &lt;Core&gt;') || !d.html.includes('<Core>'));
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  assert.equal(composeDigest({ teamName: 'x', week: 'w', card: null }), null);
});

async function busyWeek(app, weekStart, people = 6) {
  for (let d = 0; d < 5; d++) {
    const day = dayOf(2026, 8, weekStart + d);
    for (let p = 0; p < people; p++) {
      await app.onJiraEvent(ev(`557058:${p}`, `${day}T10:00:00.000Z`, `OPS-${p}`));
      await app.onJiraEvent(ev(`557058:${p}`, `${day}T23:00:00.000Z`, `OPS-${p}`));
    }
  }
}

function fakeJira() {
  const posts = [];
  return {
    posts,
    selfAccountId: async () => 'app-account',
    projectName: async (k) => `Project ${k}`,
    postDigest: async (projectKey, body) => {
      posts.push({ projectKey, ...body });
      return { id: `OPS-9${posts.length}` };
    },
  };
}

test('the digest is off by default, posts the completed week once when on, and waits for the team’s Monday', async () => {
  const store = memoryStore();
  const jira = fakeJira();
  let when = '2026-09-30T12:00:00Z'; // Wednesday of week 40
  const app = createApp({ store, jira: { ...jira, canAdminister: async () => true }, now: () => new Date(when), log: quiet });
  await busyWeek(app, 21); // week 39
  await busyWeek(app, 28); // week 40

  await app.dailyRollup();
  assert.equal(jira.posts.length, 0); // off by default

  await app.saveSettings({ scope: 'jira:OPS', product: 'jira', projectKey: 'OPS', settings: { digest: 'on' } });
  const s1 = await app.dailyRollup();
  assert.equal(jira.posts.length, 1);
  assert.equal(s1.digests, 1);
  assert.equal(jira.posts[0].projectKey, 'OPS');
  assert.match(jira.posts[0].summary, /Project OPS, week 2026-W39/);
  await app.dailyRollup();
  assert.equal(jira.posts.length, 1); // once per week

  // Sunday 4 October in a team zone where Monday has not come yet: nothing new.
  when = '2026-10-04T12:00:00Z';
  await app.dailyRollup();
  assert.equal(jira.posts.length, 1);
  // Monday 5 October: week 40 is posted.
  when = '2026-10-05T12:00:00Z';
  await app.dailyRollup();
  assert.equal(jira.posts.length, 2);
  assert.match(jira.posts[1].summary, /week 2026-W40/);
  const log = await app.auditEntries('jira:OPS');
  assert.equal(log.filter((e) => e.event === 'digest.post').length, 2);
});

test('the app’s own posts never count as the team’s work', async () => {
  const store = memoryStore();
  const app = createApp({ store, jira: fakeJira(), now: () => new Date('2026-09-30T12:00:00Z'), log: quiet });
  const own = await app.onJiraEvent(ev('app-account', '2026-09-30T10:00:00.000Z', 'OPS-1'));
  assert.equal(own.counted, false);
  const labelled = await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: 'someone', issue: { key: 'OPS-2', fields: { labels: ['happy-company'], updated: '2026-09-30T10:00:00.000Z' } } });
  assert.equal(labelled.counted, false);
  const real = await app.onJiraEvent(ev('someone', '2026-09-30T10:00:00.000Z', 'OPS-3'));
  assert.equal(real.counted, true);
  assert.equal((await store.get('day:jira:OPS:2026-09-30')).total, 1);
});

test('a week too small to show is skipped, not posted', async () => {
  const store = memoryStore();
  const jira = fakeJira();
  const app = createApp({ store, jira: { ...jira, canAdminister: async () => true }, now: () => new Date('2026-09-30T12:00:00Z'), log: quiet });
  await busyWeek(app, 21, 3);
  await app.saveSettings({ scope: 'jira:OPS', product: 'jira', projectKey: 'OPS', settings: { digest: 'on' } });
  await app.dailyRollup();
  assert.equal(jira.posts.length, 0);
  assert.equal((await store.get('digest:jira:OPS:2026-W39')).skipped, 'too few people');
});
