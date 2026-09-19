// Does this company's own output survive being checked?
//
// Every fix shipped this week — the search budget, the calculator, the critic's
// retrieval, the enumerable sizing — was made on the strength of published
// evidence about what goes wrong in research agents. None of it was measured
// *here*. The published band for claim-level citation support runs 39% to 77%
// across deep-research systems, a fifty-three point spread, and this company
// has no idea where in it sits.
//
// So this is the measurement. It samples claims the team has actually written,
// opens the page each one cites, and asks whether that page says what the claim
// says it says. Three dimensions, kept apart on purpose, because collapsing
// them is how a system scores well on the easy two:
//
//   1. Does the link resolve?           — models are reliably good at this
//   2. Is the page on topic?            — also reliably good
//   3. Does it support *this* claim?    — the one that separates systems
//
// The protocol is not free: it is one fetch and one cheap model call per claim,
// so it runs when the founder asks rather than every morning.
//
// A note on what this can and cannot tell you. It measures the claims that
// *carry a citation*. A confident sentence with no URL attached is invisible
// to it, and that is the more dangerous kind — see claimCheck.js, which catches
// a different slice. Neither is a substitute for the other.

import { fetchCitedPage } from './claimVerify.js';
import { createMessage } from './agents/agentRunner.js';
import { CHEAP_TIER, MODELS } from './agents/models.js';
import { listDailyReports } from './dailyReports.js';
import { listVentures } from './finance/ventures.js';

const URL_PATTERN = /https?:\/\/[^\s)<>\]"']+/;

/**
 * Sentences that cite something, paired with what they cite.
 *
 * Sentence-level rather than paragraph-level because the unit being judged has
 * to be small enough to be true or false. "The market is large and growing
 * (url)" is two claims and a page can support one of them.
 */
export function extractCitedClaims(text) {
  const body = String(text || '');
  if (!body.trim()) return [];

  const claims = [];
  // Split on sentence ends and newlines, but not inside a URL — a full stop in
  // a domain is not the end of a sentence, and splitting there produces a claim
  // citing "https://example" and a fragment citing nothing.
  for (const raw of body.split(/(?<=[.!?])\s+(?=[A-Z(])|\n+/)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const match = sentence.match(URL_PATTERN);
    if (!match) continue;

    const url = match[0].replace(/[.,;:]+$/, '');
    const claim = sentence.replace(URL_PATTERN, '').replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    // A bare link with no assertion around it is a reference, not a claim.
    if (claim.length < 20) continue;
    claims.push({ claim, url });
  }
  return claims;
}

/** Everything the company has written lately that might carry a citation. */
export function gatherCitedClaims({ limit = 20 } = {}) {
  const sources = [];

  // Newest first, bounded: a fortnight is enough to see current behaviour and
  // short enough that the number reflects the team as it is now, not as it was
  // before this week's changes.
  // listDailyReports is already newest-first, so this is the last fortnight.
  // Bounded and recent on purpose: the number should reflect the team as it is
  // now, not as it was before this week's changes.
  for (const report of listDailyReports().slice(0, 14)) {
    sources.push({ where: `daily report ${report.date}`, text: report.leadership?.reply || '' });
    sources.push({ where: `studio ${report.date}`, text: report.studio?.reply || '' });
  }
  for (const venture of listVentures()) {
    sources.push({
      where: `venture "${venture.title}"`,
      text: [venture.marketSize, venture.pathToMillions, venture.agentNativeEdge, venture.problem]
        .filter(Boolean)
        .join('\n'),
    });
    for (const note of venture.notes || []) sources.push({ where: `note on "${venture.title}"`, text: note.note || '' });
  }

  const claims = [];
  for (const source of sources) {
    for (const found of extractCitedClaims(source.text)) {
      claims.push({ ...found, where: source.where });
      if (claims.length >= limit) return claims;
    }
  }
  return claims;
}

const VERDICTS = ['SUPPORTED', 'PARTIAL', 'UNSUPPORTED'];

/**
 * One claim, against the page it cites.
 *
 * The judge is the cheap tier deliberately. Small models are measurably good at
 * exactly this — source-relevance verification against retrieved evidence — and
 * the frontier model's advantage is in generation, not checking. It also keeps
 * a full pass affordable enough to run more than once.
 */
export async function checkCitedClaim({ claim, url, anthropic }) {
  const page = await fetchCitedPage(url, { claim });
  if (!page.ok) {
    // Dimension one failed, and the other two are unanswerable rather than
    // failed. Reporting them as unsupported would blame the claim for the
    // network.
    return { verdict: 'UNREACHABLE', resolves: false, reason: page.error };
  }
  if (!anthropic) return { verdict: 'UNJUDGED', resolves: true, reason: 'No model client available to judge the page.' };

  const prompt = `A claim, and the page it cites. Decide whether the page actually supports it.

CLAIM: ${claim}

PAGE (${url}):
---
${page.excerpt}
---

Answer with exactly one word, then one sentence:
SUPPORTED — the page states this, including any number in it.
PARTIAL — the page says something close but different. Say what the difference is.
UNSUPPORTED — the page does not say this, or is about something else.

The page being on the right topic is not support. If the claim contains a figure, that figure has to appear.`;

  try {
    const spec = MODELS[CHEAP_TIER] || MODELS.frontier;
    const response = await createMessage(anthropic, spec, {
      max_tokens: 200,
      system: 'You check claims against sources. You are literal and you do not give benefit of the doubt.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = (response?.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();

    const verdict = VERDICTS.find((v) => new RegExp(`^\\s*${v}\\b`, 'i').test(text));
    return {
      // An answer that names no verdict is not a pass. Defaulting an
      // unparseable judgement to SUPPORTED would inflate the only number this
      // whole file exists to produce.
      verdict: verdict || 'UNJUDGED',
      resolves: true,
      reason: text.replace(/^\s*(SUPPORTED|PARTIAL|UNSUPPORTED)\b[\s—:-]*/i, '').trim(),
    };
  } catch (err) {
    return { verdict: 'UNJUDGED', resolves: true, reason: `The judge could not be reached: ${err.message}` };
  }
}

/**
 * A full pass. Serial, because each claim costs a fetch and a call and there is
 * no hurry — this is a measurement, not a request path.
 */
export async function runFactCheck({ anthropic, limit = 20 } = {}) {
  const claims = gatherCitedClaims({ limit });
  const rows = [];
  for (const item of claims) {
    const result = await checkCitedClaim({ ...item, anthropic });
    rows.push({ ...item, ...result });
  }

  const counts = rows.reduce((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] || 0) + 1;
    return acc;
  }, {});
  const judged = rows.filter((row) => VERDICTS.includes(row.verdict)).length;
  const supported = counts.SUPPORTED || 0;

  return {
    checked: rows.length,
    judged,
    counts,
    // The headline number, and null rather than 0 when nothing could be judged
    // — "0% supported" and "nothing was checkable" are different findings and
    // one of them is an indictment.
    supportRate: judged ? Math.round((supported / judged) * 100) : null,
    rows,
    at: new Date().toISOString(),
  };
}

export function describeFactCheck(result) {
  if (!result || !result.checked) {
    return 'Nothing to check: no claim in the last fortnight carried a source URL. That is itself a finding — an uncited claim cannot be checked by anyone, including the team that made it.';
  }

  const lines = [
    result.supportRate === null
      ? `${result.checked} cited claim${result.checked === 1 ? '' : 's'} sampled, none of which could be judged.`
      : `${result.supportRate}% of judged claims were supported by the page they cite (${result.counts.SUPPORTED || 0} of ${result.judged}).`,
    `Published systems land between 39% and 77% on this, so that is the band to read it against.`,
    '',
  ];

  for (const row of result.rows) {
    lines.push(`${row.verdict} — ${row.where}`);
    lines.push(`  "${row.claim.slice(0, 140)}${row.claim.length > 140 ? '…' : ''}"`);
    lines.push(`  ${row.url}`);
    if (row.reason) lines.push(`  ${row.reason.slice(0, 200)}`);
  }

  const unreachable = result.counts.UNREACHABLE || 0;
  if (unreachable) {
    lines.push('', `${unreachable} source${unreachable === 1 ? '' : 's'} could not be opened at all. Those are not judged either way — but a citation nobody can follow is not much of a citation.`);
  }
  return lines.join('\n');
}
