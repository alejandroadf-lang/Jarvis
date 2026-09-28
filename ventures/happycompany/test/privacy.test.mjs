import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pseudonym, newSalt, isPublishable, publicMetrics, MIN_GROUP } from '../src/lib/privacy.mjs';

test('pseudonyms are stable per salt and differ across installations', () => {
  const a = newSalt();
  const b = newSalt();
  assert.notEqual(a, b);
  assert.equal(pseudonym('557058:abc', a), pseudonym('557058:abc', a));
  assert.notEqual(pseudonym('557058:abc', a), pseudonym('557058:abc', b));
  assert.notEqual(pseudonym('557058:abc', a), pseudonym('557058:abd', a));
  assert.match(pseudonym('557058:abc', a), /^[0-9a-f]{16}$/);
  assert.ok(!pseudonym('557058:abc', a).includes('557058'));
  assert.throws(() => pseudonym('557058:abc', ''), /salt/);
  assert.throws(() => pseudonym('', a), /account/);
});

test('groups smaller than the minimum are suppressed and never leak per-person data', () => {
  const small = { total: 40, contributors: MIN_GROUP - 1, afterHoursShare: 0.5, weekendShare: 0.1, topShare: 0.9, hhi: 0.8, byActor: { x: 36 } };
  const shown = publicMetrics(small);
  assert.equal(shown.suppressed, true);
  assert.match(shown.reason, new RegExp(`Fewer than ${MIN_GROUP}`));
  assert.equal(shown.afterHoursShare, undefined);
  assert.equal(shown.byActor, undefined);

  const ok = publicMetrics({ ...small, contributors: MIN_GROUP });
  assert.equal(ok.suppressed, false);
  assert.equal(ok.afterHoursShare, 0.5);
  assert.equal(ok.byActor, undefined);
  assert.equal(isPublishable(undefined), false);
  assert.equal(publicMetrics(null), null);
});
