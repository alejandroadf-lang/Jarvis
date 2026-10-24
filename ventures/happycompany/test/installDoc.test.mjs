// INSTALL.md is the founder's only instruction sheet for the install that the
// objective is measured on. It drifted-proofs itself against the two things it
// depends on: the commands it tells a person to type, and the names of the
// GitHub secrets the deploy workflow actually reads. A renamed secret would
// leave the guide telling the founder to set something nothing reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = fs.readFileSync(new URL('../INSTALL.md', import.meta.url), 'utf8');
const workflow = fs.readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/happycompany-deploy.yml', import.meta.url)),
  'utf8',
);

test('every secret and variable the guide names is read by the deploy workflow', () => {
  for (const name of ['FORGE_EMAIL', 'FORGE_API_TOKEN', 'FORGE_APP_ID']) {
    assert.ok(doc.includes(name), `${name} missing from INSTALL.md`);
    assert.ok(workflow.includes(name), `${name} not used by the workflow`);
  }
});

test('the guide covers register, deploy and an install per product', () => {
  assert.ok(doc.includes('forge register'));
  assert.ok(doc.includes('forge deploy -e development'));
  assert.ok(doc.includes('--product jira'));
  assert.ok(doc.includes('--product confluence'));
});

test('the guide holds no token literal and does not tell anyone to lower the floor', () => {
  assert.doesNotMatch(doc, /ATATT/);
  assert.match(doc, /Do not lower\s+it/);
});
