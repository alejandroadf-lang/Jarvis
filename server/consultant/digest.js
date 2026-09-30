// The daily briefing from a consultant who reads everything and acts on nothing.
//
// Every morning, after the daily meeting, the founder gets one email: how ready
// this company is to earn its first million (scored from its own records, not
// from its bank balance), what is working, what is weak, the one thing to do
// today and the next seven days, and what the best sources say that applies.
//
// How it stays accurate is the design, not an afterthought:
//   - the numbers are computed by code from the company's records and printed
//     with the facts behind them (scorecard.js); no model can change them;
//   - what the sources say is read by this server and kept only if its quote is
//     in the page (playbook.js);
//   - several model families write the review alone before one merge, and code
//     checks every citation afterwards (panel.js);
//   - the email says which models ran, how many citations checked out, which
//     sources could not be read, and what it cost.
// It has no action tools. It cannot send, spend, deploy or change a record; it
// reads what the company knows and writes an email and a vault note.
//
// The layout follows the AI-readiness reviews the large consultancies publish
// (dimensions scored on a maturity scale, a current-state and a next-step), and
// says plainly that it is not from them.

import { readJson, writeJson } from '../store.js';
import { REVENUE_GOAL_EUR } from '../finance/ventures.js';
import { getLatestRoadmap } from '../roadmapStore.js';
import { isEmailConfigured, sendConsultantDigestEmail } from '../email.js';
import { loadNotes } from '../workspace/vaultIndex.js';
import { isWorkspaceConfigured, publishServerPage, readFounderSteering } from '../workspace/vault.js';
import { serializeNote } from '../workspace/frontmatter.js';
import { buildScorecard, renderScorecard, renderFacts } from './scorecard.js';
import { refreshPlaybook, getPlaybook, playbookIsStale, renderPlaybook } from './playbook.js';
import { runPanel } from './panel.js';
import { createBudget, panelMembers } from './models.js';

const FILE = 'consultant.json';
const HISTORY = 30;
const day = (d) => d.toISOString().slice(0, 10);

export function digestBudgetUsd() {
  const n = Number(process.env.CONSULTANT_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.75;
}

export function lastDigest() {
  return readJson(FILE, { lastDate: null, history: [] }).history.slice(-1)[0] || null;
}

/** The email, assembled: the model's review first, then everything a person needs to check it. Pure. */
export function composeDigest({ date, review, scorecard, playbook, panel, budgetUsd }) {
  const parts = [];
  parts.push(`# Your AI-company briefing, ${date}`, '', review.trim(), '', '---', '', '## The numbers (computed by code from the company\'s records, not written by any model)', '', renderScorecard(scorecard), '', '## The facts behind them', '', renderFacts(scorecard));

  const items = playbook?.items || [];
  const byUrl = [...new Set(items.map((i) => i.url))];
  parts.push('', '## Sources read and verified', '');
  parts.push(
    byUrl.length
      ? `Read by the server on ${playbook.refreshedAt.slice(0, 10)}; a claim is kept only if its quote is in the page.\n${byUrl.map((u) => `- ${u}`).join('\n')}`
      : 'No source could be read and verified yet, so nothing above claims a source. Cited [P#] items would appear here.',
  );
  if (playbook?.unread?.length) parts.push('', 'Could not be read or verified (so not relied on):', ...playbook.unread.map((u) => `- ${u.url}: ${u.reason}`));

  const ok = panel.members.filter((m) => m.ok);
  const bad = panel.members.filter((m) => !m.ok);
  parts.push(
    '',
    '## How this was produced',
    '',
    panel.singleModel
      ? `One model wrote this review (${ok.map((m) => `${m.name}, ${m.model}`).join('; ')}). It is NOT an independent panel: one model reviewing a company will be wrong in its own consistent way. Set more model keys (OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY) for a real panel.`
      : `${ok.filter((m) => !/merge/.test(m.name)).length} models each reviewed the company alone (${ok.filter((m) => !/merge/.test(m.name)).map((m) => `${m.name}, ${m.model}`).join('; ')}) and one merged them, listing where they disagreed.`,
    ...(bad.length ? [`Did not answer: ${bad.map((m) => `${m.name} (${m.error})`).join('; ')}.`] : []),
    `Citations: ${panel.cited} checked against the facts and sources above${panel.unknown ? `; ${panel.unknown} pointed at nothing and were replaced with [?], so treat the sentences around them as unsupported` : ''}. Anything marked (judgement) has no source.`,
    `Cost of this briefing: $${panel.usd.toFixed(3)} for the panel${budgetUsd ? ` (budget $${budgetUsd})` : ''}.`,
    'The layout follows the AI-readiness reviews the large consultancies publish. It is not produced by, or endorsed by, any of them.',
  );
  return parts.join('\n');
}

function subjectLine({ date, scorecard }) {
  const next = scorecard.closest?.next?.label;
  return `Your AI-company briefing ${date}: readiness ${scorecard.readiness}/4${next ? `, next rung: ${next}` : ''}`;
}

/**
 * Builds and delivers one briefing. Never throws. Resolves to
 * { sent, reason?, emailed, published, usd }.
 */
export async function runConsultantDigest({
  anthropic,
  force = false,
  now = new Date(),
  members = panelMembers({ anthropic }),
  refresh = refreshPlaybook,
  send = sendConsultantDigestEmail,
  publish = publishServerPage,
} = {}) {
  if (process.env.CONSULTANT_DIGEST_DISABLED === 'true') return { sent: false, reason: 'CONSULTANT_DIGEST_DISABLED is true' };
  const state = readJson(FILE, { lastDate: null, history: [] });
  const date = day(now);
  if (!force && state.lastDate === date) return { sent: false, reason: 'already sent today' };

  try {
    const budget = createBudget(digestBudgetUsd());

    let notes = null;
    if (isWorkspaceConfigured()) {
      try {
        notes = await loadNotes({});
      } catch (err) {
        console.error('Consultant: could not read the vault:', err.message);
      }
    }
    const scorecard = buildScorecard({ now, notes });

    // Read the sources first if the last reading is over a week old, so today's
    // review rests on this week's pages. A failure leaves the previous reading.
    if (playbookIsStale(now)) await refresh({ anthropic, member: members[0], budget, now });
    const playbook = getPlaybook();

    const roadmap = getLatestRoadmap();
    const steering = isWorkspaceConfigured() ? await readFounderSteering().catch(() => '') : '';
    const brief = [steering && `From the founder's Steering.md:\n${steering.slice(0, 900)}`, roadmap?.text && `The team's latest Road to €1M:\n${roadmap.text.slice(0, 1400)}`].filter(Boolean).join('\n\n');

    const inputs = {
      date,
      goal: `€${REVENUE_GOAL_EUR.toLocaleString('en')} a year in recurring revenue, across every venture`,
      scorecardText: renderScorecard(scorecard),
      factsText: renderFacts(scorecard),
      playbookText: renderPlaybook(playbook),
      brief,
      factIds: scorecard.facts.map((f) => f.id),
      playbookIds: (playbook?.items || []).map((i) => i.id),
    };
    const panel = await runPanel({ anthropic, budget, inputs, members });

    const text = composeDigest({ date, review: panel.text, scorecard, playbook, panel, budgetUsd: budget.limit });
    const subject = subjectLine({ date, scorecard });

    let emailed = false;
    if (isEmailConfigured()) {
      try {
        await send({ subject, text });
        emailed = true;
      } catch (err) {
        console.error('Consultant: the email did not send:', err.message);
      }
    }
    let published = false;
    if (isWorkspaceConfigured()) {
      published = Boolean(
        await publish(
          `Company/Consultant/${date}.md`,
          serializeNote({ type: 'consultant-digest', date, readiness: scorecard.readiness, stage: scorecard.stage, models: panel.members.filter((m) => m.ok).map((m) => m.name).join(', '), source: 'ai-panel', tags: ['company/consultant'] }, `\n${text}\n`),
          `Consultant briefing — ${date}`,
        ).catch(() => false),
      );
    }

    state.lastDate = date;
    state.history = [...state.history, { date, readiness: scorecard.readiness, usd: panel.usd, models: panel.members.filter((m) => m.ok).length, emailed, published, unknownCitations: panel.unknown }].slice(-HISTORY);
    writeJson(FILE, state);
    return { sent: true, emailed, published, usd: panel.usd, readiness: scorecard.readiness, subject, text };
  } catch (err) {
    console.error('Consultant digest failed:', err.message);
    return { sent: false, reason: err.message };
  }
}
