// The team's picture of what each venture may do. Without it the CEO asked the
// founder to link a repo that VENTURES showed was already linked, and told a
// review-only venture to commit: the team waiting on the founder for things
// already done.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let ventures;
let ctx;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-access-ctx-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  ventures = await import('../finance/ventures.js');
  ctx = await import('../finance/context.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { force: true, recursive: true });
});

const venture = (title) => ventures.createVenture({ title, oneLiner: 'x', proposedBy: 'founder' });

test('a linked, writable repo is stated, so nobody asks for it to be linked', () => {
  const v = venture('Happy Company');
  ventures.linkRepo(v.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['ventures/happycompany/'] });
  ventures.setDeploymentEnabled(v.id, true);
  const text = ctx.buildBusinessContext();
  assert.match(text, /access: repo acme\/app@main, allowed paths ventures\/happycompany\/, writes on;/);
  assert.match(text, /pull requests need no plan; a direct commit needs an approved plan/);
  assert.doesNotMatch(text, /no repo linked/);
});

test('review-only says so, and tells the team what to use instead of committing', () => {
  const v = venture('Happy Company');
  ventures.linkRepo(v.id, { owner: 'acme', name: 'app', allowedPaths: ['src/'] });
  ventures.setDeploymentEnabled(v.id, true);
  ventures.setReviewOnly(v.id, true);
  assert.match(ctx.buildBusinessContext(), /every change goes out as a pull request the founder merges; direct commits are refused, so use open_pull_request/);
});

test('writes off is named with the command that turns them on', () => {
  const v = venture('Idea');
  ventures.linkRepo(v.id, { owner: 'acme', name: 'app', allowedPaths: ['src/'] });
  assert.match(ctx.buildBusinessContext(), /writes OFF \(the founder turns them on with DEPLOY ON\)/);
});

test('a venture with no repo is told what it gets instead of code', () => {
  venture('Duty-of-Care API');
  assert.match(ctx.buildBusinessContext(), /access: no repo linked, so this venture gets research, pricing, prospects and outreach drafts rather than code/);
});

test('a live service URL is stated beside the repo', () => {
  const v = venture('CircadianAPI');
  ventures.linkRepo(v.id, { owner: 'acme', name: 'app', allowedPaths: ['src/'] });
  ventures.setDeploymentEnabled(v.id, true);
  ventures.setServiceUrl(v.id, 'https://circadian-api.up.railway.app');
  assert.match(ctx.buildBusinessContext(), /; live at https:\/\/circadian-api\.up\.railway\.app/);
});
