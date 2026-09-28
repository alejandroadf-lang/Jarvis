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

    /** Every unresolved issue in a project, as {assignee, overdue}. */
    async openIssues(projectKey, { today, maxIssues = 5000 } = {}) {
      if (!PROJECT_KEY.test(projectKey)) throw new Error(`refusing to search for project key ${JSON.stringify(projectKey)}`);
      const issues = [];
      let nextPageToken;
      do {
        const body = {
          jql: `project = "${projectKey}" AND statusCategory != Done`,
          fields: ['assignee', 'duedate'],
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
          issues.push({
            assignee: issue.fields?.assignee?.accountId || null,
            overdue: Boolean(due && today && due < today),
          });
        }
        nextPageToken = page.nextPageToken;
      } while (nextPageToken && issues.length < maxIssues);
      return issues;
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
