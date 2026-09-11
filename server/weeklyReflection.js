// Runs once a week (see weeklyScheduler.js): looks back at the week's daily
// leadership syncs and Venture Studio opportunity reviews, compares them
// against what's actually true now (venture status, real money moved), and
// writes a short verdict. The point isn't a nicer summary — it's judgment
// that compounds: the verdict gets folded into buildStudioContext() (see
// finance/context.js) so next week's ideation sees not just which ventures
// were killed, but whether last week's flagged opportunities actually went
// anywhere.
//
// Same guarantees as the daily cycle: no action handlers are wired, so this
// can't move money or kill a venture — it can only write the reflection
// text.

import { runAgent } from './agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from './agents/orgChart.js';
import { buildBusinessContext } from './finance/context.js';
import { listVentures } from './finance/ventures.js';
import { getLedger } from './finance/ledger.js';
import { listDailyReports } from './dailyReports.js';
import { weekKey, saveWeeklyReflection } from './weeklyReflections.js';
import { publishWeeklyReflection } from './workspace/vault.js';
import { sendWeeklyReflectionEmail } from './email.js';
import { estimateCostUsd, emptyUsage } from './usage.js';


function reportsInWeek(allReports, weekEndingKey) {
  const weekEnding = new Date(`${weekEndingKey}T23:59:59.999Z`);
  const weekStart = new Date(`${weekEndingKey}T00:00:00.000Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6); // Monday..Sunday, 7 days ending on weekEndingKey
  return allReports.filter((r) => {
    const d = new Date(`${r.date}T00:00:00.000Z`);
    return d >= weekStart && d <= weekEnding;
  });
}

function describeVenture(v) {
  const suffix = v.status === 'killed' ? ` — killed: ${v.killReason || 'no reason recorded'}` : '';
  return `- "${v.title}" [${v.status}]${suffix}`;
}

function buildReflectionKickoff(weekEndingKey, weekReports) {
  const dailySummaries = weekReports
    .map((r) => `### ${r.date}\nLeadership sync:\n${r.leadership.reply}\n\nVenture Studio:\n${r.studio.reply}`)
    .join('\n\n');

  const ventures = listVentures();
  const { transactions } = getLedger();
  const weekStart = new Date(`${weekEndingKey}T00:00:00.000Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const weekTransactions = transactions.filter((t) => new Date(t.createdAt) >= weekStart && t.type !== 'capital');

  const ventureList = ventures.length ? ventures.map(describeVenture).join('\n') : 'none yet';
  const transactionList = weekTransactions.length
    ? weekTransactions.map((t) => `- ${t.type}: $${t.amount} — ${t.description}`).join('\n')
    : 'none this week';

  return `It's the end of the week (week ending ${weekEndingKey}). Here are this
week's daily leadership syncs and Venture Studio opportunity reviews:

${dailySummaries}

Here's what's actually true right now, for comparison:

Ventures:
${ventureList}

Real money moved this week:
${transactionList}

Write a short Weekly Reflection: which flagged opportunities actually got
followed up on this week versus quietly dropped, how the ventures proposed
or discussed this week are actually doing, and one concrete lesson for next
week's leadership sync and ideation to carry forward. Be concrete and
critical — this is for calibrating judgment, not congratulating the team.
Keep it under 200 words.`;
}

/**
 * Runs one weekly reflection cycle and persists the result.
 * @param {{anthropic: import('@anthropic-ai/sdk').default}} opts
 * @returns {Promise<object>} the saved reflection
 */
export async function runWeeklyReflection({ anthropic }) {
  const weekEnding = weekKey();
  const startedAt = Date.now();
  const weekReports = reportsInWeek(listDailyReports(), weekEnding);

  let text;
  let trace = [];
  let usage = emptyUsage();

  if (weekReports.length === 0) {
    text = 'No daily reports were generated this week — nothing to reflect on yet.';
  } else {
    try {
      const result = await runAgent({
        anthropic,
        agents: COMPANY_AGENTS,
        agentId: COMPANY_ROOT,
        messages: [{ role: 'user', content: buildReflectionKickoff(weekEnding, weekReports) }],
        actionHandlers: {}, // read-only analysis — see file header
        extraContext: buildBusinessContext(),
      });
      text = result.text;
      trace = result.trace;
      usage = result.usage;
    } catch (err) {
      text = `(Weekly reflection failed: ${err.message})`;
    }
  }

  const reflection = {
    weekEnding,
    generatedAt: new Date().toISOString(),
    reportsConsidered: weekReports.length,
    reflection: text,
    trace,
    usage,
    costUsd: estimateCostUsd(usage),
    durationMs: Date.now() - startedAt,
  };

  saveWeeklyReflection(reflection);
  await publishWeeklyReflection(reflection);

  try {
    await sendWeeklyReflectionEmail(reflection);
  } catch (err) {
    console.error('Failed to email weekly reflection:', err);
  }

  return reflection;
}
