// The two Rovo actions: a team's working conditions, and what the app
// measures. Read-only, and never more than the Team health page shows.
//
// The action runs as the app, but the question comes from a person, and
// the page for a project is visible only to people who can see the project.
// So before describing a team the person's own access is checked (asUser),
// and the answer is refused when that check fails or cannot be made: asking
// Rovo must never be a way round Jira's or Confluence's permissions.
//
// Assumed, to confirm on the first real run: that Rovo passes the inputs as
// top-level payload fields and the page the person is on as
// `context.jira.projectKey` or `context.confluence.spaceId`.

import { PROJECT_KEY, jiraScope, confluenceScope } from './lib/events.mjs';
import { transparency } from './lib/transparency.mjs';
import { MIN_GROUP, MAX_GROUP_SETTING } from './lib/privacy.mjs';

export function targetOf(payload = {}) {
  const key = String(payload.projectKey || '').trim().toUpperCase();
  if (key) return PROJECT_KEY.test(key) ? { product: 'jira', scope: jiraScope(key), projectKey: key } : null;
  const space = String(payload.spaceId || '').trim();
  if (space) return /^\d+$/.test(space) ? { product: 'confluence', scope: confluenceScope(space), spaceId: space } : null;
  const ctxKey = payload.context?.jira?.projectKey;
  if (ctxKey && PROJECT_KEY.test(ctxKey)) return { product: 'jira', scope: jiraScope(ctxKey), projectKey: ctxKey };
  const ctxSpace = payload.context?.confluence?.spaceId;
  if (ctxSpace && /^\d+$/.test(String(ctxSpace))) return { product: 'confluence', scope: confluenceScope(String(ctxSpace)), spaceId: String(ctxSpace) };
  return null;
}

export function createRovoActions({ app, jira, confluence, log = console }) {
  async function teamHealth(payload) {
    const target = targetOf(payload);
    if (!target) return { says: 'Name a Jira project key (such as OPS) or a Confluence space id, or ask from inside a project or space.' };
    const client = target.product === 'jira' ? jira : confluence;
    const visible = target.product === 'jira' ? await client.userCanSeeProject(target.projectKey) : await client.userCanSeeSpace(target.spaceId);
    if (!visible) return { says: 'That project or space is not visible to you, so Happy Company will not describe it.' };
    try {
      return await app.teamBrief(target);
    } catch (err) {
      log.error(`[happycompany] rovo team health failed for ${target.scope}: ${err.message}`);
      return { says: 'Happy Company could not read this team just now. The Team health page in the project or space has the same information.' };
    }
  }

  function whatWeMeasure() {
    return {
      ...transparency({ minGroup: MIN_GROUP }),
      minimumGroup: `Nothing is shown for fewer than ${MIN_GROUP} active people; a team may raise this to ${MAX_GROUP_SETTING}, never lower it.`,
    };
  }

  return { teamHealth, whatWeMeasure };
}
