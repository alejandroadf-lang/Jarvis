// The organisation view, for HR, health and safety, and leadership.
//
// It answers the questions a board and an auditor ask: how much of the
// organisation is covered, how many teams work in sustainable conditions,
// how fast a team recovers when it does not, and whether teams act on what
// the app shows. It deliberately does not rank teams: public league tables
// lowered feelings of appreciation in the research the enrichment report
// cites, and a team's grade is not a mark on its manager (TERMS.md §1).
//
// Teams that could use support appear in an alphabetical list with how long
// they have needed it, never with a score or a position. Suppressed teams
// (too few people) are counted as covered-but-not-shown and named nowhere.

const GOOD = new Set(['A', 'B', 'C']);
const STRAINED = new Set(['D', 'E']);

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Lengths (in weeks) of every D/E stretch that ended with a return to C or better. */
export function recoveryEpisodes(weeks) {
  const out = [];
  let run = 0;
  for (const w of weeks) {
    if (!w.grade) continue;
    if (STRAINED.has(w.grade)) run += 1;
    else {
      if (run > 0) out.push(run);
      run = 0;
    }
  }
  return out;
}

/** How many of the latest graded weeks in a row were D or E. */
export function strainedStreak(weeks) {
  let n = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    const w = weeks[i];
    if (!w.grade) continue;
    if (STRAINED.has(w.grade)) n += 1;
    else break;
  }
  return n;
}

/**
 * @param teams [{ name, weeks: [{week, grade, score}], current: {grade, score, suppressed, hasData, contributors}, completion: {done, closed} }]
 */
export function organisationSummary(teams) {
  const withData = teams.filter((t) => t.current?.hasData);
  const graded = withData.filter((t) => t.current.grade);
  const grades = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const t of graded) grades[t.current.grade] += 1;
  const episodes = teams.flatMap((t) => recoveryEpisodes(t.weeks));
  const done = teams.reduce((a, t) => a + (t.completion?.done || 0), 0);
  const closed = teams.reduce((a, t) => a + (t.completion?.closed || 0), 0);
  const committedTeams = teams.filter((t) => (t.completion?.committed || 0) > 0).length;
  const needSupport = graded
    .map((t) => ({ name: t.name, weeks: strainedStreak(t.weeks) }))
    .filter((t) => t.weeks >= 2)
    .sort((a, b) => a.name.localeCompare(b.name));
  const strainedPeople = graded.filter((t) => STRAINED.has(t.current.grade)).reduce((a, t) => a + (t.current.contributors || 0), 0);

  // One "most improved" mention: the biggest rise against the team's own
  // earlier weeks, only when positive and the team is now C or better.
  let mostImproved = null;
  for (const t of graded) {
    if (!GOOD.has(t.current.grade)) continue;
    const scored = t.weeks.filter((w) => w.score !== null && w.score !== undefined);
    if (scored.length < 6) continue;
    const before = scored.slice(-8, -4).map((w) => w.score);
    if (!before.length) continue;
    const rise = t.current.score - before.reduce((a, b) => a + b, 0) / before.length;
    if (rise >= 10 && (!mostImproved || rise > mostImproved.rise)) mostImproved = { name: t.name, rise: Math.round(rise) };
  }

  return {
    teams: teams.length,
    withData: withData.length,
    graded: graded.length,
    suppressed: withData.length - graded.length,
    coverage: teams.length ? graded.length / teams.length : null,
    grades,
    sustainableShare: graded.length ? graded.filter((t) => GOOD.has(t.current.grade)).length / graded.length : null,
    medianWeeksToRecover: median(episodes),
    recoveries: episodes.length,
    actionCompletion: closed ? done / closed : null,
    actingTeamsShare: teams.length ? committedTeams / teams.length : null,
    needSupport,
    strainedPeople,
    mostImproved: mostImproved ? { name: mostImproved.name, rise: mostImproved.rise } : null,
  };
}

/** Who may see the organisation view: site administrators and members of the configured groups. */
export function canSeeOrganisation({ isAdmin, groups = [] }, orgSettings = {}) {
  if (isAdmin) return true;
  const allowed = new Set((orgSettings.groups || []).map((g) => g.toLowerCase()));
  return groups.some((g) => allowed.has(String(g).toLowerCase()));
}

export function validateOrgSettings(input) {
  const list = Array.isArray(input?.groups) ? input.groups : String(input?.groups || '').split(/[\n,]+/);
  const groups = [...new Set(list.map((g) => String(g).trim()).filter(Boolean))];
  if (groups.length > 20) throw new Error('List at most 20 groups');
  if (groups.some((g) => g.length > 255)) throw new Error('A group name is at most 255 characters');
  return { groups };
}
