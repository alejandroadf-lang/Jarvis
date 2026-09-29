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

export const JIRA_KIND = {
  'avi:jira:created:issue': 'created',
  'avi:jira:updated:issue': 'updated',
  'avi:jira:commented:issue': 'comment',
};

// The mention event is not an action of the actor we count (the comment event
// already is); it tells us who was *mentioned*. The field that names them is
// assumed (see the header): every shape seen in the wild is accepted.
export const JIRA_MENTION_EVENT = 'avi:jira:mentioned:issue';

function mentionedIds(event) {
  const raw = event.mentionedAccountIds || event.mentionedAccountId || event.mentioned?.accountId || event.mentioned || event.mentionedUsers;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((m) => (typeof m === 'string' ? m : m?.accountId)).filter(Boolean);
}

export const CONFLUENCE_KIND = {
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
  return { product: 'jira', scope: jiraScope(projectKey), actor, at, kind, item: issue.id ? String(issue.id) : issue.key, status: statusChange(event), tags: changelogTags(event) };
}

/** Facts about an update worth counting beside its kind. Today: a moved due date. */
export function changelogTags(event) {
  const items = event?.changelog?.items || [];
  const tags = [];
  const due = items.find((i) => i?.field === 'duedate' || i?.fieldId === 'duedate');
  // A date set for the first time is planning; a date changed is a slip.
  if (due && due.from && due.to && due.from !== due.to) tags.push('dueMoved');
  return tags;
}

/** {from, to} status ids when an update event changed the status, else null. */
export function statusChange(event) {
  const items = event?.changelog?.items || [];
  const change = items.find((i) => i?.field === 'status' || i?.fieldId === 'status');
  if (!change) return null;
  return { from: change.from ? String(change.from) : null, to: change.to ? String(change.to) : null };
}

/** {scope, mentioned: [accountId], at} for a mention event, or null. */
export function normaliseJiraMention(event, receivedAt) {
  if (event?.eventType !== JIRA_MENTION_EVENT || !event.issue) return null;
  const projectKey = event.issue.fields?.project?.key || String(event.issue.key || '').split('-')[0];
  if (!PROJECT_KEY.test(projectKey)) return null;
  const mentioned = mentionedIds(event).filter((id) => id !== event.atlassianId);
  if (!mentioned.length) return null;
  return { product: 'jira', scope: jiraScope(projectKey), mentioned, at: event.comment?.created || receivedAt };
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
    // A comment counts as touching its page, when the event says which.
    item: String(content.pageId || content.blogPostId || content.container?.id || content.id || ''),
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
