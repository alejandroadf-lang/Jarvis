// Drives the autonomous daily meeting cycle (see dailyMeeting.js) without
// any human needing to trigger it. This is a personal-scale app with no
// guaranteed uptime, so rather than a real cron schedule this does the
// simplest thing that's actually autonomous: shortly after the server
// starts, run today's cycle if it hasn't already happened today, then
// check again every 24 hours. A server that's restarted daily still gets
// one report a day; a server down over a whole calendar day just picks up
// the next day it's up, instead of silently going dark.
//
// Guarded against overlap so a scheduled tick and a manual "run now" (or
// two overlapping ticks across a restart) can't both run the cycle — and,
// per dailyMeeting.js, this never touches money or kills a venture on its
// own regardless of how often it runs.

import { runDailyMeeting } from './dailyMeeting.js';
import { hasReportForToday } from './dailyReports.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000; // let the server finish booting first

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

export function startDailyMeetingScheduler({ anthropic }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Daily meeting scheduler disabled: no ANTHROPIC_API_KEY configured.');
    return;
  }
  if (process.env.DAILY_MEETING_DISABLED === 'true') {
    console.log('Daily meeting scheduler disabled via DAILY_MEETING_DISABLED.');
    return;
  }

  const tick = async () => {
    if (hasReportForToday()) return;
    console.log("Running today's autonomous daily meeting cycle...");
    try {
      await runDailyMeetingNow({ anthropic });
      console.log('Daily meeting cycle complete.');
    } catch (err) {
      console.error('Daily meeting cycle failed:', err);
    }
  };

  setTimeout(tick, STARTUP_DELAY_MS);
  setInterval(tick, ONE_DAY_MS);
}
