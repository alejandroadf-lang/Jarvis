// Checking the grade against a validated burnout scale.
//
// The bands behind the grade are research-based starting points, not
// calibrated cut-offs. Before any public badge, the grade has to be shown to
// track something validated. With validation mode on, teams' pulse results
// include the Copenhagen Burnout Inventory's work-related scale; across
// teams, a higher grade score should go with a lower burnout score. This
// computes Spearman's rank correlation for that, and says plainly when there
// are too few teams to say anything.

export const MIN_TEAMS = 5;

function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}

/** pairs: [{ gradeScore, cbi }] one per team for the same period. */
export function validationSummary(pairs) {
  const usable = pairs.filter((p) => Number.isFinite(p.gradeScore) && Number.isFinite(p.cbi));
  if (usable.length < MIN_TEAMS) {
    return { teams: usable.length, rho: null, verdict: `Needs at least ${MIN_TEAMS} teams with both a grade and a completed burnout scale; ${usable.length} so far.` };
  }
  const rho = spearman(usable.map((p) => p.gradeScore), usable.map((p) => p.cbi));
  let verdict;
  if (rho === null) verdict = 'No variation to compare yet.';
  else if (rho <= -0.5) verdict = 'Strong agreement: teams with better working conditions report less burnout.';
  else if (rho <= -0.3) verdict = 'Moderate agreement: better conditions go with less burnout, with exceptions worth a look.';
  else if (rho < 0) verdict = 'Weak agreement: the grade and the burnout scale only loosely match. Recalibrate the bands before relying on the grade.';
  else verdict = 'No agreement: the grade does not track reported burnout here. Do not rely on it until the bands are recalibrated.';
  return { teams: usable.length, rho: Math.round(rho * 100) / 100, verdict };
}
