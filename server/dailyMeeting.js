// Runs the company's daily meeting cycle autonomously (see scheduler.js for
// what triggers it): the Executive Team holds a leadership sync where the
// CEO fans out to the C-suite (and, at their discretion, down into their own
// teams) for status and opportunities, then the Venture Studio takes a quick
// look at what came out of it and decides whether anything is worth a real
// venture proposal. The result is persisted as one Daily Report.
//
// Deliberately read-only where it matters: the leadership sync is barred
// from calling any treasury- or venture-status action (nothing here reports
// a real founder event, so there's nothing genuine to log), and it isn't
// even given those handlers — a stray call resolves as an unknown tool
// rather than a no-op that could be mistaken for success. The only side
// effect this cycle can cause is the Studio logging a new venture
// *proposal*, which spends no money and still needs the founder's
// greenlight before anything is funded — the same human-in-the-loop
// guarantee every other capital-moving action in this app already has.

import { runAgent } from './agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from './agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS, ROOT_AGENT_ID as STUDIO_ROOT } from './agents/ideationTeam.js';
import { buildTreasuryContext } from './finance/context.js';
import { getLedger } from './finance/ledger.js';
import { listVentures } from './finance/ventures.js';
import { handleProposeVenture } from './actionHandlers.js';
import { todayKey, saveDailyReport } from './dailyReports.js';

function leadershipKickoff(date) {
  return `It's ${date}. Time for today's daily leadership sync.

This is an internal status meeting, not a real-world event: don't call
log_revenue, log_expense, report_milestone_progress, request_tranche, or
kill_venture here — those are only for when the founder reports something
that actually happened. Today, just gather information and make
recommendations for the founder to act on afterward.

Consult each of your direct reports (CTO, CFO, CMO, COO). Ask each of them
to check in with their own team first if it would surface something real,
then report back three things: (1) one line on status, (2) the single
biggest blocker or risk right now, and (3) one concrete opportunity they
see — a new market, an underused asset, a customer request worth pursuing,
a process worth fixing. Push back on vague answers ("things are fine") —
you want one real, specific data point per department, not a status-report
platitude.

Once you've heard from everyone, synthesize it into a single Daily Company
Report with these sections, in this order:

## Department Status
## Opportunities Identified
## Risks & Blockers
## Recommended Actions for the Founder

Be concrete and concise — this should read like a real daily standup
summary a founder could skim in two minutes, not an essay.`;
}

function studioKickoff(leadershipReply) {
  return `Today's executive leadership sync just wrapped. Here's what came out of it:

---
${leadershipReply}
---

Look specifically at the Opportunities Identified section (and anything
else that catches your eye). Run a quick ideation pass: does any of this —
or anything else that occurs to your team — clear the bar for a real
venture proposal? Feel free to pull in your specialists if it's worth a
real look.

If something genuinely clears the bar (a believable path to $1M+ revenue,
a real market, not just a vague opportunity), log it with propose_venture.
If nothing does today, say so plainly and explain why — don't force a
proposal just to produce one. Keep your reply short either way; this is a
quick daily check-in, not a full brainstorming session.`;
}

/**
 * Runs one full daily meeting cycle and persists the result.
 * @param {{anthropic: import('@anthropic-ai/sdk').default}} opts
 * @returns {Promise<object>} the saved report
 */
export async function runDailyMeeting({ anthropic }) {
  const date = todayKey();
  const treasuryContext = buildTreasuryContext();
  const beforeIds = new Set(listVentures().map((v) => v.id));

  const leadership = await runAgent({
    anthropic,
    agents: COMPANY_AGENTS,
    agentId: COMPANY_ROOT,
    messages: [{ role: 'user', content: leadershipKickoff(date) }],
    actionHandlers: {}, // no side effects during the automated sync — see file header
    extraContext: treasuryContext,
  });

  let studio = { text: '', trace: [] };
  try {
    studio = await runAgent({
      anthropic,
      agents: STUDIO_AGENTS,
      agentId: STUDIO_ROOT,
      messages: [{ role: 'user', content: studioKickoff(leadership.text) }],
      actionHandlers: { propose_venture: handleProposeVenture },
      extraContext: treasuryContext,
    });
  } catch (err) {
    studio = { text: `(Venture Studio ideation pass failed: ${err.message})`, trace: [] };
  }

  const afterIds = listVentures().map((v) => v.id);
  const proposedVentureIds = afterIds.filter((id) => !beforeIds.has(id));
  const { balance, startingCapital } = getLedger();

  const report = {
    date,
    generatedAt: new Date().toISOString(),
    leadership: { reply: leadership.text, trace: leadership.trace },
    studio: { reply: studio.text, trace: studio.trace },
    proposedVentureIds,
    treasury: { balance, startingCapital },
  };

  return saveDailyReport(report);
}
