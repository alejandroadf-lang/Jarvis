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

import { PROJECT_KEY, DIGEST_LABEL } from './lib/events.mjs';

export { DIGEST_LABEL };

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

    /**
     * How many in-progress issues are flagged as impediments. Uses the
     * approximate-count endpoint; the "Flagged" field is Jira Software's.
     * Null when the site has no such field or the count is unavailable.
     */
    async flaggedInProgress(projectKey) {
      if (!PROJECT_KEY.test(projectKey)) return null;
      const res = await api.asApp().requestJira(route`/rest/api/3/search/approximate-count`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql: `project = "${projectKey}" AND statusCategory = "In Progress" AND Flagged = Impediment` }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Number.isFinite(data?.count) ? data.count : null;
    },

    /** Every status id -> its category key ('new' | 'indeterminate' | 'done'). */
    async statusCategories() {
      const list = await json(await api.asApp().requestJira(route`/rest/api/3/status`), 'status list');
      const out = {};
      for (const status of list || []) if (status?.id) out[String(status.id)] = status.statusCategory?.key || null;
      return out;
    },

    /** The app's own account id, so its own digest posts are never counted as work. */
    async selfAccountId() {
      const me = await json(await api.asApp().requestJira(route`/rest/api/3/myself`), 'app identity');
      return me?.accountId || null;
    },

    /**
     * One page of a project's recently updated issues with their changelog
     * and comments, for the opt-in backfill of the last three weeks. Returns
     * only who acted and when: {issues: [{id, key, labels, created, creator,
     * histories: [{author, created, items}], comments: [{author, created}]}], nextPageToken}.
     *
     * Assumed, to confirm on the first real run: that /search/jql with
     * expand "changelog" returns each issue's recent histories (Jira caps
     * the embedded changelog; three weeks of one issue fits well inside it),
     * and that the comment field lists comments with author and created.
     */
    async recentHistory(projectKey, { days = 21, nextPageToken = null, pageSize = 50 } = {}) {
      if (!PROJECT_KEY.test(projectKey)) throw new Error(`refusing to search for project key ${JSON.stringify(projectKey)}`);
      const body = {
        jql: `project = "${projectKey}" AND updated >= "-${Number(days)}d" ORDER BY updated DESC`,
        fields: ['created', 'creator', 'labels', 'comment'],
        expand: 'changelog',
        maxResults: pageSize,
        ...(nextPageToken ? { nextPageToken } : {}),
      };
      const page = await json(
        await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        'history search',
      );
      return {
        issues: (page.issues || []).map((issue) => ({
          id: String(issue.id),
          key: issue.key,
          labels: issue.fields?.labels || [],
          created: issue.fields?.created || null,
          creator: issue.fields?.creator?.accountId || null,
          histories: (issue.changelog?.histories || []).map((h) => ({ author: h.author?.accountId || null, created: h.created, items: h.items || [] })),
          comments: (issue.fields?.comment?.comments || []).map((c) => ({ author: c.author?.accountId || null, created: c.created })),
        })),
        nextPageToken: page.nextPageToken || null,
      };
    },

    /** Whether the person asking (asUser) can see the project. Fails closed. */
    async userCanSeeProject(projectKey) {
      if (!PROJECT_KEY.test(projectKey)) return false;
      try {
        const res = await api.asUser().requestJira(route`/rest/api/3/project/${projectKey}`);
        return res.ok;
      } catch {
        return false;
      }
    },

    /** A project's display name. */
    async projectName(projectKey) {
      if (!PROJECT_KEY.test(projectKey)) return projectKey;
      const p = await json(await api.asApp().requestJira(route`/rest/api/3/project/${projectKey}`), 'project lookup');
      return p?.name || projectKey;
    },

    /**
     * Post the weekly digest as an issue in the project, labelled so the app
     * can recognise its own posts. Uses the project's first non-subtask
     * issue type; the description is Atlassian Document Format.
     */
    async postDigest(projectKey, { summary, paragraphs }) {
      if (!PROJECT_KEY.test(projectKey)) throw new Error(`refusing to post to project key ${JSON.stringify(projectKey)}`);
      const meta = await json(await api.asApp().requestJira(route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`), 'issue types');
      const types = meta?.issueTypes || meta?.values || [];
      const type = types.find((t) => !t.subtask) || types[0];
      if (!type) throw new Error('no issue type available for the digest');
      const body = {
        fields: {
          project: { key: projectKey },
          issuetype: { id: String(type.id) },
          summary,
          labels: [DIGEST_LABEL],
          description: {
            type: 'doc',
            version: 1,
            content: paragraphs.map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })),
          },
        },
      };
      const created = await json(
        await api.asApp().requestJira(route`/rest/api/3/issue`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        'digest issue',
      );
      return { id: created?.key || created?.id || null };
    },

    /** The viewer's own groups, for the organisation view's access rule. */
    async myGroups() {
      const me = await json(await api.asUser().requestJira(route`/rest/api/3/myself?expand=groups`), 'my groups');
      return (me?.groups?.items || []).map((g) => g.name).filter(Boolean);
    },

    /** Whether the viewer is a Jira administrator. Fails closed. */
    async isSiteAdmin() {
      try {
        const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
        if (!res.ok) return false;
        const data = await res.json();
        return Boolean(data?.permissions?.ADMINISTER?.havePermission);
      } catch {
        return false;
      }
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
    /** The app's own account id, so its own posts are never counted as work. */
    async selfAccountId() {
      const me = await get(route`/wiki/rest/api/user/current`, 'app identity');
      return me?.accountId || null;
    },

    /**
     * Whether the viewer administers Confluence itself. Reads the viewer's
     * own operations and looks for "administer" on the application. Fails
     * closed. The expand parameter is on the tunnel-run checklist.
     */
    async isSiteAdmin() {
      try {
        const res = await api.asUser().requestConfluence(route`/wiki/rest/api/user/current?expand=operations`);
        if (!res.ok) return false;
        const me = await res.json();
        return (me?.operations || []).some((op) => op?.operation === 'administer' && (op?.targetType === 'application' || !op?.targetType));
      } catch {
        return false;
      }
    },

    /** The viewer's own groups. */
    async myGroups() {
      try {
        const me = await get(route`/wiki/rest/api/user/current?expand=groups`, 'my groups');
        return (me?.groups?.results || me?.groups || []).map((g) => g?.name).filter(Boolean);
      } catch {
        return [];
      }
    },

    async spaceName(spaceId) {
      if (!/^\d+$/.test(String(spaceId))) return String(spaceId);
      const space = await get(route`/wiki/api/v2/spaces/${spaceId}`, 'space lookup');
      return space?.name || String(spaceId);
    },

    /** Post the weekly digest as a blog post in the space. `html` is storage format. */
    async postDigest(spaceId, { title, html }) {
      if (!/^\d+$/.test(String(spaceId))) throw new Error(`refusing to post to space ${JSON.stringify(spaceId)}`);
      const created = await json(
        await api.asApp().requestConfluence(route`/wiki/api/v2/blogposts`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ spaceId: String(spaceId), status: 'current', title, body: { representation: 'storage', value: html } }),
        }),
        'digest blog post',
      );
      return { id: created?.id ? String(created.id) : null };
    },

    /** Whether the person asking (asUser) can see the space. Fails closed. */
    async userCanSeeSpace(spaceId) {
      if (!/^\d+$/.test(String(spaceId))) return false;
      try {
        const res = await api.asUser().requestConfluence(route`/wiki/api/v2/spaces/${spaceId}`);
        return res.ok;
      } catch {
        return false;
      }
    },

    /** Create a page in the space (the quarterly evidence pack). */
    async createPage(spaceId, { title, html }) {
      if (!/^\d+$/.test(String(spaceId))) throw new Error(`refusing to post to space ${JSON.stringify(spaceId)}`);
      const created = await json(
        await api.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ spaceId: String(spaceId), status: 'current', title, body: { representation: 'storage', value: html } }),
        }),
        'evidence page',
      );
      return { id: created?.id ? String(created.id) : null };
    },

    /**
     * Whether the current viewer administers the space. Asks Confluence for the
     * operations *this user* may perform on the space; "administer" is the
     * space-admin permission. Fails closed on any error, so a Confluence API
     * hiccup can only ever refuse a settings change, never allow one. The
     * `include-operations` parameter is assumed from the v2 API reference and
     * belongs on the tunnel-run checklist in the README.
     */
    async canAdminister(spaceId) {
      if (!spaceId || !/^\d+$/.test(String(spaceId))) return false;
      try {
        const res = await api.asUser().requestConfluence(route`/wiki/api/v2/spaces/${spaceId}?include-operations=true`);
        if (!res.ok) return false;
        const space = await res.json();
        return (space?.operations || []).some((op) => op?.operation === 'administer');
      } catch {
        return false;
      }
    },

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
