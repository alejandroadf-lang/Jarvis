// What the app measures, what it never measures, and what the grade may not
// be used for, in one place.
//
// The same text is shown to every employee on the "What we measure" tab,
// printed in the weekly digest footer and the evidence pack, and quoted in
// TERMS.md and WORKS_COUNCIL.md. Gartner's finding that trust in workplace
// data rises from 29% to 86% when people are told how it is used is the
// reason this is a feature and not a footnote; the Microsoft Productivity
// Score retreat in 2020 is the reason the use ban is in the product itself.

import { BANDS, DIMENSIONS } from './score.mjs';

export const USE_BAN =
  'The grade and every figure behind it describe working conditions for a team. They may not be used to assess, rank, pay, reward, promote, discipline or dismiss any person. This is a condition of the licence.';

export const NEVER_MEASURED = [
  'What anyone writes: comments, descriptions, page and issue text, titles.',
  'Who did what. People are replaced by a code before anything is stored, and nothing is ever shown for one person.',
  'Exact times. Only the hour of the day is kept.',
  'Calls, chat, email, calendars, or anything outside Jira and Confluence.',
  'Stress, emotions or health. The app describes working conditions, not people.',
];

export function transparency({ minGroup = 5, disabled = {} } = {}) {
  const measured = Object.entries(DIMENSIONS).map(([key, dim]) => ({
    key,
    label: dim.label,
    signals: Object.entries(BANDS)
      .filter(([k, b]) => b.dimension === key && disabled[k] !== false)
      .map(([, b]) => b.label),
  }));
  return {
    measured,
    neverMeasured: NEVER_MEASURED,
    rules: [
      `Nothing is shown for a week with fewer than ${minGroup} active people.`,
      'There is no view of any individual, for anyone, including administrators.',
      'Per-person counts are deleted after 21 days. Team figures are kept for 26 weeks; quarterly evidence summaries, which contain team and organisation figures only, for 3 years.',
      'Nothing leaves Atlassian. The app makes no outside connections.',
      'Administrators can switch any signal off. Switched-off signals are listed nowhere and scored nowhere.',
    ],
    useBan: USE_BAN,
    limits: 'This page sees the part of work that lands in Jira and Confluence. Workload from meetings, chat and email, and how people treat each other, are invisible to it. The optional team pulse asks about those directly.',
  };
}
