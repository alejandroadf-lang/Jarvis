import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transparency, USE_BAN, NEVER_MEASURED } from '../src/lib/transparency.mjs';
import { INDICATOR_KEYS, BANDS } from '../src/lib/score.mjs';

test('every active signal is listed under its dimension, and switched-off ones disappear', () => {
  const all = transparency();
  assert.equal(all.measured.flatMap((d) => d.signals).length, INDICATOR_KEYS.length);
  const off = transparency({ disabled: { lateShare: false } });
  assert.equal(off.measured.flatMap((d) => d.signals).includes(BANDS.lateShare.label), false);
});

test('the use ban and the never-measured list are stated plainly', () => {
  assert.match(USE_BAN, /may not be used to assess, rank, pay, reward, promote, discipline or dismiss any person/);
  assert.ok(NEVER_MEASURED.some((l) => /Stress, emotions or health/.test(l)));
  assert.match(transparency({ minGroup: 7 }).rules[0], /fewer than 7/);
});
