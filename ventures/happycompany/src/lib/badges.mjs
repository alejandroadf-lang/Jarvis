// Team recognition that rewards what a team did, not where it stands.
//
// The motivation evidence (SIGNALS.md, the enrichment report) is consistent:
// informational feedback and recognition of improvement raise motivation;
// rankings, leaderboards and prizes tied to a level lower it and invite
// gaming. So every badge here is earned by a change or a practice:
//
//  - Recovered: back to C or better after a D or E, and held for 4 weeks.
//  - Protected focus: fragmentation healthy four weeks running.
//  - Action streak: consecutive weeks with at least one committed action
//    done. Freeze weeks (a launch, an incident) neither break nor extend it.
//  - Sustainable release: a sprint closed with little carry-over in a week
//    whose hours stayed healthy.
//
// No badge is ever awarded for "being an A". Badges are private to the team
// page; nothing here ranks teams against each other.

export const HOLD_WEEKS = 4;
export const MAX_FREEZES_PER_QUARTER = 2;

const GOOD = new Set(['A', 'B', 'C']);

/**
 * @param weeks [{week, grade, fragmentationStatus, hoursStatus, carryOverShare, sprintClosed}] oldest first
 * @param actionWeeks {week: {committed, done}}
 * @param freezes [week]
 */
export function earnedBadges(weeks, actionWeeks = {}, freezes = []) {
  const badges = [];
  const graded = weeks.filter((w) => w.grade);

  // Recovered
  for (let i = 0; i < graded.length; i++) {
    if (GOOD.has(graded[i].grade)) continue;
    const after = graded.slice(i + 1);
    const hold = after.slice(0, HOLD_WEEKS);
    if (hold.length === HOLD_WEEKS && hold.every((w) => GOOD.has(w.grade))) {
      badges.push({ key: 'recovered', label: 'Recovered', week: hold[HOLD_WEEKS - 1].week, text: `Back to ${hold[HOLD_WEEKS - 1].grade} after a ${graded[i].grade}, and held for ${HOLD_WEEKS} weeks.` });
    }
  }
  dedupeLatest(badges, 'recovered');

  // Protected focus
  let run = 0;
  for (const w of weeks) {
    run = w.fragmentationStatus === 'good' ? run + 1 : 0;
    if (run === HOLD_WEEKS) badges.push({ key: 'focus', label: 'Protected focus', week: w.week, text: 'Four weeks without fragmented days.' });
  }
  dedupeLatest(badges, 'focus');

  // Action streak, ending at the latest week with an outcome.
  const streak = actionStreak(weeks.map((w) => w.week), actionWeeks, freezes);
  if (streak.length >= 3) badges.push({ key: 'streak', label: `Action streak: ${streak.length} weeks`, week: streak.endWeek, text: `${streak.length} weeks in a row with a committed action done.` });

  // Sustainable release
  for (const w of weeks) {
    if (w.sprintClosed && w.carryOverShare !== null && w.carryOverShare !== undefined && w.carryOverShare <= 0.1 && w.hoursStatus === 'good') {
      badges.push({ key: 'release', label: 'Sustainable release', week: w.week, text: 'A sprint closed nearly complete, without late nights or weekends.' });
    }
  }
  dedupeLatest(badges, 'release');
  return badges;
}

function dedupeLatest(badges, key) {
  const mine = badges.filter((b) => b.key === key);
  if (mine.length <= 1) return;
  const latest = mine[mine.length - 1];
  for (let i = badges.length - 1; i >= 0; i--) if (badges[i].key === key && badges[i] !== latest) badges.splice(i, 1);
  latest.times = mine.length;
}

/** Consecutive weeks (newest back) with an action done; freeze weeks are skipped, not counted. */
export function actionStreak(weekKeys, actionWeeks, freezes = []) {
  const frozen = new Set(freezes);
  let length = 0;
  let endWeek = null;
  let started = false;
  for (let i = weekKeys.length - 1; i >= 0; i--) {
    const week = weekKeys[i];
    if (frozen.has(week)) continue;
    const a = actionWeeks[week];
    if (!started) {
      // The current week may still be open: an undecided week does not break the streak.
      if (!a || a.done === 0) {
        if (i === weekKeys.length - 1) continue;
        break;
      }
      started = true;
      endWeek = week;
    }
    if (a && a.done > 0) length += 1;
    else break;
  }
  return { length, endWeek };
}

/** Whether another freeze may be declared, given the freezes in the last 13 weeks. */
export function canFreeze(freezes, week, recentWeeks) {
  const recent = new Set(recentWeeks);
  const used = freezes.filter((w) => recent.has(w)).length;
  return !freezes.includes(week) && used < MAX_FREEZES_PER_QUARTER;
}
