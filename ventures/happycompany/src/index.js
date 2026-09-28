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

const app = createApp({
  store: forgeStore(kvs, WhereConditions),
  jira: jiraClient(api, route),
  confluence: confluenceClient(api, route),
});

export async function onJiraEvent(event) {
  return app.onJiraEvent(event);
}

export async function onConfluenceEvent(event) {
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
resolver.define('teamHealth', ({ context }) => app.teamHealth(placeOf(context)));
resolver.define('saveSettings', ({ payload, context }) => app.saveSettings({ ...placeOf(context), settings: payload?.settings }));
export const handler = resolver.getDefinitions();
