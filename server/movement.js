// What actually happened since the last daily sync.
//
// The morning sync used to run the whole org chart every single day. Its
// kickoff said, in so many words, "Consult each of your direct reports (CTO,
// CFO, CMO, COO). Ask each of them to check in with their own team first" —
// which reaches 22 agents and costs a minimum of 27 Anthropic calls, plus the
// Studio phase after it, whether or not one thing had changed since yesterday.
//
// On a day when nothing moved, that spend does not buy better judgement. It
// buys 22 agents being asked for "one real, specific data point" about a
// company that did nothing, and the honest answer to that question is one
// line. Worse, an agent asked for a specific observation it does not have
// tends to produce one anyway — which is the same failure mode the
// diagnosing-a-blocker skill exists for, bought daily at full price.
//
// So: the sync is proportional to what moved. This module answers what moved,
// from the records of real events rather than from anyone's recollection.
//
// Deliberately only counts things that leave a trace in this app's own data. A
// founder's WhatsApp conversation is real movement too, but it is already
// answered in the moment it happens; the morning sync exists for the things
// nobody watched.

import { listVentures } from './finance/ventures.js';
import { listTasks } from './tasks.js';
import { getLedger } from './finance/ledger.js';
import { getPlan, PLAN_STATUS } from './dailyPlan.js';

// Even in a genuinely quiet stretch the full sync still runs this often. A
// company that goes permanently quiet because nothing tripped a counter is the
// failure this guard exists for: "nothing changed" is exactly the state a wider
// look is most likely to have something to say about, and a week is long enough
// that it costs almost nothing to be wrong about.
const FULL_SYNC_MAX_GAP_DAYS = Math.max(1, Number(process.env.FULL_SYNC_MAX_GAP_DAYS) || 7);

function after(timestamp, since) {
  if (!timestamp) return false;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && at > since;
}

/**
 * Every real event since `since`, as lines a person can read.
 *
 * @param {{since?: number|string|Date}} opts
 * @returns {{moved: boolean, lines: string[], daysSince: number|null}}
 */
export function describeMovement({ since } = {}) {
  const sinceMs = since === undefined || since === null ? 0 : new Date(since).getTime();
  const from = Number.isFinite(sinceMs) ? sinceMs : 0;
  const lines = [];

  for (const venture of listVentures()) {
    const deploys = (venture.deployments || []).filter((d) => after(d.deployedAt || d.at, from));
    if (deploys.length) {
      lines.push(`${venture.title}: ${deploys.length} commit${deploys.length === 1 ? '' : 's'} — ${deploys.map((d) => d.path).join(', ')}`);
    }

    const emails = (venture.sentEmails || []).filter((e) => after(e.sentAt, from));
    if (emails.length) {
      lines.push(`${venture.title}: ${emails.length} customer email${emails.length === 1 ? '' : 's'} sent`);
    }

    // A failing probe is movement even though nothing was done: the service
    // going down between syncs is precisely the thing a morning look is for.
    const probes = (venture.probes || []).filter((p) => after(p.at, from));
    const broken = probes.filter((p) => !p.ok);
    if (broken.length) {
      lines.push(`${venture.title}: the deployed service answered badly ${broken.length} time${broken.length === 1 ? '' : 's'} (last: ${broken[0].status || 'no response'})`);
    }

    const runs = (venture.runs || []).filter((r) => after(r.startedAt, from));
    const redRuns = runs.filter((r) => r.conclusion && r.conclusion !== 'success');
    if (redRuns.length) {
      lines.push(`${venture.title}: ${redRuns.length} failing CI run${redRuns.length === 1 ? '' : 's'}`);
    }

    const notes = (venture.notes || []).filter((n) => after(n.at, from));
    if (notes.length) {
      lines.push(`${venture.title}: ${notes.length} new venture note${notes.length === 1 ? '' : 's'}`);
    }

    if (after(venture.createdAt, from)) lines.push(`${venture.title}: started since the last sync`);
    if (venture.status === 'killed' && after(venture.killedAt, from)) {
      lines.push(`${venture.title}: killed since the last sync`);
    }
  }

  const tasks = listTasks({ limit: 200 });
  const finished = tasks.filter((t) => after(t.finishedAt, from));
  const done = finished.filter((t) => t.status === 'done');
  const failed = finished.filter((t) => t.status === 'failed');
  if (done.length) lines.push(`${done.length} task${done.length === 1 ? '' : 's'} completed`);
  if (failed.length) lines.push(`${failed.length} task${failed.length === 1 ? '' : 's'} failed`);
  const queued = tasks.filter((t) => after(t.queuedAt, from));
  if (queued.length) lines.push(`${queued.length} new task${queued.length === 1 ? '' : 's'} queued`);

  const money = (getLedger().transactions || []).filter((t) => after(t.createdAt, from));
  if (money.length) lines.push(`${money.length} ledger entr${money.length === 1 ? 'y' : 'ies'} recorded`);

  return { moved: lines.length > 0, lines, daysSince: daysBetween(from) };
}

function daysBetween(fromMs) {
  if (!fromMs) return null;
  return Math.floor((Date.now() - fromMs) / (24 * 60 * 60 * 1000));
}

/**
 * How wide this morning's sync should be.
 *
 * Four reasons to run the full fan-out, and they are deliberately generous —
 * the saving comes from the genuinely dead days, and being wrong in the
 * narrow direction means a real event goes unexamined, which costs more than
 * the calls it saved.
 *
 * @returns {{full: boolean, reason: string, movement: {moved: boolean, lines: string[]}}}
 */
export function planSyncScope({ since } = {}) {
  const movement = describeMovement({ since });

  if (movement.moved) {
    return { full: true, reason: 'something moved since the last sync', movement };
  }

  // A plan waiting on the founder is not movement, but it is the one state
  // where the team may have real work queued behind a decision — and where a
  // narrow sync would report "nothing happened" while the reason nothing
  // happened is sitting in the founder's inbox.
  // getPlan returns the plan itself — whatever is pending, or failing that
  // whatever is in force — not a container keyed by status. Reading `.pending`
  // off it was always undefined, which would have made this branch dead code
  // and sent the company narrow on exactly the mornings it should look wide.
  const plan = getPlan();
  if (plan?.status === PLAN_STATUS.PENDING) {
    return { full: true, reason: 'a plan is waiting on the founder', movement };
  }
  if (plan?.status === PLAN_STATUS.APPROVED) {
    return { full: true, reason: 'an approved plan is live, so the team is cleared to work', movement };
  }

  if (movement.daysSince === null || movement.daysSince >= FULL_SYNC_MAX_GAP_DAYS) {
    return {
      full: true,
      reason: movement.daysSince === null
        ? 'no previous sync to compare against'
        : `${movement.daysSince} days since the last full sync`,
      movement,
    };
  }

  return { full: false, reason: 'nothing has moved and nothing is waiting on a decision', movement };
}

export { FULL_SYNC_MAX_GAP_DAYS };
