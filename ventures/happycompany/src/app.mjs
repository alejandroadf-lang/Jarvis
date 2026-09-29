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
import { localParts, isoWeek, daysOfWeek, previousWeeks, addDays, isValidZone, parseInstant, quarterOf, previousQuarter, nextQuarter, quarterRange, weeksOfQuarter } from './lib/time.mjs';
import { newSalt, pseudonym, itemHash, publicMetrics, groupFloor, MIN_GROUP, MAX_GROUP_SETTING, RETAIN_DAYS, RETAIN_WEEKS, TIMEZONE_CACHE_DAYS } from './lib/privacy.mjs';
import { scorecard, trend, publicValue, INDICATOR_KEYS } from './lib/score.mjs';
import { pathToNextGrade } from './lib/progress.mjs';
import { earnedBadges, actionStreak } from './lib/badges.mjs';
import { transparency } from './lib/transparency.mjs';
import { briefOf } from './lib/brief.mjs';
import { createActions } from './features/actions.mjs';
import { createAudit, AUDIT_RETAIN_DAYS } from './features/audit.mjs';
import { createDigest } from './features/digest.mjs';
import { organisationSummary, canSeeOrganisation, validateOrgSettings } from './features/org.mjs';
import { strainCost } from './lib/cost.mjs';
import { createPulse } from './features/pulse.mjs';
import { cbiScore, itemMean } from './lib/pulse.mjs';
import { enablerCard, ENABLER_KEYS } from './lib/enablers.mjs';
import { validationSummary } from './lib/validation.mjs';
import { normaliseJiraEvent, normaliseJiraMention, normaliseConfluenceEvent, confluenceScope, DIGEST_LABEL } from './lib/events.mjs';
import { openWorkSnapshot } from './lib/openwork.mjs';
import { activeDaysByPerson, streakShare, updatePeopleRecord, noRestShare } from './lib/recovery.mjs';
import { sprintSummary, sprintMetricsForWeek, SPRINT_LOOKBACK_DAYS, SPRINT_FALLBACK_WEEKS } from './lib/sprints.mjs';
import { buildEvidence, evidenceMarkdown, evidenceHtml } from './lib/evidence.mjs';
import { disclosures } from './lib/disclosures.mjs';
import { organisationLevel } from './lib/levels.mjs';
import { parseOutcomes, outcomeSummary, predictiveCheck, strainGap } from './lib/outcomes.mjs';
import { newKeyPair, keyId, signAttestation, attestationPayload } from './lib/attestation.mjs';

export const WEEKS_SHOWN = 12;
const SNAPSHOT_RETAIN_DAYS = 91;
const SPRINT_RETAIN_DAYS = 182;
const SPRINTS_REMEMBERED = 500;
const SURGE_BASELINE_WEEKS = 8;
const INFLOW_WEEKS = 4;
const STATUS_CACHE_DAYS = 7;
const MAX_HOLIDAYS = 60;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NAME_CACHE_DAYS = 7;
const MAX_ORG_TEAMS = 300;
// A quarter has up to 14 ISO weeks. Weekly aggregates are kept RETAIN_WEEKS
// (26), and the surge signal needs SURGE_BASELINE_WEEKS before the first week
// shown, so 17 weeks is the furthest back a pack can see: a closed quarter is
// complete when it is packed within the first three weeks of the next one.
const EVIDENCE_WEEKS = 17;
const EVIDENCE_WINDOW_DAYS = 21;
const BACKFILL_DAYS = RETAIN_DAYS;
const BACKFILL_PAGES_PER_RUN = 6;
// Weeks are held back from rolling up while history comes in, but never for
// longer than this: the rollup re-checks the last three weeks, so three days
// of delay lose nothing, and a backfill that keeps failing must not stop a
// project's weeks from being kept.
const BACKFILL_HOLD_DAYS = 3;

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
  const digest = s.digest === 'on' || s.digest === true ? 'on' : 'off';
  const pulse = ['monthly', 'quarterly'].includes(s.pulse) ? s.pulse : 'off';
  const validation = s.validation === true || s.validation === 'true' || s.validation === 'on';
  const minGroup = Number(s.minGroup ?? MIN_GROUP);
  if (!Number.isInteger(minGroup) || minGroup < MIN_GROUP || minGroup > MAX_GROUP_SETTING) {
    throw new Error(`minGroup must be a whole number from ${MIN_GROUP} to ${MAX_GROUP_SETTING}; ${MIN_GROUP} is the floor and cannot be lowered`);
  }
  const signals = {};
  for (const [key, on] of Object.entries(s.signals || {})) {
    if (!INDICATOR_KEYS.includes(key) && !ENABLER_KEYS.includes(key)) throw new Error(`unknown signal ${JSON.stringify(key)}`);
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
    minGroup,
    digest,
    pulse,
    validation,
    signals,
  };
}

function changedFields(before, after) {
  if (!before) return Object.keys(after);
  return Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
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
  const audit = createAudit({ store, now });
  const actions = createActions({ store, now, audit: (scope, event, detail) => audit.log(scope, event, detail) });

  const pulse = createPulse({ store, now, salt, audit: (scope, event, detail) => audit.log(scope, event, detail) });

  // The app's own account, per product, so its digest posts and evidence
  // pages are never counted as the team's work. Looked up once and kept.
  async function selfId(product) {
    const key = `self:${product}`;
    const cached = await store.get(key);
    if (cached !== undefined && cached !== null) return cached || null;
    const client = product === 'jira' ? jira : confluence;
    if (!client?.selfAccountId) return null;
    try {
      const id = (await client.selfAccountId()) || '';
      await store.set(key, id);
      return id || null;
    } catch (err) {
      log.warn(`[happycompany] could not look up the app's own account: ${err.message}`);
      return null;
    }
  }

  async function teamName(scope, product) {
    const key = `name:${scope}`;
    const cached = await store.get(key);
    const today = todayUtc();
    if (cached?.name && cached.until > today) return cached.name;
    const raw = scope.slice(scope.indexOf(':') + 1);
    let name = raw;
    try {
      if (product === 'jira' && jira?.projectName) name = await jira.projectName(raw);
      else if (product === 'confluence' && confluence?.spaceName) name = await confluence.spaceName(raw);
    } catch (err) {
      log.warn(`[happycompany] name lookup failed for ${scope}: ${err.message}`);
    }
    await store.set(key, { name, until: addDays(today, NAME_CACHE_DAYS) });
    return name;
  }

  async function settingsFor(scope) {
    const saved = await store.get(`settings:${scope}`);
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  }

  async function rememberScope(scope, product) {
    const scopes = (await store.get('scopes')) || [];
    if (scopes.some((s) => s.scope === scope)) return;
    // firstSeen: when the app began counting here. The backfill takes only
    // history from before it, so nothing is counted twice.
    scopes.push({ scope, product, firstSeen: now().toISOString() });
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
    if (activity.actor && activity.actor === (await selfId(activity.product))) {
      return { scope: activity.scope, ignored: 'the app itself' };
    }
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
    const result = await ingest(activity);
    return result.ignored ? { counted: false, ...result } : { counted: true, ...result };
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
    const result = await ingest(activity);
    return result.ignored ? { counted: false, ...result } : { counted: true, ...result };
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

      // "Check this improvement": off-hours activity collapsed while output
      // held. Either the team fixed its hours, or the work moved somewhere the
      // app cannot see. The note says both; it never accuses.
      const recent4 = earlier.slice(-4);
      const offHours = (x) => (x.afterHoursShare ?? 0) + (x.weekendShare ?? 0);
      if (recent4.length >= 3) {
        const baseOff = recent4.reduce((a, x) => a + offHours(x), 0) / recent4.length;
        const baseResolved = recent4.reduce((a, x) => a + (x.kinds?.resolved || 0), 0) / recent4.length;
        const nowResolved = m.kinds?.resolved || 0;
        if (baseOff >= 0.15 && offHours(m) <= baseOff * 0.5 && baseResolved >= 5 && nowResolved >= baseResolved * 0.9) {
          m.check = {
            key: 'offHoursDrop',
            text: 'Late and weekend activity dropped by half or more while the amount of work finished held steady. If the team changed how it works, well done. If the work simply moved to places this page cannot see, the grade is flattering you. The team pulse question on finishing within normal hours is the way to tell.',
          };
        }
      }

      const weekDays = daysOfWeek(week);
      const earlierDays = previousWeeks(week, SPRINT_FALLBACK_WEEKS).flatMap(daysOfWeek);
      const sm = sprintMetricsForWeek(sprints, weekDays, earlierDays);
      m.carryOverShare = sm.carryOverShare;
      m.unplannedShare = sm.unplannedShare;
    });
  }

  /**
   * Every week's metrics, snapshot and scorecard for one team. The team page,
   * the weekly digest, the organisation view and the evidence pack all read
   * this, so a grade is computed one way everywhere.
   */
  async function computeTeam({ scope, product, shown = WEEKS_SHOWN + 1 }) {
    const settings = await settingsFor(scope);
    const minGroup = groupFloor(settings.minGroup);
    const today = localParts(now(), settings.timeZone).day;
    const thisWeek = isoWeek(today);
    const weekKeys = [thisWeek, ...previousWeeks(thisWeek, shown - 1 + SURGE_BASELINE_WEEKS)].reverse();
    const shownKeys = weekKeys.slice(-shown);
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
      const shown = publicMetrics(metrics, minGroup);
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
        card,
        enablers: card ? enablerCard(metrics, snapshot, settings.signals) : null,
        check: metrics?.check || null,
        sprintClosed: sprints.some((sp) => daysOfWeek(week).includes(sp.completeDate)),
        carryOverShare: metrics?.carryOverShare ?? null,
        openWork: snapshot
          ? { day: snapshot.day, openTotal: snapshot.openTotal, unassigned: snapshot.unassigned, unassignedOverdue: snapshot.unassignedOverdue ?? 0, people: snapshot.people }
          : null,
      });
    }
    // The week on the card: this one if it can be shown, else last week. A
    // Monday morning has too little of this week to say anything.
    const current = [...weeks].reverse().find((w, i) => i < 2 && w.score !== null) || weeks[weeks.length - 1];
    return { scope, product, settings, minGroup, today, thisWeek, weeks, current, sprints, isJira };
  }

  // A card as the browser may see it: every figure rounded (see publicValue).
  function publicCard(card) {
    if (!card) return null;
    const dimensions = {};
    for (const [k, d] of Object.entries(card.dimensions)) {
      dimensions[k] = { ...d, indicators: d.indicators.map((i) => ({ ...i, value: publicValue(i.key, i.value) })) };
    }
    return { ...card, dimensions, actions: card.actions.map((a) => ({ ...a, value: publicValue(a.key, a.value) })) };
  }

  /** What the page shows. Never contains a pseudonym or a per-person count. */
  async function teamHealth({ scope, product, accountId: viewerAccountId = null }) {
    if (!scope) throw new Error('This page only works inside a Jira project or a Confluence space.');
    await rememberScope(scope, product);
    const team = await computeTeam({ scope, product });
    const { settings, minGroup, weeks, current, thisWeek, isJira, sprints } = team;
    const earlier = weeks
      .filter((w) => w.week < current.week && w.score !== null)
      .slice(-4)
      .map((w) => w.score);

    const actionWeeks = await actions.history(scope, weeks.map((w) => w.week));
    const freezes = await actions.freezes(scope);
    const badges = earnedBadges(
      weeks.map((w) => ({
        week: w.week,
        grade: w.grade,
        fragmentationStatus: w.card?.dimensions.fragmentation.status,
        hoursStatus: w.card?.dimensions.hours.status,
        carryOverShare: w.carryOverShare,
        sprintClosed: w.sprintClosed,
      })),
      actionWeeks,
      freezes,
    );
    const toClose = Object.entries(actionWeeks)
      .filter(([week, h]) => week < thisWeek && h.open > 0)
      .map(([week, h]) => ({ week, items: h.items.filter((i) => i.done === null) }));

    const notes = [
      'Grades describe working conditions for the team, never a person. They are indicators, not diagnoses.',
      `Nothing is shown for weeks with fewer than ${minGroup} active people.`,
      product === 'confluence'
        ? 'Confluence has no per-person time zone, so quiet hours use the team time zone in the settings.'
        : 'Quiet hours use each person’s own Jira time zone when Jira shares it, and the team time zone otherwise.',
      'This page sees the part of the day that lands in Jira and Confluence. Calls, chats and email are not counted.',
    ];
    if (current.openWork?.unassignedOverdue) {
      notes.push(`${current.openWork.unassignedOverdue} overdue items have no owner. Work nobody owns is work everybody worries about.`);
    }
    if (isJira && !sprints.length) notes.push('No closed sprints seen yet, so the sprint signals are blank. They fill in after the first sprint closes.');
    // Everyone on the page is told when earlier weeks came from history.
    const filled = isJira ? await store.get(`backfill:${scope}`) : null;
    if (filled) notes.push(`Weeks before ${filled.cutoff.slice(0, 10)} include activity read from Jira issue history (who acted and when, as for live activity), requested by a project administrator on ${filled.requestedAt.slice(0, 10)}.`);

    const card = publicCard(current.card);
    const pulseState = await pulse.state({ scope, settings, today: team.today, minGroup, accountId: viewerAccountId });
    const checks = current.check ? [current.check] : [];
    const hours = pulseState.results?.items?.find((i) => i.key === 'hours');
    if (hours && current.score !== null && current.score >= 70 && hours.mean <= 2.5) {
      checks.push({
        key: 'pulseDisagrees',
        text: 'The grade is good, but the team’s last pulse says most weeks cannot be finished within normal hours. Work may be happening where this page cannot see it. Believe the team.',
      });
    }
    return {
      scope,
      product,
      generatedAt: now().toISOString(),
      settings,
      minGroup,
      indicatorKeys: INDICATOR_KEYS,
      weeks: weeks.map((w) => ({
        week: w.week,
        hasData: w.hasData,
        suppressed: w.suppressed,
        contributors: w.contributors,
        total: w.total,
        score: w.score,
        grade: w.grade,
        status: w.status,
        openWork: w.openWork,
      })),
      current: {
        week: current.week,
        hasData: current.hasData,
        suppressed: current.suppressed,
        contributors: current.contributors,
        total: current.total,
        score: current.score,
        grade: current.grade,
        status: current.status,
        dimensions: card?.dimensions ?? null,
        actions: card?.actions ?? [],
        openWork: current.openWork,
      },
      trend: trend(current.score, earlier),
      path: pathToNextGrade(current.card),
      loop: {
        thisWeek,
        committed: actionWeeks[thisWeek]?.items || [],
        toClose,
        completion: actions.completion(actionWeeks),
        streak: actionStreak(weeks.map((w) => w.week), actionWeeks, freezes),
        freezes: freezes.filter((f) => weeks.some((w) => w.week === f)),
      },
      badges,
      checks,
      enablers: current.enablers,
      enablerKeys: ENABLER_KEYS,
      pulse: pulseState,
      transparency: transparency({ minGroup, disabled: settings.signals }),
      notes,
      backfill: isJira && jira?.recentHistory ? await backfillState(scope) : null,
    };
  }

  async function backfillState(scope) {
    const state = await store.get(`backfill:${scope}`);
    if (state) return { status: state.stopped ? 'stopped' : state.done ? 'done' : 'running', issues: state.issues, events: state.events };
    const entry = ((await store.get('scopes')) || []).find((s) => s.scope === scope);
    const available = Boolean(entry?.firstSeen) && entry.firstSeen >= addDays(todayUtc(), -BACKFILL_DAYS);
    return { status: available ? 'available' : 'unavailable', days: BACKFILL_DAYS };
  }

  /**
   * The Rovo agent's view of one team: what the team page shows, condensed.
   * The caller has already checked that the person asking can see the
   * project or space. A team the app has never counted is not added to the
   * rollup by being asked about.
   */
  async function teamBrief({ scope, product }) {
    const known = ((await store.get('scopes')) || []).some((s) => s.scope === scope);
    const name = await teamName(scope, product);
    if (!known) return { team: name, status: 'not counted', says: 'Happy Company has not counted any activity here yet. Open the Team health page in the project or space to start.' };
    return briefOf(await teamHealth({ scope, product }), name);
  }

  async function answerPulse({ scope, product, accountId, answers }) {
    const team = await computeTeam({ scope, product });
    return pulse.respond({ scope, settings: team.settings, today: team.today, accountId, answers });
  }

  /** Commit to some of this week's suggestions. */
  async function commitActions({ scope, product, keys }) {
    const team = await computeTeam({ scope, product });
    if (!team.current.card) throw new Error('There is no grade this week, so there is nothing to commit to yet.');
    return actions.commit({ scope, week: team.thisWeek, keys, suggested: team.current.card.actions });
  }

  async function closeAction({ scope, product, week, key, done }) {
    const team = await computeTeam({ scope, product });
    return actions.close({ scope, week, key, done, thisWeek: team.thisWeek });
  }

  async function freezeWeek({ scope, product }) {
    const team = await computeTeam({ scope, product });
    return actions.freeze({ scope, week: team.thisWeek });
  }

  const digest = createDigest({
    store,
    jira,
    confluence,
    now,
    computeTeam: (place) => computeTeam(place),
    actions,
    teamName,
    audit: (scope, event, detail) => audit.log(scope, event, detail),
  });

  async function orgSettings(product) {
    return (await store.get(`org:${product}`)) || { groups: [] };
  }

  async function saveOrgSettings({ product, viewer, settings, by = null }) {
    if (!viewer?.isAdmin) throw new Error('Only site administrators can change who sees the organisation view.');
    // Merged over what is saved: the access editor and the evidence settings
    // each send only their own fields.
    const clean = validateOrgSettings({ ...(await orgSettings(product)), ...(settings || {}) });
    await store.set(`org:${product}`, clean);
    await audit.log(
      `org:${product}`,
      'org.settings',
      { groups: clean.groups.length, consultationRecorded: clean.consultationRecorded, evidenceSpace: Boolean(clean.evidenceSpaceId) },
      by ? pseudonym(by, await salt()) : null,
    );
    return clean;
  }

  /** Every team of one product, computed once, for the organisation view and the evidence pack. */
  async function allTeams(product) {
    const scopes = ((await store.get('scopes')) || []).filter((s) => s.product === product).slice(0, MAX_ORG_TEAMS);
    const teams = [];
    for (const { scope } of scopes) {
      const team = await computeTeam({ scope, product });
      const hist = await actions.history(scope, team.weeks.map((w) => w.week));
      teams.push({
        scope,
        name: await teamName(scope, product),
        weeks: team.weeks.map((w) => ({ week: w.week, grade: w.grade, score: w.score })),
        current: {
          week: team.current.week,
          grade: team.current.grade,
          score: team.current.score,
          suppressed: team.current.suppressed,
          hasData: team.current.hasData,
          contributors: team.current.suppressed ? 0 : team.current.contributors,
          dimensions: team.current.card
            ? Object.fromEntries(Object.entries(team.current.card.dimensions).map(([k, d]) => [k, { score: d.score, status: d.status }]))
            : null,
          worst: team.current.card ? team.current.card.actions.map((a) => a.key) : [],
        },
        completion: actions.completion(hist),
        settings: team.settings,
      });
    }
    return teams;
  }

  /** The organisation view. Access: site administrators and the configured groups. */
  async function organisationView({ product, viewer }) {
    const settings = await orgSettings(product);
    if (!canSeeOrganisation(viewer || {}, settings)) {
      throw new Error('The organisation view is for site administrators and the groups they choose. Ask a site administrator for access.');
    }
    const teams = await allTeams(product);
    const summary = organisationSummary(teams);
    summary.validation = await validationFor(teams);
    return {
      product,
      generatedAt: now().toISOString(),
      summary,
      outcomes: await outcomesView(product),
      canConfigure: Boolean(viewer?.isAdmin),
      orgSettings: viewer?.isAdmin ? settings : undefined,
      notes: [
        'Teams are never ranked. Teams that could use support are listed alphabetically with how long they have needed it.',
        `Teams with too few active people are counted but never named or shown. There ${summary.suppressed === 1 ? 'is' : 'are'} ${summary.suppressed} such team${summary.suppressed === 1 ? '' : 's'} this week.`,
        'A team’s grade describes its working conditions. It is not a mark on its manager and may not be used in any decision about a person.',
      ],
    };
  }

  /** Grade against the burnout scale, across teams, for the last closed pulse period. */
  async function validationFor(teams) {
    const pairs = [];
    let matchSum = 0;
    let matchN = 0;
    for (const t of teams) {
      if (t.settings.validation !== true) continue;
      const today = localParts(now(), t.settings.timeZone).day;
      const closed = await pulse.closedTally(t.scope, t.settings, today);
      if (!closed || closed.tally.n < groupFloor(t.settings.minGroup)) continue;
      const cbi = cbiScore(closed.tally);
      const scores = t.weeks.filter((w) => w.score !== null).slice(-5).map((w) => w.score);
      if (cbi === null || !scores.length) continue;
      pairs.push({ gradeScore: scores.reduce((a, b) => a + b, 0) / scores.length, cbi });
      const m = closed.tally.items.match ? itemMean(closed.tally.items.match) : null;
      if (m !== null) {
        matchSum += m;
        matchN += 1;
      }
    }
    return { ...validationSummary(pairs), matchMean: matchN ? Math.round((matchSum / matchN) * 10) / 10 : null };
  }

  async function estimateCost({ product, viewer, inputs }) {
    const settings = await orgSettings(product);
    if (!canSeeOrganisation(viewer || {}, settings)) throw new Error('The cost estimator is part of the organisation view.');
    const summary = organisationSummary(await allTeams(product));
    return strainCost({ ...inputs, people: summary.strainedPeople });
  }

  // ## The quarterly evidence pack
  //
  // Built from the same team computation as the organisation view, limited
  // to the weeks of one quarter. A closed quarter is packed once by the
  // rollup and kept three years (an ISO certification cycle); the current
  // quarter is built live, marked as a draft, and never attested.

  const evidenceKey = (product, quarter) => `evidence:${product}:${quarter}`;
  const attestKey = (product, quarter) => `attest:${product}:${quarter}`;
  const QUARTER = /^\d{4}-Q[1-4]$/;

  const statusesOf = (indicators) => Object.fromEntries((indicators || []).map((i) => [i.key, i.status]));

  // Pulse tallies of the quarter, closed periods only: an open period's
  // count moves when one person answers, and an organisation-wide figure
  // that moves on one answer is one answer shown. A team's tally counts only
  // when it reached that team's own group floor.
  async function quarterTallies(scope, quarter, minGroup) {
    const today = todayUtc();
    const prefix = `pulse:${scope}:`;
    return (await store.list(prefix))
      .filter(({ key, value }) => {
        const period = key.slice(prefix.length);
        const quarterly = period.includes('Q');
        const inQuarter = (quarterly ? period : quarterOf(`${period}-01`)) === quarter;
        const closed = period < (quarterly ? quarterOf(today) : today.slice(0, 7));
        return inQuarter && closed && value?.n >= minGroup;
      })
      .map((r) => r.value);
  }

  async function evidenceInput(product, quarter) {
    const weeks = weeksOfQuarter(quarter);
    const inQuarter = new Set(weeks);
    const { first, last } = quarterRange(quarter);
    const org = await orgSettings(product);
    const scopes = ((await store.get('scopes')) || []).filter((s) => s.product === product).slice(0, MAX_ORG_TEAMS);
    const teams = [];
    const summaryTeams = [];
    const auditRows = [];
    const disabled = {};
    const teamScores = {};
    const inRange = (e) => e.at.slice(0, 10) >= first && e.at.slice(0, 10) <= last;
    for (const { scope } of scopes) {
      const team = await computeTeam({ scope, product, shown: EVIDENCE_WEEKS });
      const qWeeks = team.weeks.filter((w) => inQuarter.has(w.week));
      if (!qWeeks.some((w) => w.hasData)) continue;
      const name = await teamName(scope, product);
      const completion = actions.completion(await actions.history(scope, qWeeks.map((w) => w.week)));
      const tallies = await quarterTallies(scope, quarter, team.minGroup);
      for (const [key, on] of Object.entries(team.settings.signals || {})) if (on === false) disabled[key] = false;
      const end = [...qWeeks].reverse().find((w) => w.hasData);
      teams.push({
        name,
        weeks: qWeeks.map((w) => ({
          week: w.week,
          grade: w.grade,
          suppressed: w.suppressed,
          hasData: w.hasData,
          statuses: w.card ? statusesOf(Object.values(w.card.dimensions).flatMap((d) => d.indicators)) : {},
          enablerStatuses: statusesOf(w.enablers?.indicators),
        })),
        actions: completion,
        pulse: { on: tallies.length > 0, tallies },
      });
      // Per team, for checking the grade against imported absence later:
      // the quarter's mean score and how many graded weeks were D or E.
      const graded = qWeeks.filter((w) => w.score !== null);
      teamScores[scope] = {
        mean: graded.length ? Math.round(graded.reduce((a, w) => a + w.score, 0) / graded.length) : null,
        graded: graded.length,
        strained: graded.filter((w) => w.grade === 'D' || w.grade === 'E').length,
      };
      summaryTeams.push({
        name,
        weeks: qWeeks.map((w) => ({ week: w.week, grade: w.grade, score: w.score })),
        current: { week: end.week, grade: end.grade, score: end.score, suppressed: end.suppressed, hasData: true, contributors: 0 },
        completion,
      });
      auditRows.push(...(await audit.entries(scope, { since: first })).filter(inRange));
    }
    auditRows.push(...(await audit.entries(`org:${product}`, { since: first })).filter(inRange));
    return { product, quarter, weeks, generatedAt: now().toISOString(), teams, summary: organisationSummary(summaryTeams), audit: auditRows, disabled, orgSettings: org, teamScores };
  }

  /** Packs a closed quarter once. Returns whether a new pack was stored. */
  async function snapshotEvidence(product, quarter) {
    if (await store.get(evidenceKey(product, quarter))) return false;
    const input = await evidenceInput(product, quarter);
    const pack = buildEvidence(input);
    if (pack.scope.teams) await store.set(`qscores:${product}:${quarter}`, input.teamScores);
    // An empty quarter is stored too, so the rollup does not rebuild it daily.
    await store.set(evidenceKey(product, quarter), pack.scope.teams ? pack : { quarter, empty: true });
    await audit.log(`org:${product}`, 'evidence.snapshot', { quarter, teams: pack.scope.teams });
    return Boolean(pack.scope.teams);
  }

  async function storedPacks(product) {
    return (await store.list(`evidence:${product}:`)).map((r) => r.value).filter((p) => p && !p.empty);
  }

  async function publicKeyInfo() {
    const pem = await store.get('attestation:publicKey');
    return pem ? { publicKey: pem, keyId: keyId(pem) } : null;
  }

  /** The evidence page: a closed quarter's pack, or this quarter's draft, with its level. */
  async function evidenceView({ product, viewer, quarter = null }) {
    const org = await orgSettings(product);
    if (!canSeeOrganisation(viewer || {}, org)) throw new Error('The evidence pack is part of the organisation view. Ask a site administrator for access.');
    if (quarter !== null && !QUARTER.test(String(quarter))) throw new Error('quarter must be written like 2026-Q3');
    const current = quarterOf(todayUtc());
    const stored = await storedPacks(product);
    const quarters = [...new Set([current, ...stored.map((p) => p.quarter)])].sort().reverse();
    const chosen = quarter || stored.map((p) => p.quarter).sort().at(-1) || current;
    let pack = stored.find((p) => p.quarter === chosen) || null;
    const live = !pack;
    if (live) {
      if (chosen !== current) throw new Error(`There is no evidence pack for ${chosen}. Packs exist for quarters the app was installed for, from the first full quarter.`);
      pack = buildEvidence(await evidenceInput(product, current));
    }
    // Absence figures arrive after a quarter is packed, so they join at view time.
    pack = await withOutcomes(product, pack);
    const previous = stored.find((p) => p.quarter === previousQuarter(pack.quarter)) || null;
    return {
      product,
      quarter: pack.quarter,
      live,
      quarters,
      pack,
      markdown: evidenceMarkdown(pack),
      disclosures: disclosures(pack),
      level: organisationLevel(pack, previous),
      attestation: live ? null : (await store.get(attestKey(product, pack.quarter))) || null,
      key: await publicKeyInfo(),
      canAttest: Boolean(viewer?.isAdmin) && !live,
      canPublish: Boolean(viewer?.isAdmin) && !live && Boolean(org.evidenceSpaceId),
    };
  }

  async function closedPack(product, quarter) {
    if (!QUARTER.test(String(quarter))) throw new Error('quarter must be written like 2026-Q3');
    const pack = await store.get(evidenceKey(product, quarter));
    if (!pack || pack.empty) throw new Error(`${quarter} has no closed evidence pack. Only a closed quarter, packed by the nightly run, can be attested or published.`);
    return pack;
  }

  /** Signs the level a closed quarter reached. Site administrators only. */
  async function issueAttestation({ product, viewer, quarter, by = null }) {
    if (!viewer?.isAdmin) throw new Error('Only site administrators can issue an attestation.');
    const pack = await closedPack(product, quarter);
    const previous = await store.get(evidenceKey(product, previousQuarter(quarter)));
    const level = organisationLevel(pack, previous?.empty ? null : previous);
    if (level.level === 'none') throw new Error(`${quarter} did not reach Measuring, so there is nothing to attest. Still needed: ${level.next.missing.join('; ')}.`);
    let privateKey = await store.getSecret('attestationKey');
    let publicKey = await store.get('attestation:publicKey');
    if (!privateKey || !publicKey) {
      ({ privateKey, publicKey } = newKeyPair());
      await store.setSecret('attestationKey', privateKey);
      await store.set('attestation:publicKey', publicKey);
    }
    const payload = attestationPayload({ pack, level, product, issuedAt: now().toISOString(), validUntil: quarterRange(nextQuarter(quarter)).last });
    const att = signAttestation(payload, privateKey, publicKey);
    await store.set(attestKey(product, quarter), att);
    await audit.log(`org:${product}`, 'attestation.issue', { quarter, level: level.level, keyId: att.keyId }, by ? pseudonym(by, await salt()) : null);
    return att;
  }

  /** Publishes a closed quarter's pack as a Confluence page. Site administrators only. */
  async function publishEvidence({ product, viewer, quarter, by = null }) {
    if (!viewer?.isAdmin) throw new Error('Only site administrators can publish the evidence pack.');
    const org = await orgSettings(product);
    if (!org.evidenceSpaceId) throw new Error('Set the Confluence space id for evidence pages first (organisation settings, "Evidence").');
    if (!confluence?.createPage) throw new Error('Publishing needs Happy Company installed in Confluence on this site.');
    const pack = await closedPack(product, quarter);
    if (pack.publishedPageId) throw new Error(`${quarter} is already published as Confluence page ${pack.publishedPageId}.`);
    const title = `${pack.title} (${product === 'jira' ? 'Jira' : 'Confluence'})${pack.organisation ? `, ${pack.organisation}` : ''}`;
    let created;
    try {
      created = await confluence.createPage(org.evidenceSpaceId, { title, html: evidenceHtml(await withOutcomes(product, pack)) });
    } catch (err) {
      throw new Error(`Confluence did not accept the page. Check that Happy Company is installed in Confluence and the space id ${org.evidenceSpaceId} exists: ${err.message}`);
    }
    await store.set(evidenceKey(product, quarter), { ...pack, publishedPageId: created.id });
    await audit.log(`org:${product}`, 'evidence.publish', { quarter, pageId: created.id }, by ? pseudonym(by, await salt()) : null);
    return { pageId: created.id, title };
  }

  // ## Backfill: the last three weeks from Jira history, on request
  //
  // A new installation otherwise shows nothing for a week and no trend for a
  // month; every competitor that reads history shows a picture on day one.
  // A project administrator can ask for the last BACKFILL_DAYS days to be
  // read from issue changelogs and comments. Only activity from before the
  // app began counting this project (`firstSeen`) is taken, so nothing is
  // counted twice, and each run reads BACKFILL_PAGES_PER_RUN pages so one
  // project cannot use up the nightly run. While it is running, weeks are
  // not rolled up, so no week is frozen half-filled; after BACKFILL_HOLD_DAYS
  // it stops where it is, keeps what it read, and says so.
  //
  // Not recoverable from history: mentions (they are in comment bodies,
  // which the app never reads) and deleted issues. A run cut off mid-page
  // (the function timeout) can count that page twice on the next run; the
  // page size keeps that small and the audit trail records each run.

  async function requestBackfill({ scope, product, projectKey, by = null }) {
    if (product !== 'jira' || !jira?.recentHistory) throw new Error('Backfill reads Jira issue history; it is only available in Jira projects.');
    if (jira.canAdminister && !(await jira.canAdminister(projectKey))) throw new Error('Only project administrators can fill in history.');
    const existing = await store.get(`backfill:${scope}`);
    if (existing) return existing;
    const entry = ((await store.get('scopes')) || []).find((s) => s.scope === scope);
    const since = entry?.firstSeen || now().toISOString();
    if (since < addDays(todayUtc(), -BACKFILL_DAYS)) throw new Error(`This project has been counted for more than ${BACKFILL_DAYS} days, so there is no history left to fill in.`);
    const state = { requestedAt: now().toISOString(), cutoff: since, nextPageToken: null, issues: 0, events: 0, done: false };
    await store.set(`backfill:${scope}`, state);
    await rememberScope(scope, product);
    await audit.log(scope, 'backfill.request', { days: BACKFILL_DAYS }, by ? pseudonym(by, await salt()) : null);
    return state;
  }

  const backfillExpired = (state) => state.requestedAt < `${addDays(todayUtc(), -BACKFILL_HOLD_DAYS)}T`;
  const holdsWeeks = (state) => Boolean(state) && !state.done && !backfillExpired(state);

  async function runBackfill(scope, projectKey) {
    const key = `backfill:${scope}`;
    const state = await store.get(key);
    if (!state || state.done) return 0;
    if (backfillExpired(state)) {
      await store.set(key, { ...state, done: true, stopped: true });
      await audit.log(scope, 'backfill.stopped', { issues: state.issues, events: state.events });
      return 0;
    }
    const from = `${addDays(todayUtc(), -BACKFILL_DAYS)}T00:00:00Z`;
    const within = (at) => {
      const t = parseInstant(at);
      return Boolean(t) && t.toISOString() >= from && t.toISOString() < state.cutoff;
    };
    let counted = 0;
    for (let page = 0; page < BACKFILL_PAGES_PER_RUN && !state.done; page++) {
      const { issues, nextPageToken } = await jira.recentHistory(projectKey, { days: BACKFILL_DAYS, nextPageToken: state.nextPageToken });
      let pageEvents = 0;
      for (const issue of issues) {
        if (issue.labels.includes(DIGEST_LABEL)) continue;
        const base = { id: issue.id, key: issue.key, fields: { labels: issue.labels, project: { key: projectKey } } };
        const replay = [];
        if (issue.creator && within(issue.created)) replay.push({ eventType: 'avi:jira:created:issue', atlassianId: issue.creator, issue: { ...base, fields: { ...base.fields, updated: issue.created } } });
        for (const h of issue.histories) {
          if (h.author && within(h.created)) replay.push({ eventType: 'avi:jira:updated:issue', atlassianId: h.author, issue: { ...base, fields: { ...base.fields, updated: h.created } }, changelog: { items: h.items } });
        }
        for (const c of issue.comments) {
          if (c.author && within(c.created)) replay.push({ eventType: 'avi:jira:commented:issue', atlassianId: c.author, issue: base, comment: { created: c.created } });
        }
        for (const event of replay) {
          const activity = normaliseJiraEvent(event, event.issue.fields.updated || event.comment?.created);
          if (activity && !(await ingest(activity)).ignored) pageEvents += 1;
        }
        state.issues += 1;
      }
      state.nextPageToken = nextPageToken;
      state.done = !nextPageToken;
      state.events += pageEvents;
      counted += pageEvents;
      await store.set(key, state);
    }
    if (state.done) await audit.log(scope, 'backfill.done', { issues: state.issues, events: state.events });
    return counted;
  }

  // ## Sickness absence and leavers (see src/lib/outcomes.mjs)

  const outcomesKey = (product, quarter) => `outcomes:${product}:${quarter}`;

  /** Site administrators paste one closed quarter's team figures from the HR system. */
  async function importOutcomes({ product, viewer, quarter, text, by = null }) {
    if (!viewer?.isAdmin) throw new Error('Only site administrators can import absence and leaver figures.');
    if (!QUARTER.test(String(quarter))) throw new Error('quarter must be written like 2026-Q3');
    const today = todayUtc();
    if (quarter >= quarterOf(today)) throw new Error(`${quarter} has not ended yet. Import a quarter once it is closed.`);
    if (quarter < quarterOf(addDays(today, -AUDIT_RETAIN_DAYS))) throw new Error(`${quarter} is older than the three years figures are kept.`);
    const knownScopes = ((await store.get('scopes')) || []).filter((s) => s.product === product).map((s) => s.scope);
    const { rows, dropped } = parseOutcomes(text, { product, knownScopes });
    const replaced = Boolean(await store.get(outcomesKey(product, quarter)));
    await store.set(outcomesKey(product, quarter), { quarter, importedAt: now().toISOString(), rows });
    await audit.log(`org:${product}`, 'outcomes.import', { quarter, teams: rows.length, dropped: dropped.length, replaced }, by ? pseudonym(by, await salt()) : null);
    return { quarter, teams: rows.length, dropped, replaced, summary: outcomeSummary({ quarter, rows }) };
  }

  /** What the organisation page shows: organisation figures and the checks, never a team's own rate. */
  async function outcomesView(product) {
    const records = (await store.list(`outcomes:${product}:`)).map((r) => r.value).filter(Boolean).sort((a, b) => (a.quarter < b.quarter ? -1 : 1));
    if (!records.length) return { quarters: [], latest: null, check: null, gap: null };
    // Checked on the latest import: its absence against the same quarter's
    // grades and the quarter before's. The strain gap needs the quarter
    // before's grades, since it asks what followed a strained quarter.
    const latest = records.at(-1);
    const sameScores = await store.get(`qscores:${product}:${latest.quarter}`);
    const priorScores = await store.get(`qscores:${product}:${previousQuarter(latest.quarter)}`);
    const check = predictiveCheck({ quarter: latest.quarter, sameScores, priorScores, record: latest });
    const gap = strainGap(priorScores, latest);
    return { quarters: records.map((r) => outcomeSummary(r)), latest: outcomeSummary(records.at(-1)), check, gap };
  }

  async function withOutcomes(product, pack) {
    return { ...pack, outcomes: outcomeSummary(await store.get(outcomesKey(product, pack.quarter))) };
  }

  async function saveSettings({ scope, product, projectKey, spaceId, settings, by = null }) {
    if (!scope) throw new Error('This page only works inside a Jira project or a Confluence space.');
    if (product === 'jira' && jira?.canAdminister && !(await jira.canAdminister(projectKey))) {
      throw new Error('Only project administrators can change these settings.');
    }
    if (product === 'confluence' && confluence?.canAdminister && !(await confluence.canAdminister(spaceId))) {
      throw new Error('Only space administrators can change these settings.');
    }
    const clean = validateSettings(settings);
    const before = await store.get(`settings:${scope}`);
    await store.set(`settings:${scope}`, { ...clean, updatedAt: now().toISOString() });
    await audit.log(scope, 'settings.save', { changed: changedFields(before, clean) }, by ? pseudonym(by, await salt()) : null);
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

    // Each step runs on its own. A failure in one (a missing scope, a Jira
    // outage, a board the app cannot see) is recorded and the next step still
    // runs. Retention runs last and always: the promise in WORKS_COUNCIL.md
    // that per-person counts are gone after 21 days cannot depend on the
    // sprint API answering.
    const step = async (scope, name, fn) => {
      try {
        await fn();
      } catch (err) {
        summary.errors.push({ scope, step: name, message: err.message });
        log.error(`[happycompany] ${name} failed for ${scope}: ${err.message}`);
      }
    };

    for (const { scope, product } of scopes) {
      const projectKey = product === 'jira' ? scope.slice('jira:'.length) : null;
      let settings = DEFAULT_SETTINGS;
      await step(scope, 'settings', async () => {
        settings = await settingsFor(scope);
      });
      // The people record first, so the week rolled below sees today's rests.
      await step(scope, 'people', async () => {
        const window = await windowRows(scope, addDays(today, -1));
        await store.set(`people:${scope}`, updatePeopleRecord((await store.get(`people:${scope}`)) || {}, window, settings, today));
      });
      if (projectKey && jira?.recentHistory) {
        await step(scope, 'backfill', async () => {
          summary.backfilled = (summary.backfilled || 0) + (await runBackfill(scope, projectKey));
        });
      }
      await step(scope, 'weeks', async () => {
        if (holdsWeeks(await store.get(`backfill:${scope}`))) return;
        for (const week of previousWeeks(thisWeek, 3)) {
          if (await store.get(`wk:${scope}:${week}`)) continue;
          const sunday = daysOfWeek(week)[6];
          const metrics = await weekMetricsFromDays(scope, week, settings, sunday);
          if (!metrics) continue;
          await store.set(`wk:${scope}:${week}`, { week, metrics, rolledAt: today });
          summary.weeksRolled += 1;
        }
      });
      if (projectKey && jira?.openIssues) {
        await step(scope, 'open work', async () => {
          const issues = await jira.openIssues(projectKey, { today });
          const key = await salt();
          let flagged = null;
          if (jira.flaggedInProgress) {
            try {
              flagged = await jira.flaggedInProgress(projectKey);
            } catch (err) {
              log.warn(`[happycompany] flagged count failed for ${scope}: ${err.message}`);
            }
          }
          await store.set(`wip:${scope}:${today}`, openWorkSnapshot(issues, (id) => pseudonym(id, key), today, { flaggedInProgress: flagged }));
          summary.snapshots += 1;
        });
      }
      if (projectKey && jira?.boards) {
        await step(scope, 'sprints', async () => {
          summary.sprints += await pollSprints(scope, projectKey, today);
        });
      }
      await step(scope, 'digest', async () => {
        const r = await digest.maybePost({ scope, product });
        if (r.posted) summary.digests = (summary.digests || 0) + 1;
      });
      await step(scope, 'pulse', async () => {
        summary.deleted += await pulse.expire(scope, settings, today);
      });
      await step(scope, 'retention', async () => {
        summary.deleted += await expire(`day:${scope}:`, (k) => k.slice(-10) < oldestDayKept);
        summary.deleted += await expire(`wip:${scope}:`, (k) => k.slice(-10) < oldestSnapshotKept);
        summary.deleted += await expire(`wk:${scope}:`, (k) => k.slice(-8) < oldestWeekKept);
        summary.deleted += await expire(`sprint:${scope}:`, (_k, v) => (v?.completeDate || '') < addDays(today, -SPRINT_RETAIN_DAYS));
        summary.deleted += await expire(`audit:${scope}:`, (_k, v) => (v?.at || '').slice(0, 10) < addDays(today, -AUDIT_RETAIN_DAYS));
        summary.deleted += await expire(`actions:${scope}:`, (k) => k.slice(-8) < oldestWeekKept);
        summary.deleted += await expire(`digest:${scope}:`, (k) => k.slice(-8) < oldestWeekKept);
      });
    }
    // The closed quarter's evidence pack, in the first weeks of the next one
    // (see EVIDENCE_WEEKS). Once packed it is never rebuilt.
    const thisQuarter = quarterOf(today);
    if (today <= addDays(quarterRange(thisQuarter).first, EVIDENCE_WINDOW_DAYS - 1)) {
      for (const product of [...new Set(scopes.map((s) => s.product))]) {
        await step(`org:${product}`, 'evidence', async () => {
          if (await snapshotEvidence(product, previousQuarter(thisQuarter))) summary.evidencePacks = (summary.evidencePacks || 0) + 1;
        });
      }
    }
    summary.deleted += await expire('tz:', (_k, v) => !v?.until || v.until <= today);
    // Packs and attestations are kept as long as the audit trail.
    const oldestQuarterKept = quarterOf(addDays(today, -AUDIT_RETAIN_DAYS));
    summary.deleted += await expire('evidence:', (k) => k.slice(-7) < oldestQuarterKept);
    summary.deleted += await expire('attest:', (k) => k.slice(-7) < oldestQuarterKept);
    summary.deleted += await expire('outcomes:', (k) => k.slice(-7) < oldestQuarterKept);
    summary.deleted += await expire('qscores:', (k) => k.slice(-7) < oldestQuarterKept);
    summary.deleted += await expire('audit:org:', (_k, v) => (v?.at || '').slice(0, 10) < addDays(today, -AUDIT_RETAIN_DAYS));
    return summary;
  }

  return {
    onJiraEvent,
    onConfluenceEvent,
    dailyRollup,
    teamHealth,
    saveSettings,
    settingsFor,
    commitActions,
    closeAction,
    freezeWeek,
    computeTeam,
    auditEntries: audit.entries,
    organisationView,
    saveOrgSettings,
    answerPulse,
    estimateCost,
    allTeams,
    teamName,
    evidenceView,
    importOutcomes,
    teamBrief,
    requestBackfill,
    issueAttestation,
    publishEvidence,
    snapshotEvidence,
  };
}
