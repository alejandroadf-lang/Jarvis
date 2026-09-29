// The privacy rules, in code rather than in a policy document.
//
// This app grades teams, never people, and it is built so that it *cannot*
// grade people even if someone later wants it to:
//
//  1. Account ids are replaced by a keyed hash before they touch storage. The
//     key is generated once per installation and lives in Forge's secret
//     store, so the same person hashes differently on every customer site and
//     the hash cannot be reversed without that key.
//  2. Per-person counts exist only inside day buckets, which are deleted after
//     RETAIN_DAYS. Weekly aggregates keep the metrics and drop the counts.
//  3. Nothing is shown for a group of fewer than MIN_GROUP active people. With
//     four people, "25% of activity was after hours" points at someone; with
//     five or more it does not, which is the same threshold ISO 45003-style
//     survey tools and most works councils use for small-group reporting.
//  4. The page never receives byActor. publicMetrics() is the only path from a
//     bucket to the browser and it strips everything per person.

import { createHash, randomBytes } from 'node:crypto';

export const MIN_GROUP = 5;
export const RETAIN_DAYS = 21; // day buckets, which hold per-person counts
export const RETAIN_WEEKS = 26; // weekly aggregates, which do not
export const TIMEZONE_CACHE_DAYS = 30;

export function newSalt() {
  return randomBytes(32).toString('hex');
}

export function pseudonym(accountId, salt) {
  if (!salt) throw new Error('pseudonyms need the installation salt');
  if (!accountId) throw new Error('pseudonyms need an account id');
  return createHash('sha256').update(`${salt}:${accountId}`).digest('hex').slice(0, 16);
}

/** A short keyed hash of an issue or page id, for counting distinct items without keeping ids. */
export function itemHash(itemId, salt) {
  if (!salt) throw new Error('item hashes need the installation salt');
  if (!itemId) return null;
  return createHash('sha256').update(`${salt}:item:${itemId}`).digest('hex').slice(0, 10);
}

export function isPublishable(contributors) {
  return Number.isFinite(contributors) && contributors >= MIN_GROUP;
}

/** What a period's metrics look like once they may leave the backend. */
export function publicMetrics(metrics) {
  if (!metrics) return null;
  if (!isPublishable(metrics.contributors)) {
    return {
      suppressed: true,
      reason: `Fewer than ${MIN_GROUP} people were active, so no figures are shown. This protects individuals.`,
      total: metrics.total,
      contributors: metrics.contributors,
    };
  }
  // Everything in metrics is a team-level share or count. The one thing that
  // must never pass is a per-person map, and periodMetrics never emits one;
  // this copies field by field so a future field has to be added here on purpose.
  const {
    total, contributors, personDays, afterHoursShare, lateShare, weekendShare, topShare, hhi,
    longSpanShare, burstyShare, itemsMedian, mentionsPerPersonDay, mentionTopShare, reopenRate, dueMoves,
    streakShare, noRestShare, carryOverShare, unplannedShare, inflowRatio, loadSurge, dueMoveRate, kinds,
  } = metrics;
  return {
    suppressed: false, total, contributors, personDays, afterHoursShare, lateShare, weekendShare, topShare, hhi,
    longSpanShare, burstyShare, itemsMedian, mentionsPerPersonDay, mentionTopShare, reopenRate, dueMoves: dueMoves || 0,
    streakShare: streakShare ?? null, noRestShare: noRestShare ?? null,
    carryOverShare: carryOverShare ?? null, unplannedShare: unplannedShare ?? null,
    inflowRatio: inflowRatio ?? null, loadSurge: loadSurge ?? null, dueMoveRate: dueMoveRate ?? null,
    kinds: kinds || {},
  };
}
