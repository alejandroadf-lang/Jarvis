// How the briefing gets better, and what it says about itself.
//
// The technology the briefing rests on moves every month: newer models, new agent
// tooling, new protocols and data sources. A briefing that only reviews the
// company slowly becomes a briefing about last quarter's company. So once a day
// it also reviews itself, in the same way it reviews everything else: numbers
// computed by code from its own record, and a short list of improvements chosen
// by code from fixed rules, each one an action a person can take.
//
// Three inputs feed that, none of them a model's opinion of itself:
//   - its own history (consultant.json): did it get to send, what did it cost,
//     did its citations hold, how many KPIs could it not measure;
//   - the model check (modelScout.js): what each provider's own list says the
//     account can use, against what is configured;
//   - the founder's replies to BRIEFING FEEDBACK, stored here and shown back so
//     nothing said about the briefing is lost.
// The models then write about these facts as they write about any others, cited
// as [B#]. They may add ideas of their own; those are marked (judgement).

import { readJson, writeJson } from '../store.js';
import { checkVaultText } from '../workspace/writeGate.js';

const FEEDBACK_FILE = 'consultant-feedback.json';
const MAX_FEEDBACK = 20;

// ── The founder's notes on the briefing ────────────────────────────────────────

export const getFeedback = () => readJson(FEEDBACK_FILE, { items: [] }).items;

/**
 * Stores one note from the founder about the briefing. The write gate applies as
 * anywhere else (a pasted credential is refused, not stored). Returns
 * { ok, reason? }.
 */
export function addFeedback(text, now = new Date()) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (clean.length < 3) return { ok: false, reason: 'Say what to change, e.g. BRIEFING FEEDBACK shorter, and put the KPIs first.' };
  const refused = checkVaultText(clean, clean);
  if (refused) return { ok: false, reason: refused };
  const items = [...getFeedback(), { date: now.toISOString().slice(0, 10), text: clean }].slice(-MAX_FEEDBACK);
  writeJson(FEEDBACK_FILE, { items });
  return { ok: true };
}

/** The recent notes as the models see them: the founder's words, as data. */
export function feedbackText(items = getFeedback(), { limit = 5 } = {}) {
  return items.slice(-limit).map((f) => `- ${f.date}: ${f.text}`).join('\n');
}

// ── The briefing's health, from its own record ─────────────────────────────────

/**
 * What the record of past briefings says, plus what is known about this one.
 * `history` is consultant.json's list; `today` is what has just been measured.
 * Pure.
 */
export function briefingHealth({ history = [], today = {} } = {}) {
  const recent = history.slice(-14);
  const withCost = recent.filter((h) => Number.isFinite(h.usd));
  const avgUsd = withCost.length ? withCost.reduce((n, h) => n + h.usd, 0) / withCost.length : null;
  const unknownTotal = recent.reduce((n, h) => n + (h.unknownCitations || 0), 0);
  const citedTotal = recent.reduce((n, h) => n + (h.citations || 0), 0);
  const unmeasured = today.unmeasuredKpis ?? null;
  const kpiTotal = today.kpiTotal ?? null;
  const facts = [];
  facts.push(`Briefing record: ${history.length} briefing${history.length === 1 ? '' : 's'} sent so far${avgUsd !== null ? `, averaging $${avgUsd.toFixed(2)} each over the last ${withCost.length}` : ''}.`);
  if (unmeasured !== null && kpiTotal) facts.push(`Briefing coverage: ${unmeasured} of ${kpiTotal} KPIs could not be measured today, so the briefing cannot steer by them.`);
  if (citedTotal + unknownTotal > 0) facts.push(`Briefing accuracy: over the last ${recent.length} briefings ${unknownTotal} of ${citedTotal + unknownTotal} citations pointed at nothing and were replaced.`);
  if (today.singleModel !== undefined) facts.push(`Briefing panel: ${today.singleModel ? 'one model wrote today\'s review, so it was not an independent panel' : `${today.drafters} models reviewed independently today`}.`);
  const sources = today.sources || {};
  const shelves = Object.entries(sources).map(([name, s]) => `${name}: ${s.read} read, ${s.unread} unreadable`);
  if (shelves.length) facts.push(`Briefing reading: ${shelves.join('; ')}.`);
  return { facts, avgUsd, unknownTotal, citedTotal, recentCount: recent.length };
}

// ── Improvements, chosen by code ───────────────────────────────────────────────

/**
 * The improvements to the briefing itself, from fixed rules over what was
 * measured. Each is a short, concrete action. Ids are B1, B2… in a stable order
 * so a citation means the same thing in every model's draft. Pure.
 */
export function improvementCandidates({ health, today = {}, scout = null, feedback = [], budgetUsd = null, now = new Date() }) {
  const out = [];
  const add = (text) => out.push({ id: `B${out.length + 1}`, text });

  if (today.singleModel) add('Add a second and third model so the panel is real: set OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY on the Jarvis service in Railway. One model reviewing a company is wrong in its own consistent way.');

  for (const r of scout?.results || []) {
    if (r.error) continue;
    if (!r.found && r.provider !== 'Gemini') {
      add(`${r.provider}'s list no longer shows ${r.configured}. Check the provider's deprecations page and set the ${r.provider} model variable in Railway before it stops answering.`);
    } else if (r.newer?.length) {
      add(`${r.provider} lists newer models than ${r.configured}: ${r.newer.map((n) => n.id).join(', ')}. Trying one means setting its model variable together with its INPUT and OUTPUT price variables (see server/.env.example), otherwise the spend meter under-counts it.`);
    }
  }

  if (today.unmeasuredKpis > 0 && today.kpiTotal) {
    add(`${today.unmeasuredKpis} of ${today.kpiTotal} KPIs are NOT MEASURED. Each one names the record it needs; start collecting the two nearest to being measurable first (the KPI table says what is missing).`);
  }

  const unread = Object.entries(today.sources || {}).filter(([, s]) => s.unread > s.read);
  for (const [name] of unread) {
    add(`More sources on the ${name} shelf could not be read than were read. Add pages that load as plain text under "${name}" in Library/Briefing sources.md; script-only sites and PDFs are skipped.`);
  }
  const thin = Object.entries(today.sources || {}).filter(([, s]) => s.read === 0 && s.unread === 0);
  for (const [name] of thin) add(`The ${name} shelf has not been read yet. It is read weekly; run DIGEST once its keys and budget are in place.`);

  if (budgetUsd && health?.avgUsd !== null && health?.avgUsd > budgetUsd * 0.9) {
    add(`The briefing averages $${health.avgUsd.toFixed(2)} against a $${budgetUsd} budget. It is close to the ceiling that cuts a briefing short; raise CONSULTANT_BUDGET_USD or drop a panel member.`);
  }

  if (health?.unknownTotal > 0 && health.citedTotal + health.unknownTotal > 0 && health.unknownTotal / (health.citedTotal + health.unknownTotal) > 0.1) {
    add('More than one citation in ten has pointed at nothing recently. Read the "Citations" line in "How this was produced" and treat those sentences as unsupported until it drops.');
  }

  const last = feedback.slice(-1)[0];
  if (last) add(`The founder's latest note on the briefing (${last.date}): "${last.text}". Reflect it in how today's review is written and say so.`);
  else add('No feedback has been given on the briefing yet. Reply to the WhatsApp number with BRIEFING FEEDBACK <what to change> and it will be applied from the next briefing.');

  if ((health?.recentCount ?? 0) < 3) add('Fewer than three briefings exist, so trends (readiness, KPI health, cost) are not meaningful yet. Judge the briefing on the sources and citations, not the trend, for now.');

  return out;
}

/** The candidates as the models are shown them. */
export const improvementsText = (candidates) => (candidates || []).map((c) => `[${c.id}] ${c.text}`).join('\n');

/** The section of the email. Pure. */
export function renderSelfReview({ health, candidates, scoutFacts = [], feedback = [] }) {
  const parts = [];
  parts.push('The briefing measured on its own record, and what would improve it. Chosen by code from fixed rules; the review above may add ideas, marked (judgement).', '');
  parts.push(...(health?.facts || []).map((f) => `- ${f}`));
  if (scoutFacts.length) parts.push('', 'Are the reviewing models the newest available?', ...scoutFacts.map((f) => `- ${f}`));
  parts.push('', 'Improvements, in order:', ...(candidates || []).map((c) => `- [${c.id}] ${c.text}`));
  if (feedback.length) parts.push('', 'Your recent notes on the briefing:', feedbackText(feedback));
  return parts.join('\n');
}

/** Sources the founder asked for, per shelf, from one vault note. Pure. */
export function founderSources(notes, topic) {
  const note = (notes || []).find((n) => n.fm?.type === 'briefing-sources');
  if (!note) return [];
  const re = new RegExp(`## ${topic}\\s*\\n([\\s\\S]*?)(\\n## |$)`, 'i');
  const section = note.body.match(re);
  return section ? [...section[1].matchAll(/^\s*-\s*(https:\/\/\S+)/gim)].map((m) => ({ url: m[1], publisher: 'chosen by the founder', title: '', source: 'founder' })).slice(0, 6) : [];
}
