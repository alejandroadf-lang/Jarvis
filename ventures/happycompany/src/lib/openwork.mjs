// The daily open-work snapshot, Jira only.
//
// Activity buckets say how work *happens*; this says how work is *distributed*
// right now. It is taken once a day by the scheduled function from a JQL
// search of unresolved issues, and only the team-level figures are stored.
// The per-person counts exist for the length of this function call.
//
// "Overloaded" means at least twice the team's median open issues and at least
// OVERLOAD_FLOOR of them. The floor stops a team whose median is one open
// issue from flagging someone with two.

export const OVERLOAD_FLOOR = 8;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param issues [{ assignee: accountId | null, overdue: boolean }]
 * @param toPseudonym accountId -> pseudonym (so no id survives in the result)
 */
export function openWorkSnapshot(issues, toPseudonym, day) {
  const perPerson = new Map();
  let unassigned = 0;
  let overdue = 0;
  for (const issue of issues) {
    if (issue.overdue) overdue += 1;
    if (!issue.assignee) {
      unassigned += 1;
      continue;
    }
    const who = toPseudonym(issue.assignee);
    perPerson.set(who, (perPerson.get(who) || 0) + 1);
  }
  const counts = [...perPerson.values()];
  const med = median(counts);
  const threshold = Math.max(OVERLOAD_FLOOR, 2 * med);
  const overloaded = counts.filter((n) => n >= threshold).length;
  const assigned = counts.reduce((a, b) => a + b, 0);
  return {
    day,
    openTotal: issues.length,
    unassigned,
    people: counts.length,
    medianOpen: med,
    overdueShare: issues.length ? overdue / issues.length : null,
    overloadedShare: counts.length ? overloaded / counts.length : null,
    topShare: assigned ? Math.max(...counts) / assigned : null,
  };
}
