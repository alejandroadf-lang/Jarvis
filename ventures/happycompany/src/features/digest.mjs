// Posting the weekly digest.
//
// Off by default. A team (project or space administrator) turns it on in
// settings; the works-council pack says so, because it needs the app's write
// permission. Once on, the first daily run on or after the team's Monday
// posts the completed week, once: the week key is remembered, so a retried
// or repeated run never posts twice.

import { composeDigest } from '../lib/digest.mjs';
import { previousWeeks, localParts } from '../lib/time.mjs';
import { trend } from '../lib/score.mjs';
import { pathToNextGrade } from '../lib/progress.mjs';

export function createDigest({ store, jira, confluence, now, computeTeam, actions, teamName, audit }) {
  async function maybePost({ scope, product }) {
    const settings = (await store.get(`settings:${scope}`)) || {};
    if (settings.digest !== 'on') return { posted: false, reason: 'off' };
    const team = await computeTeam({ scope, product });
    const weekday = localParts(now(), team.settings.timeZone).weekday;
    if (weekday === 0) return { posted: false, reason: 'sunday' }; // wait for Monday in the team's zone
    const [lastWeek] = previousWeeks(team.thisWeek, 1);
    const key = `digest:${scope}:${lastWeek}`;
    if (await store.get(key)) return { posted: false, reason: 'already posted' };
    const entry = team.weeks.find((w) => w.week === lastWeek);
    if (!entry?.card) {
      await store.set(key, { week: lastWeek, skipped: entry?.suppressed ? 'too few people' : 'no data', at: now().toISOString() });
      return { posted: false, reason: 'nothing to show' };
    }
    const earlier = team.weeks.filter((w) => w.week < lastWeek && w.score !== null).slice(-4).map((w) => w.score);
    const hist = await actions.history(scope, previousWeeks(team.thisWeek, 3));
    const toClose = Object.entries(hist)
      .filter(([, h]) => h.open > 0)
      .map(([week, h]) => ({ week, items: h.items.filter((i) => i.done === null) }));
    const digest = composeDigest({
      teamName: await teamName(scope, product),
      week: lastWeek,
      card: entry.card,
      trend: trend(entry.score, earlier),
      toClose,
      path: pathToNextGrade(entry.card),
    });
    let result;
    if (product === 'jira') result = await jira.postDigest(scope.slice('jira:'.length), { summary: digest.title, paragraphs: digest.paragraphs });
    else result = await confluence.postDigest(scope.slice('confluence:'.length), { title: digest.title, html: digest.html });
    await store.set(key, { week: lastWeek, id: result?.id || null, at: now().toISOString() });
    await audit(scope, 'digest.post', { week: lastWeek, id: result?.id || null });
    return { posted: true, week: lastWeek, id: result?.id || null };
  }
  return { maybePost };
}
