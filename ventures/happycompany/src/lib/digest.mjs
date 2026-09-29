// The weekly digest, as text.
//
// Weekly nudges are what turn a dashboard into a habit (Perceptyx, Officevibe,
// Swarmia); a daily bot was called spam (Yerbo's first product) and pull-only
// digest emails were paused (Viva). So: once a week, inside the tool the team
// already uses, and only when there is something the team can act on.
//
// The digest contains exactly what the team page shows for the completed
// week: grade, trend, the three things, what is waiting to be closed. It is
// posted where the team's page is visible to the same people, and every
// digest ends with the use ban.

import { USE_BAN } from './transparency.mjs';

const ARROW = { up: 'improving', down: 'worsening', flat: 'steady' };

/** {title, paragraphs, html} for a completed week, or null when there is nothing to say. */
export function composeDigest({ teamName, week, card, trend, toClose = [], path = null }) {
  if (!card || card.score === null) return null;
  const title = `Working conditions, ${teamName}, week ${week}: ${card.grade} (${card.score}/100)`;
  const paragraphs = [];
  paragraphs.push(
    trend?.delta === null || trend?.delta === undefined
      ? `The grade for week ${week} is ${card.grade}.`
      : `The grade for week ${week} is ${card.grade}, ${ARROW[trend.direction]} (${trend.delta > 0 ? '+' : ''}${trend.delta} against the four weeks before).`,
  );
  if (card.actions.length) {
    paragraphs.push('Three things worth changing this week:');
    for (const a of card.actions) paragraphs.push(`• ${a.text} ${a.action}`);
    paragraphs.push('Open Team health in this project or space to commit to the ones the team will try.');
  } else {
    paragraphs.push('Nothing needs changing this week.');
  }
  if (path?.target && path.levers?.length) {
    const best = path.levers[0];
    paragraphs.push(`To reach ${path.target}: ${best.label.toLowerCase()} would lift the score to ${best.liftsTo}.`);
  }
  const open = toClose.reduce((n, w) => n + w.items.length, 0);
  if (open) paragraphs.push(`${open} committed action${open === 1 ? ' is' : 's are'} waiting for a yes or no on the Actions tab.`);
  paragraphs.push('');
  paragraphs.push(`This describes working conditions for the team, never a person. ${USE_BAN}`);
  const html = paragraphs.map((p) => (p ? `<p>${escapeHtml(p)}</p>` : '')).join('');
  return { title, paragraphs, html };
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
