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

test('every function handler in the manifest is exported by src/index.js', () => {
  // A handler that names a missing export deploys fine and fails on every
  // call, which for a Rovo action means the agent silently has no answer.
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const exported = new Set([...index.matchAll(/^export (?:async function|function|const) (\w+)/gm)].map((m) => m[1]));
  const handlers = [...manifest.matchAll(/^\s*handler:\s*index\.(\w+)\s*$/gm)].map((m) => m[1]);
  assert.ok(handlers.length >= 6);
  assert.deepEqual(handlers.filter((h) => !exported.has(h)), []);
  // And every action and agent refers to keys that exist.
  const functionKeys = new Set([...manifest.matchAll(/^\s*-\s*key:\s*([\w-]+)\s*\n\s*handler:/gm)].map((m) => m[1]));
  for (const [, fn] of manifest.matchAll(/^\s*function:\s*([\w-]+)\s*$/gm)) assert.ok(functionKeys.has(fn), `no function ${fn}`);
});
