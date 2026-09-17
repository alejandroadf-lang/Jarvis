// Usage is the one number that cannot be backfilled. A request that was not
// counted when it happened is gone, and "we had customers that first week but
// no idea how many" is a permanent hole in the only evidence that matters —
// which is why this exists before the venture launches rather than after.
//
// Most of these tests are about the two states that look alike and are not:
// a product nobody is counting, and a product nobody is using.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordUsage,
  usageSummary,
  mintIngestKey,
  verifyIngestKey,
  hasIngestKey,
  MAX_TRACKED_CALLERS,
} from '../ventureUsage.js';
import { createVenture, linkRepo } from '../finance/ventures.js';
import { buildUsageContext } from '../finance/context.js';

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-test-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const file of ['ventureUsage.json', 'ventures.json']) {
    fs.rmSync(path.join(tmpDir, file), { force: true });
  }
});

// --- The key ------------------------------------------------------------------

test('a venture key opens that venture and nothing else', () => {
  const a = mintIngestKey('v_one');
  const b = mintIngestKey('v_two');
  assert.notEqual(a, b);
  assert.equal(verifyIngestKey('v_one', a), true);
  // The whole reason ingest does not use the app token: a compromised product
  // must not be able to touch anything but its own counters.
  assert.equal(verifyIngestKey('v_two', a), false);
  assert.equal(verifyIngestKey('v_one', b), false);
});

test('a missing or wrong key is refused without throwing', () => {
  assert.equal(verifyIngestKey('v_never_minted', 'anything'), false);
  mintIngestKey('v_one');
  assert.equal(verifyIngestKey('v_one', ''), false);
  assert.equal(verifyIngestKey('v_one', null), false);
  // Different lengths must not throw out of timingSafeEqual.
  assert.equal(verifyIngestKey('v_one', 'short'), false);
});

test('minting again replaces the key without losing the counters', () => {
  mintIngestKey('v_one');
  recordUsage('v_one', { calls: 5 });
  const rotated = mintIngestKey('v_one');
  assert.equal(verifyIngestKey('v_one', rotated), true);
  assert.equal(usageSummary('v_one').calls, 5, 'rotating a credential must not erase the history');
});

// --- Counting -----------------------------------------------------------------

test('batches accumulate into one day', () => {
  recordUsage('v_one', { calls: 10, errors: 1, callers: ['a', 'b'] });
  recordUsage('v_one', { calls: 5, callers: ['a', 'c'] });
  const summary = usageSummary('v_one');
  assert.equal(summary.calls, 15);
  assert.equal(summary.errors, 1);
  // The same caller twice is one caller. Summing the daily distincts would
  // report a week of one customer as seven customers.
  assert.equal(summary.callers, 3);
});

test('an empty report is refused rather than recorded as a zero day', () => {
  // A zero day and no day are different: one says the product was counting and
  // nobody called, the other says nothing at all.
  assert.throws(() => recordUsage('v_one', { calls: 0, errors: 0 }), /at least one/);
});

test('the caller set is capped so a viral day cannot eat the disk', () => {
  const many = Array.from({ length: MAX_TRACKED_CALLERS + 50 }, (_, i) => `caller-${i}`);
  recordUsage('v_one', { calls: many.length, callers: many });
  const summary = usageSummary('v_one');
  assert.equal(summary.calls, many.length, 'the count keeps rising');
  assert.equal(summary.callers, MAX_TRACKED_CALLERS, 'the identities stop being recorded first');
});

test('negative and nonsense counts do not corrupt the total', () => {
  recordUsage('v_one', { calls: 10 });
  recordUsage('v_one', { calls: -5, errors: 2 });
  recordUsage('v_one', { calls: 'many', errors: 1 });
  assert.equal(usageSummary('v_one').calls, 10);
  assert.equal(usageSummary('v_one').errors, 3);
});

// --- The two states that look alike -------------------------------------------

test('never reported and reported nothing are different answers', () => {
  const unknown = usageSummary('v_never');
  assert.equal(unknown.known, false);

  recordUsage('v_one', { calls: 3 });
  const known = usageSummary('v_one');
  assert.equal(known.known, true);
  assert.equal(known.silent, false);
});

test('silence is reported as a finding, not as missing data', () => {
  recordUsage('v_one', { errors: 4 });
  const summary = usageSummary('v_one');
  assert.equal(summary.known, true);
  assert.equal(summary.silent, true, 'errors without calls is still nobody successfully using it');
  assert.equal(summary.calls, 0);
});

test('hasIngestKey tells "not deployed" apart from "not wired up"', () => {
  assert.equal(hasIngestKey('v_one'), false);
  mintIngestKey('v_one');
  assert.equal(hasIngestKey('v_one'), true);
  // A key with no reports means the code exists and is not calling home, which
  // is a different problem from having no key at all.
  assert.equal(usageSummary('v_one').known, false);
});

// --- What the team sees ---------------------------------------------------------

test('the shared context names silent ventures first', () => {
  const quiet = createVenture({ title: 'Quiet', oneLiner: 'x', proposedBy: 'venture_partner' });
  const busy = createVenture({ title: 'Busy', oneLiner: 'y', proposedBy: 'venture_partner' });
  for (const v of [quiet, busy]) {
    linkRepo(v.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  }
  recordUsage(quiet.id, { errors: 1 });
  recordUsage(busy.id, { calls: 200, callers: ['a', 'b'] });

  const text = buildUsageContext();
  assert.match(text, /SILENT/);
  // A week of silence on a deployed product is the most important sentence in
  // the context; buried under a table of zeros it gets skimmed past.
  assert.ok(text.indexOf('Quiet') < text.indexOf('Busy'), 'the silent one must come first');
  assert.match(text, /200 calls from 2 callers/);
});

test('ventures with no repo are left out entirely', () => {
  createVenture({ title: 'Just an idea', oneLiner: 'x', proposedBy: 'venture_partner' });
  assert.equal(buildUsageContext(), '', 'nothing is deployed, so there is nothing to say about usage');
});

test('a deployed venture that was never instrumented says so', () => {
  const venture = createVenture({ title: 'Shipped', oneLiner: 'x', proposedBy: 'venture_partner' });
  linkRepo(venture.id, { owner: 'acme', name: 'app', branch: 'main', allowedPaths: ['src/'], maxPerWeek: 5 });
  assert.match(buildUsageContext(), /not reporting usage/);
});
