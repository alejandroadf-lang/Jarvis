// The application, with every Forge dependency injected.
//
// Forge hands us four entry points: two product-event handlers, one scheduled
// function and one resolver for the page. All four are methods on the object
// createApp() returns, and everything they need — storage, the Jira and
// Confluence REST clients, the clock — comes in through the constructor. That
// is what lets test/app.test.mjs run the whole app against an in-memory store
// and a fake Jira, and it is why src/index.js is five lines of wiring.
//
// ## The concurrency caveat
//
// A day bucket is read, incremented and written back. Two events for the same
// team in the same second can race and one increment is lost. For a signal
// that is a share of hundreds of actions a week this does not move the
// result, and the alternative (one key per event, and a query fan-out on every
// page view) costs far more than it protects. If a customer ever has teams
// busy enough for this to matter, the fix is a per-day transaction on the
// bucket key, which @forge/kvs supports.

import { DEFAULT_SETTINGS, emptyBucket, recordActivity, mergeBuckets, periodMetrics } from './lib/signals.mjs';
import { localParts, isoWeek, daysOfWeek, previousWeeks, addDays, isValidZone, parseInstant } from './lib/time.mjs';
import { newSalt, pseudonym, publicMetrics, MIN_GROUP, RETAIN_DAYS, RETAIN_WEEKS, TIMEZONE_CACHE_DAYS } from './lib/privacy.mjs';
import { scorecard, trend } from './lib/score.mjs';
import { normaliseJiraEvent, normaliseConfluenceEvent, confluenceScope } from './lib/events.mjs';
import { openWorkSnapshot } from './lib/openwork.mjs';

export const WEEKS_SHOWN = 12;
const SNAPSHOT_RETAIN_DAYS = 91;

/** Settings as a caller may set them: validated, or an Error naming the field. */
export function validateSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  if (!isValidZone(s.timeZone)) throw new Error(`timeZone must be an IANA zone such as Europe/Berlin, not ${JSON.stringify(s.timeZone)}`);
  for (const field of ['quietStart', 'quietEnd']) {
    const n = Number(s[field]);
    if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error(`${field} must be a whole hour from 0 to 23`);
    s[field] = n;
  }
  if (s.quietStart === s.quietEnd) throw new Error('quietStart and quietEnd must differ');
  const days = Array.isArray(s.weekendDays) ? s.weekendDays : String(s.weekendDays).split(',');
  const weekend = [...new Set(days.map((d) => Number(String(d).trim())))];
  if (weekend.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('weekendDays must be weekday numbers from 0 (Sunday) to 6 (Saturday)');
  if (weekend.length > 3) throw new Error('weekendDays lists more than three days');
  s.weekendDays = weekend;
  return { timeZone: s.timeZone, quietStart: s.quietStart, quietEnd: s.quietEnd, weekendDays: s.weekendDays };
}

export function createApp({ store, jira = null, confluence = null, now = () => new Date(), log = console }) {
  if (!store) throw new Error('createApp needs a store');

  let saltCache;
  async function salt() {
    if (saltCache) return saltCache;
    let value = await store.getSecret('salt');
    if (!value) {
      value = newSalt();
      await store.setSecret('salt', value);
    }
    saltCache = value;
    return value;
  }

  const todayUtc = () => now().toISOString().slice(0, 10);

  async function settingsFor(scope) {
    const saved = await store.get(`settings:${scope}`);
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  }

  async function rememberScope(scope, product) {
    const scopes = (await store.get('scopes')) || [];
    if (scopes.some((s) => s.scope === scope)) return;
    scopes.push({ scope, product });
    await store.set('scopes', scopes);
  }

  // A person's own time zone when Jira will tell us, the team's otherwise.
  // Confluence has no per-user time zone API, so Confluence always uses the
  // team setting; that is the main reason the setting exists.
  async function zoneFor(activity, settings, who) {
    if (activity.product !== 'jira' || !jira?.userTimeZone) return settings.timeZone;
    const key = `tz:${who}`;
    const today = todayUtc();
    const cached = await store.get(key);
    if (cached?.zone && cached.until > today) return cached.zone;
    let zone = null;
    try {
      zone = await jira.userTimeZone(activity.actor);
    } catch (err) {
      log.warn(`[happycompany] time zone lookup failed, using team zone: ${err.message}`);
    }
    if (!zone || !isValidZone(zone)) return settings.timeZone;
    await store.set(key, { zone, until: addDays(today, TIMEZONE_CACHE_DAYS) });
    return zone;
  }

  async function ingest(activity) {
    const settings = await settingsFor(activity.scope);
    const who = pseudonym(activity.actor, await salt());
    const zone = await zoneFor(activity, settings, who);
    const parts = localParts(parseInstant(activity.at) || now(), zone);
    const key = `day:${activity.scope}:${parts.day}`;
    const bucket = (await store.get(key)) || emptyBucket();
    recordActivity(bucket, { actor: who, hour: parts.hour, weekday: parts.weekday, kind: activity.kind }, settings);
    await store.set(key, bucket);
    await rememberScope(activity.scope, activity.product);
    return { scope: activity.scope, day: parts.day, hour: parts.hour };
  }

  async function onJiraEvent(event) {
    const activity = normaliseJiraEvent(event, now().toISOString());
    if (!activity) return { counted: false };
    return { counted: true, ...(await ingest(activity)) };
  }

  async function onConfluenceEvent(event) {
    const activity = normaliseConfluenceEvent(event, now().toISOString());
    if (!activity) return { counted: false };
    if (!activity.scope && activity.lookup?.contentId && confluence?.spaceIdFor) {
      try {
        const spaceId = await confluence.spaceIdFor(activity.lookup);
        if (spaceId) activity.scope = confluenceScope(spaceId);
      } catch (err) {
        log.warn(`[happycompany] space lookup failed for content ${activity.lookup.contentId}: ${err.message}`);
      }
    }
    if (!activity.scope) {
      log.warn(`[happycompany] ${event.eventType} carried no space; not counted`);
      return { counted: false };
    }
    return { counted: true, ...(await ingest(activity)) };
  }

  async function weekBucketFromDays(scope, week) {
    const days = await Promise.all(daysOfWeek(week).map((day) => store.get(`day:${scope}:${day}`)));
    if (days.every((d) => !d)) return null;
    return mergeBuckets(days);
  }

  async function weekMetrics(scope, week) {
    const stored = await store.get(`wk:${scope}:${week}`);
    if (stored?.metrics) return stored.metrics;
    const bucket = await weekBucketFromDays(scope, week);
    return bucket ? periodMetrics(bucket) : null;
  }

  async function snapshots(scope) {
    const rows = (await store.list(`wip:${scope}:`)).map((r) => r.value).filter((v) => v?.day);
    rows.sort((a, b) => (a.day < b.day ? -1 : 1));
    const byWeek = {};
    for (const snap of rows) byWeek[isoWeek(snap.day)] = snap; // last of the week wins
    return { byWeek, latest: rows[rows.length - 1] || null };
  }

  /** What the page shows. Never contains a pseudonym or a per-person count. */
  async function teamHealth({ scope, product }) {
    if (!scope) throw new Error('This page only works inside a Jira project or a Confluence space.');
    await rememberScope(scope, product);
    const settings = await settingsFor(scope);
    const today = localParts(now(), settings.timeZone).day;
    const thisWeek = isoWeek(today);
    const weekKeys = [thisWeek, ...previousWeeks(thisWeek, WEEKS_SHOWN)].reverse();
    const snaps = product === 'jira' ? await snapshots(scope) : { byWeek: {}, latest: null };

    const weeks = [];
    for (const week of weekKeys) {
      const metrics = await weekMetrics(scope, week);
      const shown = publicMetrics(metrics);
      const snapshot = snaps.byWeek[week] || (week === thisWeek ? snaps.latest : null);
      const card = shown && !shown.suppressed ? scorecard(metrics, snapshot) : null;
      weeks.push({
        week,
        hasData: Boolean(metrics),
        suppressed: Boolean(shown?.suppressed),
        contributors: metrics?.contributors ?? 0,
        total: metrics?.total ?? 0,
        score: card?.score ?? null,
        grade: card?.grade ?? null,
        status: card?.status ?? 'unknown',
        dimensions: card?.dimensions ?? null,
        openWork: snapshot
          ? { day: snapshot.day, openTotal: snapshot.openTotal, unassigned: snapshot.unassigned, people: snapshot.people }
          : null,
      });
    }

    // The week on the card: this one if it can be shown, else last week. A
    // Monday morning has too little of this week to say anything.
    const current = [...weeks].reverse().find((w, i) => i < 2 && w.score !== null) || weeks[weeks.length - 1];
    const earlier = weeks
      .filter((w) => w.week < current.week && w.score !== null)
      .slice(-4)
      .map((w) => w.score);

    return {
      scope,
      product,
      generatedAt: now().toISOString(),
      settings,
      minGroup: MIN_GROUP,
      weeks,
      current,
      trend: trend(current.score, earlier),
      notes: [
        'Grades describe the team, never a person, and are indicators, not diagnoses.',
        `Nothing is shown for weeks with fewer than ${MIN_GROUP} active people.`,
        product === 'confluence'
          ? 'Confluence has no per-person time zone, so quiet hours use the team time zone in the settings below.'
          : 'Quiet hours use each person’s own Jira time zone when Jira shares it, and the team time zone otherwise.',
      ],
    };
  }

  async function saveSettings({ scope, product, projectKey, settings }) {
    if (!scope) throw new Error('This page only works inside a Jira project or a Confluence space.');
    if (product === 'jira' && jira?.canAdminister && !(await jira.canAdminister(projectKey))) {
      throw new Error('Only project administrators can change these settings.');
    }
    const clean = validateSettings(settings);
    await store.set(`settings:${scope}`, { ...clean, updatedAt: now().toISOString() });
    return settingsFor(scope);
  }

  async function expire(prefix, isExpired) {
    let n = 0;
    for (const { key, value } of await store.list(prefix)) {
      if (isExpired(key, value)) {
        await store.delete(key);
        n += 1;
      }
    }
    return n;
  }

  /** Once a day: roll completed weeks up, snapshot open work, enforce retention. */
  async function dailyRollup() {
    const scopes = (await store.get('scopes')) || [];
    const today = todayUtc();
    const thisWeek = isoWeek(today);
    const oldestWeekKept = previousWeeks(thisWeek, RETAIN_WEEKS).at(-1);
    const oldestDayKept = addDays(today, -RETAIN_DAYS);
    const oldestSnapshotKept = addDays(today, -SNAPSHOT_RETAIN_DAYS);
    const summary = { scopes: scopes.length, weeksRolled: 0, snapshots: 0, deleted: 0, errors: [] };

    for (const { scope, product } of scopes) {
      try {
        for (const week of previousWeeks(thisWeek, 3)) {
          if (await store.get(`wk:${scope}:${week}`)) continue;
          const bucket = await weekBucketFromDays(scope, week);
          if (!bucket) continue;
          await store.set(`wk:${scope}:${week}`, { week, metrics: periodMetrics(bucket), kinds: bucket.kinds, rolledAt: today });
          summary.weeksRolled += 1;
        }
        if (product === 'jira' && jira?.openIssues) {
          const projectKey = scope.slice('jira:'.length);
          const issues = await jira.openIssues(projectKey, { today });
          const key = await salt();
          await store.set(`wip:${scope}:${today}`, openWorkSnapshot(issues, (id) => pseudonym(id, key), today));
          summary.snapshots += 1;
        }
        summary.deleted += await expire(`day:${scope}:`, (k) => k.slice(-10) < oldestDayKept);
        summary.deleted += await expire(`wip:${scope}:`, (k) => k.slice(-10) < oldestSnapshotKept);
        summary.deleted += await expire(`wk:${scope}:`, (k) => k.slice(-8) < oldestWeekKept);
      } catch (err) {
        summary.errors.push({ scope, message: err.message });
        log.error(`[happycompany] rollup failed for ${scope}: ${err.message}`);
      }
    }
    summary.deleted += await expire('tz:', (_k, v) => !v?.until || v.until <= today);
    return summary;
  }

  return { onJiraEvent, onConfluenceEvent, dailyRollup, teamHealth, saveSettings, settingsFor };
}
