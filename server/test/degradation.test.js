// The failure this guards against produced no error at all: a retired model
// id meant every specialist call 404'd and fell back to Claude, correctly
// and silently, at 25x the intended price. The only trace was a console
// warning in a log nobody reads.
//
// So what is tested here is that the number reaches the founder on its own.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let degradation;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-degradation-'));
  process.env.JARVIS_DATA_DIR = tmpDir;
  degradation = await import('../degradation.js');
});

after(() => {
  delete process.env.JARVIS_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'degradation.json'), { force: true });
});

test('nothing degraded means nothing is said', () => {
  // Not "all good": this text is appended to replies, and a reassurance on
  // every message is what makes a real warning easy to miss.
  assert.equal(degradation.describeDegradation(), '');
  assert.equal(degradation.getDegradationToday().count, 0);
});

test('a fallback is counted, costed, and described', () => {
  degradation.recordFallback({
    from: 'nousresearch/hermes-4-70b',
    to: 'claude-sonnet-5',
    reason: 'OpenRouter returned 404',
    extraUsd: 0.0125,
  });

  const today = degradation.getDegradationToday();
  assert.equal(today.count, 1);
  assert.equal(today.extraUsd, 0.0125);

  const text = degradation.describeDegradation();
  assert.match(text, /1 agent turn ran on a fallback model today/);
  assert.match(text, /\$0\.01/, 'the founder gets a number, not an adjective');
  assert.match(text, /404/, 'and the reason, so it is actionable');
});

test('many identical failures collapse to one line with a count', () => {
  // Twelve specialists falling back on one turn is one problem, not twelve.
  for (let i = 0; i < 12; i += 1) {
    degradation.recordFallback({
      from: 'retired/model',
      to: 'claude-sonnet-5',
      reason: 'OpenRouter returned 404',
      extraUsd: 0.01,
    });
  }

  const text = degradation.describeDegradation();
  assert.match(text, /12 agent turns/);
  assert.match(text, /×12/, 'one line with a count, not twelve lines');
  assert.equal(text.split('\n').length, 1);
  assert.equal(degradation.getDegradationToday().extraUsd.toFixed(2), '0.12');
});

test('the most common reason is the one reported', () => {
  degradation.recordFallback({ from: 'a', to: 'b', reason: 'rare thing' });
  for (let i = 0; i < 5; i += 1) {
    degradation.recordFallback({ from: 'a', to: 'b', reason: 'the actual problem' });
  }
  assert.match(degradation.describeDegradation(), /the actual problem ×5/);
});

test('a cheaper fallback still counts but is not billed as a surcharge', () => {
  // Falling back to something cheaper is still degradation worth knowing
  // about — it just isn't money lost, and reporting a negative surcharge
  // would read as a refund.
  degradation.recordFallback({ from: 'expensive', to: 'cheap', reason: 'outage', extraUsd: -5 });
  const today = degradation.getDegradationToday();
  assert.equal(today.count, 1);
  assert.equal(today.extraUsd, 0);
  assert.doesNotMatch(degradation.describeDegradation(), /\$/);
});
