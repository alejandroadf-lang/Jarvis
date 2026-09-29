import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JIRA_KIND, CONFLUENCE_KIND, JIRA_MENTION_EVENT } from '../src/lib/events.mjs';

// The handlers are tested by calling them directly, which proves nothing about
// whether Forge will ever call them: that depends on the manifest subscribing
// to the event. The mention event was handled and tested for a whole release
// while the manifest never subscribed to it, so both mention signals would
// have read "no data" on every real site. This pins the two together.

const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
const subscribed = new Set([...manifest.matchAll(/^\s*-\s*(avi:[a-z-]+:[a-z]+:[a-z]+)\s*$/gm)].map((m) => m[1]));

test('every event the code handles is subscribed in the manifest', () => {
  const handled = [...Object.keys(JIRA_KIND), JIRA_MENTION_EVENT, ...Object.keys(CONFLUENCE_KIND)];
  const missing = handled.filter((e) => !subscribed.has(e));
  assert.deepEqual(missing, []);
});

test('the manifest subscribes to nothing the code ignores', () => {
  const handled = new Set([...Object.keys(JIRA_KIND), JIRA_MENTION_EVENT, ...Object.keys(CONFLUENCE_KIND)]);
  const unused = [...subscribed].filter((e) => !handled.has(e));
  // Each unused subscription is a paid invocation that does nothing.
  assert.deepEqual(unused, []);
});

test('the manifest declares no egress, remotes or external fetch', () => {
  // Any of these costs the Runs on Atlassian badge and breaks the promise in
  // WORKS_COUNCIL.md that nothing leaves Atlassian.
  assert.doesNotMatch(manifest, /^\s*remotes\s*:/m);
  assert.doesNotMatch(manifest, /^\s*external\s*:/m);
  assert.doesNotMatch(manifest, /^\s*egress\s*:/m);
});
