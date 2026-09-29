// Disclosure templates drafted from the evidence pack.
//
// These are drafts for a person to edit, never filed automatically:
//  - ESRS S1 (own workforce) narrative on health and safety and work-life
//    balance. After the 2026 Omnibus, CSRD applies to companies with more
//    than 1,000 employees and €450m turnover, from financial year 2027, and
//    S1 has no burnout metric: this supports the narrative only.
//  - Top Employers Institute, Wellbeing domain: supporting evidence for the
//    HR Best Practices Survey validation session.
//  - B Corp, Fair Work: "regularly evaluate workplace culture and respond".
//    B Lab also asks for results by identity group, which this app cannot
//    and will not produce.

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);

export function disclosures(p) {
  const top = p.hazards.filter((h) => !h.enabler && h.attention === 'high').slice(0, 3).map((h) => h.label.toLowerCase());
  const measures = `Every week, ${p.scope.teams} teams' working conditions were screened for organisation-of-work hazards (working hours and recovery, workload and pace, fragmentation, deadline pressure and rework) from work-tracking metadata, at team level only, with no individual data and no content read.`;
  const outcome = `At the end of ${p.quarter}, ${pct(p.sustainableShare)} of screened teams were in sustainable conditions (grade C or better); teams that dropped below recovered in a median of ${p.medianWeeksToRecover ?? 'n/a'} weeks.`;
  const acted = `${p.actions.teams} teams committed to ${p.actions.committed} changes to how work is organised, and ${pct(p.actions.completion)} of closed actions were carried out.`;
  const participation = p.participation.pulseTeams
    ? `Workers took part through an anonymous team pulse (${p.participation.responses} responses across ${p.participation.pulseTeams} teams).`
    : 'Worker participation in the screening itself is not yet in place.';
  const focus = top.length ? `The hazards needing most attention were ${top.join(', ')}.` : 'No hazard indicator needed high attention across the organisation.';
  return {
    esrsS1: {
      title: 'ESRS S1 own workforce: health and safety and work-life balance (narrative draft)',
      text: [measures, outcome, focus, acted, participation, 'These are leading indicators of psychosocial risk at team level; they are not a measure of individual health.'].join(' '),
      caveat: 'Draft for the sustainability team. ESRS S1 datapoints on health and safety are incidents and ill-health; this supports the narrative on policies and actions only.',
    },
    topEmployers: {
      title: 'Top Employers: Wellbeing domain supporting evidence (draft)',
      text: [measures, outcome, acted, participation, 'The approach, bands and limits are documented, and the use of results in any decision about an individual is prohibited.'].join(' '),
      caveat: 'Supporting evidence for the validation session, not a survey answer.',
    },
    bCorpFairWork: {
      title: 'B Corp Fair Work: regular evaluation of workplace culture (draft)',
      text: [measures, participation, focus, acted].join(' '),
      caveat: 'B Lab asks for results by identity group. Happy Company does not collect identity data and cannot produce such breakdowns; pair it with a survey that can.',
    },
  };
}
