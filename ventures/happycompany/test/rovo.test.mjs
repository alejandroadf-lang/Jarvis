import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetOf, createRovoActions } from '../src/rovo.mjs';
import { createApp } from '../src/app.mjs';
import { memoryStore } from '../src/storage.mjs';
import { USE_BAN } from '../src/lib/transparency.mjs';

const quiet = { warn() {}, error() {}, log() {} };
const NOW = '2026-09-30T12:00:00Z';

test('the target: an explicit key or space id first, then the page the person is on; malformed input goes nowhere', () => {
  assert.deepEqual(targetOf({ projectKey: ' ops ' }), { product: 'jira', scope: 'jira:OPS', projectKey: 'OPS' });
  assert.deepEqual(targetOf({ spaceId: '42' }), { product: 'confluence', scope: 'confluence:42', spaceId: '42' });
  assert.deepEqual(targetOf({ context: { jira: { projectKey: 'WEB' } } }), { product: 'jira', scope: 'jira:WEB', projectKey: 'WEB' });
  assert.deepEqual(targetOf({ context: { confluence: { spaceId: 7 } } }), { product: 'confluence', scope: 'confluence:7', spaceId: '7' });
  assert.equal(targetOf({ projectKey: 'OPS" OR 1=1' }), null);
  assert.equal(targetOf({ spaceId: '../1' }), null);
  assert.equal(targetOf({}), null);
});

async function populated() {
  const store = memoryStore();
  const app = createApp({ store, jira: { projectName: async () => 'Operations' }, now: () => new Date(NOW), log: quiet });
  for (let d = 0; d < 5; d++) {
    const day = `2026-09-${21 + d}`;
    for (let p = 0; p < 6; p++) {
      await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: `557058:${p}`, issue: { id: `1${p}`, key: `OPS-${p}`, fields: { updated: `${day}T21:30:00.000Z` } } });
    }
  }
  return { store, app };
}

test('the team action checks the asker can see the project, fails closed, and returns only team figures', async () => {
  const { store, app } = await populated();
  let visible = true;
  const jira = { userCanSeeProject: async () => visible };
  const confluence = { userCanSeeSpace: async () => false };
  const rovo = createRovoActions({ app, jira, confluence, log: quiet });

  const brief = await rovo.teamHealth({ projectKey: 'OPS' });
  assert.equal(brief.team, 'Operations');
  assert.equal(brief.status, 'graded');
  assert.match(brief.grade, /^[A-E]$/);
  assert.ok(brief.dimensions.length === 5);
  assert.ok(brief.changesSuggested.length > 0, 'late-night work suggests a change');
  assert.equal(brief.rules, USE_BAN);
  assert.ok(!JSON.stringify(brief).includes('557058'), 'no account id');

  visible = false;
  assert.match((await rovo.teamHealth({ projectKey: 'OPS' })).says, /not visible to you/);
  assert.match((await rovo.teamHealth({ spaceId: '42' })).says, /not visible to you/);
  assert.match((await rovo.teamHealth({})).says, /Name a Jira project key/);

  // A project the app never counted is described as such, and not added to the nightly run.
  visible = true;
  const before = await store.get('scopes');
  assert.equal((await rovo.teamHealth({ projectKey: 'NEW' })).status, 'not counted');
  assert.deepEqual(await store.get('scopes'), before);
});

test('too few people: the agent is told why nothing is shown', async () => {
  const store = memoryStore();
  const app = createApp({ store, now: () => new Date(NOW), log: quiet });
  await app.onJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: 'u', issue: { id: '1', key: 'OPS-1', fields: { updated: NOW } } });
  const rovo = createRovoActions({ app, jira: { userCanSeeProject: async () => true }, confluence: {}, log: quiet });
  const brief = await rovo.teamHealth({ projectKey: 'OPS' });
  assert.equal(brief.status, 'too few people');
  assert.match(brief.says, /cannot be lowered/);
  assert.equal(brief.grade, undefined);
});

test('a failure inside the app becomes an answer, not an error the agent improvises around', async () => {
  const app = { teamBrief: async () => { throw new Error('kvs down'); } };
  const rovo = createRovoActions({ app, jira: { userCanSeeProject: async () => true }, confluence: {}, log: quiet });
  assert.match((await rovo.teamHealth({ projectKey: 'OPS' })).says, /could not read this team/);
});

test('what we measure: the same text as the tab, with the use ban', () => {
  const rovo = createRovoActions({ app: {}, jira: {}, confluence: {}, log: quiet });
  const w = rovo.whatWeMeasure();
  assert.equal(w.useBan, USE_BAN);
  assert.ok(w.neverMeasured.some((n) => /What anyone writes/.test(n)));
  assert.match(w.minimumGroup, /never lower it/);
});
