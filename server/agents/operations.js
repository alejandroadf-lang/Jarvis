// How the company actually ran, for the agents whose job is improving it.
//
// An Agent Operations Engineer that can't see its own company's behaviour is
// a nameplate. Every daily report already carries the delegation trace, the
// token usage, the cost and the wall-clock duration — that's the raw
// material, it just never reached an agent before.
//
// The most useful signal here is the one nobody was looking at: which roles
// never get consulted. An agent nobody asks is pure overhead — it dilutes the
// profit-share pool and adds a tool the manager has to consider on every
// turn. Naming those is more valuable than any amount of prompt polish.

import { listDailyReports } from '../dailyReports.js';
import { AGENTS as COMPANY_AGENTS } from './orgChart.js';
import { AGENTS as STUDIO_AGENTS } from './ideationTeam.js';
import { formatUsd } from '../usage.js';

// Enough to see a trend, few enough that the context stays small.
const REPORTS_CONSIDERED = 7;

export function buildOperationsContext() {
  const reports = listDailyReports().slice(0, REPORTS_CONSIDERED);
  if (reports.length === 0) {
    return `No daily cycles have run yet, so there is nothing to review about how
the company operates. Say so plainly rather than speculating about
performance you cannot see.`;
  }

  const consulted = new Map();
  let totalCost = 0;
  let totalMs = 0;
  let costed = 0;

  for (const report of reports) {
    for (const phase of [report.leadership, report.studio]) {
      for (const step of phase?.trace || []) {
        consulted.set(step.id, (consulted.get(step.id) || 0) + 1);
      }
    }
    if (typeof report.costUsd === 'number') {
      totalCost += report.costUsd;
      totalMs += report.durationMs || 0;
      costed += 1;
    }
  }

  const everyAgentId = [...Object.keys(COMPANY_AGENTS), ...Object.keys(STUDIO_AGENTS)];
  const never = everyAgentId.filter((id) => !consulted.has(id));
  const ranked = [...consulted.entries()].sort((a, b) => b[1] - a[1]);

  const lines = [
    `How the company has actually run over its last ${reports.length} daily cycle(s):`,
    '',
  ];

  if (costed) {
    lines.push(
      `Average cycle: ${formatUsd(totalCost / costed)} and ${(totalMs / costed / 1000).toFixed(1)}s.`,
      ''
    );
  }

  lines.push(
    'Consultations per agent (how often each was actually asked):',
    ranked.length ? ranked.map(([id, n]) => `  - ${id}: ${n}`).join('\n') : '  (none recorded)',
    ''
  );

  if (never.length) {
    lines.push(
      `Never consulted once in this window: ${never.join(', ')}.`,
      '',
      `Treat that list as the most actionable thing here. An agent nobody asks
is not free — it dilutes the profit-share pool, and it is one more tool a
manager weighs on every single turn. Either its tool description is not
telling managers when to reach for it, it sits under the wrong manager, or
the company genuinely does not need the role. Say which you think it is, and
be willing to recommend removing a role outright.`,
      ''
    );
  }

  lines.push(
    `When you recommend a change, name the specific agent and the specific
wording or structure to change, and say what you expect to happen as a
result. "Improve the prompts" is not a recommendation.`
  );

  return lines.join('\n');
}
