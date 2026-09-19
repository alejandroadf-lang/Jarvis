// Simulate, then judge: the pre-release check on the advisor.
//
// The one QA method the production voice companies describe in enough
// detail to copy: a model plays a caller with a goal, the advisor answers
// as it would on the phone, and a second, stronger model reads the
// conversation against a rubric — alongside a set of deterministic rules
// that need no model at all (right language, codes intact, no invented
// amounts, not too long, a handoff where one was due). Run before a
// prompt, a model or a provider changes, and after, and compare.
//
// Two tiers on purpose. The live path runs whatever brain the deployment
// runs, so the check is of the thing that ships; the judge runs the judge
// model (see providers/llm.js) — stronger, slower, and never on the
// caller's clock.
//
// Nothing here touches WhatsApp or a real phone number, and the Amadeus
// tools are stubbed by default so a run costs model tokens and nothing
// else. `npm run travel:qa` runs the built-in scenarios; the module is
// also importable so a test can run it with fake models.

import { runAdvisorTurn } from '../advisor.js';
import { resolveProvider } from '../providers/index.js';
import { judgeModel, judgePriceSpec } from '../providers/llm.js';
import { checkReply } from '../replyCheck.js';
import { groundingCheck } from '../grounding.js';
import { codesIn, droppedCodes } from '../translate.js';
import { isHandoffRequest } from '../escalation.js';
import { LANGUAGE_NAMES, normalizeLanguage, DEFAULT_LANGUAGE } from '../languages.js';
import { priceUsage } from '../../usage.js';
import { assertUnderDailyCap, recordSpend } from '../../spend.js';

// --- the callers ------------------------------------------------------------------------

// Each scenario is a person with a goal. The persona is what the caller
// model is told to be; `opening` is their first message, verbatim, so the
// first turn is reproducible; `expect` is what the deterministic rules
// look for beyond the defaults.
export const SCENARIOS = [
  {
    id: 'es-pricing',
    language: 'es',
    persona: 'Eres una agente de viajes en Madrid con diez años de Amadeus. Tienes un PNR con localizador X7K2PQ que no valora con FXP. Hablas de forma directa y profesional, tratas de usted.',
    opening: 'Buenos días. Tengo el localizador X7K2PQ y no me valora con FXP, me da un error. ¿Qué hago?',
    turns: 3,
    expect: { codes: ['X7K2PQ', 'FXP'], mentions: ['TST', 'FXB', 'FQD', 'FXX', 'FXA'] },
  },
  {
    id: 'fr-refund',
    language: 'fr',
    persona: "Vous êtes conseillère dans une agence à Lyon. Un client veut le remboursement d'un billet Air France émis il y a trois semaines, dossier ABC123. Vous vouvoyez et vous êtes pressée.",
    opening: "Bonjour, j'ai un client qui veut se faire rembourser un billet AF émis il y a trois semaines, dossier ABC123. Comment je procède ?",
    turns: 3,
    expect: { codes: ['ABC123'], mentions: ['TRF', 'catégorie 33', 'FQN', 'remboursement'] },
  },
  {
    id: 'en-eu261',
    language: 'en',
    persona: 'You are a corporate travel booker in Manchester. Your traveller was delayed five hours on MAD to JFK last week and wants compensation. You are polite and want a straight answer.',
    opening: 'Hi, my traveller was delayed five hours on a MAD to JFK flight last week. Are they owed compensation and how much?',
    turns: 2,
    expect: { noAmounts: true, mentions: ['EU261', '261', 'extraordinary', 'carrier'] },
  },
  {
    id: 'es-fee-trap',
    language: 'es',
    persona: 'Eres un agente de viajes en Buenos Aires. Quieres saber cuánto cuesta cambiar la fecha de un billete de Iberia en clase Q y presionas para que te den una cifra concreta.',
    opening: '¿Cuánto me cobra Iberia por cambiar la fecha de un billete en clase Q? Necesito la cifra exacta ya.',
    turns: 2,
    expect: { noAmounts: true, mentions: ['FQN', 'categoría 31', '16', 'tarifa'] },
  },
  {
    id: 'fr-handoff',
    language: 'fr',
    persona: "Vous êtes gérante d'agence à Marseille, furieuse : un ADM de 800 € est arrivé et vous voulez le contester, et vous exigez de parler à une personne responsable.",
    opening: "J'ai reçu un ADM de 800 € que je conteste formellement. Je veux parler à un responsable, pas à une machine.",
    turns: 1,
    expect: { handoff: true },
  },
  {
    id: 'en-codeswitch',
    language: 'en',
    persona: 'You are a Spanish agent writing in English but slipping into Spanish for the jargon. You want to know what TKTL does and when to use it.',
    opening: 'Hi, quick one: what does TKTL do exactly, and when do I put it in the PNR before I emito the billete?',
    turns: 1,
    expect: { codes: ['TKTL'], mentions: ['ticketing', 'time limit', 'TK'] },
  },
];

// --- the rules that need no model --------------------------------------------------------

/**
 * Deterministic checks on one advisor reply.
 *
 * Every rule returns a finding or nothing; a run's rule score is the
 * share of turns with no finding. These are the failures a person would
 * notice first, and none of them needs a judge to see.
 */
export function ruleChecks({ reply, language, transcript, toolOutputs = [], expect = {}, handoff = null, turnIndex = 0, turns = 1 }) {
  const findings = [];
  const wanted = normalizeLanguage(language) || DEFAULT_LANGUAGE;

  const check = checkReply(reply, { language: wanted });
  if (check.drifted) findings.push({ rule: 'language', detail: `answered in ${check.detected}, wanted ${wanted}` });
  if (check.tooLong) findings.push({ rule: 'length', detail: `${check.words} words` });

  const dropped = droppedCodes(transcript, reply).filter((code) => (expect.codes || []).includes(code));
  if (dropped.length) findings.push({ rule: 'codes', detail: `did not echo ${dropped.join(', ')}` });

  const ground = groundingCheck(reply, { toolOutputs, callerText: [transcript] });
  if (ground.ungrounded.length) findings.push({ rule: 'grounding', detail: `amounts with no source: ${ground.ungrounded.map((a) => a.text).join(', ')}` });
  if (expect.noAmounts && ground.amounts.length && ground.ungrounded.length) findings.push({ rule: 'no-amounts', detail: 'a figure was given where none should be' });

  if (expect.handoff && !handoff && turnIndex === turns - 1) findings.push({ rule: 'handoff', detail: 'a person was wanted and none was offered' });
  if (!expect.handoff && handoff && !isHandoffRequest(transcript)) findings.push({ rule: 'handoff', detail: 'handed over without being asked' });

  // Any one of the expected mentions is enough: the rubric names the
  // entries a good answer would reach for, not a script.
  if (expect.mentions?.length && turnIndex === 0) {
    const lower = reply.toLowerCase();
    if (!expect.mentions.some((m) => lower.includes(m.toLowerCase()))) findings.push({ rule: 'substance', detail: `none of ${expect.mentions.join(', ')} mentioned` });
  }

  return findings;
}

// --- the caller model ------------------------------------------------------------------------

function callerPrompt(scenario) {
  const names = LANGUAGE_NAMES[scenario.language];
  return `${scenario.persona}

You are talking to a travel-industry advisor over WhatsApp. Stay in character. Write ONLY your next message, in ${names.english}, one to three sentences, as a person would type or say it. Ask a follow-up or push back if the answer was vague; say thank you and stop if it was complete. Never break character, never explain that you are simulating.`;
}

async function nextCallerMessage({ anthropic, brain, scenario, exchange }) {
  const messages = [];
  // The caller sees the conversation from the other side: the advisor's
  // replies are "user" turns to the caller model.
  for (const step of exchange) {
    messages.push({ role: 'assistant', content: step.caller });
    if (step.reply) messages.push({ role: 'user', content: step.reply });
  }
  const response = await brain.create(
    { model: brain.model(), max_tokens: 300, system: [{ type: 'text', text: callerPrompt(scenario) }], messages },
    { anthropic }
  );
  return (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// --- the judge --------------------------------------------------------------------------------

const RUBRIC = `You are judging a travel-industry helpdesk advisor's conversation with an agent, for an Amadeus-focused helpdesk that answers in Spanish, French and English.

Score each criterion 0, 1 or 2 (2 = fully met):
1. correctness: the Amadeus entries, rules and industry facts stated are right; nothing invented.
2. grounding: no fare, fee or compensation amount is stated unless it came from a tool result or the caller; where an amount is unknown the advisor says how to check it.
3. language: entirely in the caller's language, formal register (usted / vous), the trade's own words.
4. codes: locators, IATA codes and entries are repeated exactly; a locator heard is confirmed.
5. brevity: fits a spoken voice note; answer first, then steps, one caveat at most.
6. escalation: a person is offered when the caller asks or when the question needs a decision the advisor cannot ground; not otherwise.
7. register: nothing said about the caller's mood, identity or origin; no legal advice presented as certain.

Reply with JSON only: {"scores": {"correctness": n, "grounding": n, "language": n, "codes": n, "brevity": n, "escalation": n, "register": n}, "worst": "<criterion>", "note": "<one sentence a colleague can act on>"}`;

export async function judgeConversation({ anthropic, scenario, exchange, model = judgeModel() }) {
  const transcript = exchange
    .map((step, i) => `Caller (${i + 1}): ${step.caller}\nAdvisor (${i + 1}): ${step.reply}${step.handoff ? '\n[advisor requested a person]' : ''}${step.toolCalls?.length ? `\n[tools: ${step.toolCalls.join(', ')}]` : ''}`)
    .join('\n\n');
  assertUnderDailyCap();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 600,
    system: [{ type: 'text', text: RUBRIC, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Scenario: ${scenario.id} (${LANGUAGE_NAMES[scenario.language].english}).\n\n${transcript}` }],
  });
  const usage = response.usage || {};
  const cost = priceUsage(
    { inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0, cacheWriteTokens: usage.cache_creation_input_tokens || 0, cacheReadTokens: usage.cache_read_input_tokens || 0 },
    { ...judgePriceSpec(), model }
  );
  recordSpend(cost);
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const parsed = parseJudge(text);
  return { ...parsed, model, costUsd: cost };
}

export function parseJudge(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return { scores: null, worst: null, note: 'judge returned no JSON', raw: String(text || '').slice(0, 300) };
  try {
    const data = JSON.parse(match[0]);
    const scores = data.scores || {};
    const values = Object.values(scores).map(Number).filter(Number.isFinite);
    return { scores, worst: data.worst || null, note: data.note || '', mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  } catch {
    return { scores: null, worst: null, note: 'judge returned malformed JSON', raw: match[0].slice(0, 300) };
  }
}

// --- the run ------------------------------------------------------------------------------------

/**
 * Runs the scenarios end to end.
 *
 * @param {object} opts
 * @param {object} opts.anthropic the Anthropic client (the judge and, by default, the caller)
 * @param {string} [opts.provider] which brain the advisor answers with; the deployment's default otherwise
 * @param {Array} [opts.scenarios]
 * @param {(name, input) => Promise<any>} [opts.tools] tool executor; a stub by default
 * @param {boolean} [opts.judge] run the judge model; rules only when false
 * @param {(line: string) => void} [opts.log]
 */
export async function runSimulation({ anthropic, provider = null, scenarios = SCENARIOS, tools = stubTools, judge = true, log = () => {} } = {}) {
  const caller = resolveProvider('llm', 'anthropic');
  if (!caller) throw new Error('The caller model needs the Anthropic brain configured');
  const results = [];
  const startedAt = Date.now();

  for (const scenario of scenarios) {
    const exchange = [];
    let history = [];
    let costUsd = 0;
    const toolOutputs = [];
    const findings = [];
    log(`▶ ${scenario.id} (${scenario.language})`);

    for (let i = 0; i < scenario.turns; i++) {
      const callerText = i === 0 ? scenario.opening : await nextCallerMessage({ anthropic, brain: caller, scenario, exchange });
      if (!callerText) break;
      const turn = await runAdvisorTurn({
        anthropic,
        provider,
        history,
        text: callerText,
        language: scenario.language,
        tools: async (name, input) => {
          const out = await tools(name, input);
          toolOutputs.push(JSON.stringify(out));
          return out;
        },
      });
      history = turn.messages;
      costUsd += turn.usage.costUsd;
      const step = { caller: callerText, reply: turn.reply, toolCalls: turn.toolCalls.map((t) => t.name), handoff: turn.handoff, ms: turn.ms, drift: turn.drift, grounding: turn.grounding };
      exchange.push(step);
      const stepFindings = ruleChecks({ reply: turn.reply, language: scenario.language, transcript: callerText, toolOutputs, expect: scenario.expect || {}, handoff: turn.handoff, turnIndex: i, turns: scenario.turns });
      findings.push(...stepFindings.map((f) => ({ turn: i + 1, ...f })));
      log(`  ${i + 1}. ${callerText.slice(0, 70)}…\n     → ${turn.reply.slice(0, 90)}…${stepFindings.length ? `\n     ✗ ${stepFindings.map((f) => `${f.rule}: ${f.detail}`).join('; ')}` : ''}`);
      if (turn.handoff) break;
    }

    let verdict = null;
    if (judge && exchange.length) {
      verdict = await judgeConversation({ anthropic, scenario, exchange });
      costUsd += verdict.costUsd;
      log(`  judge: ${verdict.mean === null || verdict.mean === undefined ? '?' : verdict.mean.toFixed(2)}/2${verdict.worst ? `, worst ${verdict.worst}` : ''} — ${verdict.note}`);
    }

    results.push({ id: scenario.id, language: scenario.language, exchange, findings, judge: verdict, costUsd, provider: exchange.length ? (provider || resolveProvider('llm').id) : null });
  }

  return summarize(results, { ms: Date.now() - startedAt });
}

export function summarize(results, extra = {}) {
  const byLanguage = {};
  for (const r of results) {
    const b = byLanguage[r.language] || (byLanguage[r.language] = { scenarios: 0, turns: 0, findings: 0, clean: 0, judgeMean: [], costUsd: 0 });
    b.scenarios += 1;
    b.turns += r.exchange.length;
    b.findings += r.findings.length;
    if (!r.findings.length) b.clean += 1;
    if (r.judge?.mean !== null && r.judge?.mean !== undefined) b.judgeMean.push(r.judge.mean);
    b.costUsd += r.costUsd;
  }
  for (const b of Object.values(byLanguage)) {
    b.judgeMean = b.judgeMean.length ? b.judgeMean.reduce((a, c) => a + c, 0) / b.judgeMean.length : null;
  }
  const findings = results.flatMap((r) => r.findings.map((f) => ({ scenario: r.id, ...f })));
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  return {
    ...extra,
    scenarios: results.length,
    clean: results.filter((r) => !r.findings.length).length,
    findings: findings.length,
    byRule,
    byLanguage,
    judgeMean: (() => {
      const means = results.map((r) => r.judge?.mean).filter((m) => m !== null && m !== undefined);
      return means.length ? means.reduce((a, c) => a + c, 0) / means.length : null;
    })(),
    costUsd: results.reduce((a, r) => a + r.costUsd, 0),
    results,
  };
}

// A stub Amadeus: one priced itinerary, so a scenario that searches has a
// grounded figure to quote and one that should not has nothing to invent.
export async function stubTools(name, input) {
  if (name === 'lookup_location') return [{ iataCode: 'MAD', name: 'Madrid Barajas' }, { iataCode: 'CDG', name: 'Paris Charles de Gaulle' }];
  if (name === 'search_flight_offers') return [{ price: { total: '189.40', currency: input?.currency || 'EUR' }, itineraries: [{ segments: [{ carrierCode: 'IB', number: '3402', departure: { iataCode: input?.origin }, arrival: { iataCode: input?.destination } }] }] }];
  throw new Error(`Unknown tool: ${name}`);
}

export function formatSummary(summary) {
  const lines = [
    `Simulate-then-judge: ${summary.clean}/${summary.scenarios} scenarios clean, ${summary.findings} findings, judge ${summary.judgeMean === null ? 'off' : `${summary.judgeMean.toFixed(2)}/2`}, $${summary.costUsd.toFixed(3)}${summary.ms ? `, ${(summary.ms / 1000).toFixed(0)}s` : ''}.`,
  ];
  for (const [language, b] of Object.entries(summary.byLanguage)) {
    lines.push(`  ${language}: ${b.clean}/${b.scenarios} clean, ${b.findings} findings, judge ${b.judgeMean === null ? '—' : `${b.judgeMean.toFixed(2)}/2`}, $${b.costUsd.toFixed(3)}`);
  }
  if (Object.keys(summary.byRule).length) lines.push(`  by rule: ${Object.entries(summary.byRule).map(([r, n]) => `${r} ${n}`).join(', ')}`);
  for (const r of summary.results) {
    for (const f of r.findings) lines.push(`  ✗ ${r.id} turn ${f.turn} ${f.rule}: ${f.detail}`);
    // The judge's sentence is shown when it found something: a low mean, or
    // any single criterion at zero — one zero is a real failure whatever the
    // average says.
    const zero = Object.values(r.judge?.scores || {}).some((v) => Number(v) === 0);
    if (r.judge?.note && ((r.judge.mean ?? 2) < 1.5 || zero)) lines.push(`  ⚖ ${r.id}: ${r.judge.note}`);
  }
  return lines.join('\n');
}
