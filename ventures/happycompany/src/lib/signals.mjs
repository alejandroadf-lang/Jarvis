// Counting work signals into buckets, and turning buckets into metrics.
//
// A bucket is one team (a Jira project or a Confluence space) for one calendar
// day. It holds counts only: how many actions, how many of them after hours,
// late at night, or on a rest day, and per pseudonymous person how many
// actions, which hours of the day they were active, which items (hashed) they
// touched and how many times they were mentioned. Nothing about *what* was
// done is kept, so a leaked bucket says "someone on team X worked late on
// Tuesday across nine tickets" and nothing more.
//
// "After hours", "late", the weekend and holidays are settings, not
// constants: quiet hours differ by team, the weekend is Friday–Saturday in
// several countries where Jira is common, and public holidays are local. The
// defaults are the ones most teams would recognise.
//
// ## Why the per-person fields exist
//
// The signals in SIGNALS.md that describe an 8-to-12-hour day (long-span
// days, fragmentation, mention load, streaks) cannot be computed from team
// totals: they are properties of a person-day, aggregated afterwards. So the
// bucket keeps, per pseudonym, the *hours* active (24 possible values, not
// timestamps), the item hashes touched (capped) and a mention count. All of
// it dies with the bucket after RETAIN_DAYS; weekly aggregates keep the
// derived shares only.

export const DEFAULT_SETTINGS = Object.freeze({
  timeZone: 'UTC',
  quietStart: 20, // first quiet hour, local
  quietEnd: 7, // first working hour, local
  lateStart: 22, // late night, weighted separately from the evening
  lateEnd: 5,
  weekendDays: Object.freeze([6, 0]), // Saturday, Sunday
  holidays: Object.freeze([]), // "YYYY-MM-DD" dates the team has off
  longSpanHours: 11, // a person-day whose first and last action are this far apart
  signals: Object.freeze({}), // indicator key -> false to switch it off
});

export const MAX_ITEMS_PER_PERSON_DAY = 200;
export const BURSTY_BURSTS = 4; // separate activity runs in a day that count as fragmented

export function emptyBucket() {
  return { v: 2, total: 0, afterHours: 0, late: 0, weekend: 0, kinds: {}, tags: {}, people: {} };
}

function inWindow(hour, start, end) {
  // Windows normally wrap midnight (20 -> 7). A team can also set one that
  // does not (say 0 -> 6), which is the second branch.
  if (start > end) return hour >= start || hour < end;
  return hour >= start && hour < end;
}

export function isAfterHours(hour, settings = DEFAULT_SETTINGS) {
  return inWindow(hour, settings.quietStart, settings.quietEnd);
}

export function isLate(hour, settings = DEFAULT_SETTINGS) {
  return inWindow(hour, settings.lateStart, settings.lateEnd);
}

/** A weekend day or a holiday: a day the team is meant to be off. */
export function isRestDay(weekday, day, settings = DEFAULT_SETTINGS) {
  return settings.weekendDays.includes(weekday) || (settings.holidays || []).includes(day);
}

// Older buckets (v1) kept `byActor: {pseudonym: count}`. They are read, never
// written, until retention removes them.
export function upgradeBucket(bucket) {
  if (!bucket || bucket.v === 2) return bucket;
  const people = {};
  for (const [who, n] of Object.entries(bucket.byActor || {})) people[who] = { n, hours: [], items: [], mentions: 0 };
  return { v: 2, total: bucket.total || 0, afterHours: bucket.afterHours || 0, late: 0, weekend: bucket.weekend || 0, kinds: bucket.kinds || {}, people };
}

function person(bucket, who) {
  if (!bucket.people[who]) bucket.people[who] = { n: 0, hours: [], items: [], mentions: 0 };
  return bucket.people[who];
}

/** Adds one action to a bucket. Returns the same bucket for chaining. */
export function recordActivity(bucket, { actor, hour, weekday, day, kind = 'activity', item = null, tags = [] }, settings = DEFAULT_SETTINGS) {
  if (!actor) throw new Error('an activity needs a pseudonymous actor');
  bucket.total += 1;
  if (isAfterHours(hour, settings)) bucket.afterHours += 1;
  if (isLate(hour, settings)) bucket.late += 1;
  if (isRestDay(weekday, day, settings)) bucket.weekend += 1;
  bucket.kinds[kind] = (bucket.kinds[kind] || 0) + 1;
  // Tags are facts about the action beyond its kind: a due date moved, say.
  // One action can carry several; kinds are one per action.
  if (!bucket.tags) bucket.tags = {};
  for (const tag of tags) bucket.tags[tag] = (bucket.tags[tag] || 0) + 1;
  const p = person(bucket, actor);
  p.n += 1;
  if (!p.hours.includes(hour)) p.hours.push(hour);
  if (item && !p.items.includes(item) && p.items.length < MAX_ITEMS_PER_PERSON_DAY) p.items.push(item);
  return bucket;
}

/** Someone was @mentioned. Not an action of theirs: it lands on the mentioned person. */
export function recordMention(bucket, { mentioned }) {
  if (!mentioned) throw new Error('a mention needs the mentioned pseudonym');
  person(bucket, mentioned).mentions += 1;
  return bucket;
}

/** Number of separate runs of active hours in a day: 9,10,11,14,15 is two bursts. */
export function bursts(hours) {
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  let runs = 0;
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1] + 1) runs += 1;
  return runs;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The metrics of a period, from its day buckets.
 *
 * Shares are null, not 0, when there was nothing to count: "no data" and
 * "nobody worked late" must not look the same on the page.
 *
 * `topShare` is the share of all actions by the single busiest person and
 * `hhi` the Herfindahl index of the same distribution (1 = one person did
 * everything, 1/n = perfectly even). The score uses topShare because a
 * manager can picture it; hhi is kept for comparing teams of different sizes.
 */
export function periodMetrics(dayBuckets, settings = DEFAULT_SETTINGS) {
  const days = (dayBuckets || []).map(upgradeBucket).filter(Boolean);
  let total = 0;
  let afterHours = 0;
  let late = 0;
  let weekend = 0;
  const kinds = {};
  const tags = {};
  const perPerson = {};
  const mentionsPerPerson = {};
  let personDays = 0;
  let longSpanDays = 0;
  let burstyDays = 0;
  const itemsPerPersonDay = [];

  for (const b of days) {
    total += b.total;
    afterHours += b.afterHours;
    late += b.late || 0;
    weekend += b.weekend;
    for (const [k, n] of Object.entries(b.kinds || {})) kinds[k] = (kinds[k] || 0) + n;
    for (const [k, n] of Object.entries(b.tags || {})) tags[k] = (tags[k] || 0) + n;
    for (const [who, p] of Object.entries(b.people || {})) {
      if (p.mentions) mentionsPerPerson[who] = (mentionsPerPerson[who] || 0) + p.mentions;
      if (!p.n) continue; // mentioned but not active that day
      perPerson[who] = (perPerson[who] || 0) + p.n;
      personDays += 1;
      if (p.hours.length) {
        const span = Math.max(...p.hours) - Math.min(...p.hours);
        if (span >= settings.longSpanHours) longSpanDays += 1;
        if (bursts(p.hours) >= BURSTY_BURSTS) burstyDays += 1;
      }
      if (p.items.length) itemsPerPersonDay.push(p.items.length);
    }
  }

  const counts = Object.values(perPerson);
  const contributors = counts.length;
  const share = (n, of) => (of ? n / of : null);
  const mentionTotal = Object.values(mentionsPerPerson).reduce((a, b) => a + b, 0);
  const mentionTop = Object.values(mentionsPerPerson).length ? Math.max(...Object.values(mentionsPerPerson)) : 0;
  const resolved = kinds.resolved || 0;
  const reopened = kinds.reopened || 0;

  return {
    total,
    contributors,
    personDays,
    afterHoursShare: share(afterHours, total),
    lateShare: share(late, total),
    weekendShare: share(weekend, total),
    topShare: share(counts.length ? Math.max(...counts) : 0, total),
    hhi: total ? counts.reduce((sum, n) => sum + (n / total) ** 2, 0) : null,
    longSpanShare: share(longSpanDays, personDays),
    burstyShare: share(burstyDays, personDays),
    itemsMedian: median(itemsPerPersonDay),
    mentionsPerPersonDay: personDays ? mentionTotal / personDays : null,
    mentionTopShare: mentionTotal ? mentionTop / mentionTotal : null,
    reopenRate: resolved + reopened ? reopened / (resolved + reopened) : null,
    dueMoves: tags.dueMoved || 0,
    kinds,
    tags,
  };
}
