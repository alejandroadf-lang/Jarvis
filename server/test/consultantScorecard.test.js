// The readiness scorecard is arithmetic over the company's own records. What is
// pinned: every score follows from a cited fact, a venture's ladder stops at the
// first rung it has not reached, the risk score falls as unread rules rise, and
// the rendering (which no model may change) shows the binding constraint.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let sc;
let ventures;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-scorecard-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  sc = await import('../consultant/scorecard.js');
  ventures = await import('../finance/ventures.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-10T03:00:00Z');
const rule = (name, status) => ({ path: `Company/Rules/${name}.md`, fm: { type: 'rule', status } });

test('with no ventures it still scores, honestly, and says what it could not read', () => {
  const card = sc.buildScorecard({ now: NOW });
  assert.equal(card.ventures.length, 0);
  assert.equal(card.dimensions.length, 8);
  assert.ok(card.dimensions.every((d) => d.level >= 0 && d.level <= 4));
  assert.match(sc.renderFacts(card), /the rules register could not be read/);
  assert.equal(card.dimensions.find((d) => d.key === 'risk').level, 1, 'unknown rules are not scored as safe');
});

test('a venture is placed on the ladder and stops at the first rung it has not reached', () => {
  const a = ventures.createVenture({ title: 'Alpha API', oneLiner: 'x', proposedBy: 'venture_partner' });
  ventures.setPricing(a.id, { currency: 'EUR', floorMonthly: 29 });
  ventures.linkRepo(a.id, { owner: 'me', name: 'alpha', allowedPaths: ['src/'] });
  ventures.recordPullRequest(a.id, { number: 1, url: 'https://github.com/me/alpha/pull/1', title: 't', branch: 'b', paths: ['src/a.js'], triggeredBy: 'interactive', agentId: 'cto' });
  for (let i = 0; i < 10; i++) ventures.updatePipeline(a.id, { handle: `lead${i}`, source: 'https://example.com/list', stage: 'lead' });
  const b = ventures.createVenture({ title: 'Beta Service', oneLiner: 'x', proposedBy: 'venture_partner' });

  const card = sc.buildScorecard({ now: NOW });
  const alpha = card.ventures.find((v) => v.id === a.id);
  const beta = card.ventures.find((v) => v.id === b.id);

  assert.deepEqual(
    Object.entries(alpha.done).filter(([, ok]) => ok).map(([k]) => k),
    ['price', 'product', 'buyers'],
  );
  assert.equal(alpha.reached, 3);
  assert.equal(alpha.next.key, 'used', 'the next rung is the first unmet one, not the first rung after the last met');
  assert.match(alpha.next.evidence, /^E\d+$/);
  assert.equal(beta.reached, 0);
  assert.equal(beta.next.key, 'price');

  // Conversations and a first customer move the rung on.
  ventures.updatePipeline(a.id, { handle: 'lead0', stage: 'contacted' });
  ventures.updatePipeline(a.id, { handle: 'lead1', stage: 'paying', dealValueMonthly: 29 });
  const later = sc.buildScorecard({ now: NOW }).ventures.find((v) => v.id === a.id);
  assert.equal(later.done.talking, true);
  assert.equal(later.done.paying, true);
  assert.equal(later.done.repeatable, false);
  assert.equal(later.mrr, 29);
  assert.equal(sc.buildScorecard({ now: NOW }).closest.title, 'Alpha API');
});

test('every score cites facts that exist, and the same records give the same card', () => {
  const card = sc.buildScorecard({ now: NOW });
  const ids = new Set(card.facts.map((f) => f.id));
  for (const d of card.dimensions) for (const id of d.why) assert.ok(ids.has(id), `${d.key} cites ${id}`);
  assert.deepEqual(sc.buildScorecard({ now: NOW }).dimensions, card.dimensions);
});

test('the risk score falls as outside rules stay unread', () => {
  const level = (notes) => sc.buildScorecard({ now: NOW, notes }).dimensions.find((d) => d.key === 'risk').level;
  assert.equal(level([rule('A', 'reviewed'), rule('B', 'reviewed')]), 4);
  assert.equal(level([rule('A', 'needs-legal-read'), rule('B', 'reviewed')]), 3);
  assert.equal(level([rule('A', 'needs-legal-read'), rule('B', 'source-changed'), rule('C', 'to-verify')]), 2);
  assert.equal(level(['A', 'B', 'C', 'D', 'E', 'F'].map((n) => rule(n, 'needs-legal-read'))), 1);
  assert.match(sc.renderFacts(sc.buildScorecard({ now: NOW, notes: [rule('WHOOP API terms', 'source-changed')] })), /WHOOP API terms/);
});

test('the rendering states the score, the binding constraint and each venture\'s next rung', () => {
  const card = sc.buildScorecard({ now: NOW, notes: [] });
  const text = sc.renderScorecard(card);
  assert.match(text, /^Readiness \d(\.\d)?\/4 \((Initial|Emerging|Defined|Managed|Optimised)\)\./);
  assert.match(text, /▰|▱/);
  assert.match(text, /Binding constraint: (Product and technology|Revenue engine|Go-to-market machinery)/);
  assert.match(text, /Alpha API: \d\/9\s+[✓·]{9}/);
  assert.match(text, /next rung: .* \[E\d+\]/);
  assert.match(text, /not of how much it has earned/);
});
