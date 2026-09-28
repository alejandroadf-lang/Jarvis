import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseJiraEvent, normaliseConfluenceEvent, scopeFromExtension, PROJECT_KEY } from '../src/lib/events.mjs';

const received = '2026-09-28T09:00:00.000Z';

test('a Jira issue event becomes actor + time + project', () => {
  const a = normaliseJiraEvent(
    {
      eventType: 'avi:jira:updated:issue',
      atlassianId: '557058:abc',
      issue: { id: '10001', key: 'OPS-42', fields: { updated: '2026-09-28T23:10:00.000+0700', summary: 'secret text' } },
    },
    received,
  );
  assert.deepEqual(a, { product: 'jira', scope: 'jira:OPS', actor: '557058:abc', at: '2026-09-28T23:10:00.000+0700', kind: 'updated' });
  assert.ok(!JSON.stringify(a).includes('secret'));
});

test('a comment event uses the comment time; project comes from fields when present', () => {
  const a = normaliseJiraEvent(
    {
      eventType: 'avi:jira:commented:issue',
      atlassianId: 'u',
      issue: { key: 'OPS-42', fields: { project: { key: 'CORE' }, updated: '2026-01-01T00:00:00.000Z' } },
      comment: { created: '2026-09-28T08:00:00.000Z' },
    },
    received,
  );
  assert.equal(a.scope, 'jira:CORE');
  assert.equal(a.at, '2026-09-28T08:00:00.000Z');
  assert.equal(a.kind, 'comment');
});

test('events we do not count, or cannot place safely, are dropped', () => {
  assert.equal(normaliseJiraEvent({ eventType: 'avi:jira:viewed:issue', atlassianId: 'u', issue: { key: 'A-1' } }, received), null);
  assert.equal(normaliseJiraEvent({ eventType: 'avi:jira:updated:issue', issue: { key: 'A-1' } }, received), null);
  // A key that could smuggle JQL never becomes a scope.
  assert.equal(normaliseJiraEvent({ eventType: 'avi:jira:updated:issue', atlassianId: 'u', issue: { key: 'A" OR 1=1-1' } }, received), null);
  assert.equal(PROJECT_KEY.test('OPS_2'), true);
  assert.equal(PROJECT_KEY.test('ops'), false);
});

test('a Confluence event reads the space from any of the shapes, or asks for a lookup', () => {
  const direct = normaliseConfluenceEvent(
    { eventType: 'avi:confluence:updated:page', atlassianId: 'u', content: { id: '99', type: 'page', space: { id: 123 }, version: { createdAt: '2026-09-28T01:00:00Z' } } },
    received,
  );
  assert.deepEqual(direct, { product: 'confluence', scope: 'confluence:123', lookup: null, actor: 'u', at: '2026-09-28T01:00:00Z', kind: 'updated' });

  const flat = normaliseConfluenceEvent({ eventType: 'avi:confluence:created:blogpost', atlassianId: 'u', content: { id: '7', spaceId: '55' } }, received);
  assert.equal(flat.scope, 'confluence:55');
  assert.equal(flat.at, received);

  const lookup = normaliseConfluenceEvent({ eventType: 'avi:confluence:created:comment', atlassianId: 'u', comment: { id: '31' } }, received);
  assert.equal(lookup.scope, null);
  assert.deepEqual(lookup.lookup, { contentId: '31', type: 'comment' });

  assert.equal(normaliseConfluenceEvent({ eventType: 'avi:confluence:viewed:page', atlassianId: 'u' }, received), null);
});

test('the page scope comes from the project key or the space id', () => {
  assert.deepEqual(scopeFromExtension({ type: 'jira:projectPage', project: { key: 'OPS', id: '10000' } }), { scope: 'jira:OPS', product: 'jira', projectKey: 'OPS' });
  assert.deepEqual(scopeFromExtension({ type: 'confluence:spacePage', space: { id: 123, key: 'ENG' } }), { scope: 'confluence:123', product: 'confluence', spaceId: '123' });
  assert.equal(scopeFromExtension({}), null);
  assert.equal(scopeFromExtension({ project: { key: 'bad key' } }), null);
});
