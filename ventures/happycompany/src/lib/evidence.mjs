// The quarterly psychosocial-risk evidence pack.
//
// What an ISO 45001 auditor, a German Gefährdungsbeurteilung, the HSE
// Management Standards approach, Safe Work Australia's code and a French
// DUERP all ask for is the same shape: which hazards were screened, how,
// what was found, what was done, whether workers took part, and what the
// assessment does not cover. This builds that, for one quarter and one
// product, from organisation-level figures only. No team is named in the
// pack except in the alphabetical "needed support" list, and no person
// ever is.

import { FRAMEWORKS, SIGNAL_MAP, ISO45001_EVIDENCE, METHOD_VERSION, coverage } from './frameworks.mjs';
import { BANDS, INDICATOR_KEYS } from './score.mjs';
import { ENABLER_BANDS, ENABLER_KEYS } from './enablers.mjs';
import { PULSE_ITEMS, itemMean } from './pulse.mjs';
import { USE_BAN, NEVER_MEASURED } from './transparency.mjs';

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${Math.round(v * 100)}%`);
const LABEL = { ...Object.fromEntries(Object.entries(BANDS).map(([k, b]) => [k, b.label])), ...Object.fromEntries(Object.entries(ENABLER_BANDS).map(([k, b]) => [k, b.label])) };

export function attentionLevel(actShare) {
  if (actShare === null || actShare === undefined) return 'no data';
  if (actShare >= 0.3) return 'high';
  if (actShare >= 0.1) return 'medium';
  return 'low';
}

/**
 * @param input {
 *   product, quarter, weeks: [week], generatedAt,
 *   teams: [{ name, weeks: [{ week, grade, suppressed, hasData, statuses: {key: status}, enablerStatuses }], actions: {committed, done, closed}, pulse: { tallies: [tally], on } , settings }],
 *   summary: organisationSummary(...) for the last week,
 *   audit: [{ event, detail }], disabled: {key:false} union across teams,
 *   orgSettings: { consultationRecorded, consultationDate, organisationName }
 * }
 */
export function buildEvidence(input) {
  const { product, quarter, weeks, teams, summary, audit = [], orgSettings = {}, generatedAt } = input;
  const inQuarter = new Set(weeks);
  const half = Math.ceil(weeks.length / 2);
  const firstHalf = new Set(weeks.slice(0, half));

  // Hazard indicators: share of scored team-weeks at "act now", and the trend.
  const tally = {};
  for (const key of [...INDICATOR_KEYS, ...ENABLER_KEYS]) tally[key] = { scored: 0, act: 0, early: [0, 0], late: [0, 0] };
  let teamWeeks = 0;
  let suppressedWeeks = 0;
  const gradeWeeks = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const t of teams) {
    for (const w of t.weeks) {
      if (!inQuarter.has(w.week) || !w.hasData) continue;
      teamWeeks += 1;
      if (w.suppressed || !w.grade) {
        suppressedWeeks += 1;
        continue;
      }
      gradeWeeks[w.grade] += 1;
      for (const [key, status] of Object.entries({ ...(w.statuses || {}), ...(w.enablerStatuses || {}) })) {
        if (!tally[key] || status === 'unknown') continue;
        const act = status === 'act' ? 1 : 0;
        tally[key].scored += 1;
        tally[key].act += act;
        const bucket = firstHalf.has(w.week) ? tally[key].early : tally[key].late;
        bucket[0] += 1;
        bucket[1] += act;
      }
    }
  }
  const hazards = Object.entries(tally)
    .filter(([, t]) => t.scored > 0)
    .map(([key, t]) => {
      const actShare = t.act / t.scored;
      const early = t.early[0] ? t.early[1] / t.early[0] : null;
      const late = t.late[0] ? t.late[1] / t.late[0] : null;
      const direction = early === null || late === null ? 'n/a' : late < early - 0.05 ? 'improving' : late > early + 0.05 ? 'worsening' : 'steady';
      return { key, label: LABEL[key], enabler: ENABLER_KEYS.includes(key), teamWeeks: t.scored, actShare, attention: attentionLevel(actShare), direction };
    })
    .sort((a, b) => b.actShare - a.actShare || a.key.localeCompare(b.key));

  // Worker participation: pulse tallies summed across teams, per statement.
  const pulseTeams = teams.filter((t) => t.pulse?.on).length;
  const summed = {};
  let responses = 0;
  for (const t of teams) {
    for (const tl of t.pulse?.tallies || []) {
      responses += tl.n;
      for (const [k, counts] of Object.entries(tl.items || {})) {
        if (!summed[k]) summed[k] = [0, 0, 0, 0, 0];
        counts.forEach((c, i) => (summed[k][i] += c));
      }
    }
  }
  const minGroup = 5;
  const statements = PULSE_ITEMS.map((item) => {
    const counts = summed[item.key];
    const n = counts ? counts.reduce((a, b) => a + b, 0) : 0;
    if (n < minGroup) return { key: item.key, text: item.text, standard: item.standard, n, shown: false };
    return { key: item.key, text: item.text, standard: item.standard, n, shown: true, mean: Math.round(itemMean(counts) * 10) / 10, favourable: (counts[3] + counts[4]) / n };
  });

  const actions = teams.reduce(
    (a, t) => ({ committed: a.committed + (t.actions?.committed || 0), done: a.done + (t.actions?.done || 0), closed: a.closed + (t.actions?.closed || 0), teams: a.teams + ((t.actions?.committed || 0) > 0 ? 1 : 0) }),
    { committed: 0, done: 0, closed: 0, teams: 0 },
  );

  // Framework view: each category's attention level, from the worst of its signals.
  const disabled = input.disabled || {};
  const frameworks = Object.keys(FRAMEWORKS).map((fk) => {
    const cov = coverage(fk, { disabled });
    return {
      ...cov,
      categories: cov.categories.map((c) => {
        const metadata = c.signals.filter((s) => !s.startsWith('pulse:'));
        const shares = metadata.map((s) => hazards.find((h) => h.key === s)?.actShare).filter((v) => v !== undefined);
        const pulse = c.signals.filter((s) => s.startsWith('pulse:')).map((s) => statements.find((st) => `pulse:${st.key}` === s)).filter((st) => st?.shown);
        return {
          ...c,
          attention: shares.length ? attentionLevel(Math.max(...shares)) : 'no data',
          pulse: pulse.map((st) => ({ standard: st.standard, favourable: st.favourable })),
        };
      }),
    };
  });

  const settingsChanges = audit.filter((e) => e.event === 'settings.save').length;
  const switchedOff = Object.entries(disabled).filter(([, v]) => v === false).map(([k]) => LABEL[k] || k);

  return {
    title: `Psychosocial risk evidence, ${quarter}`,
    organisation: orgSettings.organisationName || null,
    product,
    quarter,
    weeks,
    generatedAt,
    methodVersion: METHOD_VERSION,
    scope: {
      teams: teams.length,
      teamWeeks,
      suppressedShare: teamWeeks ? suppressedWeeks / teamWeeks : null,
      coverage: summary?.coverage ?? null,
    },
    grades: gradeWeeks,
    sustainableShare: summary?.sustainableShare ?? null,
    medianWeeksToRecover: summary?.medianWeeksToRecover ?? null,
    needSupport: summary?.needSupport || [],
    hazards,
    actions: { ...actions, completion: actions.closed ? actions.done / actions.closed : null },
    participation: {
      consultationRecorded: Boolean(orgSettings.consultationRecorded),
      consultationDate: orgSettings.consultationDate || null,
      pulseTeams,
      responses,
      statements,
    },
    frameworks,
    iso45001: ISO45001_EVIDENCE,
    governance: { settingsChanges, switchedOff, auditEntries: audit.length },
    limits: {
      notMeasured: NEVER_MEASURED,
      note: 'This is a screening input to a psychosocial risk assessment, not the assessment itself. The hazards listed as not covered must be assessed by other means, with the involvement of workers.',
    },
    useBan: USE_BAN,
    signOff: { reviewedBy: '', role: '', date: '' },
  };
}

/** The pack as Markdown, for copying into any document system. */
export function evidenceMarkdown(p) {
  const L = [];
  L.push(`# ${p.title}${p.organisation ? `: ${p.organisation}` : ''}`);
  L.push('');
  L.push(`Generated ${p.generatedAt.slice(0, 10)} by Happy Company, method ${p.methodVersion}, ${p.product === 'jira' ? 'Jira' : 'Confluence'} activity, weeks ${p.weeks[0]} to ${p.weeks[p.weeks.length - 1]}.`);
  L.push('');
  L.push('## Scope');
  L.push(`${p.scope.teams} teams; ${p.scope.teamWeeks} team-weeks with activity, ${pct(p.scope.suppressedShare)} of them too small to show (fewer than 5 active people) and excluded from every figure below.`);
  L.push('');
  L.push('## Results');
  L.push(`Share of teams in sustainable conditions (grade C or better) at quarter end: ${pct(p.sustainableShare)}. Team-weeks by grade: ${Object.entries(p.grades).map(([g, n]) => `${g} ${n}`).join(', ')}. Median weeks to recover from D or E: ${p.medianWeeksToRecover ?? 'n/a'}.`);
  if (p.needSupport.length) L.push(`Teams at D or E for two weeks or more at quarter end (alphabetical): ${p.needSupport.map((t) => t.name).join(', ')}.`);
  L.push('');
  L.push('## Hazards screened (share of team-weeks at "act now", trend within the quarter)');
  L.push('| Indicator | Attention | Act-now share | Trend |');
  L.push('|---|---|---|---|');
  for (const h of p.hazards) L.push(`| ${h.label}${h.enabler ? ' (enabler)' : ''} | ${h.attention} | ${pct(h.actShare)} | ${h.direction} |`);
  L.push('');
  L.push('## Actions (organisational controls)');
  L.push(`${p.actions.teams} teams committed to ${p.actions.committed} changes to how work is organised; ${p.actions.done} of ${p.actions.closed} closed actions were done (${pct(p.actions.completion)}).`);
  L.push('');
  L.push('## Worker participation');
  L.push(`Consultation with workers' representatives recorded: ${p.participation.consultationRecorded ? `yes${p.participation.consultationDate ? `, ${p.participation.consultationDate}` : ''}` : 'no'}. Anonymous team pulse: ${p.participation.pulseTeams} teams, ${p.participation.responses} responses.`);
  for (const s of p.participation.statements.filter((x) => x.shown)) L.push(`- ${s.standard}: "${s.text}" ${pct(s.favourable)} agree (n=${s.n}).`);
  L.push('');
  for (const f of p.frameworks) {
    L.push(`## ${f.name}`);
    if (f.role) L.push(f.role);
    for (const c of f.categories) L.push(`- ${c.label}: attention ${c.attention}${c.pulse.length ? `; pulse ${c.pulse.map((x) => `${x.standard} ${pct(x.favourable)} agree`).join(', ')}` : ''}.`);
    L.push(`- Not covered by this app: ${f.notCovered.join('; ')}.`);
    L.push('');
  }
  L.push('## ISO 45001:2018 clauses this evidence supports');
  for (const e of p.iso45001) L.push(`- ${e.clause} ${e.topic}: ${e.evidence}`);
  L.push('');
  L.push('## Governance');
  L.push(`${p.governance.settingsChanges} settings changes recorded in the audit trail this quarter.${p.governance.switchedOff.length ? ` Signals switched off: ${p.governance.switchedOff.join(', ')}.` : ' No signals switched off.'}`);
  L.push('');
  L.push('## Limits');
  L.push(p.limits.note);
  for (const n of p.limits.notMeasured) L.push(`- ${n}`);
  L.push('');
  L.push(`Use: ${p.useBan}`);
  L.push('');
  L.push('## Review');
  L.push('Reviewed by: ____________________  Role: ____________________  Date: __________');
  return L.join('\n');
}

/** The pack as Confluence storage format (XHTML). */
export function evidenceHtml(p) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return evidenceMarkdown(p)
    .split('\n')
    .map((line) => {
      if (line.startsWith('# ')) return `<h1>${esc(line.slice(2))}</h1>`;
      if (line.startsWith('## ')) return `<h2>${esc(line.slice(3))}</h2>`;
      if (line.startsWith('- ')) return `<p>• ${esc(line.slice(2))}</p>`;
      if (line.startsWith('|')) {
        if (/^\|---/.test(line)) return '';
        const cells = line.split('|').slice(1, -1).map((c) => `<td>${esc(c.trim())}</td>`).join('');
        return `<table><tbody><tr>${cells}</tr></tbody></table>`;
      }
      return line ? `<p>${esc(line)}</p>` : '';
    })
    .join('');
}

export { SIGNAL_MAP };
