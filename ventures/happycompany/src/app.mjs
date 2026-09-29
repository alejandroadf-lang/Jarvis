// The application, with every Forge dependency injected.
//
// Forge hands us four entry points: two product-event handlers, one scheduled
// function and one resolver for the page. All four are methods on the object
// createApp() returns, and everything they need — storage, the Jira and
// Confluence REST clients, the clock — comes in through the constructor. That
// is what lets test/app.test.mjs run the whole app against an in-memory store
// and a fake Jira, and it is why src/index.js is a few lines of wiring.
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

import { DEFAULT_SETTINGS, emptyBucket, recordActivity, recordMention, periodMetrics, upgradeBucket } from './lib/signals.mjs';
import { localParts, isoWeek, daysOfWeek, previousWeeks, addDays, isValidZone, parseInstant } from './lib/time.mjs';
import { newSalt, pseudonym, itemHash, publicMetrics, MIN_GROUP, RETAIN_DAYS, RETAIN_WEEKS, TIMEZONE_CACHE_DAYS } from './lib/privacy.mjs';
import { scorecard, trend, INDICATOR_KEYS } from './lib/score.mjs';
import { normaliseJiraEvent, normaliseJiraMention, normaliseConfluenceEvent, confluenceScope } from './lib/events.mjs';
import { openWorkSnapshot } from './lib/openwork.mjs';
import { activeDaysByPerson, streakShare, updatePeopleRecord, noRestShare } from './lib/recovery.mjs';
import { sprintSummary, sprintMetricsForWeek, SPRINT_LOOKBACK_DAYS, SPRINT_FALLBACK_WEEKS } from './lib/sprints.mjs';

export const WEEKS_SHOWN = 12;
const SNAPSHOT_RETAIN_DAYS = 91;
const SPRINT_RETAIN_DAYS = 182;
const SPRINTS_REMEMBERED = 500;
const SURGE_BASELINE_WEEKS = 8;
const INFLOW_WEEKS = 4;
const STATUS_CACHE_DAYS = 7;
const MAX_HOLIDAYS = 60;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Settings as a caller may set them: validated, or an Error naming the field. */
export function validateSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  if (!isValidZone(s.timeZone)) throw new Error(`timeZone must be an IANA zone such as Europe/Berlin, not ${JSON.stringify(s.timeZone)}`);
  for (const field of ['quietStart', 'quietEnd', 'lateStart', 'lateEnd']) {
    const n = Number(s[field]);
    if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error(`${field} must be a whole hour from 0 to 23`);
    s[field] = n;
  }
  if (s.quietStart === s.quietEnd) throw new Error('quietStart and quietEnd must differ');
  if (s.lateStart === s.lateEnd) throw new Error('lateStart and lateEnd must differ');
  const days = Array.isArray(s.weekendDays) ? s.weekendDays : String(s.weekendDays).split(',');
  const weekend = [...new Set(days.map((d) => Number(String(d).trim())).filter((d) => !Number.isNaN(d)))];
  if (weekend.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('weekendDays must be weekday numbers from 0 (Sunday) to 6 (Saturday)');
  if (weekend.length > 3) throw new Error('weekendDays lists more than three days');
  const holidayList = Array.isArray(s.holidays) ? s.holidays : String(s.holidays || '').split(/[\s,;]+/);
  const holidays = [...new Set(holidayList.map((d) => String(d).trim()).filter(Boolean))].sort();
  if (holidays.some((d) => !DAY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) throw new Error('holidays must be dates written YYYY-MM-DD');
  if (holidays.length > MAX_HOLIDAYS) throw new Error(`holidays lists more than ${MAX_HOLIDAYS} dates`);
  const span = Number(s.longSpanHours);
  if (!Number.isInteger(span) || span < 8 || span > 16) throw new Error('longSpanHours must be a whole number of hours from 8 to 16');
  const signals = {};
  for (const [key, on] of Object.entries(s.signals || {})) {
    if (!INDICATOR_KEYS.includes(key)) throw new Error(`unknown signal ${JSON.stringify(key)}`);
    if (on === false || on === 'false' || on === 0) signals[key] = false;
  }
  return {
    timeZone: s.timeZone,
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
    lateStart: s.lateStart,
    lateEnd: s.lateEnd,
    weekendDays: weekend,
    holidays,
    longSpanHours: span,
    signals,
  };
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

  // Status ids -> categories, fetched once a week, so a status change can be
  // read as "resolved" or "reopened" without an API call per event.
  // An unknown id refreshes the list at most once a day: a status created
  // today is recognised tomorrow, and a deleted one cannot cause a fetch per
  // event.
  async function statusCategory(id) {
    if (!id || !jira?.statusCategories) return null;
    const today = todayUtc();
    let cached = await store.get('statuses');
    const stale = !cached || cached.until <= today;
    const unknown = cached && !(id in cached.map) && cached.fetchedOn !== today;
    if (stale || unknown) {
      try {
        cached = { map: await jira.statusCategories(), fetchedOn: today, until: addDays(today, STATUS_CACHE_DAYS) };
        await store.set('statuses', cached);
      } catch (err) {
        log.warn(`[happycompany] status list failed: ${err.message}`);
        return cached?.map?.[id] ?? null;
      }
    }
    return cached.map[id] ?? null;
  }

  // "updated" becomes "resolved" or "reopened" when the status crossed the
  // Done line; those two feed the reopen rate. Everything else stays as is.
  async function kindOf(activity) {
    if (activity.kind !== 'updated' || !activity.status) return activity.kind;
    const from = await statusCategory(activity.status.from);
    const to = await statusCategory(activity.status.to);
    if (from && to && from !== 'done' && to === 'done') return 'resolved';
    if (from && to && from === 'done' && to !== 'done') return 'reopened';
    return activity.kind;
  }

  async function ingest(activity) {
    const settings = await settingsFor(activity.scope);
    const key = await salt();
    const who = pseudonym(activity.actor, key);
    const zone = await zoneFor(activity, settings, who);
    const parts = localParts(parseInstant(activity.at) || now(), zone);
    const bucketKey = `day:${activity.scope}:${parts.day}`;
    const bucket = upgradeBucket(await store.get(bucketKey)) || emptyBucket();
    recordActivity(
      bucket,
      { actor: who, hour: parts.hour, weekday: parts.weekday, day: parts.day, kind: await kindOf(activity), item: itemHash(activity.item, key), tags: activity.tags || [] },
      settings,
    );
    await store.set(bucketKey, bucket);
    await rememberScope(activity.scope, activity.product);
    return { scope: activity.scope, day: parts.day, hour: parts.hour };
  }

  async function ingestMention(mention) {
    const settings = await settingsFor(mention.scope);
    const key = await salt();
    // Mentions are placed on the team's calendar day: the mentioned person's
    // zone is unknown until they act, and the count is per day, not per hour.
    const parts = localParts(parseInstant(mention.at) || now(), settings.timeZone);
    const bucketKey = `day:${mention.scope}:${parts.day}`;
    const bucket = upgradeBucket(await store.get(bucketKey)) || emptyBucket();
    for (const accountId of mention.mentioned) recordMention(bucket, { mentioned: pseudonym(accountId, key) });
    await store.set(bucketKey, bucket);
    await rememberScope(mention.scope, mention.product);
    return { scope: mention.scope, day: parts.day, mentions: mention.mentioned.length };
  }

  async function onJiraEvent(event) {
    const mention = normaliseJiraMention(event, now().toISOString());
    if (mention) return { counted: true, ...(await ingestMention(mention)) };
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

  /** [{day, bucket}] for the given days, buckets upgraded, missing days omitted. */
  async function dayRows(scope, days) {
    const buckets = await Promise.all(days.map((day) => store.get(`day:${scope}:${day}`)));
    return days.map((day, i) => ({ day, bucket: upgradeBucket(buckets[i]) })).filter((r) => r.bucket);
  }

  // The 21-day window ending on `lastDay`, for streaks and rests.
  async function windowRows(scope, lastDay) {
    const days = Array.from({ length: RETAIN_DAYS }, (_, i) => addDays(lastDay, -i)).reverse();
    return dayRows(scope, days);
  }

  async function weekMetricsFromDays(scope, week, settings, lastDay) {
    const rows = await dayRows(scope, daysOfWeek(week));
    if (!rows.length) return null;
    const metrics = periodMetrics(rows.map((r) => r.bucket), settings);
    const window = await windowRows(scope, lastDay);
    const byPerson = activeDaysByPerson(window);
    const weekDays = daysOfWeek(week);
    metrics.streakShare = streakShare(byPerson, weekDays, lastDay);
    const record = (await store.get(`people:${scope}`)) || {};
    const activeThisWeek = Object.keys(activeDaysByPerson(rows));
    metrics.noRestShare = noRestShare(record, activeThisWeek, lastDay);
    return metrics;
  }

  async function weekMetrics(scope, week, settings, today) {
    const stored = await store.get(`wk:${scope}:${week}`);
    if (stored?.metrics) return stored.metrics;
    const sunday = daysOfWeek(week)[6];
    return weekMetricsFromDays(scope, week, settings, sunday < today ? sunday : today);
  }

  async function snapshots(scope) {
    const rows = (await store.list(`wip:${scope}:`)).map((r) => r.value).filter((v) => v?.day);
    rows.sort((a, b) => (a.day < b.day ? -1 : 1));
    const byWeek = {};
    for (const snap of rows) byWeek[isoWeek(snap.day)] = snap; // last of the week wins
    return { byWeek, latest: rows[rows.length - 1] || null };
  }

  async function sprintSummaries(scope) {
    return (await store.list(`sprint:${scope}:`)).map((r) => r.value).filter((v) => v?.completeDate);
  }

  // Indicators that need more than one week: inflow against outflow over
  // four weeks, this week's load against the eight before, due-date moves
  // against the dated open work, and the sprint shares. Computed at read
  // time from the per-week metrics, so they need no extra storage.
  function derive(weekKeys, metricsByWeek, snapshotByWeek, sprints) {
    weekKeys.forEach((week, index) => {
      const m = metricsByWeek[week];
      if (!m) return;
      const earlier = weekKeys.slice(0, index).map((w) => metricsByWeek[w]).filter(Boolean);

      const recent = [m, ...earlier.slice(-(INFLOW_WEEKS - 1))];
      const created = recent.reduce((a, x) => a + (x.kinds?.created || 0), 0);
      const resolved = recent.reduce((a, x) => a + (x.kinds?.resolved || 0), 0);
      m.inflowRatio = resolved >= 5 && created >= 5 ? Math.round((created / resolved) * 100) / 100 : null;

      const perPerson = (x) => (x.contributors ? x.total / x.contributors : null);
      const baseline = earlier.slice(-SURGE_BASELINE_WEEKS).map(perPerson).filter((v) => v !== null);
      if (baseline.length >= 3 && perPerson(m) !== null) {
        const sorted = [...baseline].sort((a, b) => a - b);
        const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        m.loadSurge = median > 0 ? Math.round((perPerson(m) / median) * 100) / 100 : null;
      } else m.loadSurge = null;

      const dated = snapshotByWeek[week]?.dated ?? null;
      m.dueMoveRate = dated ? Math.round(((m.dueMoves || 0) / dated) * 100) / 100 : null;

      const weekDays = daysOfWeek(week);
      const earlierDays = previousWeeks(week, SPRINT_FALLBACK_WEEKS).flatMap(daysOfWeek);
      const sm = sprintMetricsForWeek(sprints, weekDays, earlierDays);
      m.carryOverShare = sm.carryOverShare;
      m.unplannedShare = sm.unplannedShare;
    });
  }

  /** What the page shows. Never contains a pseudonym or a per-person count. */
  async function teamHealth({ scope, product }) {
    if (!scope) throw new Error('This page only works inside a Jira project or a Confluence space.');
    await rememberScope(scope, product);
    const settings = await settingsFor(scope);
    const today = localParts(now(), settings.timeZone).day;
    const thisWeek = isoWeek(today);
    const weekKeys = [thisWeek, ...previousWeeks(thisWeek, WEEKS_SHOWN + SURGE_BASELINE_WEEKS)].reverse();
    const shownKeys = weekKeys.slice(-(WEEKS_SHOWN + 1));
    const isJira = product === 'jira';
    const snaps = isJira ? await snapshots(scope) : { byWeek: {}, latest: null };
    const sprints = isJira ? await sprintSummaries(scope) : [];

    const metricsByWeek = {};
    for (const week of weekKeys) metricsByWeek[week] = await weekMetrics(scope, week, settings, today);
    const snapshotByWeek = { ...snaps.byWeek };
    if (!snapshotByWeek[thisWeek] && snaps.latest) snapshotByWeek[thisWeek] = snaps.latest;
    derive(weekKeys, metricsByWeek, snapshotByWeek, sprints);

    const weeks = [];
    for (const week of shownKeys) {
      const metrics = metricsByWeek[week];
      const shown = publicMetrics(metrics);
      const snapshot = snapshotByWeek[week] || null;
      const card = shown && !shown.suppressed ? scorecard(metrics, snapshot, settings.signals) : null;
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
        actions: card?.actions ?? [],
        openWork: snapshot
          ? { day: snapshot.day, openTotal: snapshot.openTotal, unassigned: snapshot.unassigned, unassignedOverdue: snapshot.unassignedOverdue ?? 0, people: snapshot.people }
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

    const notes = [
      'Grades describe the team, never a person, and are indicators, not diagnoses.',
      `Nothing is shown for weeks with fewer than ${MIN_GROUP} active people.`,
      product === 'confluence'
        ? 'Confluence has no per-person time zone, so quiet hours use the team time zone in the settings below.'
        : 'Quiet hours use each person’s own Jira time zone when Jira shares it, and the team time zone otherwise.',
      'This page sees the part of the day that lands in Jira and Confluence. Calls, chats and email are not counted.',
    ];
    if (current.openWork?.unassignedOverdue) {
      notes.push(`${current.openWork.unassignedOverdue} overdue items have no owner. Work nobody owns is work everybody worries about.`);
    }
    if (isJira && !sprints.length) notes.push('No closed sprints seen yet, so the sprint signals are blank. They fill in after the first sprint closes.');

    return {
      scope,
      product,
      generatedAt: now().toISOString(),
      settings,
      minGroup: MIN_GROUP,
      indicatorKeys: INDICATOR_KEYS,
      weeks: weeks.map(({ dimensions, actions, ...w }) => ({ ...w, ...(w.week === current.week ? { dimensions, actions } : {}) })),
      current,
      trend: trend(current.score, earlier),
      notes,
    };
  }

  async function saveSettings({ scope, product, projectKey, spaceId, settings }) {
    if (!scope) throw new Error('This page only works inside a Jira project or a Confluence space.');
    if (product === 'jira' && jira?.canAdminister && !(await jira.canAdminister(projectKey))) {
      throw new Error('Only project administrators can change these settings.');
    }
    if (product === 'confluence' && confluence?.canAdminister && !(await confluence.canAdminister(spaceId))) {
      throw new Error('Only space administrators can change these settings.');
    }
    const clean = validateSettings(settings);
    await store.set(`settings:${scope}`, { ...clean, updatedAt: now().toISOString() });
    return settingsFor(scope);
  }

  // Closed sprints of the project's boards, summarised once each. Boards and
  // sprint lists are cheap; the JQL per new sprint is the cost, so a sprint
  // already summarised is never fetched again.
  async function pollSprints(scope, projectKey, today) {
    const seenKey = `sprintsSeen:${scope}`;
    const seen = (await store.get(seenKey)) || [];
    const since = addDays(today, -SPRINT_LOOKBACK_DAYS);
    let added = 0;
    for (const board of await jira.boards(projectKey)) {
      for (const sprint of await jira.closedSprints(board.id, since)) {
        if (seen.includes(sprint.id)) continue;
        const summary = sprintSummary(sprint, await jira.sprintIssues(sprint.id));
        await store.set(`sprint:${scope}:${summary.completeDate}:${summary.id}`, summary);
        seen.push(sprint.id);
        added += 1;
      }
    }
    if (added) await store.set(seenKey, seen.slice(-SPRINTS_REMEMBERED));
    return added;
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

  /** Once a day: roll completed weeks up, snapshot open work, keep the people record, enforce retention. */
  async function dailyRollup() {
    const scopes = (await store.get('scopes')) || [];
    const today = todayUtc();
    const thisWeek = isoWeek(today);
    const oldestWeekKept = previousWeeks(thisWeek, RETAIN_WEEKS).at(-1);
    const oldestDayKept = addDays(today, -RETAIN_DAYS);
    const oldestSnapshotKept = addDays(today, -SNAPSHOT_RETAIN_DAYS);
    const summary = { scopes: scopes.length, weeksRolled: 0, snapshots: 0, sprints: 0, deleted: 0, errors: [] };

    for (const { scope, product } of scopes) {
      try {
        const settings = await settingsFor(scope);
        // The people record first, so the week rolled below sees today's rests.
        const window = await windowRows(scope, addDays(today, -1));
        const record = updatePeopleRecord((await store.get(`people:${scope}`)) || {}, window, settings, today);
        await store.set(`people:${scope}`, record);

        for (const week of previousWeeks(thisWeek, 3)) {
          if (await store.get(`wk:${scope}:${week}`)) continue;
          const sunday = daysOfWeek(week)[6];
          const metrics = await weekMetricsFromDays(scope, week, settings, sunday);
          if (!metrics) continue;
          await store.set(`wk:${scope}:${week}`, { week, metrics, rolledAt: today });
          summary.weeksRolled += 1;
        }
        if (product === 'jira' && jira?.openIssues) {
          const projectKey = scope.slice('jira:'.length);
          const issues = await jira.openIssues(projectKey, { today });
          const key = await salt();
          await store.set(`wip:${scope}:${today}`, openWorkSnapshot(issues, (id) => pseudonym(id, key), today));
          summary.snapshots += 1;
        }
        if (product === 'jira' && jira?.boards) summary.sprints += await pollSprints(scope, scope.slice('jira:'.length), today);
        summary.deleted += await expire(`day:${scope}:`, (k) => k.slice(-10) < oldestDayKept);
        summary.deleted += await expire(`wip:${scope}:`, (k) => k.slice(-10) < oldestSnapshotKept);
        summary.deleted += await expire(`wk:${scope}:`, (k) => k.slice(-8) < oldestWeekKept);
        summary.deleted += await expire(`sprint:${scope}:`, (_k, v) => (v?.completeDate || '') < addDays(today, -SPRINT_RETAIN_DAYS));
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
