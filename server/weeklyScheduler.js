// Drives the autonomous weekly reflection cycle (see weeklyReflection.js).
// Same approach as scheduler.js, generalized from "a fixed hour every day"
// to "a fixed hour on a fixed weekday": Sunday 01:30 UTC — thirty minutes
// after the daily cycle's own 01:00 UTC slot (see scheduler.js), so the
// reflection has that same day's fresh daily report to include alongside
// the six before it, rather than a stale six-day window.
//
// Same resilience story as the daily scheduler: a self-rescheduling
// setTimeout recomputed fresh each time (no drift), a catch-up run if the
// server starts after this week's slot has passed with nothing generated
// yet, and an overlap guard shared with the manual "run now" trigger. Per
// weeklyReflection.js, this is read-only — it can't touch money or kill a
// venture regardless of how often it runs.

import { runWeeklyReflection } from './weeklyReflection.js';
import { hasReflectionForThisWeek, weekKey } from './weeklyReflections.js';

const STARTUP_DELAY_MS = 20_000; // slightly after the daily scheduler's own startup delay
export const TARGET_DAY_OF_WEEK = 0; // Sunday (UTC), 0-6 per Date#getUTCDay()
export const TARGET_UTC_HOUR = 1;
export const TARGET_UTC_MINUTE = 30;

let running = false;

export function isWeeklyReflectionRunning() {
  return running;
}

export async function runWeeklyReflectionNow({ anthropic }) {
  if (running) {
    throw new Error('A weekly reflection is already in progress — try again shortly.');
  }
  running = true;
  try {
    return await runWeeklyReflection({ anthropic });
  } finally {
    running = false;
  }
}

// The next moment the weekly cycle should fire: this week's target
// day/time (UTC) if it hasn't passed yet, otherwise the same time next week.
export function nextWeeklyTargetUTC(from = new Date()) {
  const candidate = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), TARGET_UTC_HOUR, TARGET_UTC_MINUTE, 0, 0)
  );
  const daysUntilTarget = (TARGET_DAY_OF_WEEK - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilTarget);
  if (candidate <= from) candidate.setUTCDate(candidate.getUTCDate() + 7);
  return candidate;
}

export function startWeeklyReflectionScheduler({ anthropic }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Weekly reflection scheduler disabled: no ANTHROPIC_API_KEY configured.');
    return;
  }
  if (process.env.WEEKLY_REFLECTION_DISABLED === 'true') {
    console.log('Weekly reflection scheduler disabled via WEEKLY_REFLECTION_DISABLED.');
    return;
  }

  const scheduleNext = (tick) => setTimeout(tick, nextWeeklyTargetUTC().getTime() - Date.now());

  const tick = async () => {
    if (!hasReflectionForThisWeek()) {
      console.log("Running this week's autonomous reflection cycle...");
      try {
        await runWeeklyReflectionNow({ anthropic });
        console.log('Weekly reflection cycle complete.');
      } catch (err) {
        console.error('Weekly reflection cycle failed:', err);
      }
    }
    scheduleNext(tick);
  };

  // hasReflectionForThisWeek() keys purely off calendar date (weekKey), not
  // time-of-day, so "this week's" target moment is that same date at
  // TARGET_UTC_HOUR:TARGET_UTC_MINUTE — in the past on any day after
  // Sunday, possibly still upcoming if today IS Sunday but earlier than
  // the target time.
  const now = new Date();
  const thisWeekTarget = new Date(`${weekKey(now)}T${String(TARGET_UTC_HOUR).padStart(2, '0')}:${String(TARGET_UTC_MINUTE).padStart(2, '0')}:00.000Z`);
  if (now >= thisWeekTarget && !hasReflectionForThisWeek()) {
    // Starting up after this week's slot already passed with nothing
    // generated yet — catch up soon instead of waiting until next week.
    setTimeout(tick, STARTUP_DELAY_MS);
  } else {
    scheduleNext(tick);
  }
}
