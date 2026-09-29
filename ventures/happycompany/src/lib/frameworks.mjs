// Where each signal sits in the standards and laws an auditor will ask about.
//
// The mapping is the product's claim, so it is written down once, here, and
// every evidence pack, disclosure template and the ISO page quote it. It
// says which hazard category each signal is evidence for, and, as loudly,
// which categories the app does NOT cover, so nobody mistakes a screening
// input for a complete assessment.
//
// Category names follow the published structure of each framework. Clause
// and table references in ISO documents are copyrighted text we do not
// reproduce; check them against your own copy. What the app may claim is
// "aligned with ISO 45003" and "evidence for ISO 45001 clauses …", never
// "certified": only organisations are certified, and ISO 45003 is guidance.

export const METHOD_VERSION = 'hc-2026.10';

// ISO 45003:2021 groups psychosocial hazards into aspects of how work is
// organised, social factors, and the work environment, equipment and
// hazardous tasks.
export const FRAMEWORKS = Object.freeze({
  iso45003: {
    name: 'ISO 45003:2021 psychosocial hazards',
    categories: {
      workingHours: 'Working hours and schedule (how work is organised)',
      workload: 'Workload and work pace (how work is organised)',
      jobDemands: 'Job demands (how work is organised)',
      jobControl: 'Job control or autonomy (how work is organised)',
      roles: 'Roles and expectations (how work is organised)',
      change: 'Organisational change management (how work is organised)',
      support: 'Support (social factors)',
      relationships: 'Interpersonal relationships, civility and respect (social factors)',
      workLife: 'Work–life balance (social factors)',
    },
    notCovered: [
      'Violence, harassment and bullying (the pulse asks about respect; it is not a reporting channel)',
      'Leadership, recognition and reward, career development',
      'Job security and precarious work',
      'Remote and isolated work',
      'The physical work environment, equipment and hazardous tasks',
      'Emotional demands and traumatic events',
    ],
  },
  hse: {
    name: 'UK HSE Management Standards',
    categories: { demands: 'Demands', control: 'Control', support: 'Support', relationships: 'Relationships', role: 'Role', change: 'Change' },
    notCovered: ['Relationships and Support are covered only through the optional pulse'],
  },
  gda: {
    name: 'Germany: GDA guidance on the psychosocial risk assessment (§5 ArbSchG)',
    categories: {
      content: 'Arbeitsinhalt / Arbeitsaufgabe (work content and task)',
      organisation: 'Arbeitsorganisation (work organisation, incl. working time and workflow)',
      social: 'Soziale Beziehungen (social relationships)',
      newForms: 'Neue Arbeitsformen (new forms of work)',
    },
    notCovered: ['Arbeitsumgebung (the physical work environment)', 'Emotional demands in the task itself'],
    role: 'A screening input to the assessment ("orientierendes Verfahren"), alongside the involvement of employees',
  },
  safeWorkAustralia: {
    name: 'Australia: psychosocial hazards (Safe Work Australia model Code of Practice; Victoria OHS (Psychological Health) Regulations)',
    categories: {
      highDemands: 'High job demands',
      lowControl: 'Low job control',
      poorSupport: 'Poor support',
      roleClarity: 'Lack of role clarity',
      change: 'Poor organisational change management',
      relationships: 'Conflict or poor workplace relationships',
    },
    notCovered: ['Bullying, harassment and violence', 'Inadequate reward and recognition', 'Poor organisational justice', 'Traumatic events', 'Remote or isolated work', 'Poor physical environment', 'Low job demands'],
  },
  france: {
    name: 'France: psychosocial risks in the DUERP (Gollac axes)',
    categories: {
      intensity: 'Intensité et temps de travail (work intensity and time)',
      autonomy: 'Autonomie (autonomy)',
      socialRelations: 'Rapports sociaux au travail (social relations)',
    },
    notCovered: ['Exigences émotionnelles', 'Conflits de valeurs', 'Insécurité de la situation de travail'],
  },
  netherlands: {
    name: 'Netherlands: psychosocial workload in the RI&E (Arbobesluit art. 2.15)',
    categories: { workPressure: 'Werkdruk (work pressure)', behaviour: 'Ongewenst gedrag (undesirable behaviour), via the pulse only' },
    notCovered: ['Reporting and handling of individual complaints of undesirable behaviour'],
  },
  belgium: {
    name: 'Belgium: psychosocial risks (well-being at work, the five domains)',
    categories: { organisation: 'Organisation du travail / arbeidsorganisatie', content: 'Contenu du travail / arbeidsinhoud', relations: 'Relations interpersonnelles / interpersoonlijke relaties' },
    notCovered: ['Conditions de vie au travail (physical environment)', 'Conditions de travail (terms of employment)'],
  },
  japan: {
    name: 'Japan: Stress Check Program, group analysis',
    categories: { demands: 'Quantitative job demands', control: 'Job control', support: 'Supervisor and co-worker support' },
    notCovered: ['The individual stress questionnaire itself, which is a separate legal duty'],
  },
});

// Signal → categories per framework. Pulse statements are listed too.
export const SIGNAL_MAP = Object.freeze({
  afterHoursShare: { iso45003: ['workingHours', 'workLife'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  lateShare: { iso45003: ['workingHours', 'workLife'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  weekendShare: { iso45003: ['workingHours', 'workLife'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  longSpanShare: { iso45003: ['workingHours'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  streakShare: { iso45003: ['workingHours', 'workLife'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  noRestShare: { iso45003: ['workingHours', 'workLife'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  concentration: { iso45003: ['workload'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  overloadedShare: { iso45003: ['workload'], hse: ['demands'], gda: ['content'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['content'], japan: ['demands'] },
  overdueShare: { iso45003: ['workload', 'jobDemands'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  wipMean: { iso45003: ['workload', 'jobDemands'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  carryOverShare: { iso45003: ['workload'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  inflowRatio: { iso45003: ['workload'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  itemsMedian: { iso45003: ['jobDemands'], hse: ['demands'], gda: ['content', 'newForms'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['content'], japan: ['demands'] },
  burstyShare: { iso45003: ['jobDemands'], hse: ['demands'], gda: ['organisation', 'newForms'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  mentionsPerPersonDay: { iso45003: ['jobDemands'], hse: ['demands'], gda: ['newForms'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  mentionTopShare: { iso45003: ['workload', 'support'], hse: ['demands', 'support'], gda: ['organisation'], safeWorkAustralia: ['highDemands', 'poorSupport'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands', 'support'] },
  dueCrunch: { iso45003: ['workload', 'jobDemands'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  highPriorityShare: { iso45003: ['jobDemands'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  unplannedShare: { iso45003: ['workload', 'change'], hse: ['demands', 'change'], gda: ['organisation'], safeWorkAustralia: ['highDemands', 'change'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  dueMoveRate: { iso45003: ['jobDemands', 'change'], hse: ['demands', 'change'], gda: ['organisation'], safeWorkAustralia: ['highDemands', 'change'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  loadSurge: { iso45003: ['workload'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  reopenRate: { iso45003: ['jobDemands', 'roles'], hse: ['demands', 'role'], gda: ['content'], safeWorkAustralia: ['highDemands', 'roleClarity'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['content'], japan: ['demands'] },
  blockedShare: { iso45003: ['jobControl', 'support'], hse: ['control', 'support'], gda: ['organisation'], safeWorkAustralia: ['lowControl', 'poorSupport'], france: ['autonomy'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['control'] },
  reprioritisationRate: { iso45003: ['change'], hse: ['change'], gda: ['organisation'], safeWorkAustralia: ['change'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  selfAssignedShare: { iso45003: ['jobControl'], hse: ['control'], gda: ['content'], safeWorkAustralia: ['lowControl'], france: ['autonomy'], netherlands: ['workPressure'], belgium: ['content'], japan: ['control'] },
  soloShare: { iso45003: ['support', 'workLife'], hse: ['support'], gda: ['social'], safeWorkAustralia: ['poorSupport'], france: ['socialRelations'], netherlands: ['workPressure'], belgium: ['relations'], japan: ['support'] },
  'pulse:hours': { iso45003: ['workingHours', 'workload'], hse: ['demands'], gda: ['organisation'], safeWorkAustralia: ['highDemands'], france: ['intensity'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['demands'] },
  'pulse:control': { iso45003: ['jobControl'], hse: ['control'], gda: ['content'], safeWorkAustralia: ['lowControl'], france: ['autonomy'], netherlands: ['workPressure'], belgium: ['content'], japan: ['control'] },
  'pulse:support': { iso45003: ['support'], hse: ['support'], gda: ['social'], safeWorkAustralia: ['poorSupport'], france: ['socialRelations'], netherlands: ['workPressure'], belgium: ['relations'], japan: ['support'] },
  'pulse:respect': { iso45003: ['relationships'], hse: ['relationships'], gda: ['social'], safeWorkAustralia: ['relationships'], france: ['socialRelations'], netherlands: ['behaviour'], belgium: ['relations'], japan: ['support'] },
  'pulse:safety': { iso45003: ['relationships'], hse: ['relationships'], gda: ['social'], safeWorkAustralia: ['relationships'], france: ['socialRelations'], netherlands: ['behaviour'], belgium: ['relations'], japan: ['support'] },
  'pulse:role': { iso45003: ['roles'], hse: ['role'], gda: ['content'], safeWorkAustralia: ['roleClarity'], france: ['autonomy'], netherlands: ['workPressure'], belgium: ['content'], japan: ['demands'] },
  'pulse:change': { iso45003: ['change'], hse: ['change'], gda: ['organisation'], safeWorkAustralia: ['change'], france: ['socialRelations'], netherlands: ['workPressure'], belgium: ['organisation'], japan: ['support'] },
});

// ISO 45001:2018 requirements the app produces evidence for. The app is
// evidence inside an OH&S management system; it is not the system.
export const ISO45001_EVIDENCE = Object.freeze([
  { clause: '5.4', topic: 'Consultation and participation of workers', evidence: 'Works agreement status; the optional anonymous team pulse, its participation and results; the "What we measure" page available to every employee.' },
  { clause: '6.1.2.1', topic: 'Hazard identification, including psychosocial factors and how work is organised', evidence: 'Weekly screening of the organisation-of-work hazards in the framework map, for every covered team.' },
  { clause: '6.1.2.2', topic: 'Assessment of OH&S risks', evidence: 'Share of team-weeks in which each hazard indicator was at "act now", per quarter, with trend.' },
  { clause: '6.1.4', topic: 'Planning action', evidence: 'Actions teams committed to, from the week’s suggestions.' },
  { clause: '7.4', topic: 'Communication', evidence: 'The weekly digest and the employee transparency page.' },
  { clause: '7.5', topic: 'Documented information', evidence: 'The audit trail of settings, signal switches, actions and evidence packs, kept three years; quarterly evidence snapshots kept three years.' },
  { clause: '8.1.2', topic: 'Eliminating hazards and reducing risks (organisational controls)', evidence: 'The suggested changes are organisational controls on how work is organised, not individual resilience measures.' },
  { clause: '9.1.1', topic: 'Monitoring, measurement, analysis and performance evaluation', evidence: 'Weekly indicators with published method and bands, leading indicators in the sense of ISO 45004; sickness absence and leavers per quarter, imported by the organisation, as lagging indicators, with a check of whether the grade anticipated them.' },
  { clause: '9.3', topic: 'Management review', evidence: 'The quarterly evidence pack, with the organisation summary and trends, as a management review input.' },
  { clause: '10.2', topic: 'Incident, nonconformity and corrective action', evidence: 'Teams at D or E for two weeks or more, their committed actions and whether they were done.' },
  { clause: '10.3', topic: 'Continual improvement', evidence: 'Trends, recovery times, action completion and organisation levels quarter on quarter.' },
]);

/** For one framework: each category with the signals that feed it. */
export function coverage(frameworkKey, { disabled = {} } = {}) {
  const fw = FRAMEWORKS[frameworkKey];
  const out = Object.entries(fw.categories).map(([key, label]) => ({ key, label, signals: [] }));
  for (const [signal, map] of Object.entries(SIGNAL_MAP)) {
    if (disabled[signal] === false) continue;
    for (const cat of map[frameworkKey] || []) {
      const row = out.find((r) => r.key === cat);
      if (row && !row.signals.includes(signal)) row.signals.push(signal);
    }
  }
  return { key: frameworkKey, name: fw.name, categories: out, notCovered: fw.notCovered, role: fw.role || null };
}
