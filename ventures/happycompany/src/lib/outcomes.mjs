// Sickness absence and leavers per team per quarter: the lagging indicators.
//
// The grade is a leading indicator: it moves weeks before anyone is off sick
// or hands in their notice. Absence and turnover are what follows, and they
// are what an ISO 45001 auditor, a CFO and an insurer count. With both, the
// app can check whether its grade predicted next quarter's absence, and the
// cost estimator can use the customer's own figures instead of guesses.
//
// Sickness absence is health data (GDPR Art. 9), even as a count of days. So:
//  - figures come in by hand, pasted from the HR system once a quarter, per
//    team, never per person. There is no HR-system connection: that would
//    need egress, and the app makes no outside connections;
//  - a team under OUTCOME_MIN_HEADCOUNT is refused at import and never
//    stored: in a team of six, one long absence is one known person;
//  - nothing is shown per team, anywhere. Group figures need at least
//    MIN_GROUP_TEAMS teams on each side, so no single team's rate can be
//    read off a group average;
//  - the figures never feed the grade: a team would look healthier simply
//    because people came in sick.

import { spearman } from './validation.mjs';
import { PROJECT_KEY, jiraScope, confluenceScope } from './events.mjs';

export const OUTCOME_MIN_HEADCOUNT = 10;
export const MIN_TEAMS = 5;
export const MIN_GROUP_TEAMS = 3;
export const MAX_ROWS = 300;
export const WORKING_DAYS_PER_YEAR = 220;

const num = (raw, decimalComma) => {
  const text = String(raw ?? '').trim().replace(/%$/, '').trim();
  if (!text) return null;
  // "4,5" from a European export is 4.5; "1.234,5" is 1234.5; "4.5" stays 4.5.
  const n = Number(decimalComma && text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Parses pasted rows `team, headcount, absence rate %, leavers` (leavers
 * optional). Comma, semicolon or tab separated; with semicolons or tabs a
 * decimal comma is accepted, as European spreadsheets export it. A header
 * row is skipped. `team` is the Jira project key or the Confluence space id.
 *
 * @returns {{ rows: [{scope, headcount, absenceRate, leavers}], dropped: [team] }}
 * @throws Error naming the line and the problem, or the unknown teams.
 */
export function parseOutcomes(text, { product, knownScopes }) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Paste one row per team: team, headcount, absence rate %, leavers.');
  if (lines.length > MAX_ROWS + 1) throw new Error(`At most ${MAX_ROWS} teams per import.`);
  const known = new Set(knownScopes);
  const rows = [];
  const dropped = [];
  const unknown = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    const semi = /[;\t]/.test(line);
    const cells = line.split(semi ? /[;\t]/ : ',').map((c) => c.trim());
    // A header row: neither headcount nor rate is a number.
    if (i === 0 && Number.isNaN(num(cells[1], semi)) && Number.isNaN(num(cells[2], semi))) return;
    const where = `Line ${i + 1}`;
    if (cells.length < 3) throw new Error(`${where}: expected team, headcount, absence rate %, leavers.`);
    const team = product === 'jira' ? cells[0].toUpperCase() : cells[0];
    const valid = product === 'jira' ? PROJECT_KEY.test(team) : /^\d{1,20}$/.test(team);
    if (!valid) throw new Error(`${where}: "${cells[0]}" is not a ${product === 'jira' ? 'Jira project key' : 'Confluence space id'}.`);
    const scope = product === 'jira' ? jiraScope(team) : confluenceScope(team);
    if (seen.has(scope)) throw new Error(`${where}: ${team} appears twice.`);
    seen.add(scope);
    const headcount = num(cells[1], semi);
    const absenceRate = num(cells[2], semi);
    const leavers = cells[3] === undefined || cells[3] === '' ? null : num(cells[3], semi);
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 100000) throw new Error(`${where}: headcount must be a whole number of people.`);
    if (absenceRate === null || Number.isNaN(absenceRate) || absenceRate < 0 || absenceRate > 100) throw new Error(`${where}: absence rate must be a percentage from 0 to 100, such as 4.5.`);
    if (leavers !== null && (!Number.isInteger(leavers) || leavers < 0 || leavers > headcount)) throw new Error(`${where}: leavers must be a whole number no larger than the headcount.`);
    if (!known.has(scope)) {
      unknown.push(team);
      return;
    }
    if (headcount < OUTCOME_MIN_HEADCOUNT) {
      dropped.push(team);
      return;
    }
    // Stored at the precision a group figure needs, not more.
    rows.push({ scope, headcount, absenceRate: Math.round(absenceRate * 10) / 10, leavers });
  });
  if (unknown.length) {
    throw new Error(`Happy Company does not count ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ` and ${unknown.length - 10} more` : ''}. Use the project key or space id of a team the app covers.`);
  }
  if (!rows.length) throw new Error(`No team with ${OUTCOME_MIN_HEADCOUNT} or more people: nothing to import.`);
  return { rows, dropped };
}

const weighted = (rows, pick) => {
  const usable = rows.filter((r) => pick(r) !== null && pick(r) !== undefined);
  const people = usable.reduce((a, r) => a + r.headcount, 0);
  return people ? usable.reduce((a, r) => a + pick(r) * r.headcount, 0) / people : null;
};
const turnover = (r) => (r.leavers === null ? null : r.leavers / r.headcount);

/** Organisation-level figures for one quarter's import. */
export function outcomeSummary(record) {
  if (!record?.rows?.length) return null;
  const rows = record.rows;
  const rate = weighted(rows, (r) => r.absenceRate);
  const turn = weighted(rows, turnover);
  return {
    quarter: record.quarter,
    teams: rows.length,
    headcount: rows.reduce((a, r) => a + r.headcount, 0),
    absenceRate: rate === null ? null : Math.round(rate * 10) / 10,
    quarterlyTurnover: turn === null ? null : Math.round(turn * 1000) / 10,
  };
}

/**
 * Does the grade go with absence? Spearman across teams between a quarter's
 * mean grade score and a quarter's absence rate.
 * @param scores {scope: {mean, graded, strained}} for the grade quarter
 * @param record the imported outcomes for the absence quarter
 */
export function rankCheck(scores, record) {
  if (!scores || !record) return { teams: 0, rho: null };
  const pairs = record.rows.filter((r) => Number.isFinite(scores[r.scope]?.mean));
  if (pairs.length < MIN_TEAMS) return { teams: pairs.length, rho: null };
  const rho = spearman(pairs.map((r) => scores[r.scope].mean), pairs.map((r) => r.absenceRate));
  return { teams: pairs.length, rho: rho === null ? null : Math.round(rho * 100) / 100 };
}

/**
 * The check the organisation page shows for one absence quarter: against
 * the same quarter's grades, and against the quarter before (does the grade
 * see it coming?). The verdict reads the lagged check when there is one.
 */
export function predictiveCheck({ quarter, sameScores, priorScores, record }) {
  const sameQuarter = rankCheck(sameScores, record);
  const quarterBefore = rankCheck(priorScores, record);
  const rho = quarterBefore.rho ?? sameQuarter.rho;
  let verdict;
  if (rho === null) verdict = `Needs at least ${MIN_TEAMS} teams with both a grade and imported absence figures.`;
  else if (rho <= -0.3) verdict = 'Teams with better working conditions had less sickness absence.';
  else if (rho < 0) verdict = 'Better working conditions go only loosely with less absence here.';
  else verdict = 'The grade does not track sickness absence here. Absence has many causes outside work; look at the teams before drawing conclusions.';
  return { quarter, sameQuarter, quarterBefore, verdict };
}

/**
 * Next quarter's absence and turnover for teams that spent most of a
 * quarter at D or E, against teams that did not. Null unless each side has
 * MIN_GROUP_TEAMS teams, so no team's own rate can be read off.
 */
export function strainGap(scores, next) {
  if (!scores || !next) return null;
  const strained = [];
  const sustainable = [];
  for (const r of next.rows) {
    const s = scores[r.scope];
    if (!s || s.graded < 4) continue;
    (s.strained / s.graded >= 0.5 ? strained : sustainable).push(r);
  }
  if (strained.length < MIN_GROUP_TEAMS || sustainable.length < MIN_GROUP_TEAMS) return null;
  const side = (rows) => ({ teams: rows.length, absenceRate: Math.round(weighted(rows, (r) => r.absenceRate) * 10) / 10, turnover: weighted(rows, turnover) });
  const a = side(strained);
  const b = side(sustainable);
  const extraRate = Math.max(0, a.absenceRate - b.absenceRate);
  const extraTurnover = a.turnover === null || b.turnover === null ? null : Math.max(0, a.turnover - b.turnover) * 4;
  return {
    quarter: next.quarter,
    strained: { teams: a.teams, absenceRate: a.absenceRate },
    sustainable: { teams: b.teams, absenceRate: b.absenceRate },
    // For the cost estimator, as a starting value the customer can change.
    suggestedAbsenceDays: Math.round((extraRate / 100) * WORKING_DAYS_PER_YEAR * 10) / 10,
    suggestedExtraTurnover: extraTurnover === null ? null : Math.round(extraTurnover * 100) / 100,
    caveat: 'A difference between groups, not proof that working conditions caused it. Absence and leaving have many causes.',
  };
}
