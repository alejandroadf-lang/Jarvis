// "What gets you to the next letter."
//
// A grade that only goes up or down is a verdict. A grade that says which two
// changes would lift it is a plan, and the plan is what a team comes back
// for. This module answers one question: if one indicator were brought to
// healthy (100), what would the overall score become? It recomputes the
// score the same way score.mjs does (indicator → dimension mean → overall
// mean) so the promise on the page is arithmetic, not a guess.
//
// It says nothing about how hard each change is. That is the team's call,
// which is why the page offers levers and the team picks.

import { GRADE_FLOORS, gradeOf, meanOf } from './score.mjs';

const ORDER = ['E', 'D', 'C', 'B', 'A'];

export function nextGrade(grade) {
  const i = ORDER.indexOf(grade);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

/** Overall score of a card with one indicator's score replaced. */
export function scoreWith(card, key, newScore) {
  const dims = Object.values(card.dimensions).map((d) => meanOf(d.indicators.map((i) => (i.key === key ? newScore : i.score))));
  return meanOf(dims);
}

/**
 * The levers towards the next grade, best first.
 * @returns {{ grade, target, pointsNeeded, levers: [{key, label, from, liftsTo, reaches}] } | null}
 */
export function pathToNextGrade(card, max = 3) {
  if (!card || card.score === null) return null;
  const target = nextGrade(card.grade);
  if (!target) return { grade: card.grade, target: null, pointsNeeded: 0, levers: [] };
  const floor = GRADE_FLOORS[target];
  const levers = [];
  for (const dim of Object.values(card.dimensions)) {
    for (const ind of dim.indicators) {
      if (ind.score === null || ind.score >= 100) continue;
      const liftsTo = scoreWith(card, ind.key, 100);
      if (liftsTo <= card.score) continue;
      levers.push({ key: ind.key, label: ind.label, from: ind.score, liftsTo, reaches: liftsTo >= floor, grade: gradeOf(liftsTo) });
    }
  }
  levers.sort((a, b) => b.liftsTo - a.liftsTo || a.key.localeCompare(b.key));
  // If no single lever reaches the next grade, say which pair would.
  let pair = null;
  if (levers.length >= 2 && !levers[0].reaches) {
    const [a, b] = levers;
    const both = meanOf(
      Object.values(card.dimensions).map((d) => meanOf(d.indicators.map((i) => (i.key === a.key || i.key === b.key ? 100 : i.score)))),
    );
    pair = { keys: [a.key, b.key], liftsTo: both, reaches: both >= floor };
  }
  return { grade: card.grade, target, pointsNeeded: Math.max(0, floor - card.score), levers: levers.slice(0, max), pair };
}
