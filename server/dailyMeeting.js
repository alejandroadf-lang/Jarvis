// Runs the company's daily meeting cycle autonomously (see scheduler.js for
// what triggers it): the Executive Team holds a leadership sync where the
// CEO fans out to the C-suite (and, at their discretion, down into their own
// teams) for status and opportunities, then the Venture Studio takes a quick
// look at what came out of it and decides whether anything is worth a real
// venture proposal. The result is persisted as one Daily Report.
//
// Every action that requires the founder to have personally reported a real
// outcome is still barred here: log_revenue, log_expense,
// report_milestone_progress, request_tranche, and kill_venture are not
// wired in, so a stray call resolves as an unknown tool rather than a no-op
// that could be mistaken for success — there's nothing genuine for those to
// log in an unattended run. deploy_code and send_customer_email are the
// exception, and deliberately so: unlike those, they don't depend on the
// founder reporting anything — they act inside a scope (a linked repo, an
// outreach allowlist) the founder already granted in advance specifically
// so an agent could act without asking again, and that grant makes no
// distinction between "during a conversation" and "during this unattended
// cycle." A venture with no scope granted, or scope left disabled, still
// can't be touched here (see finance/ventures.js's authorizeDeployment and
// authorizeOutreach) — this only changes what happens for ventures the
// founder has already explicitly opted in. The Studio phase can still also
// cause a venture *proposal*, which spends no money and still needs the
// founder's greenlight before anything is funded.

import { runAgent } from './agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from './agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS, ROOT_AGENT_ID as STUDIO_ROOT } from './agents/ideationTeam.js';
import { buildCompanyContext, buildStudioContext } from './finance/context.js';
import { getLedger } from './finance/ledger.js';
import { listVentures } from './finance/ventures.js';
import {
  handleProposeVenture,
  handleDeployCode,
  handleSendCustomerEmail,
  handleLogContactNote,
} from './actionHandlers.js';
import { todayKey, saveDailyReport } from './dailyReports.js';
import { sendDailyReportEmail } from './email.js';
import { estimateCostUsd, sumUsage } from './usage.js';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

function leadershipKickoff(date) {
  return `It's ${date}. Time for today's daily leadership sync.

This is an internal status meeting, not a real-world event: don't call
log_revenue, log_expense, report_milestone_progress, request_tranche, or
kill_venture here — those are only for when the founder reports something
that actually happened, and nobody is reporting anything today. Just
gather information and make recommendations for the founder to act on
afterward.

The exceptions are deploy_code and send_customer_email: for any venture
where the founder has already linked a repo or set up an outreach scope
and enabled it, those tools work exactly the same here as they would in a
live conversation — that's what enabling them means. Use them only for
real, ready work that scope was actually granted for, not to manufacture
activity for today's report; if nothing rises to that bar today, say so.

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
  const startedAt = Date.now();
  const companyContext = buildCompanyContext();
  const beforeIds = new Set(listVentures().map((v) => v.id));

  // Both phases are isolated the same way: a persistent failure in one
  // still leaves a report worth saving (and emailing) for the day, instead
  // of the whole cycle throwing and leaving nothing — silently going dark
  // is worse than a report that plainly says one half didn't run.
  let leadership;
  let leadershipFailed = false;
  try {
    leadership = await runAgent({
      anthropic,
      agents: COMPANY_AGENTS,
      agentId: COMPANY_ROOT,
      messages: [{ role: 'user', content: leadershipKickoff(date) }],
      // Only the two scope-gated real actions are wired in here — see file
      // header for why those specifically are safe in an unattended run
      // when every other treasury/venture action still isn't.
      actionHandlers: {
        // 'daily_cycle' is recorded on the venture's deployment/outreach log
        // so the founder can tell an unattended real action apart from one
        // that happened during a live conversation — see index.js's
        // 'interactive' counterpart.
        deploy_code: (input) => handleDeployCode(input, 'daily_cycle'),
        send_customer_email: (input) => handleSendCustomerEmail(input, 'daily_cycle'),
        // Safe unattended for the opposite reason to the two above: it has
        // no real-world effect at all, it only writes what the agent learned
        // into memory the next draft will read.
        log_contact_note: handleLogContactNote,
      },
      extraContext: companyContext,
    });
  } catch (err) {
    leadershipFailed = true;
    leadership = { text: `(Leadership sync failed: ${err.message})`, trace: [], usage: { ...ZERO_USAGE } };
  }

  let studio;
  if (leadershipFailed) {
    studio = {
      text: "(Skipped: today's leadership sync failed, so there's nothing fresh to review.)",
      trace: [],
      usage: { ...ZERO_USAGE },
    };
  } else {
    try {
      studio = await runAgent({
        anthropic,
        agents: STUDIO_AGENTS,
        agentId: STUDIO_ROOT,
        messages: [{ role: 'user', content: studioKickoff(leadership.text) }],
        actionHandlers: { propose_venture: handleProposeVenture },
        extraContext: buildStudioContext(),
      });
    } catch (err) {
      studio = { text: `(Venture Studio ideation pass failed: ${err.message})`, trace: [], usage: { ...ZERO_USAGE } };
    }
  }

  const afterIds = listVentures().map((v) => v.id);
  const proposedVentureIds = afterIds.filter((id) => !beforeIds.has(id));
  const { balance, startingCapital } = getLedger();
  const usage = sumUsage(leadership.usage, studio.usage);

  const report = {
    date,
    generatedAt: new Date().toISOString(),
    leadership: { reply: leadership.text, trace: leadership.trace },
    studio: { reply: studio.text, trace: studio.trace },
    proposedVentureIds,
    treasury: { balance, startingCapital },
    usage,
    costUsd: estimateCostUsd(usage),
    durationMs: Date.now() - startedAt,
  };

  saveDailyReport(report);

  try {
    await sendDailyReportEmail(report);
  } catch (err) {
    // Email delivery is a notification on top of a report that's already
    // saved and viewable in the Daily Report tab — don't fail the whole
    // cycle just because SMTP had a bad day.
    console.error('Failed to email daily report:', err);
  }

  return report;
}
