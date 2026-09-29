// The optional anonymous team pulse.
//
// Metadata cannot see the biggest single predictor of burnout (McKinsey's
// Health Institute: toxic behaviour explains more than 60% of the variance
// in burnout symptoms), nor support, role clarity, control or how change is
// handled. Regulators expect worker participation in the risk assessment
// (HSE's Talking Toolkit, GDA). So a team can add a short pulse: eight
// statements, one per HSE Management Standard plus two that check the grade.
//
// Anonymity is structural, not a promise:
//  - answers are stored only as counts per statement and option; no
//    response record exists, so no answer can be linked to anyone;
//  - a separate list of "already answered" codes, hashed with a key that is
//    different for every period and unrelated to the activity pseudonyms,
//    stops double voting and says nothing about the answers;
//  - results are shown only for a closed period (the current one shows only
//    how many have answered), so nobody can watch the counts move when a
//    colleague answers;
//  - a statement's results are shown only when at least the team's minimum
//    group answered it. There is no free text.
//
// Validation mode adds the seven work-related items of the Copenhagen
// Burnout Inventory (Kristensen et al., Work & Stress 2005), which its
// authors made free to use, so the grade can be checked against a validated
// scale (VALIDATION.md). Check the wording against the published version,
// and the validated translation for non-English teams, before a pilot.

export const AGREE = ['Strongly disagree', 'Disagree', 'Neither', 'Agree', 'Strongly agree'];
export const FREQUENCY = ['Never or almost never', 'Seldom', 'Sometimes', 'Often', 'Always'];
export const DEGREE = ['To a very low degree', 'To a low degree', 'Somewhat', 'To a high degree', 'To a very high degree'];

export const PULSE_ITEMS = Object.freeze([
  { key: 'match', text: 'The grade on our team page matches how the last few weeks felt.', scale: 'agree', standard: 'Calibration' },
  { key: 'hours', text: 'Most weeks I can finish my work within normal hours.', scale: 'agree', standard: 'Demands' },
  { key: 'control', text: 'I have a say in how I do my work.', scale: 'agree', standard: 'Control' },
  { key: 'support', text: 'When work piles up, I get the support I need from my lead.', scale: 'agree', standard: 'Support' },
  { key: 'respect', text: 'People on this team treat each other with respect.', scale: 'agree', standard: 'Relationships' },
  { key: 'safety', text: 'I can raise a problem or a mistake without fear.', scale: 'agree', standard: 'Relationships' },
  { key: 'role', text: 'I know what is expected of me.', scale: 'agree', standard: 'Role' },
  { key: 'change', text: 'Changes that affect my work are explained to me in time.', scale: 'agree', standard: 'Change' },
]);

// Copenhagen Burnout Inventory, work-related burnout. Scored 0/25/50/75/100
// from the lowest to the highest option; item cbi4 is reversed.
export const CBI_ITEMS = Object.freeze([
  { key: 'cbi1', text: 'Do you feel worn out at the end of the working day?', scale: 'frequency' },
  { key: 'cbi2', text: 'Are you exhausted in the morning at the thought of another day at work?', scale: 'frequency' },
  { key: 'cbi3', text: 'Do you feel that every working hour is tiring for you?', scale: 'frequency' },
  { key: 'cbi4', text: 'Do you have enough energy for family and friends during leisure time?', scale: 'frequency', reverse: true },
  { key: 'cbi5', text: 'Is your work emotionally exhausting?', scale: 'degree' },
  { key: 'cbi6', text: 'Does your work frustrate you?', scale: 'degree' },
  { key: 'cbi7', text: 'Do you feel burnt out because of your work?', scale: 'degree' },
]);

export const SCALES = { agree: AGREE, frequency: FREQUENCY, degree: DEGREE };

export function itemsFor({ validation = false } = {}) {
  return validation ? [...PULSE_ITEMS, ...CBI_ITEMS] : [...PULSE_ITEMS];
}

/** The period a date falls in: "2026-09" monthly, "2026-Q3" quarterly. */
export function periodOf(day, cadence) {
  const [y, m] = day.split('-').map(Number);
  if (cadence === 'quarterly') return `${y}-Q${Math.ceil(m / 3)}`;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function previousPeriod(period) {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) return Number(q[2]) === 1 ? `${Number(q[1]) - 1}-Q4` : `${q[1]}-Q${Number(q[2]) - 1}`;
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Validates one response: {itemKey: 1..5}. Unanswered items are allowed and skipped. */
export function validateResponse(answers, items) {
  const known = new Map(items.map((i) => [i.key, i]));
  const clean = {};
  for (const [key, value] of Object.entries(answers || {})) {
    if (!known.has(key)) throw new Error(`unknown statement ${JSON.stringify(key)}`);
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('Each answer is a whole number from 1 to 5');
    clean[key] = n;
  }
  if (!Object.keys(clean).length) throw new Error('Answer at least one statement');
  return clean;
}

export function emptyTally() {
  return { n: 0, items: {} };
}

/** Adds a response to the counts. The response itself is not kept anywhere. */
export function addToTally(tally, answers) {
  tally.n += 1;
  for (const [key, value] of Object.entries(answers)) {
    if (!tally.items[key]) tally.items[key] = [0, 0, 0, 0, 0];
    tally.items[key][value - 1] += 1;
  }
  return tally;
}

/** Mean on the 1..5 scale for an item's counts. */
export function itemMean(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  if (!n) return null;
  return counts.reduce((a, c, i) => a + c * (i + 1), 0) / n;
}

/** Team mean on the CBI 0..100 scale, from item counts. Null without all seven items. */
export function cbiScore(tally) {
  const means = [];
  for (const item of CBI_ITEMS) {
    const counts = tally.items[item.key];
    if (!counts) return null;
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) return null;
    const score = counts.reduce((a, c, i) => a + c * (item.reverse ? (4 - i) * 25 : i * 25), 0) / n;
    means.push(score);
  }
  return Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 10) / 10;
}

/** What may be shown of a closed period: items with enough answers only. */
export function publicResults(tally, items, minGroup) {
  if (!tally || tally.n < minGroup) return { shown: false, n: tally?.n || 0 };
  const out = [];
  for (const item of items) {
    const counts = tally.items[item.key];
    const n = counts ? counts.reduce((a, b) => a + b, 0) : 0;
    if (n < minGroup) continue;
    out.push({ key: item.key, text: item.text, standard: item.standard || 'Burnout scale', n, mean: Math.round(itemMean(counts) * 10) / 10, favourable: item.scale === 'agree' ? (counts[3] + counts[4]) / n : null });
  }
  return { shown: true, n: tally.n, items: out, cbi: cbiScore(tally) };
}
