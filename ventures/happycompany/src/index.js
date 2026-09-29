// Forge entry points. Wiring only: the app lives in app.mjs, where it can be
// tested without Forge, and the Forge packages are imported here alone. (They
// are CommonJS; importing them from an .mjs file would lose their default
// exports under the bundler's strict ESM handling.)
import Resolver from '@forge/resolver';
import kvs, { WhereConditions } from '@forge/kvs';
import api, { route } from '@forge/api';
import { createApp } from './app.mjs';
import { forgeStore } from './storage.mjs';
import { jiraClient, confluenceClient } from './clients.mjs';
import { scopeFromExtension } from './lib/events.mjs';
import { eventShape, shapeLoggingOn } from './lib/shape.mjs';

// Development only: see src/lib/shape.mjs. Structure, never values.
function logShape(event) {
  if (!shapeLoggingOn()) return;
  console.log(`[happycompany] shape of ${event?.eventType || 'unknown event'}:\n  ${eventShape(event).join('\n  ')}`);
}

const jiraApi = jiraClient(api, route);
const confluenceApi = confluenceClient(api, route);
const app = createApp({
  store: forgeStore(kvs, WhereConditions),
  jira: jiraApi,
  confluence: confluenceApi,
});

export async function onJiraEvent(event) {
  logShape(event);
  return app.onJiraEvent(event);
}

export async function onConfluenceEvent(event) {
  logShape(event);
  return app.onConfluenceEvent(event);
}

export async function dailyRollup() {
  const summary = await app.dailyRollup();
  console.log(`[happycompany] rollup ${JSON.stringify(summary)}`);
  return summary;
}

function placeOf(context) {
  const place = scopeFromExtension(context?.extension);
  if (!place) throw new Error('This page only works inside a Jira project or a Confluence space.');
  return place;
}

const resolver = new Resolver();
resolver.define('teamHealth', ({ context }) => app.teamHealth({ ...placeOf(context), accountId: context?.accountId || null }));
resolver.define('answerPulse', ({ payload, context }) =>
  app.answerPulse({ ...placeOf(context), accountId: context?.accountId || null, answers: payload?.answers }),
);
resolver.define('saveSettings', ({ payload, context }) =>
  app.saveSettings({ ...placeOf(context), settings: payload?.settings, by: context?.accountId || null }),
);
resolver.define('commitActions', ({ payload, context }) => app.commitActions({ ...placeOf(context), keys: payload?.keys }));
resolver.define('closeAction', ({ payload, context }) =>
  app.closeAction({ ...placeOf(context), week: payload?.week, key: payload?.key, done: payload?.done }),
);
resolver.define('freezeWeek', ({ context }) => app.freezeWeek(placeOf(context)));
resolver.define('requestBackfill', ({ context }) => app.requestBackfill({ ...placeOf(context), by: context?.accountId || null }));

// The organisation view. Only its own page may call these, and the viewer
// is checked on every call: a site administrator, or a member of a group an
// administrator named. Both checks fail closed.
const ORG_MODULES = { 'happycompany-jira-org': 'jira', 'happycompany-confluence-org': 'confluence' };

async function viewerOf(context) {
  const product = ORG_MODULES[context?.moduleKey];
  if (!product) throw new Error('The organisation view is only available from its own page.');
  const client = product === 'jira' ? jiraApi : confluenceApi;
  const [isAdmin, groups] = await Promise.all([client.isSiteAdmin(), client.myGroups().catch(() => [])]);
  return { product, viewer: { isAdmin, groups } };
}

resolver.define('organisationView', async ({ context }) => app.organisationView(await viewerOf(context)));
resolver.define('saveOrgSettings', async ({ payload, context }) =>
  app.saveOrgSettings({ ...(await viewerOf(context)), settings: payload?.settings, by: context?.accountId || null }),
);
resolver.define('evidenceView', async ({ payload, context }) => app.evidenceView({ ...(await viewerOf(context)), quarter: payload?.quarter || null }));
resolver.define('issueAttestation', async ({ payload, context }) =>
  app.issueAttestation({ ...(await viewerOf(context)), quarter: payload?.quarter, by: context?.accountId || null }),
);
resolver.define('publishEvidence', async ({ payload, context }) =>
  app.publishEvidence({ ...(await viewerOf(context)), quarter: payload?.quarter, by: context?.accountId || null }),
);
resolver.define('estimateCost', async ({ payload, context }) => app.estimateCost({ ...(await viewerOf(context)), inputs: payload?.inputs }));

export const handler = resolver.getDefinitions();
