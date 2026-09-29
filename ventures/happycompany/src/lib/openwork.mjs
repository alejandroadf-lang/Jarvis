// The daily open-work snapshot, Jira only.
//
// Activity buckets say how work *happens*; this says how work is *distributed*
// right now: who carries how much, how much is in progress at once, how much
// is overdue or marked urgent, and how the due dates bunch. It is taken once a
// day by the scheduled function from a JQL search of unresolved issues, and
// only the team-level figures are stored. The per-person counts exist for the
// length of this function call.
//
// "Overloaded" means at least twice the team's median open issues and at least
// OVERLOAD_FLOOR of them. The floor stops a team whose median is one open
// issue from flagging someone with two.

export const OVERLOAD_FLOOR = 8;
export const WIP_HIGH = 5;
export const CRUNCH_WINDOW_DAYS = 5;
export const CRUNCH_HORIZON_DAYS = 60;
export const CRUNCH_MIN_ISSUES = 5;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** How much the busiest five-day window of due dates exceeds a typical one. Null when there is too little to say. */
export function dueCrunch(dueDates, today) {
  const windows = new Array(Math.ceil(CRUNCH_HORIZON_DAYS / CRUNCH_WINDOW_DAYS)).fill(0);
  for (const due of dueDates) {
    if (!due) continue;
    const ahead = daysBetween(today, due);
    if (ahead < 0 || ahead >= CRUNCH_HORIZON_DAYS) continue;
    windows[Math.floor(ahead / CRUNCH_WINDOW_DAYS)] += 1;
  }
  const busy = windows.filter((n) => n > 0);
  const max = busy.length ? Math.max(...busy) : 0;
  if (busy.length < 2 || max < CRUNCH_MIN_ISSUES) return null;
  const typical = busy.reduce((a, b) => a + b, 0) / busy.length;
  return Math.round((max / typical) * 10) / 10;
}

/**
 * @param issues [{ assignee, overdue, inProgress, high, due }]
 * @param toPseudonym accountId -> pseudonym (so no id survives in the result)
 */
export function openWorkSnapshot(issues, toPseudonym, day) {
  const open = new Map();
  const wip = new Map();
  let unassigned = 0;
  let unassignedOverdue = 0;
  let overdue = 0;
  let high = 0;
  for (const issue of issues) {
    if (issue.overdue) overdue += 1;
    if (issue.high) high += 1;
    if (!issue.assignee) {
      unassigned += 1;
      if (issue.overdue) unassignedOverdue += 1;
      continue;
    }
    const who = toPseudonym(issue.assignee);
    open.set(who, (open.get(who) || 0) + 1);
    if (issue.inProgress) wip.set(who, (wip.get(who) || 0) + 1);
  }
  const counts = [...open.values()];
  const med = median(counts);
  const threshold = Math.max(OVERLOAD_FLOOR, 2 * med);
  const overloaded = counts.filter((n) => n >= threshold).length;
  const assigned = counts.reduce((a, b) => a + b, 0);
  const wipCounts = [...open.keys()].map((who) => wip.get(who) || 0);
  return {
    day,
    openTotal: issues.length,
    unassigned,
    unassignedOverdue,
    people: counts.length,
    medianOpen: med,
    overdueShare: issues.length ? overdue / issues.length : null,
    overloadedShare: counts.length ? overloaded / counts.length : null,
    topShare: assigned ? Math.max(...counts) / assigned : null,
    wipMean: wipCounts.length ? Math.round((wipCounts.reduce((a, b) => a + b, 0) / wipCounts.length) * 10) / 10 : null,
    wipHighShare: wipCounts.length ? wipCounts.filter((n) => n >= WIP_HIGH).length / wipCounts.length : null,
    highPriorityShare: issues.length ? high / issues.length : null,
    dueCrunch: dueCrunch(issues.map((i) => i.due), day),
  };
}
