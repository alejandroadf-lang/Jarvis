// Counting work signals into buckets, and turning a bucket into metrics.
//
// A bucket is one team (a Jira project or a Confluence space) for one calendar
// day. It holds counts only: how many actions, how many of them after hours,
// how many on a weekend day, and how many by each pseudonymous person. That is
// the entire data model, and it is small on purpose. Nothing about *what* was
// done is kept, so a leaked bucket says "someone on team X worked late on
// Tuesday" and nothing more.
//
// "After hours" and "weekend" are settings, not constants: quiet hours differ
// by team and the weekend is Friday-Saturday in several countries where Jira
// is common. The defaults are the ones most teams would recognise.

export const DEFAULT_SETTINGS = Object.freeze({
  timeZone: 'UTC',
  quietStart: 20, // first quiet hour, local
  quietEnd: 7, // first working hour, local
  weekendDays: Object.freeze([6, 0]), // Saturday, Sunday
});

export function emptyBucket() {
  return { total: 0, afterHours: 0, weekend: 0, byActor: {}, kinds: {} };
}

export function isAfterHours(hour, settings = DEFAULT_SETTINGS) {
  const { quietStart, quietEnd } = settings;
  // Quiet hours normally wrap midnight (20 -> 7). A team can also set a window
  // that does not (say 0 -> 6), which is the second branch.
  if (quietStart > quietEnd) return hour >= quietStart || hour < quietEnd;
  return hour >= quietStart && hour < quietEnd;
}

export function isWeekend(weekday, settings = DEFAULT_SETTINGS) {
  return settings.weekendDays.includes(weekday);
}

/** Adds one action to a bucket. Returns the same bucket for chaining. */
export function recordActivity(bucket, { actor, hour, weekday, kind = 'activity' }, settings = DEFAULT_SETTINGS) {
  if (!actor) throw new Error('an activity needs a pseudonymous actor');
  bucket.total += 1;
  if (isAfterHours(hour, settings)) bucket.afterHours += 1;
  if (isWeekend(weekday, settings)) bucket.weekend += 1;
  bucket.byActor[actor] = (bucket.byActor[actor] || 0) + 1;
  bucket.kinds[kind] = (bucket.kinds[kind] || 0) + 1;
  return bucket;
}

export function mergeBuckets(buckets) {
  const out = emptyBucket();
  for (const b of buckets) {
    if (!b) continue;
    out.total += b.total || 0;
    out.afterHours += b.afterHours || 0;
    out.weekend += b.weekend || 0;
    for (const [actor, n] of Object.entries(b.byActor || {})) out.byActor[actor] = (out.byActor[actor] || 0) + n;
    for (const [kind, n] of Object.entries(b.kinds || {})) out.kinds[kind] = (out.kinds[kind] || 0) + n;
  }
  return out;
}

/**
 * The metrics of a period, computed from a (merged) bucket.
 *
 * `topShare` is the share of all actions done by the single busiest person and
 * `hhi` the Herfindahl index of the same distribution (1 = one person did
 * everything, 1/n = perfectly even). Both are concentration measures; the
 * score uses topShare because a manager can picture it, hhi is kept because it
 * is what you would want when comparing teams of different sizes.
 *
 * Shares are null, not 0, when there was no activity: "no data" and "nobody
 * worked late" must not look the same on the page.
 */
export function periodMetrics(bucket) {
  const total = bucket.total || 0;
  const counts = Object.values(bucket.byActor || {});
  const contributors = counts.length;
  const share = (n) => (total ? n / total : null);
  const top = counts.length ? Math.max(...counts) : 0;
  return {
    total,
    contributors,
    afterHoursShare: share(bucket.afterHours || 0),
    weekendShare: share(bucket.weekend || 0),
    topShare: share(top),
    hhi: total ? counts.reduce((sum, n) => sum + (n / total) ** 2, 0) : null,
  };
}
