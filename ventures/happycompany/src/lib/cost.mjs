// The cost-of-strain estimator: the customer's own assumptions, shown.
//
// Executives buy what they can put a number on (BCG puts burnout's cost to
// Canadian employers above C$200B a year; McKinsey's Health Institute
// estimates up to $11.7T of global value from better health). Those figures
// do not transfer to one company, and inventing a per-company figure would
// be false precision. So the calculator has no defaults for the assumptions
// that matter: the customer types in salary, replacement cost and the extra
// turnover they believe strain causes, and the page shows the arithmetic.

const FIELDS = {
  people: 'People in teams graded D or E',
  salary: 'Average annual salary cost per person',
  replacementCostShare: 'Cost of replacing one person, as a share of a year’s salary (e.g. 0.5)',
  extraTurnover: 'Extra yearly turnover you attribute to strain, as a share (e.g. 0.05 for 5 points)',
  absenceDays: 'Extra absence days per person per year you attribute to strain',
  workingDays: 'Working days per year',
};

export function validateCostInputs(input) {
  const out = {};
  for (const key of Object.keys(FIELDS)) {
    const v = Number(input?.[key]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${FIELDS[key]} must be a number of zero or more`);
    out[key] = v;
  }
  if (out.replacementCostShare > 5) throw new Error('Replacement cost above five years of salary is not credible');
  if (out.extraTurnover > 1) throw new Error('Extra turnover is a share between 0 and 1');
  if (out.workingDays === 0 || out.workingDays > 366) throw new Error('Working days per year must be between 1 and 366');
  return out;
}

export function strainCost(input) {
  const i = validateCostInputs(input);
  const turnover = i.people * i.extraTurnover * i.salary * i.replacementCostShare;
  const absence = i.people * i.absenceDays * (i.salary / i.workingDays);
  const total = turnover + absence;
  return {
    inputs: i,
    turnover: Math.round(turnover),
    absence: Math.round(absence),
    total: Math.round(total),
    formula: [
      `Turnover: ${i.people} people × ${i.extraTurnover} extra turnover × ${i.salary} salary × ${i.replacementCostShare} replacement cost = ${Math.round(turnover)}`,
      `Absence: ${i.people} people × ${i.absenceDays} days × ${i.salary} / ${i.workingDays} days = ${Math.round(absence)}`,
    ],
    caveat: 'Every assumption above is yours. The app contributes only the number of people in teams graded D or E. This is a scenario, not a measurement.',
  };
}

export const COST_FIELDS = FIELDS;
