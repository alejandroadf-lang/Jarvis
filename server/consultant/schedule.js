// The briefing on its own clock: 08:00 Bangkok every day, whether or not the
// daily meeting runs.
//
// It used to be the last step of the daily meeting, which meant the cheap thing
// (one review, well under a dollar) waited on the expensive thing (a whole
// organisation of agents in conversation) and never came if the meeting was
// switched off to save tokens, failed, or was halted. The briefing reads the
// company's records, not the meeting's minutes, so it does not need to wait.
//
// Same clock as the meeting (01:00 UTC is 08:00 in Bangkok, which has no DST) and
// the same self-rescheduling timer, with a catch-up: a server that starts after
// today's slot with no briefing sent yet sends it shortly after boot, so a deploy
// at noon does not mean waiting until tomorrow. The digest itself keeps the
// once-a-day rule and refuses a second overlapping run, so the catch-up, the
// meeting's own call and the founder's DIGEST cannot double-send.

import { nextTargetUTC, TARGET_UTC_HOUR } from '../scheduler.js';
import { lastDigest, runConsultantDigest } from './digest.js';
import { isEmailConfigured } from '../email.js';
import { isWorkspaceConfigured } from '../workspace/vault.js';

// After the daily meeting scheduler's own 15 s startup delay, so a catch-up
// meeting and a catch-up briefing do not start in the same breath.
export const STARTUP_DELAY_MS = 45_000;

/**
 * Starts the daily timer. Returns a stop function, or null when it will not run
 * (and says why in the log). `run`, `timers` and `now` are injectable for tests.
 */
export function startConsultantScheduler({ anthropic, run = runConsultantDigest, timers = { set: setTimeout, clear: clearTimeout }, now = () => new Date(), env = process.env } = {}) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('Briefing scheduler disabled: no ANTHROPIC_API_KEY configured.');
    return null;
  }
  if (env.CONSULTANT_DIGEST_DISABLED === 'true') {
    console.log('Briefing scheduler disabled via CONSULTANT_DIGEST_DISABLED.');
    return null;
  }
  if (!isEmailConfigured() && !isWorkspaceConfigured()) {
    console.log('Briefing scheduler disabled: no SMTP_HOST and REPORT_EMAIL_TO, and no vault, to deliver it to.');
    return null;
  }

  let handle = null;
  const scheduleNext = () => {
    handle = timers.set(tick, nextTargetUTC(now()).getTime() - now().getTime());
  };
  const tick = async () => {
    try {
      const r = await run({ anthropic });
      console.log(r?.sent ? `Briefing sent (readiness ${r.readiness}/4).` : `Briefing not sent: ${r?.reason}.`);
    } catch (err) {
      console.error('Briefing run failed:', err.message);
    }
    scheduleNext();
  };

  const t = now();
  const slotToday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), TARGET_UTC_HOUR, 0, 0, 0));
  const sentToday = lastDigest()?.date === t.toISOString().slice(0, 10);
  if (t >= slotToday && !sentToday) handle = timers.set(tick, STARTUP_DELAY_MS);
  else scheduleNext();
  return () => timers.clear(handle);
}
