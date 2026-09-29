// The GitHub deploy workflow (.github/workflows/happycompany-deploy.yml).
//
// It holds the Forge token, and the agents propose their work as pull
// requests, so two properties are the whole point of it and are pinned here:
// it never runs on pull_request (a pull request's code would run with the
// token in reach), and a push only ever reaches staging (production is other
// companies' Jira, and is released by a person choosing it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../../.github/workflows/happycompany-deploy.yml', import.meta.url));
const text = fs.readFileSync(file, 'utf8');
const triggers = text.slice(text.indexOf('\non:'), text.indexOf('\npermissions:'));

test('never triggered by a pull request, or by anything but a push to main and a manual run', () => {
  assert.doesNotMatch(triggers, /pull_request|pull_request_target|workflow_run|issue_comment/);
  assert.match(triggers, /push:\n\s+branches: \[main\]\n\s+paths: \['ventures\/happycompany\/\*\*'\]/);
  assert.match(triggers, /workflow_dispatch:/);
});

test('a push deploys to staging; production only when a person chooses it', () => {
  // inputs.environment is empty on a push, so the fallback is what a push gets.
  assert.match(text, /FORGE_ENV: \$\{\{ inputs\.environment \|\| 'staging' \}\}/);
  assert.doesNotMatch(text, /\|\| 'production'/);
  assert.match(text, /environment: forge-\$\{\{ inputs\.environment \|\| 'staging' \}\}/);
});

test('the token comes from GitHub secrets, and the workflow can only read the repo', () => {
  assert.match(text, /FORGE_API_TOKEN: \$\{\{ secrets\.FORGE_API_TOKEN \}\}/);
  assert.match(text, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(text, /ATATT|api[_-]?token:\s*['"][^$]/i, 'no token literal in the file');
});

test('the placeholder id it replaces is the one in the manifest', (t) => {
  const manifest = fs.readFileSync(fileURLToPath(new URL('../manifest.yml', import.meta.url)), 'utf8');
  const placeholder = manifest.match(/id: (ari:cloud:ecosystem::app\/REPLACE-[\w-]+)/)?.[1];
  // Once the real id is committed, FORGE_APP_ID is not used and nothing to check.
  if (!placeholder) return t.skip('manifest.yml carries a real app id');
  assert.ok(text.includes(`s|${placeholder}|`), 'a renamed placeholder would make the deploy skip setting the id');
});
