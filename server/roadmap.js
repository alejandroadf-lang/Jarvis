// The Road to €1M: for every active venture, where it stands, what is between
// it and a million euros a year, and the improvements the team proposes.
//
// The founder's aim was never one venture: it is each of them on the way to
// €1,000,000 a year in recurring revenue, with the team proposing what gets it
// there. Nothing produced that. The daily meeting reported status, the weekly
// reflection looked backwards, and a venture's plan for growing lived only in
// whichever agent had last thought about it.
//
// So once a week (and once at the first daily meeting after deploy) the CEO
// writes it, alone: no fan-out, no tools, from what is already in the shared
// context. One call, cents, and read-only, so it cannot move money or touch a
// repo. What makes it more than a document is where it goes next: it is put in
// the shared context, and the work sessions take a venture's top improvement as
// that venture's next piece of work.

import { runAgent } from './agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from './agents/orgChart.js';
import { buildCompanyContext } from './finance/context.js';
import { listVentures, REVENUE_GOAL_EUR } from './finance/ventures.js';
import { withSpendContext } from './spend.js';
import { getLatestRoadmap, saveRoadmap } from './roadmapStore.js';
import { publishRoadmap } from './workspace/vault.js';

export const ROADMAP_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function roadmapKickoff(date = new Date().toISOString().slice(0, 10)) {
  const goal = REVENUE_GOAL_EUR.toLocaleString('en');
  return `It's ${date}. The founder's aim is for every venture to reach €${goal} a year in recurring revenue, and they asked the team to keep proposing what would get each one there.

Write the Road to €1M, one block per active venture, using only what is in your context (revenue, price, pipeline, usage, objectives, notes, the last roadmap). If a number is not recorded, write "not recorded": do not invent a market size, a conversion rate or a customer.

For each venture, in at most 110 words:
- Where it stands: recurring revenue now (times 12 for a year), paying customers, pipeline, and whether anyone uses it.
- The gap to €${goal} a year, in customers at the current price, or "no price on record".
- Three improvements, ranked by how much closer each gets it: product, price and packaging, or channel. Each with the evidence for it and a first step small enough for the team to start this week.
- What would make you change or drop this venture's plan.

End with "## Across the portfolio": one line naming where the next hour of the team's time goes, given the founder's split.

These are proposals for the team to work from: the work sessions take each venture's top improvement as its next piece of work. Be concrete and critical. A route to €${goal} that names no customer is a wish.`;
}

/** Writes and stores a new roadmap. Null when there is no active venture to write one for. */
export async function runRoadmap({ anthropic }) {
  if (!listVentures().some((v) => v.status === 'active')) return null;
  // The CEO on its own: reports, actions and server tools (web search, billed
  // per query) removed, so a fan-out, an action or a search is impossible
  // rather than discouraged. It writes from the context it is given. See
  // soloRoster in dailyMeeting.js.
  const agents = {
    ...COMPANY_AGENTS,
    [COMPANY_ROOT]: { ...COMPANY_AGENTS[COMPANY_ROOT], reports: [], actions: [], serverTools: [] },
  };
  const result = await withSpendContext({ source: 'roadmap' }, () =>
    runAgent({
      anthropic,
      agents,
      agentId: COMPANY_ROOT,
      messages: [{ role: 'user', content: roadmapKickoff() }],
      actionHandlers: {},
      extraContext: buildCompanyContext(),
    }),
  );
  const saved = saveRoadmap({ text: result.text, costUsd: result.usage?.costUsd || 0 });
  // Into the founder's vault as a dated note. Fail-quiet and inert when no
  // workspace is set (see publish in workspace/vault.js).
  await publishRoadmap(saved);
  return saved;
}

/**
 * Writes one if there is none or the last is over a week old. Called from the
 * daily meeting, so a server that was down on the right day catches up on the
 * next one. Never throws: the morning does not depend on it.
 */
export async function ensureRoadmap({ anthropic, now = new Date() }) {
  const latest = getLatestRoadmap();
  if (latest && now.getTime() - Date.parse(latest.generatedAt) < ROADMAP_MAX_AGE_DAYS * DAY_MS) {
    return { ran: false, reason: 'the current roadmap is under a week old' };
  }
  try {
    const written = await runRoadmap({ anthropic });
    return written ? { ran: true } : { ran: false, reason: 'no active venture' };
  } catch (err) {
    console.error('Could not write the Road to €1M:', err.message);
    return { ran: false, reason: err.message };
  }
}
