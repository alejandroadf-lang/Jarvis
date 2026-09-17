// Orchestrator-workers engine, generic over any agent map (the operating
// company's org chart, the venture studio, or anything else shaped the same
// way — see registry.js).
//
// Each agent that has direct reports is run through a Claude tool-use loop
// where every report is exposed as a callable tool named `consult_<id>`.
// When the agent calls one of those tools, we recursively run that report as
// its own (possibly further-delegating) agent, feed its answer back as a
// tool_result, and let the manager keep going until it produces a final
// text answer. This mirrors Anthropic's orchestrator-workers workflow and
// the Claude Agent SDK's subagent model.
//
// An agent can also define `actions`: extra tools that aren't delegation,
// but a real side effect (e.g. the venture studio's `propose_venture`,
// which logs a venture proposal). The caller supplies `actionHandlers`, a
// map from tool name to an async function that performs the effect and
// returns the text to feed back to the agent as the tool_result.
//
// A third kind, `serverTools`, is for Anthropic-hosted tools (e.g. web
// search): the tool spec is passed straight through to the API, and
// Anthropic executes it server-side and returns the result already folded
// into the same response — no tool_result round trip needed from us, so
// the dispatch loop below doesn't need to know these tools exist.

import { getAgent } from './registry.js';
import { assertUnderDailyCap, recordSpend } from '../spend.js';
import { priceUsage, emptyUsage } from '../usage.js';
import {
  resolveModelForAgent,
  MODELS,
  OPENAI_TIER,
  GEMINI_TIER,
  DEEPSEEK_TIER,
  DEFAULT_TIER,
  CHEAP_TIER,
} from './models.js';
import { recordFallback } from '../degradation.js';
import { recordContribution } from '../finance/profitShare.js';
import { skillsFor, getSkill, describeSkillsForAgent } from '../skills/registry.js';
import { mcpRequestFields, describeMcpForAgent } from './mcp.js';
import { isOpenRouterConfigured, createCompletion, openRouterFallbackModel } from './openrouter.js';
import {
  isDeepSeekConfigured,
  createCompletion as deepSeekCompletion,
  deepSeekModel,
} from './deepseek.js';
import { createCompletion as createOpenAiCompletion, isOpenAIConfigured, fallbackModel } from './openai.js';
import { createCompletion as createGeminiCompletion, isGeminiConfigured, geminiModel } from './gemini.js';

// 1024 was far too tight and produced a specific, baffling failure: the CEO
// would spend its whole budget writing four delegation requests, get cut off
// mid-tool-call, and come back with no text at all — which the loop below
// read as "nothing to say". A synthesis across several departments is a few
// thousand tokens on its own, and a truncated answer is worse than a slow
// one. Output tokens are billed as generated, so a higher ceiling costs
// nothing on the replies that don't need it.
const MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS) > 0 ? Number(process.env.AGENT_MAX_TOKENS) : 4096;
// A leaf's answer is one contribution to someone else's synthesis, not the
// reply the founder reads, and 4096 tokens of it is usually a specialist
// saying the same thing at greater length. Most of the twenty-two Executive Team agents
// are leaves, so their generation dominates the wall clock on any real
// question — this is the single biggest latency lever in the system.
//
// A cap does not force brevity, it only removes the room to ramble. Raise it
// if answers start stopping mid-sentence.
const MAX_LEAF_TOKENS = Number(process.env.AGENT_MAX_LEAF_TOKENS) > 0
  ? Number(process.env.AGENT_MAX_LEAF_TOKENS)
  : 2000;

const MAX_ROUNDS = 6; // safety cap on tool-calling rounds within one agent's turn

// How hard each kind of agent thinks. Effort is a better lever than the token
// cap above: it reduces how much a specialist reasons rather than truncating
// what it manages to write. A leaf answering a bounded question — review this
// copy, poke holes in this idea — rarely needs deep deliberation, and there
// are sixteen of them per fan-out. Orchestrators decide what the company
// does, and that is where thinking earns its cost.
const LEAF_EFFORT = (process.env.AGENT_LEAF_EFFORT || '').trim() || 'low';
const ORCHESTRATOR_EFFORT = (process.env.AGENT_ORCHESTRATOR_EFFORT || '').trim() || 'high';

// How many delegations run at once. Dispatch used to be strictly sequential,
// which made a turn's latency proportional to the number of agents consulted
// rather than to the depth of the chart — around eight minutes for a
// company of 150, which is unusable however cheap it is.
//
// Bounded rather than unlimited for two reasons that both cost money. The
// daily spend cap is checked *before* each request, so N calls launched at
// once can all pass the check before any of them records what they spent —
// the cap can be overshot by roughly the width of this limit, and no more.
// And an unbounded fan-out is also the fastest way to hit a provider's rate
// limit, which converts a wide turn into a slow one anyway.
const MAX_PARALLEL_CONSULTS = 5;

// Runs `tasks` with at most `limit` in flight, preserving result order.
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// The Anthropic SDK already retries a single request on 429/5xx/connection
// errors internally (see its own `maxRetries`, default 2). This adds one
// more attempt on top of that, specifically for a daily cycle that can burn
// through 10-20 calls in a row — a rate-limit spike that outlasts the SDK's
// own retry window is exactly the case a single unattended run needs to
// survive. It only wraps the raw API call, never a whole delegated
// conversation, so a retry here can never re-run an action tool that
// already fired in an earlier round.
const EXTRA_RETRY_DELAY_MS = 1000;

export function isRetryableError(err) {
  // Anthropic SDK APIError subclasses expose `.status`; undefined means a
  // connection-level failure (no response at all), just as transient as a
  // 429 or 5xx. Anything else (400/401/403/404/422...) won't succeed on
  // retry, so don't waste the attempt.
  const status = err?.status;
  return status === undefined || status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The system prompt, as cacheable blocks.
 *
 * Two breakpoints. The shared context gets one, the agent's own prompt the
 * second; earnings are last and uncached, because they change as the turn
 * records contributions and a breakpoint behind them would be invalidated by
 * the work it was meant to speed up.
 *
 * ## Why `cache` is a parameter rather than always on
 *
 * Caching is prefix-based, and the prefix starts before these blocks: tool
 * schemas are sent ahead of the system prompt, so a cache read requires the
 * tools to be identical too. Every agent carries a different tool set, which
 * means the shared-context block cannot be reused across agents no matter how
 * byte-identical its text is — an earlier version of this comment claimed it
 * "survives across the twenty-one agents a single question can reach" — a count
 * that was already stale when it was written — and that
 * is simply not how the mechanism works.
 *
 * What it does survive is repeated calls by the *same* agent, where tools and
 * system are unchanged. An orchestrator makes several of those per turn: one
 * round to issue its consults, another to read the results, another to
 * synthesise. Those rounds hit, and at a tenth of the input price they pay for
 * the write many times over.
 *
 * A leaf makes exactly one call per turn. It pays the write — which costs 1.25x
 * what the same tokens cost uncached — and there is no second call to read it
 * back. So for half the roster, caching was a 25% surcharge dressed as an
 * optimisation. Hence: cache for agents that loop, not for agents that don't.
 *
 * The founder can still see whether this judgement is right: cacheHitRate in
 * usage.js reports reads as a share of cached tokens, which is the number that
 * settles it rather than leaving it to reasoning like the above.
 */
export function buildSystemBlocks({ extraContext, agentPrompt, ownContext, cache = true }) {
  const blocks = [];
  const push = (text, cache) => {
    if (!text || !text.trim()) return;
    blocks.push({
      type: 'text',
      text,
      ...(cache ? { cache_control: { type: 'ephemeral' } } : {}),
    });
  };

  push(extraContext, cache);
  push(agentPrompt, cache);
  push(ownContext, false);
  return blocks;
}

/** Flattened for providers with no notion of content blocks. */
export function systemBlocksToText(system) {
  if (typeof system === 'string') return system;
  return (system || [])
    .map((block) => block.text)
    .filter(Boolean)
    .join('\n\n');
}

// Every paid call in this app funnels through here, which makes it the one
// honest place to enforce a spend ceiling: checked *before* the request (so a
// runaway delegation loop stops costing money at the cap rather than after
// someone notices), and recorded from the response's real token counts
// immediately after. See spend.js for why a per-venture action cap doesn't
// cover this.
// When Anthropic itself is the thing that's broken — the account out of
// credit, the key rejected, an outage that outlived the retry — the whole
// company goes silent at once, including a founder waiting on their phone.
// Any configured backup answers instead.
//
// The limit is honest and deliberate: every backup is a plain completion with
// no tools, exactly like the OpenRouter path, so an orchestrating agent that
// fails over cannot delegate. That's a real loss of quality, not a
// transparent swap, which is why the reply says so rather than passing off a
// single model's guess as the team's considered answer.
function isProviderOutage(err) {
  const status = err?.status;
  if (status === undefined || status === 401 || status === 403 || status === 429 || status >= 500) {
    return true;
  }
  // The exact failure that took the company down the first time it was asked
  // a real question over WhatsApp: a 400 whose body explains the account has
  // no credit. Other 400s are genuine bad requests and must keep throwing.
  return status === 400 && /credit balance|billing|quota/i.test(err?.message || '');
}

// Tried in order. Two backups rather than one because a single backup is
// still a single point of failure, and the whole point of this path is that
// the company keeps answering.
function backupProviders() {
  return [
    {
      name: 'OpenAI',
      available: isOpenAIConfigured,
      model: fallbackModel,
      send: createOpenAiCompletion,
      tier: OPENAI_TIER,
    },
    {
      name: 'Gemini',
      available: isGeminiConfigured,
      model: geminiModel,
      send: createGeminiCompletion,
      tier: GEMINI_TIER,
    },
    // Last by default only because its default model is the smallest of the
    // three. Point OPENROUTER_FALLBACK_MODEL at an Anthropic model on
    // OpenRouter and it becomes the truest substitute in the chain: the same
    // model, billed through a different account — which is the case that
    // actually took this company down.
    {
      name: 'DeepSeek',
      provider: 'deepseek',
      available: isDeepSeekConfigured,
      model: deepSeekModel,
      send: deepSeekCompletion,
      tier: DEEPSEEK_TIER,
    },
    {
      name: 'OpenRouter',
      provider: 'openrouter',
      available: isOpenRouterConfigured,
      model: openRouterFallbackModel,
      send: createCompletion,
      tier: CHEAP_TIER,
    },
  ];
}

// What running somewhere else actually cost, on the tokens that were really
// used. Negative when the substitute was cheaper than the original, which is
// why it is floored at zero — a cheaper fallback is still a degradation
// worth counting, but it is not a surcharge.
function extraCostUsd(usage, intended, actual) {
  if (!usage || !intended || !actual) return 0;
  // Priced through the same function as everything else, so the surcharge
  // counts the cached tokens too. A backup provider returns no cache fields, so
  // what it actually compares is "this many tokens there" against "the same
  // tokens here" — which is the comparison intended.
  const tokens = tokensOf(usage);
  return Math.max(0, priceUsage(tokens, actual) - priceUsage(tokens, intended));
}

async function failOverToBackup(anthropic, modelSpec, params, err) {
  if (!isProviderOutage(err)) throw err;

  // A tiered agent whose cheaper provider is refusing us. models.js already
  // collapses a tier to the default model when the key is simply absent; a
  // key that is present but rejected is the same condition discovered later,
  // so it gets the same answer instead of taking the agent down.
  //
  // This is the failure that reads to a founder as a broken "tool": the
  // specialist agents are the ones on tiers, so a single bad OpenRouter key
  // makes exactly those agents 401 while everything else keeps working.
  // Nothing is lost by the swap — tiered agents are leaves by construction,
  // and the default model is the better one.
  if (modelSpec.provider !== 'anthropic') {
    const fallback = MODELS[DEFAULT_TIER];
    console.warn(
      `${modelSpec.provider} rejected the request (${err.message}); running this agent on ${fallback.model} instead.`
    );
    try {
      const response = await anthropic.messages.create({
        ...params,
        model: fallback.model,
        thinking: { type: 'adaptive' },
      });
      response.__pricedAs = fallback;
      // The expensive silent case: this succeeds, so nothing surfaces it.
      // Costed as the difference between what ran and what was meant to, on
      // the tokens actually used, so the founder sees a number rather than
      // an adjective.
      recordFallback({
        from: modelSpec.model,
        to: fallback.model,
        reason: err.message,
        extraUsd: extraCostUsd(response.usage, modelSpec, fallback),
      });
      return response;
    } catch (anthropicErr) {
      // Both the tier's provider and the default are down. Rather than give
      // up where a plain Anthropic agent would have had two more options,
      // fall through to the same chain everything else uses.
      if (!isProviderOutage(anthropicErr)) throw anthropicErr;
      console.error(`${fallback.model} could not answer either: ${anthropicErr.message}`);
    }
  }

  const candidates = backupProviders().filter(
    // No point asking the provider that just refused us to try again.
    (provider) => provider.available() && provider.provider !== modelSpec.provider
  );
  if (!candidates.length) throw err;

  let lastError = err;
  for (const provider of candidates) {
    try {
      console.warn(`Anthropic unavailable (${err.message}); trying ${provider.name} for this call.`);
      const response = await provider.send({
        model: provider.model(),
        system: systemBlocksToText(params.system),
        messages: params.messages,
        maxTokens: params.max_tokens,
        // Forwarded, so an orchestrator failing over keeps its reports. This is
        // what retired the note that used to be prepended here — it told the
        // founder they were getting "one model working alone rather than the
        // departments weighing in", which was true when the backups could not
        // carry tools and is now simply wrong. The swap is still recorded for
        // SPEND by recordFallback below; it is a provider change, not a loss of
        // the team.
        tools: params.tools,
      });
      // Priced on the tier that actually ran, not the Anthropic one that
      // failed, so the spend cap meters what was really spent.
      response.__pricedAs = MODELS[provider.tier];
      recordFallback({
        from: modelSpec.model,
        to: provider.model(),
        reason: err.message,
        extraUsd: extraCostUsd(response.usage, modelSpec, MODELS[provider.tier]),
      });
      return response;
    } catch (backupErr) {
      console.error(`${provider.name} could not answer either: ${backupErr.message}`);
      lastError = backupErr;
    }
  }

  // Every backup failed too. The original Anthropic error is the more useful
  // one to surface — it's the provider the company is actually meant to run
  // on, and its message names something the founder can act on.
  console.error(`All backup providers failed; surfacing the original error. Last was: ${lastError.message}`);
  throw err;
}

async function createMessage(anthropic, modelSpec, params) {
  assertUnderDailyCap();

  // Both providers are called through here so neither can slip past the
  // spend cap, and the retry policy is identical because openrouter.js
  // sets the same `.status` the Anthropic SDK does.
  // Only Anthropic understands content blocks and cache_control; the others
  // take a plain string, so the same prompt is flattened for them.
  const { effort, ...rest } = params;
  const flat = {
    model: modelSpec.model,
    system: systemBlocksToText(params.system),
    messages: params.messages,
    maxTokens: params.max_tokens,
    // Tools travel to the alternative providers now. Without this line the
    // whole translation layer is unreachable and an orchestrator routed to
    // DeepSeek or Gemini would answer without ever delegating — the exact
    // silent failure canUseAlternativeModel used to prevent by refusing to
    // route it at all.
    tools: params.tools,
  };

  // Table-driven rather than a chain of ifs, because the chain had no branch
  // for DeepSeek: the tier existed, resolveModelForAgent returned it, and every
  // call it resolved fell through to Anthropic instead. Silently — the agent
  // answered, on the wrong model, at 7x the price, and nothing reported it.
  // That is the third capability in this codebase found sitting behind a door
  // nothing opened, so this is a lookup that fails loudly on an unknown
  // provider instead of a fallthrough that picks one.
  const alternatives = {
    openrouter: createCompletion,
    openai: createOpenAiCompletion,
    gemini: createGeminiCompletion,
    deepseek: deepSeekCompletion,
  };

  const send = () => {
    if (modelSpec.provider !== 'anthropic') {
      const client = alternatives[modelSpec.provider];
      if (!client) {
        throw new Error(
          `No client for provider "${modelSpec.provider}" — it is in models.js but not wired into agentRunner.`
        );
      }
      return client(flat);
    }
    // MCP requires the beta endpoint and its flag; everything else uses the
    // stable one, so a company with no MCP servers is unaffected by it.
    const endpoint = rest.betas?.length ? anthropic.beta.messages : anthropic.messages;
    return endpoint.create({
      ...rest,
      model: modelSpec.model,
      // Adaptive thinking with a per-role effort level. A leaf answering a
      // bounded question does not need to deliberate; an orchestrator
      // deciding what the company does is where thinking earns its cost.
      thinking: { type: 'adaptive' },
      ...(effort ? { output_config: { effort } } : {}),
    });
  };

  let response;
  try {
    response = await send();
  } catch (err) {
    if (isRetryableError(err)) {
      await sleep(EXTRA_RETRY_DELAY_MS + Math.random() * 250);
      try {
        response = await send();
      } catch (retryErr) {
        response = await failOverToBackup(anthropic, modelSpec, params, retryErr);
      }
    } else {
      response = await failOverToBackup(anthropic, modelSpec, params, err);
    }
  }

  if (response?.usage) {
    const tokens = tokensOf(response.usage);
    response.costUsd = priceUsage(tokens, response.__pricedAs || modelSpec);
    recordSpend(response.costUsd, tokens);
  }
  return response;
}

/**
 * The four token counts a response was billed for, in this app's own names.
 *
 * Read in one place because it was previously read in three and two of them
 * only took `input_tokens` — which, with prompt caching on, is the *uncached*
 * input alone. Everything in the cached prefix (tool schemas, shared context,
 * each agent's system prompt) arrives in the two cache fields, so the spend cap
 * and every reported cost were metering a small fraction of the real bill and
 * the cap could never fire. A helper makes that a single thing to get right
 * rather than three places to forget.
 *
 * The other providers return no cache fields at all, so these read as 0 and
 * price exactly as they did before.
 */
function tokensOf(usage) {
  return {
    inputTokens: usage?.input_tokens || 0,
    outputTokens: usage?.output_tokens || 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens || 0,
    cacheReadTokens: usage?.cache_read_input_tokens || 0,
  };
}

// Accumulates one response's billed tokens onto a run's usage total.
function addUsage(usage, response) {
  if (!response?.usage) return;
  const t = tokensOf(response.usage);
  usage.inputTokens += t.inputTokens;
  usage.outputTokens += t.outputTokens;
  usage.cacheWriteTokens = (usage.cacheWriteTokens || 0) + t.cacheWriteTokens;
  usage.cacheReadTokens = (usage.cacheReadTokens || 0) + t.cacheReadTokens;
  usage.costUsd = (usage.costUsd || 0) + (response.costUsd || 0);
}

function buildTools(agents, agent) {
  const delegationTools = agent.reports.map((reportId) => {
    const report = getAgent(agents, reportId);
    return {
      name: `consult_${report.id}`,
      description: report.toolDescription,
      input_schema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              "A clear, self-contained brief for this specialist. They do not see the rest of this conversation, so include all context they'd need.",
          },
        },
        required: ['task'],
      },
    };
  });

  const actionTools = (agent.actions || []).map((action) => ({
    name: action.name,
    description: action.description,
    input_schema: action.input_schema,
  }));

  const serverTools = agent.serverTools || [];

  // Added here rather than per agent, so adding a skill file is the whole
  // job — no roster edit, no wiring, no chance of a skill existing that
  // nobody can reach.
  const skillTools = skillsFor(agent.id).length
    ? [
        {
          name: 'load_skill',
          description:
            'Load a procedure by name before doing that kind of work. The list of what is available to you, with one line on each, is in your context. Load the one that fits rather than working from memory — these exist because the details matter and are easy to get subtly wrong.',
          input_schema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The skill name, exactly as listed.' },
            },
            required: ['name'],
          },
        },
      ]
    : [];

  // MCP toolsets are tools like any other from the model's side; the
  // connection half travels separately on the request (see mcp.js).
  const { mcpTools = [] } = mcpRequestFields(agent);

  return [...delegationTools, ...actionTools, ...skillTools, ...mcpTools, ...serverTools];
}

/**
 * Runs a single agent (and, transitively, any reports it delegates to) to
 * produce a final text answer.
 *
 * @param {object} opts
 * @param {import('@anthropic-ai/sdk').default} opts.anthropic
 * @param {Record<string, object>} opts.agents - the org chart / team this agent belongs to
 * @param {string} opts.agentId
 * @param {Array<{role: string, content: any}>} opts.messages
 * @param {Array<object>} [opts.trace] - shared array collecting every agent consulted
 * @param {number} [opts.depth]
 * @param {Record<string, (input: object, ctx: {agentId: string}) => Promise<string>>} [opts.actionHandlers]
 * @param {string} [opts.extraContext] - extra text appended to every agent's system prompt for this run
 * @param {(agentId: string) => string} [opts.perAgentContext] - extra text specific to each agent, resolved per delegation (e.g. what that agent has personally earned). Kept as a callback so this runner stays ignorant of finance.
 * @param {{inputTokens: number, outputTokens: number, costUsd: number}} [opts.usage] - shared accumulator, mutated across the whole run (including every delegated sub-agent)
 * @returns {Promise<{text: string, trace: object[], usage: {inputTokens: number, outputTokens: number, costUsd: number}}>}
 */
export async function runAgent({
  anthropic,
  agents,
  agentId,
  messages,
  trace = [],
  depth = 0,
  actionHandlers = {},
  extraContext = '',
  perAgentContext = null,
  usage = emptyUsage(),
  // A wall-clock moment after which this turn stops widening. Not a hard
  // abort: work already in flight finishes, and the agent is then asked to
  // answer with what it has. Cutting an agent off mid-thought produces
  // nothing useful, while stopping it from consulting three more people
  // produces a shorter answer to the same question.
  deadlineAt = null,
}) {
  const agent = getAgent(agents, agentId);
  const tools = buildTools(agents, agent);
  // Resolved per agent, not per run: a fan-out can legitimately mix a
  // frontier orchestrator with cheap leaves in the same conversation.
  const modelSpec = resolveModelForAgent(agent, isOpenRouterConfigured());
  // Resolved per agent rather than per run: a delegated specialist gets its
  // own line here, not the CEO's.
  const startedAt = Date.now();
  // Leaves are the ones with no reports and no tools to call — the same
  // condition models.js already uses to decide what may run on a cheap tier.
  const isLeaf = (agent.reports || []).length === 0 && (agent.actions || []).length === 0;
  const tokenBudget = isLeaf ? Math.min(MAX_LEAF_TOKENS, MAX_TOKENS) : MAX_TOKENS;

  const ownContext = perAgentContext ? perAgentContext(agent.id) : '';
  // Ordered for the cache, not for reading.
  //
  // Caching is a prefix match, so what goes first decides what can be reused.
  // The shared business context is byte-identical across every agent in a
  // turn, and one question can fan out to twenty-one of them — putting it
  // first means twenty cache hits instead of twenty full re-reads. The
  // agent's own prompt comes next: frozen per agent, so it caches across
  // turns for whoever is asked repeatedly. Earnings go last, uncached,
  // because they change as the turn itself records contributions and would
  // otherwise invalidate everything behind them.
  //
  // Reading "here is the company, here is who you are in it" is also the
  // more natural order, which is luck rather than design.
  // Appended to the agent's own prompt rather than sent separately: it is
  // as stable as the prompt is, so it belongs behind the same cache
  // breakpoint instead of adding a third block that invalidates nothing.
  const skillMenu = describeSkillsForAgent(agent.id);
  const mcpNote = describeMcpForAgent(agent);
  const system = buildSystemBlocks({
    extraContext,
    agentPrompt: [agent.systemPrompt, skillMenu, mcpNote].filter(Boolean).join('\n\n'),
    ownContext,
    // A leaf's single call cannot read back what it writes. See
    // buildSystemBlocks for why that made caching a surcharge rather than a
    // saving on every agent in the bottom half of the chart.
    cache: !isLeaf,
  });

  // The connection half of MCP, minus the toolsets already folded into
  // `tools` above. Empty for an agent with no servers, so its request stays
  // byte-identical and nothing caches differently.
  const { mcpTools: _ignored, ...mcpFields } = mcpRequestFields(agent);

  const working = [...messages];

  let finalText = '';
  // True when the turn ran out of time and finished early. Carried up so the
  // caller can offer the deeper version rather than passing off a rushed
  // answer as the considered one.
  let ranOutOfTime = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Checked between rounds rather than mid-call: a round already underway
    // is cheaper to finish than to abandon, and its result is already paid
    // for. Round 0 always runs — a deadline that produces no answer at all
    // is worse than a late one.
    if (deadlineAt && round > 0 && Date.now() > deadlineAt) {
      ranOutOfTime = true;
      break;
    }

    const response = await createMessage(anthropic, modelSpec, {
      max_tokens: tokenBudget,
      system,
      messages: working,
      effort: isLeaf ? LEAF_EFFORT : ORCHESTRATOR_EFFORT,
      ...mcpFields,
      ...(tools.length ? { tools } : {}),
    });

    addUsage(usage, response);

    const toolUses = response.content.filter((block) => block.type === 'tool_use');

    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      finalText = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      break;
    }

    working.push({ role: 'assistant', content: response.content });

    // Consultations run concurrently; actions never do. An action tool has a
    // real side effect governed by per-venture daily caps and a cooldown
    // (see finance/ventures.js), and every one of those checks reads the log
    // that the previous action writes. Running two at once lets both read
    // the same pre-action state and slip past a cap that should have stopped
    // the second — so actions stay strictly in order, in the order the model
    // asked for them.
    const consults = toolUses.filter((t) => t.name.startsWith('consult_'));
    const others = toolUses.filter((t) => !t.name.startsWith('consult_'));

    const consultResults = await mapWithLimit(consults, MAX_PARALLEL_CONSULTS, async (toolUse) => {
      const reportId = toolUse.name.slice('consult_'.length);
      try {
        const report = getAgent(agents, reportId);
        const brief = typeof toolUse.input?.task === 'string' ? toolUse.input.task : '';
        const sub = await runAgent({
          anthropic,
          agents,
          agentId: reportId,
          messages: [{ role: 'user', content: brief }],
          trace,
          depth: depth + 1,
          actionHandlers,
          extraContext,
          perAgentContext,
          usage,
          // The whole tree shares one deadline. A specialist that starts a
          // fan-out of its own with two seconds left is how a turn that was
          // supposed to take two minutes takes six.
          deadlineAt,
        });
        const resultText = sub.text;
        trace.push({
          id: report.id,
          title: report.title,
          department: report.department,
          depth: depth + 1,
          // Without this, "the team is slow" is unanswerable: 22 agents can
          // be consulted in one turn and any of them could be the reason.
          ms: sub.durationMs ?? null,
        });
        // Credit the specialist for answering — but only if it actually said
        // something. A consult that errored or came back empty is not work,
        // and the catch below means a failed one never reaches here.
        if (resultText && resultText.trim()) {
          recordContribution({ agentId: report.id, kind: 'consulted', detail: `consulted by ${agent.id}` });
        }
        return { tool_use_id: toolUse.id, resultText };
      } catch (err) {
        return { tool_use_id: toolUse.id, resultText: `(Could not reach ${toolUse.name}: ${err.message})` };
      }
    });

    const toolResults = consultResults.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.tool_use_id,
      content: r.resultText,
    }));

    for (const toolUse of others) {
      let resultText;
      if (toolUse.name === 'load_skill') {
        // Handled here rather than through actionHandlers: it reads a file
        // and has no side effect, so there is nothing for a scope to govern
        // and no reason for every caller to wire it up.
        const skill = getSkill(agent.id, toolUse.input?.name);
        resultText = skill
          ? skill.body
          : `No skill called "${toolUse.input?.name}" is available to you. Work from what you know rather than guessing at another name.`;
      } else if (actionHandlers[toolUse.name]) {
        const actionStarted = Date.now();
        let ok = true;
        try {
          // The acting agent is passed alongside the input so a handler can
          // attribute what just happened (see finance/profitShare.js). It's
          // the runner that knows this, not the agent — which is precisely
          // why credit can't be self-reported.
          resultText = await actionHandlers[toolUse.name](toolUse.input || {}, { agentId: agent.id });
          // A handler that refuses returns text rather than throwing, so the
          // trace reads the reply the way the agent does.
          ok = !/^(Could not|Not started|Nothing to check)/.test(String(resultText || ''));
        } catch (err) {
          resultText = `(Action ${toolUse.name} failed: ${err.message})`;
          ok = false;
        }
        // Recorded beside the delegations, so "why did the team do that" has an
        // answer after the fact. `title` because the report views render trace
        // entries by title; no `id` so the graph's activity map, which counts
        // agents consulted, ignores it.
        trace.push({
          kind: 'action',
          title: `${ok ? '⚙' : '⚠'} ${toolUse.name}`,
          agentId: agent.id,
          tool: toolUse.name,
          ok,
          depth,
          ms: Date.now() - actionStarted,
        });
      } else {
        resultText = `(Unknown tool: ${toolUse.name})`;
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: resultText });
    }
    working.push({ role: 'user', content: toolResults });
  }

  // Reaching here with nothing to say means the turn ended without a written
  // answer — the round budget ran out mid-delegation, or a response spent its
  // whole token budget on tool calls. The agent has usually done the work by
  // this point and simply never got to write it up, so asking once more with
  // the tools removed turns "I can't" into the answer it already had.
  if (!finalText) {
    try {
      const closing = await createMessage(anthropic, modelSpec, {
        max_tokens: tokenBudget,
        system,
        messages: [
          ...working,
          {
            role: 'user',
            content:
              'Answer now, in full, using what you already have. Do not consult anyone else — ' +
              'summarise what you have gathered and give your recommendation.',
          },
        ],
      });
      addUsage(usage, closing);
      finalText = (closing.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    } catch (err) {
      // Falls through to the message below, which is more useful than the
      // raw error for someone reading this on their phone.
      console.error(`Agent ${agent.id} could not close out its turn:`, err.message);
    }
  }

  if (!finalText) {
    finalText =
      "I ran out of room working through that one. Ask me for a smaller piece of it " +
      'and I can answer properly.';
  }

  return { text: finalText, trace, usage, ranOutOfTime, durationMs: Date.now() - startedAt };
}
