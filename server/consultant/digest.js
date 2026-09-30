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
import { buildScorecard, renderScorecard, renderFacts, addFact } from './scorecard.js';
import { buildKpis, renderKpis, kpiFactsText } from './kpis.js';
import { reviewCode, renderCodeReview, repoTargets } from './engineering.js';
import { reviewPractice, renderPractice, actionsText } from './practice.js';
import { refreshBenchmark, getBenchmark, benchmarkIsStale, benchmarkFacts, renderBenchmark } from './competitors.js';
import { isGithubConfigured } from '../deploy/github.js';
import { autofixOn, buildCandidates, selectCandidates, runAutofix, lastFixRun, renderFixes } from './autofix.js';
import { refreshPlaybook, getPlaybook, playbookIsStale, renderPlaybook } from './playbook.js';
import { scoutModels, getModelScout, modelScoutIsStale, scoutFacts } from './modelScout.js';
import { briefingHealth, improvementCandidates, panelImprovements, improvementsText, renderSelfReview, getFeedback, feedbackText, founderSources } from './selfReview.js';
import { runPanel } from './panel.js';
import { createBudget, panelMembers } from './models.js';

const FILE = 'consultant.json';
const HISTORY = 30;
const day = (d) => d.toISOString().slice(0, 10);

export function digestBudgetUsd() {
  const n = Number(process.env.CONSULTANT_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.75;
}

// The weekly reading of sources has its own ceiling: it is the one part of the
// briefing whose cost is not the same every day, and it should not be squeezed
// out by, or squeeze out, the daily review.
export function readingBudgetUsd() {
  const n = Number(process.env.CONSULTANT_READING_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 1.5;
}

export function lastDigest() {
  return readJson(FILE, { lastDate: null, history: [] }).history.slice(-1)[0] || null;
}

/** The email, assembled: the model's review first, then everything a person needs to check it. Pure. */
export function composeDigest({ date, review, scorecard, kpis, engineering, benchmark, practice, fixes, selfReview, playbook, vibe, tech, panel, budgetUsd, readingUsd = 0 }) {
  const parts = [];
  parts.push(`# Your AI-company briefing, ${date}`, '', review.trim(), '', '---');
  parts.push('', "## KPIs and maturity (computed by code from the company's records, not written by any model)", '', renderKpis(kpis));
  parts.push('', '## Technology against competitors (public signals, measured the same way for everyone)', '', renderBenchmark(benchmark));
  parts.push('', '## Your building practice: KPIs, trend and the actions that would lift them', '', renderPractice(practice));
  parts.push('', '## Corrections the team starts on its own, without asking you', '', renderFixes(fixes || { planned: [], last: null, on: false }));
  if (selfReview) parts.push('', '## How to improve this briefing (its own record, the model check and your notes)', '', renderSelfReview(selfReview));
  parts.push('', '## Readiness scorecard (also computed by code)', '', renderScorecard(scorecard));
  parts.push('', '## Code review: what is in place and what is missing', '', renderCodeReview(engineering));
  parts.push('', '## The facts behind the numbers', '', renderFacts(scorecard));

  const claims = [...(playbook?.items || []), ...(vibe?.items || []), ...(tech?.items || [])];
  const urls = [...new Set(claims.map((i) => i.url))];
  parts.push('', '## Sources read and verified', '');
  parts.push(
    urls.length
      ? `Read by the server (${[...new Set([playbook?.refreshedAt, vibe?.refreshedAt, tech?.refreshedAt].filter(Boolean).map((d) => d.slice(0, 10)))].join(' and ')}); a claim is kept only if its quote is in the page.\n${urls.map((u) => `- ${u}`).join('\n')}`
      : 'No source could be read and verified yet, so nothing above rests on a source. Cited [P#], [V#] and [T#] items would appear here.',
  );
  const unread = [...(playbook?.unread || []), ...(vibe?.unread || []), ...(tech?.unread || [])];
  if (unread.length) parts.push('', 'Could not be read or verified (so not relied on):', ...unread.map((u) => `- ${u.url}: ${u.reason}`));

  const drafters = panel.members.filter((m) => m.ok && !/merge/.test(m.name));
  const bad = panel.members.filter((m) => !m.ok);
  parts.push(
    '',
    '## How this was produced',
    '',
    panel.singleModel
      ? `One model wrote this review (${panel.members.filter((m) => m.ok).map((m) => `${m.name}, ${m.model}`).join('; ')}). It is NOT an independent panel: one model reviewing a company will be wrong in its own consistent way. Set more model keys (OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY) for a real panel.`
      : `${drafters.length} models each reviewed the company alone (${drafters.map((m) => `${m.name}, ${m.model}`).join('; ')}) and one merged them, listing where they disagreed.`,
    ...(bad.length ? [`Did not answer: ${bad.map((m) => `${m.name} (${String(m.error).replace(/\s+/g, ' ').slice(0, 140)})`).join('; ')}.`] : []),
    `Citations: ${panel.cited} checked against the facts, KPIs and sources above${panel.unknown ? `; ${panel.unknown} pointed at nothing and were replaced with [?], so treat the sentences around them as unsupported` : ''}. Anything marked (judgement) has no source.`,
    `Cost: $${panel.usd.toFixed(3)} for the review${budgetUsd ? ` (budget $${budgetUsd})` : ''}${readingUsd ? `, plus $${readingUsd.toFixed(3)} reading this week's sources` : ''}.`,
    'The layout follows the AI-readiness reviews the large consultancies publish. It is not produced by, or endorsed by, any of them.',
  );
  return parts.join('\n');
}

function subjectLine({ date, scorecard, kpis }) {
  const next = scorecard.closest?.next?.label;
  return `Your AI-company briefing ${date}: readiness ${scorecard.readiness}/4, KPI health ${Math.round(kpis.health * 100)}%${next ? `, next rung: ${next}` : ''}`;
}

// The briefing has two callers that can meet at 8:00 (its own schedule and the
// tail of the daily meeting) plus the founder's DIGEST. A second call while one is
// running gets the first one's result instead of building and sending twice.
let inFlight = null;

/**
 * Builds and delivers one briefing. Never throws. Resolves to
 * { sent, reason?, emailed, published, usd }.
 */
export function runConsultantDigest(options = {}) {
  if (inFlight) return inFlight;
  inFlight = buildAndSend(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function buildAndSend({
  anthropic,
  force = false,
  now = new Date(),
  members = panelMembers({ anthropic }),
  refresh = refreshPlaybook,
  review = reviewCode,
  practiceReview = (o) => (isGithubConfigured() ? reviewPractice(o) : null),
  benchmarkRefresh = refreshBenchmark,
  autofix = runAutofix,
  modelScan = scoutModels,
  send = sendConsultantDigestEmail,
  publish = publishServerPage,
} = {}) {
  if (process.env.CONSULTANT_DIGEST_DISABLED === 'true') return { sent: false, reason: 'CONSULTANT_DIGEST_DISABLED is true' };
  const state = readJson(FILE, { lastDate: null, history: [] });
  const date = day(now);
  if (!force && state.lastDate === date) return { sent: false, reason: 'already sent today' };

  try {
    const budget = createBudget(digestBudgetUsd());
    const reading = createBudget(readingBudgetUsd());

    let notes = null;
    if (isWorkspaceConfigured()) {
      try {
        notes = await loadNotes({});
      } catch (err) {
        console.error('Consultant: could not read the vault:', err.message);
      }
    }

    // The code, looked at from outside; null when GitHub is not configured or
    // no repo can be found, and the email says so.
    const engineering = await review({ now }).catch((err) => {
      console.error('Consultant: the code review failed:', err.message);
      return null;
    });
    // The founder's building habits, from pull requests and commits; null when
    // GitHub is not configured.
    const practice = await Promise.resolve(practiceReview({ targets: repoTargets(), engineering, now })).catch((err) => {
      console.error('Consultant: the practice review failed:', err.message);
      return null;
    });

    // The weekly look at competitors' public surfaces, under the reading budget.
    if (benchmarkIsStale(now)) await benchmarkRefresh({ anthropic, budget: reading, now, notes: notes || [] });
    const benchmark = getBenchmark();

    const scorecard = buildScorecard({ now, notes, engineering });
    // Their findings become citable facts before the KPI table cites them.
    for (const text of benchmarkFacts(benchmark)) addFact(scorecard, 'benchmark', text);
    for (const text of practice?.facts || []) addFact(scorecard, 'practice', text);
    const kpis = buildKpis(scorecard, { now, engineering, benchmark, practice });

    // What will be corrected on its own after this email, and what the last
    // run did. Chosen by code from the findings above; the models are told about
    // both so the review does not recommend what is already under way.
    const fixesOn = autofixOn();
    const planned = fixesOn ? selectCandidates(buildCandidates({ scorecard, benchmark, engineering }), { now }) : [];
    const lastFixes = lastFixRun();
    if (lastFixes) addFact(scorecard, 'fixes', `Automatic corrections on ${lastFixes.date}: ${lastFixes.outcomes.map((o) => `${o.title} ${o.status}`).join('; ') || 'none'}; ${lastFixes.prs.length} pull requests opened.`);
    if (planned.length) addFact(scorecard, 'fixes', `Automatic corrections starting after this briefing: ${planned.map((c) => c.title).join('; ')}.`);
    const fixes = { planned, last: lastFixes, on: fixesOn };

    // Read the sources first if the last reading is over a week old, so today's
    // review rests on this week's pages. A failure leaves the previous reading.
    // Pages the founder asked to have read are read first, from their own vault note.
    for (const topic of ['company', 'vibe', 'tech']) {
      if (playbookIsStale(now, topic)) await refresh({ topic, anthropic, member: members[0], budget: reading, now, extraPages: founderSources(notes, topic) });
    }
    const playbook = getPlaybook('company');
    const vibe = getPlaybook('vibe');
    const tech = getPlaybook('tech');

    // Are the reviewing models the newest the account can use? Weekly, quiet on failure.
    if (modelScoutIsStale(now)) await modelScan({ now }).catch((err) => console.error('Consultant: the model check failed:', err.message));
    const scout = getModelScout();

    // The briefing reviewing itself: its own record, the model check, the
    // founder's notes. Health lines become facts the models can cite; the
    // improvements are chosen by code and cited as [B#].
    const shelf = (pb) => ({ read: new Set((pb?.items || []).map((i) => i.url)).size, unread: (pb?.unread || []).length });
    const today = {
      unmeasuredKpis: kpis.kpis.filter((k) => k.status === 'unmeasured').length,
      kpiTotal: kpis.kpis.length,
      singleModel: members.length < 2,
      drafters: members.length,
      sources: { company: shelf(playbook), coding: shelf(vibe), technology: shelf(tech) },
    };
    const health = briefingHealth({ history: state.history, today });
    for (const text of [...health.facts, ...scoutFacts(scout)]) addFact(scorecard, 'briefing', text);
    const feedback = getFeedback();
    const candidates = improvementCandidates({ health, today, scout, feedback, budgetUsd: budget.limit, now });
    const selfReview = { health, candidates, scoutFacts: scoutFacts(scout), feedback: feedback.slice(-3) };

    const roadmap = getLatestRoadmap();
    const steering = isWorkspaceConfigured() ? await readFounderSteering().catch(() => '') : '';
    const brief = [steering && `From the founder's Steering.md:\n${steering.slice(0, 900)}`, roadmap?.text && `The team's latest Road to €1M:\n${roadmap.text.slice(0, 1400)}`].filter(Boolean).join('\n\n');

    const inputs = {
      date,
      goal: `€${REVENUE_GOAL_EUR.toLocaleString('en')} a year in recurring revenue, across every venture`,
      scorecardText: renderScorecard(scorecard),
      // The KPI facts are listed once, as [K#], so they are left out of the E list here.
      factsText: renderFacts(scorecard, { skipDims: ['kpi'] }),
      kpiText: kpiFactsText(kpis),
      playbookText: renderPlaybook(playbook),
      vibeText: vibe?.items?.length ? renderPlaybook(vibe) : '',
      techText: tech?.items?.length ? renderPlaybook(tech) : '',
      improvementsText: improvementsText(candidates),
      feedbackText: feedbackText(feedback),
      actionsText: actionsText(practice),
      brief,
      factIds: scorecard.facts.map((f) => f.id),
      // Everything that is not an E fact and may be cited: sources and KPIs.
      playbookIds: [...(playbook?.items || []).map((i) => i.id), ...(vibe?.items || []).map((i) => i.id), ...(tech?.items || []).map((i) => i.id), ...candidates.map((c) => c.id), ...kpis.kpis.map((k) => k.id), ...(practice?.actions || []).map((a) => a.id)],
    };
    const panel = await runPanel({ anthropic, budget, inputs, members });

    // What the panel actually did, now that it has run: a model that did not
    // answer becomes an improvement with the fix its own error names.
    selfReview.candidates = [...candidates, ...panelImprovements(panel.members, candidates.length)];

    const text = composeDigest({ date, review: panel.text, scorecard, kpis, engineering, benchmark, practice, fixes, selfReview, playbook, vibe, tech, panel, budgetUsd: budget.limit, readingUsd: reading.spent });
    const subject = subjectLine({ date, scorecard, kpis });

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
          serializeNote({ type: 'consultant-digest', date, readiness: scorecard.readiness, stage: scorecard.stage, kpi_health: Math.round(kpis.health * 100), company_stage: kpis.stage, models: panel.members.filter((m) => m.ok).map((m) => m.name).join(', '), source: 'ai-panel', tags: ['company/consultant'] }, `\n${text}\n`),
          `Consultant briefing — ${date}`,
        ).catch(() => false),
      );
    }

    // The corrections start only now that the briefing has gone out, so a slow
    // session never delays it; never a reason for the briefing to fail.
    let corrections = null;
    if (planned.length) {
      corrections = await autofix({ anthropic, selected: planned, now }).catch((err) => ({ ran: false, reason: err.message }));
      if (corrections?.ran) {
        const report = `# Corrections started, ${date}\n\n${renderFixes({ planned: [], last: corrections, on: true })}`;
        if (isEmailConfigured()) {
          await send({ subject: `Corrections started ${date}: ${corrections.outcomes.filter((o) => o.status === 'done').length} done, ${corrections.outcomes.filter((o) => o.status === 'asked').length} asked, ${corrections.prs.length} pull requests`, text: report }).catch((err) => console.error('Consultant: the corrections email did not send:', err.message));
        }
        if (isWorkspaceConfigured()) await publish(`Company/Consultant/${date} corrections.md`, serializeNote({ type: 'consultant-corrections', date, tags: ['company/consultant'] }, `\n${report}\n`), `Corrections — ${date}`).catch(() => {});
      }
    }

    state.lastDate = date;
    state.history = [...state.history, { date, readiness: scorecard.readiness, kpiHealth: kpis.health, usd: panel.usd + reading.spent, models: panel.members.filter((m) => m.ok).length, emailed, published, unknownCitations: panel.unknown, citations: panel.cited, unmeasuredKpis: today.unmeasuredKpis }].slice(-HISTORY);
    writeJson(FILE, state);
    return { sent: true, emailed, published, usd: panel.usd + reading.spent + (corrections?.usd || 0), readiness: scorecard.readiness, kpiHealth: kpis.health, subject, text, corrections };
  } catch (err) {
    console.error('Consultant digest failed:', err.message);
    return { sent: false, reason: err.message };
  }
}
