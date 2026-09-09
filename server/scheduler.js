// Drives the autonomous daily meeting cycle (see dailyMeeting.js) without
// any human needing to trigger it, targeting a fixed wall-clock time: 8:00
// AM Bangkok time (Asia/Bangkok is UTC+7 year-round — no DST — so that's
// always 01:00 UTC, no timezone library needed).
//
// This is a personal-scale app with no guaranteed uptime, so rather than a
// real cron schedule this recomputes "the next 01:00 UTC" and reschedules
// itself with setTimeout each time, instead of a naive setInterval that
// would drift or fire at whatever time the server happened to start. If
// the server is up when the slot arrives, the cycle runs right on time; if
// it's down over the slot and comes back up later the same day with no
// report yet, it catches up soon after starting rather than waiting for
// tomorrow's slot — but a server that's down all day still just picks up
// the next day it's up, instead of silently going dark forever.
//
// Guarded against overlap so a scheduled tick and a manual "run now" (or
// two overlapping ticks across a restart) can't both run the cycle — and,
// per dailyMeeting.js, this never touches money or kills a venture on its
// own regardless of how often it runs.

import { runDailyMeeting } from './dailyMeeting.js';
import { hasReportForToday } from './dailyReports.js';

const STARTUP_DELAY_MS = 15_000; // let the server finish booting first
export const TARGET_UTC_HOUR = 1; // 01:00 UTC == 08:00 Asia/Bangkok (UTC+7)

let running = false;

export function isDailyMeetingRunning() {
  return running;
}

export async function runDailyMeetingNow({ anthropic }) {
  if (running) {
    throw new Error('A daily meeting is already in progress — try again shortly.');
  }
  running = true;
  try {
    return await runDailyMeeting({ anthropic });
  } finally {
    running = false;
  }
}

// The next moment the daily cycle should fire: today's target hour (UTC) if
// it hasn't passed yet, otherwise the same time tomorrow.
export function nextTargetUTC(from = new Date()) {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), TARGET_UTC_HOUR, 0, 0, 0));
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function startDailyMeetingScheduler({ anthropic }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Daily meeting scheduler disabled: no ANTHROPIC_API_KEY configured.');
    return;
  }
  if (process.env.DAILY_MEETING_DISABLED === 'true') {
    console.log('Daily meeting scheduler disabled via DAILY_MEETING_DISABLED.');
    return;
  }

  const scheduleNext = (tick) => setTimeout(tick, nextTargetUTC().getTime() - Date.now());

  const tick = async () => {
    if (!hasReportForToday()) {
      console.log("Running today's autonomous daily meeting cycle...");
      try {
        await runDailyMeetingNow({ anthropic });
        console.log('Daily meeting cycle complete.');
      } catch (err) {
        console.error('Daily meeting cycle failed:', err);
      }
    }
    scheduleNext(tick);
  };

  const now = new Date();
  const todayTarget = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), TARGET_UTC_HOUR, 0, 0, 0));
  if (now >= todayTarget && !hasReportForToday()) {
    // Starting up after today's slot already passed with nothing generated
    // yet — catch up soon instead of waiting until tomorrow's slot.
    setTimeout(tick, STARTUP_DELAY_MS);
  } else {
    scheduleNext(tick);
  }
}
