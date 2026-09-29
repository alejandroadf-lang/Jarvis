// Organisation levels: Measuring, Acting, Sustaining.
//
// A certificate is what the enrichment report found customers chase (Great
// Place to Work, Top Employers), and what an ISO 45001 auditor looks for is
// the same loop: screen, consult, act, check the result held. The levels are
// that loop in three steps, judged from the quarterly evidence packs, so an
// organisation can see what the next step needs and prove it reached it.
//
// These are Happy Company's own levels, not an ISO scheme and not a
// certification. The thresholds are provisional (method hc-2026.10): they
// were set from the research, not from customer data, and ISO.md says so.
// When pilots produce data they are revisited and the method version moves.

export const LEVELS = Object.freeze(['measuring', 'acting', 'sustaining']);
export const LEVEL_LABEL = Object.freeze({ none: 'Not yet measuring', measuring: 'Measuring', acting: 'Acting', sustaining: 'Sustaining' });

export const THRESHOLDS = Object.freeze({
  shownShare: 0.8, // team-weeks large enough to show
  actingTeams: 0.5, // teams that committed to at least one action
  completion: 0.5, // closed actions that were done
  pulseTeams: 0.5, // teams running the anonymous pulse
  sustainable: 0.7, // teams at C or better at quarter end
  recoveryWeeks: 4, // median weeks back from D or E
});

const pct = (v) => `${Math.round(v * 100)}%`;
const share = (n, d) => (d ? n / d : null);

/** The criteria one pack meets or misses, per level. Sustaining also needs the pack before it. */
function criteriaOf(pack) {
  const teams = pack.scope.teams;
  const shown = pack.scope.suppressedShare === null ? null : 1 - pack.scope.suppressedShare;
  const acting = share(pack.actions.teams, teams);
  const pulse = share(pack.participation.pulseTeams, teams);
  const recovery = pack.medianWeeksToRecover;
  const row = (level, key, text, value, met) => ({ level, key, text, value, met: Boolean(met) });
  return [
    row('measuring', 'consultation', 'Workers’ representatives consulted, and the date recorded (ISO 45001 5.4)', pack.participation.consultationRecorded ? 'recorded' : 'not recorded', pack.participation.consultationRecorded),
    row('measuring', 'screening', `At least ${pct(THRESHOLDS.shownShare)} of team-weeks large enough to show`, shown === null ? 'no data' : pct(shown), shown !== null && shown >= THRESHOLDS.shownShare),
    row('acting', 'actingTeams', `At least ${pct(THRESHOLDS.actingTeams)} of teams committed to a change`, acting === null ? 'no data' : pct(acting), acting !== null && acting >= THRESHOLDS.actingTeams),
    row('acting', 'completion', `At least ${pct(THRESHOLDS.completion)} of closed actions done`, pack.actions.completion === null ? 'none closed' : pct(pack.actions.completion), pack.actions.completion !== null && pack.actions.completion >= THRESHOLDS.completion),
    row('acting', 'pulse', `At least ${pct(THRESHOLDS.pulseTeams)} of teams run the anonymous pulse`, pulse === null ? 'no data' : pct(pulse), pulse !== null && pulse >= THRESHOLDS.pulseTeams),
    row('sustaining', 'sustainable', `At least ${pct(THRESHOLDS.sustainable)} of teams at C or better at quarter end`, pack.sustainableShare === null ? 'no data' : pct(pack.sustainableShare), pack.sustainableShare !== null && pack.sustainableShare >= THRESHOLDS.sustainable),
    // No recovery seen means no team dropped long enough to need one: met.
    row('sustaining', 'recovery', `Teams back from D or E within ${THRESHOLDS.recoveryWeeks} weeks (median)`, recovery === null ? 'none needed' : `${recovery} weeks`, recovery === null || recovery <= THRESHOLDS.recoveryWeeks),
  ];
}

function reached(criteria, level) {
  const upTo = LEVELS.slice(0, LEVELS.indexOf(level) + 1);
  return criteria.filter((c) => upTo.includes(c.level)).every((c) => c.met);
}

/**
 * The level one quarter's pack reaches. `previous` is the quarter before it
 * (or null): Sustaining means two quarters in a row met every criterion.
 * Returns the criteria, the level and what the next one still needs.
 */
export function organisationLevel(pack, previous = null) {
  const criteria = criteriaOf(pack);
  let level = 'none';
  if (reached(criteria, 'measuring')) level = 'measuring';
  if (level === 'measuring' && reached(criteria, 'acting')) level = 'acting';
  const heldBefore = previous ? reached(criteriaOf(previous), 'sustaining') : false;
  if (level === 'acting' && reached(criteria, 'sustaining') && heldBefore) level = 'sustaining';
  const nextLevel = LEVELS[LEVELS.indexOf(level) + 1] || null;
  const missing = nextLevel ? criteria.filter((c) => LEVELS.indexOf(c.level) <= LEVELS.indexOf(nextLevel) && !c.met).map((c) => c.text) : [];
  if (nextLevel === 'sustaining' && !heldBefore && reached(criteria, 'sustaining')) missing.push('The same again next quarter: Sustaining is two quarters in a row');
  return { quarter: pack.quarter, level, label: LEVEL_LABEL[level], criteria, next: nextLevel ? { level: nextLevel, label: LEVEL_LABEL[nextLevel], missing } : null };
}
