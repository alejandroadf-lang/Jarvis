// Reducing a product event to the one fact this app keeps: who, when, where.
//
// Forge delivers an event as a JSON object whose shape differs per product and
// per event. This module knows those shapes so nothing else has to, and it is
// where to look when Atlassian changes a payload: the symptom is a project or
// space that stops accumulating activity.
//
// ## What is verified and what is assumed
//
// Verified against Atlassian's event reference: every event carries
// `eventType` and `atlassianId` (the actor); Jira issue events carry `issue`
// with `id`, `key` and `fields`; the comment event carries `comment`.
//
// Assumed, and to be confirmed on the first `forge tunnel` run against a real
// site (see README, step 4): which of `content.space.id`, `content.spaceId` or
// a top-level `space` a Confluence event carries. The normaliser accepts all
// three and, if none is present, asks for a lookup by content id, which the
// app resolves through the Confluence REST API.

const JIRA_KIND = {
  'avi:jira:created:issue': 'created',
  'avi:jira:updated:issue': 'updated',
  'avi:jira:commented:issue': 'comment',
};

const CONFLUENCE_KIND = {
  'avi:confluence:created:page': 'created',
  'avi:confluence:updated:page': 'updated',
  'avi:confluence:created:blogpost': 'created',
  'avi:confluence:updated:blogpost': 'updated',
  'avi:confluence:created:comment': 'comment',
};

// A Jira project key: letters, digits and underscore, starting with a letter.
// Anything else is refused before it can reach a JQL string.
export const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

export function jiraScope(projectKey) {
  return `jira:${projectKey}`;
}

export function confluenceScope(spaceId) {
  return `confluence:${spaceId}`;
}

/** {product, scope, actor, at, kind} or null when the event is not one we count. */
export function normaliseJiraEvent(event, receivedAt) {
  const kind = JIRA_KIND[event?.eventType];
  const issue = event?.issue;
  const actor = event?.atlassianId;
  if (!kind || !issue || !actor) return null;
  const projectKey = issue.fields?.project?.key || String(issue.key || '').split('-')[0];
  if (!PROJECT_KEY.test(projectKey)) return null;
  const at = event.comment?.created || event.comment?.updated || issue.fields?.updated || receivedAt;
  return { product: 'jira', scope: jiraScope(projectKey), actor, at, kind };
}

/**
 * As above for Confluence. When the space cannot be read off the event the
 * result has `scope: null` and a `lookup` the app can resolve.
 */
export function normaliseConfluenceEvent(event, receivedAt) {
  const kind = CONFLUENCE_KIND[event?.eventType];
  const actor = event?.atlassianId;
  if (!kind || !actor) return null;
  const content = event.content || event.page || event.blogpost || event.comment || {};
  const spaceId = content.space?.id ?? content.spaceId ?? event.space?.id ?? null;
  const at = content.version?.createdAt || content.version?.when || content.createdAt || receivedAt;
  const type = kind === 'comment' ? 'comment' : content.type || (event.eventType.includes('blogpost') ? 'blogpost' : 'page');
  return {
    product: 'confluence',
    scope: spaceId ? confluenceScope(String(spaceId)) : null,
    lookup: spaceId ? null : { contentId: content.id ? String(content.id) : null, type },
    actor,
    at,
    kind,
  };
}

/** The scope a page is showing, from the resolver's extension context. */
export function scopeFromExtension(extension) {
  const projectKey = extension?.project?.key;
  if (projectKey && PROJECT_KEY.test(projectKey)) return { scope: jiraScope(projectKey), product: 'jira', projectKey };
  const spaceId = extension?.space?.id;
  if (spaceId) return { scope: confluenceScope(String(spaceId)), product: 'confluence', spaceId: String(spaceId) };
  return null;
}
