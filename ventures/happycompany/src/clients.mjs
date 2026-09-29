// The few product REST calls the app makes, behind small functions.
//
// Everything here runs asApp(), so it sees what the app was granted at
// install, not what the viewer can see, and works from a scheduled function
// with no user in context. The one exception is the project-admin check,
// which is about the viewer and runs asUser().
//
// `api` and `route` are injected rather than imported so this file can be
// exercised with a fake in tests. `route` is Forge's tagged template: it
// URL-encodes interpolated values, which is what stops an issue key or account
// id from becoming a path traversal.

import { PROJECT_KEY } from './lib/events.mjs';

async function json(response, what) {
  if (!response.ok) {
    throw new Error(`${what} failed: ${response.status} ${await response.text().catch(() => '')}`.trim());
  }
  return response.json();
}

export function jiraClient(api, route) {
  return {
    /** The user's IANA time zone, or null when the account is hidden. */
    async userTimeZone(accountId) {
      const res = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
      if (!res.ok) return null;
      const user = await res.json();
      return user?.timeZone || null;
    },

    /** Every unresolved issue in a project, as {assignee, overdue, inProgress, high, due}. */
    async openIssues(projectKey, { today, maxIssues = 5000 } = {}) {
      if (!PROJECT_KEY.test(projectKey)) throw new Error(`refusing to search for project key ${JSON.stringify(projectKey)}`);
      const issues = [];
      let nextPageToken;
      do {
        const body = {
          // Epics and initiatives are containers, usually assigned to a lead;
          // counting them would flag every lead as overloaded.
          jql: `project = "${projectKey}" AND statusCategory != Done AND hierarchyLevel = 0`,
          fields: ['assignee', 'duedate', 'status', 'priority'],
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
        };
        const page = await json(
          await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
          'issue search',
        );
        for (const issue of page.issues || []) {
          const due = issue.fields?.duedate;
          const priority = String(issue.fields?.priority?.name || '').toLowerCase();
          issues.push({
            assignee: issue.fields?.assignee?.accountId || null,
            overdue: Boolean(due && today && due < today),
            inProgress: issue.fields?.status?.statusCategory?.key === 'indeterminate',
            high: priority === 'high' || priority === 'highest' || priority === 'critical' || priority === 'blocker',
            due: due || null,
          });
        }
        nextPageToken = page.nextPageToken;
      } while (nextPageToken && issues.length < maxIssues);
      return issues;
    },

    /** Board ids of a project's scrum boards. */
    async boards(projectKey) {
      if (!PROJECT_KEY.test(projectKey)) return [];
      const out = [];
      let startAt = 0;
      for (;;) {
        const page = await json(await api.asApp().requestJira(route`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&type=scrum&startAt=${startAt}&maxResults=50`), 'board list');
        for (const board of page.values || []) out.push({ id: String(board.id) });
        if (page.isLast !== false || !(page.values || []).length) break;
        startAt += page.values.length;
      }
      return out;
    },

    /** Sprints of a board closed on or after `since` (YYYY-MM-DD). */
    async closedSprints(boardId, since) {
      const out = [];
      let startAt = 0;
      for (;;) {
        const page = await json(await api.asApp().requestJira(route`/rest/agile/1.0/board/${boardId}/sprint?state=closed&startAt=${startAt}&maxResults=50`), 'sprint list');
        for (const sprint of page.values || []) {
          if (sprint.completeDate && sprint.completeDate.slice(0, 10) >= since) {
            out.push({ id: String(sprint.id), startDate: sprint.startDate || null, completeDate: sprint.completeDate });
          }
        }
        if (page.isLast !== false || !(page.values || []).length) break;
        startAt += page.values.length;
      }
      return out;
    },

    /** Every issue that was ever in a sprint, as {done, created, resolved}. */
    async sprintIssues(sprintId) {
      const issues = [];
      let nextPageToken;
      do {
        const body = {
          jql: `sprint = ${Number(sprintId)}`,
          fields: ['status', 'created', 'resolutiondate'],
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
        };
        const page = await json(
          await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
          'sprint issue search',
        );
        for (const issue of page.issues || []) {
          issues.push({
            done: issue.fields?.status?.statusCategory?.key === 'done',
            created: issue.fields?.created || null,
            resolved: issue.fields?.resolutiondate || null,
          });
        }
        nextPageToken = page.nextPageToken;
      } while (nextPageToken && issues.length < 5000);
      return issues;
    },

    /** Every status id -> its category key ('new' | 'indeterminate' | 'done'). */
    async statusCategories() {
      const list = await json(await api.asApp().requestJira(route`/rest/api/3/status`), 'status list');
      const out = {};
      for (const status of list || []) if (status?.id) out[String(status.id)] = status.statusCategory?.key || null;
      return out;
    },

    /** Whether the current viewer administers the project. */
    async canAdminister(projectKey) {
      if (!PROJECT_KEY.test(projectKey)) return false;
      const res = await api
        .asUser()
        .requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`);
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data?.permissions?.ADMINISTER_PROJECTS?.havePermission);
    },
  };
}

export function confluenceClient(api, route) {
  const get = async (path, what) => json(await api.asApp().requestConfluence(path), what);
  return {
    /** The space id of a page, blog post or comment, or null. */
    async spaceIdFor({ contentId, type }) {
      if (!contentId) return null;
      if (type === 'blogpost') {
        const post = await get(route`/wiki/api/v2/blogposts/${contentId}`, 'blog post lookup');
        return post?.spaceId ? String(post.spaceId) : null;
      }
      if (type === 'comment') {
        const comment = await get(route`/wiki/api/v2/footer-comments/${contentId}`, 'comment lookup');
        if (comment?.pageId) return this.spaceIdFor({ contentId: String(comment.pageId), type: 'page' });
        if (comment?.blogPostId) return this.spaceIdFor({ contentId: String(comment.blogPostId), type: 'blogpost' });
        return null;
      }
      const page = await get(route`/wiki/api/v2/pages/${contentId}`, 'page lookup');
      return page?.spaceId ? String(page.spaceId) : null;
    },
  };
}
