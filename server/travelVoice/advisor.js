// The travel advisor: one agent, three languages, one domain.
//
// Deliberately not a member of the Executive Team. The company's agents
// delegate to each other and can act — deploy, email, book revenue — and a
// stranger on a phone must never reach any of that. This agent has two read-
// only tools at most (an airport lookup and a fare search) and no way to
// reach the org chart, so it can be exposed to the public on its own
// WhatsApp number with nothing behind it but the spend cap.
//
// It answers in the caller's language, decided before the model is asked (see
// languages.js) and stated in the prompt rather than left to the model's
// judgement. A model asked to "reply in the language of the message" gets it
// right most of the time; a voice product needs it right every time.
//
// The domain brief below is what the advisor knows without looking anything
// up. It is the knowledge a good Amadeus trainer carries: the cryptic entries
// agencies actually type, the PNR lifecycle, what the words on a fare mean.
// Where an answer depends on a specific airline's rule or a live price, the
// advisor is told to say so and — when Amadeus credentials exist — to look.

import { priceUsage } from '../usage.js';
import { assertUnderDailyCap, recordSpend } from '../spend.js';
import { LANGUAGE_NAMES, normalizeLanguage, DEFAULT_LANGUAGE } from './languages.js';
import { isAmadeusConfigured, lookupLocations, searchFlightOffers, amadeusEnvironment } from './amadeus.js';
import { resolveProvider } from './providers/index.js';
import { checkReply, correctionPrompt, languageRetryEnabled } from './replyCheck.js';

const MAX_TOOL_ROUNDS = 4;

// Headroom, not a brevity control.
//
// This was 700, which was the right number for a model that answers straight
// away and the wrong one for a model that thinks first: thinking tokens come
// out of the same budget, so a low cap truncates the answer rather than
// shortening it. Brevity is the prompt's job ("roughly 60 to 150 words") and
// the trim in replyCheck.js is the backstop for when the prompt is ignored.
function maxTokens() {
  const value = Number(process.env.TRAVEL_VOICE_MAX_TOKENS);
  return Number.isFinite(value) && value > 0 ? value : 2000;
}

/** The model the default brain answers with, for status displays. */
export function advisorModel() {
  const brain = resolveProvider('llm');
  return brain ? brain.model() : null;
}

const DOMAIN_BRIEF = `You are a senior travel-industry advisor who has spent years on an Amadeus helpdesk and in agency back offices. Callers are travel agents, agency owners, tour operators and corporate travel bookers. They ring with a live problem — a PNR that will not price, a client asking for a refund, a fare they do not understand — and they want a clear, practical answer they can act on now.

WHAT YOU KNOW WELL
- Amadeus Selling Platform (Connect and classic cryptic). Common entries, with what each does:
  AN25DECMADCDG (availability), SN (schedule), TN (timetable), SS1Y2 (sell one seat in class Y on line 2), SS AA123Y25DECMADCDG1 (long sell), NM1GARCIA/JUAN MR (name), AP MAD 91 123 4567 (phone), APE- email, TKOK / TKTL25DEC/1800 (ticketing element), RF (received from), ER / ET (end and retrieve / end transact), RT (retrieve PNR), RTxxxxxx (retrieve by locator), XE2 (cancel element 2), XI (cancel itinerary), XR (cancel and retrieve), FXP (price PNR with stored fare, TST), FXB (best buy: lowest fare for the booked itinerary), FXA (lowest fare with alternative booking classes), FXX (informative pricing, no TST), FQDMADCDG/AIB (fare display), FQN (fare notes / rules by category, e.g. FQN1*16 for penalties), FQP (informative pricing of a routing), TTP (issue ticket), TTP/RT (issue and retrieve), TWD (ticket display), TRDC (void within the void window), TRF (automated refund), TQT (TST display), TTE (delete TST), TTC (TST copy), FE (endorsement/restrictions), FM (commission), FP (form of payment: FPCASH, FPCC), FV (validating carrier), OS (other service information), SR (special service request, e.g. SR VGML, SR WCHR), SM (seat map), ST (seat request), FFN (frequent flyer), DO (flight information), DD (date calculation), QT (queue totals), QC (queue count), QS (queue start), QE (place on queue), QD (delete from queue), QI (ignore and remove), HE (help on any entry, e.g. HE SS).
- The PNR: the five mandatory elements (name, itinerary, phone, ticketing, received from), what a segment status code means (HK confirmed, HL waitlisted, HN needs confirmation, UC unable, UN unable to confirm, NO no action, TK schedule change confirmed, TL/UN and WK/WL after a schedule change, HX cancelled by carrier), the difference between an active and a passive segment, the ticketing time limit, and why a PNR ends up on queue.
- Fares and ticketing: fare basis codes and what their letters usually signal, published versus private/negotiated fares, TST versus TSM, the difference between void (within the same reporting period), refund and exchange, involuntary versus voluntary changes, the ATPCO category numbers that matter most (16 penalties, 31 voluntary changes, 33 voluntary refunds), EMDs for ancillaries, BSP reporting and ADMs, IATA interline and ticketing authority, the 24-hour rule in the US, and EU261 obligations for delays and cancellations.
- NDC and modern retailing: what changes when an airline moves content out of EDIFACT (continuous pricing, rich content, order-based servicing), what Amadeus Travel Platform and NDC-enabled agencies mean in practice, and when a fare on the airline's site is not visible in the GDS.
- The wider industry: GDS versus direct connects, IATA and ARC accreditation, airline alliances and codeshares, baggage and MCT (minimum connecting time) rules, visa and passport basics with the caution that TIMATIC (TIFA/TIDFT) is the authority, hotel and car segments, rail in Amadeus, travel insurance basics, and how agencies earn (commission, service fees, mark-ups).
- The three languages of this service: Spanish, French and English. Amadeus cryptic entries and IATA codes stay exactly as typed in any language — never translate an entry.

HOW YOU ANSWER
- Give the answer first, then the entry or steps, then one caveat if one genuinely matters. No preamble.
- You are usually being heard, not read. Keep replies to what fits in a spoken voice note: roughly 60 to 150 words. No markdown, no bullet lists, no tables — say "first, second, third" instead. Spell out entries as they would be typed, e.g. "F X P" is not needed; say the entry as text: FXP.
- If the question is ambiguous, ask ONE precise question rather than answering three versions.
- Never invent a specific fare, a rule for a named airline, or a schedule. Where a rule depends on the carrier or the fare, say which category to check (for example FQN on category 16) and that the fare rule wins. Where a live price is asked for and you have a search tool, use it; where you have none, say plainly that you cannot see live fares and explain how the agent can check.
- When you use a tool, read the results back the way a colleague would over the phone: the cheapest option first with its total price, airline, stops and rough timings, then one alternative. Do not list more than three itineraries.
- You give industry guidance, not legal advice. For disputes, say what the documented rule is and recommend the agent confirm with the carrier or their BSP/IATA contact.
- Stay in the travel and Amadeus domain. If asked something unrelated, say briefly that this line is for travel and GDS questions and offer to help with one.`;

function languageInstruction(language) {
  const names = LANGUAGE_NAMES[language] || LANGUAGE_NAMES[DEFAULT_LANGUAGE];
  return `LANGUAGE: Reply entirely in ${names.english} (${names.native}). The caller is using it. Do not switch unless they explicitly ask you to, and if they ask, switch for the rest of the conversation. Keep IATA codes, airline names and Amadeus entries as they are.`;
}

function toolsAvailable() {
  if (!isAmadeusConfigured()) return [];
  return [
    {
      name: 'lookup_location',
      description:
        'Find airports and cities by name or partial name, returning IATA codes. Use it when a caller names a place rather than a code, before searching fares.',
      input_schema: {
        type: 'object',
        properties: { keyword: { type: 'string', description: 'City or airport name, e.g. "Paris", "Barcelona", "Heathrow"' } },
        required: ['keyword'],
      },
    },
    {
      name: 'search_flight_offers',
      description: `Live flight offers from the Amadeus Self-Service API (${amadeusEnvironment()} environment). Needs IATA codes and an ISO date. Returns up to a handful of priced itineraries.`,
      input_schema: {
        type: 'object',
        properties: {
          origin: { type: 'string', description: 'Origin IATA code, e.g. MAD' },
          destination: { type: 'string', description: 'Destination IATA code, e.g. CDG' },
          departureDate: { type: 'string', description: 'YYYY-MM-DD' },
          returnDate: { type: 'string', description: 'YYYY-MM-DD, only for a round trip' },
          adults: { type: 'integer', description: 'Number of adult passengers, default 1' },
          travelClass: { type: 'string', enum: ['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST'] },
          nonStop: { type: 'boolean' },
          currency: { type: 'string', description: 'ISO currency, e.g. EUR' },
        },
        required: ['origin', 'destination', 'departureDate'],
      },
    },
  ];
}

async function runTool(name, input) {
  if (name === 'lookup_location') return lookupLocations(input.keyword);
  if (name === 'search_flight_offers') return searchFlightOffers(input);
  throw new Error(`Unknown tool: ${name}`);
}

function usageOf(response) {
  const u = response?.usage || {};
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
  };
}

/**
 * One advisor turn.
 *
 * @param {object} args
 * @param {object} [args.anthropic] the Anthropic client, used by the Anthropic brain
 * @param {string} [args.provider] which brain to think with (see providers/llm.js);
 *   the deployment default when omitted
 * @param {Array} args.history prior messages for this caller, Anthropic-shaped
 * @param {string} args.text what the caller said, already transcribed
 * @param {string} args.language which of the three to answer in
 * @param {(name: string, input: object) => Promise<any>} [args.tools] tool
 *   executor override, for tests
 * @returns {Promise<{ reply: string, messages: Array, usage: object, toolCalls: Array<{name, input}>, provider: string, model: string, ms: number }>}
 */
export async function runAdvisorTurn({ anthropic = null, provider = null, history = [], text, language, tools = runTool }) {
  const lang = normalizeLanguage(language) || DEFAULT_LANGUAGE;
  const brain = resolveProvider('llm', provider);
  if (!brain) throw new Error('No advisor model is configured — set ANTHROPIC_API_KEY (or IONOS_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY and choose it)');
  const modelSpec = brain.priceSpec();
  const model = brain.model();
  const toolDefs = toolsAvailable();
  const startedAt = Date.now();

  const system = [
    { type: 'text', text: DOMAIN_BRIEF, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: languageInstruction(lang) },
  ];

  const messages = [...history, { role: 'user', content: String(text) }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0 };
  const toolCalls = [];

  // One call, metered. Shared by the tool loop and the language correction
  // below so both are billed and capped the same way — a correction that
  // slipped past the cap would be the one call in the app that could.
  async function ask({ withTools = true } = {}) {
    assertUnderDailyCap();
    const request = { model, max_tokens: maxTokens(), system, messages };
    if (withTools && toolDefs.length) request.tools = toolDefs;
    const response = await brain.create(request, { anthropic });

    const tokens = usageOf(response);
    const cost = priceUsage(tokens, modelSpec);
    recordSpend(cost, tokens);
    usage.inputTokens += tokens.inputTokens;
    usage.outputTokens += tokens.outputTokens;
    usage.cacheWriteTokens += tokens.cacheWriteTokens;
    usage.cacheReadTokens += tokens.cacheReadTokens;
    usage.costUsd += cost;

    const content = response.content || [];
    messages.push({ role: 'assistant', content });
    return { response, content };
  }

  function textOf(content) {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  let reply = '';
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const { response, content } = await ask();

    const toolUses = content.filter((block) => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0 || round === MAX_TOOL_ROUNDS) {
      reply = textOf(content);
      break;
    }

    // Every tool_use block needs a matching tool_result, or the API rejects
    // the next request; a failure becomes a result the model can explain
    // rather than an exception that ends the call in silence.
    const results = [];
    for (const use of toolUses) {
      toolCalls.push({ name: use.name, input: use.input });
      try {
        const output = await tools(use.name, use.input || {});
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(output).slice(0, 12000) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: err.message });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  // The answer is written. Is it in the language the caller is speaking?
  // See replyCheck.js for why this is worth a second call and why it fires
  // only on strong evidence.
  let check = checkReply(reply, { language: lang });
  let drift = null;
  if (check.drifted && languageRetryEnabled()) {
    drift = { detected: check.detected, corrected: false };
    messages.push({ role: 'user', content: correctionPrompt(lang) });
    try {
      // No tools on the correction: this is a rewrite of an answer already
      // researched, and a fresh tool round here would be a third call and a
      // longer wait for words the model has already chosen.
      const { content } = await ask({ withTools: false });
      const rewritten = textOf(content);
      if (rewritten) {
        const recheck = checkReply(rewritten, { language: lang });
        // Kept even if it drifted again: a second wrong-language answer is no
        // worse than the first, and refusing to use it would mean throwing
        // away a call the founder has already paid for.
        reply = rewritten;
        check = recheck;
        drift.corrected = !recheck.drifted;
        drift.stillDrifted = recheck.drifted;
      }
    } catch (err) {
      // The first answer still exists and is still useful to someone who
      // reads the language it came back in. Losing it to a failed retry
      // would turn a degraded reply into no reply at all.
      drift.error = err.message;
      if (String(err?.message || '').startsWith('Daily spend cap reached')) drift.error = 'daily spend cap reached before the correction could run';
    }
  }

  return {
    reply,
    messages,
    usage,
    toolCalls,
    language: lang,
    provider: brain.id,
    model,
    // What the answer looked like once it was written: whether it came back
    // in the wrong language and had to be asked again, and how long it ran.
    // The numbers that say which brain can be trusted with a phone call.
    drift,
    words: check.words,
    tooLong: check.tooLong,
    ms: Date.now() - startedAt,
  };
}

export const __testing = { DOMAIN_BRIEF, languageInstruction, toolsAvailable };
