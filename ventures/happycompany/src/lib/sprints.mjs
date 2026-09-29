// Sprint signals: carry-over and unplanned work.
//
// Jira's sprint-closed event is reported unreliable, so the daily rollup
// polls instead: the boards of a project, their sprints closed in the last
// three weeks, and for each new one a JQL search `sprint = {id}`. That search
// matches every issue that was ever in the sprint, including the ones Jira
// moved to the backlog or the next sprint at close, which is exactly the set
// needed:
//
//  - committed: all of them
//  - carried over: not done when the sprint completed
//  - unplanned: created after the sprint started
//
// Benchmarks from the sprint literature: carry-over under 10% is healthy,
// 10–20% concerning, over 20% a problem. Unplanned work is scope creep;
// some of it is healthy responsiveness, a lot of it is planning that does
// not survive contact with the week.

export const SPRINT_LOOKBACK_DAYS = 21;
export const SPRINT_FALLBACK_WEEKS = 4;

/** One sprint reduced to four numbers. Issues: [{done, created, resolved}] with ISO timestamps. */
export function sprintSummary(sprint, issues) {
  const start = sprint.startDate ? Date.parse(sprint.startDate) : null;
  const complete = sprint.completeDate ? Date.parse(sprint.completeDate) : null;
  let carried = 0;
  let unplanned = 0;
  for (const issue of issues) {
    const resolvedAt = issue.resolved ? Date.parse(issue.resolved) : null;
    const doneInTime = issue.done && (!complete || !resolvedAt || resolvedAt <= complete);
    if (!doneInTime) carried += 1;
    if (start && issue.created && Date.parse(issue.created) > start) unplanned += 1;
  }
  return {
    id: String(sprint.id),
    completeDate: (sprint.completeDate || '').slice(0, 10),
    committed: issues.length,
    carried,
    unplanned,
  };
}

/** Team shares over a set of sprint summaries. Null when nothing was committed. */
export function sprintMetrics(summaries) {
  const committed = summaries.reduce((a, s) => a + s.committed, 0);
  if (!committed) return { carryOverShare: null, unplannedShare: null, sprints: summaries.length };
  return {
    carryOverShare: summaries.reduce((a, s) => a + s.carried, 0) / committed,
    unplannedShare: summaries.reduce((a, s) => a + s.unplanned, 0) / committed,
    sprints: summaries.length,
  };
}

/**
 * The sprint metrics for a week: sprints completed in that week, or, when
 * none did, the most recent sprint completed in the few weeks before it (a
 * two-week sprint closes every other week; the page should not blink).
 */
export function sprintMetricsForWeek(summaries, weekDays, earlierWeekDays) {
  const inWeek = summaries.filter((s) => weekDays.includes(s.completeDate));
  if (inWeek.length) return sprintMetrics(inWeek);
  const earlier = summaries.filter((s) => earlierWeekDays.includes(s.completeDate)).sort((a, b) => (a.completeDate < b.completeDate ? 1 : -1));
  if (!earlier.length) return { carryOverShare: null, unplannedShare: null, sprints: 0 };
  return sprintMetrics([earlier[0]]);
}
