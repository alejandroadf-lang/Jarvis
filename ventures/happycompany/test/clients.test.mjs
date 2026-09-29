import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jiraClient, confluenceClient } from '../src/clients.mjs';

// Forge's `route` tag, minus the internals: encodes interpolations, keeps the path.
const route = (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? encodeURIComponent(values[i]) : ''), '');

function fakeApi(responses, calls) {
  const respond = (url, init) => {
    calls.push({ url, init });
    const hit = responses.find((r) => url.startsWith(r.path));
    if (!hit) return { ok: false, status: 404, text: async () => 'no route', json: async () => ({}) };
    const body = typeof hit.body === 'function' ? hit.body(init) : hit.body;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { asApp: () => ({ requestJira: respond, requestConfluence: respond }), asUser: () => ({ requestJira: respond }) };
}

test('open issues page through nextPageToken and read assignee and due date', async () => {
  const calls = [];
  const pages = [
    {
      issues: [
        { fields: { assignee: { accountId: 'a' }, duedate: '2026-09-01', status: { statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' } } },
        { fields: { assignee: null, duedate: null } },
      ],
      nextPageToken: 'p2',
    },
    { issues: [{ fields: { assignee: { accountId: 'b' }, duedate: '2026-12-01', status: { statusCategory: { key: 'new' } }, priority: { name: 'Medium' } } }] },
  ];
  let n = 0;
  const api = fakeApi([{ path: '/rest/api/3/search/jql', body: () => pages[n++] }], calls);
  const issues = await jiraClient(api, route).openIssues('OPS', { today: '2026-09-28' });
  assert.deepEqual(issues, [
    { assignee: 'a', overdue: true, inProgress: true, high: true, due: '2026-09-01' },
    { assignee: null, overdue: false, inProgress: false, high: false, due: null },
    { assignee: 'b', overdue: false, inProgress: false, high: false, due: '2026-12-01' },
  ]);
  assert.equal(calls.length, 2);
  const second = JSON.parse(calls[1].init.body);
  assert.equal(second.nextPageToken, 'p2');
  assert.match(second.jql, /^project = "OPS" AND statusCategory != Done AND hierarchyLevel = 0$/);
});

test('boards, closed sprints since a date, and the issues that were ever in a sprint', async () => {
  const calls = [];
  const api = fakeApi(
    [
      { path: '/rest/agile/1.0/board?projectKeyOrId=OPS', body: { values: [{ id: 7 }], isLast: true } },
      {
        path: '/rest/agile/1.0/board/7/sprint',
        body: { values: [{ id: 1, startDate: '2026-08-01T00:00:00Z', completeDate: '2026-08-15T00:00:00Z' }, { id: 2, startDate: '2026-09-14T00:00:00Z', completeDate: '2026-09-28T09:00:00Z' }], isLast: true },
      },
      { path: '/rest/api/3/search/jql', body: { issues: [{ fields: { status: { statusCategory: { key: 'done' } }, created: '2026-09-10T00:00:00Z', resolutiondate: '2026-09-20T00:00:00Z' } }, { fields: { status: { statusCategory: { key: 'new' } }, created: '2026-09-20T00:00:00Z' } }] } },
    ],
    calls,
  );
  const jira = jiraClient(api, route);
  assert.deepEqual(await jira.boards('OPS'), [{ id: '7' }]);
  assert.deepEqual(await jira.boards('bad key'), []);
  assert.deepEqual(await jira.closedSprints('7', '2026-09-08'), [{ id: '2', startDate: '2026-09-14T00:00:00Z', completeDate: '2026-09-28T09:00:00Z' }]);
  assert.deepEqual(await jira.sprintIssues('2'), [
    { done: true, created: '2026-09-10T00:00:00Z', resolved: '2026-09-20T00:00:00Z' },
    { done: false, created: '2026-09-20T00:00:00Z', resolved: null },
  ]);
  assert.equal(JSON.parse(calls.at(-1).init.body).jql, 'sprint = 2');
  assert.equal(JSON.parse(calls.at(-1).init.body).jql.includes('NaN'), false);
});

test('the status catalogue maps ids to categories', async () => {
  const api = fakeApi([{ path: '/rest/api/3/status', body: [{ id: '1', statusCategory: { key: 'new' } }, { id: '10001', statusCategory: { key: 'done' } }, { noid: true }] }], []);
  assert.deepEqual(await jiraClient(api, route).statusCategories(), { 1: 'new', 10001: 'done' });
});

test('a project key that is not a project key never reaches JQL', async () => {
  const api = fakeApi([], []);
  await assert.rejects(jiraClient(api, route).openIssues('OPS" OR 1=1'), /refusing/);
  assert.equal(await jiraClient(api, route).canAdminister('bad key'), false);
});

test('time zone and admin checks read the right fields and fail closed', async () => {
  const calls = [];
  const api = fakeApi(
    [
      { path: '/rest/api/3/user?accountId=', body: { accountId: 'a', timeZone: 'Asia/Bangkok' } },
      { path: '/rest/api/3/mypermissions', body: { permissions: { ADMINISTER_PROJECTS: { havePermission: true } } } },
    ],
    calls,
  );
  const jira = jiraClient(api, route);
  assert.equal(await jira.userTimeZone('a'), 'Asia/Bangkok');
  assert.equal(await jira.canAdminister('OPS'), true);
  assert.equal(await jiraClient(fakeApi([], []), route).userTimeZone('hidden'), null);
  assert.equal(await jiraClient(fakeApi([], []), route).canAdminister('OPS'), false);
});

test('a comment resolves to its page, then to the space', async () => {
  const calls = [];
  const api = fakeApi(
    [
      { path: '/wiki/api/v2/footer-comments/31', body: { id: '31', pageId: '99' } },
      { path: '/wiki/api/v2/pages/99', body: { id: '99', spaceId: 123 } },
      { path: '/wiki/api/v2/blogposts/7', body: { id: '7', spaceId: 55 } },
    ],
    calls,
  );
  const confluence = confluenceClient(api, route);
  assert.equal(await confluence.spaceIdFor({ contentId: '31', type: 'comment' }), '123');
  assert.equal(await confluence.spaceIdFor({ contentId: '7', type: 'blogpost' }), '55');
  assert.equal(await confluence.spaceIdFor({ contentId: null, type: 'page' }), null);
  await assert.rejects(confluence.spaceIdFor({ contentId: '404', type: 'page' }), /page lookup failed: 404/);
});
