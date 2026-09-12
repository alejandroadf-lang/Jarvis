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
import { resolveModelForAgent, MODELS, OPENAI_TIER, GEMINI_TIER, DEFAULT_TIER, CHEAP_TIER } from './models.js';
import { recordContribution } from '../finance/profitShare.js';
import { isOpenRouterConfigured, createCompletion, openRouterFallbackModel } from './openrouter.js';
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
// saying the same thing at greater length. Sixteen of the twenty-one agents
// are leaves, so their generation dominates the wall clock on any real
// question — this is the single biggest latency lever in the system.
//
// A cap does not force brevity, it only removes the room to ramble. Raise it
// if answers start stopping mid-sentence.
const MAX_LEAF_TOKENS = Number(process.env.AGENT_MAX_LEAF_TOKENS) > 0
  ? Number(process.env.AGENT_MAX_LEAF_TOKENS)
  : 2000;

const MAX_ROUNDS = 6; // safety cap on tool-calling rounds within one agent's turn

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
      name: 'OpenRouter',
      provider: 'openrouter',
      available: isOpenRouterConfigured,
      model: openRouterFallbackModel,
      send: createCompletion,
      tier: CHEAP_TIER,
    },
  ];
}

const DEGRADED_NOTE =
  '(Answering without the team — the usual model is unavailable, so this is one ' +
  'model working alone rather than the departments weighing in.)\n\n';

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
      const response = await anthropic.messages.create({ ...params, model: fallback.model });
      response.__pricedAs = fallback;
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
        system: params.system,
        messages: params.messages,
        maxTokens: params.max_tokens,
      });

      // Only orchestrators lose something by coming through here. A leaf
      // agent's turn is a single completion either way, so labelling it
      // would be noise.
      if (params.tools?.length) {
        const first = response.content.find((block) => block.type === 'text');
        if (first) first.text = DEGRADED_NOTE + first.text;
      }
      // Priced on the tier that actually ran, not the Anthropic one that
      // failed, so the spend cap meters what was really spent.
      response.__pricedAs = MODELS[provider.tier];
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
  const send = () => {
    if (modelSpec.provider === 'openrouter') {
      return createCompletion({
        model: modelSpec.model,
        system: params.system,
        messages: params.messages,
        maxTokens: params.max_tokens,
      });
    }
    if (modelSpec.provider === 'openai') {
      return createOpenAiCompletion({
        model: modelSpec.model,
        system: params.system,
        messages: params.messages,
        maxTokens: params.max_tokens,
      });
    }
    if (modelSpec.provider === 'gemini') {
      return createGeminiCompletion({
        model: modelSpec.model,
        system: params.system,
        messages: params.messages,
        maxTokens: params.max_tokens,
      });
    }
    return anthropic.messages.create({ ...params, model: modelSpec.model });
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
    response.costUsd = priceUsage(
      {
        inputTokens: response.usage.input_tokens || 0,
        outputTokens: response.usage.output_tokens || 0,
      },
      response.__pricedAs || modelSpec
    );
    recordSpend(response.costUsd);
  }
  return response;
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

  return [...delegationTools, ...actionTools, ...serverTools];
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
  const system = [agent.systemPrompt, extraContext, ownContext].filter((part) => part && part.trim()).join('\n\n');
  const working = [...messages];

  let finalText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await createMessage(anthropic, modelSpec, {
      max_tokens: tokenBudget,
      system,
      messages: working,
      ...(tools.length ? { tools } : {}),
    });

    if (response.usage) {
      usage.inputTokens += response.usage.input_tokens || 0;
      usage.outputTokens += response.usage.output_tokens || 0;
      usage.costUsd = (usage.costUsd || 0) + (response.costUsd || 0);
    }

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
        });
        const resultText = sub.text;
        trace.push({
          id: report.id,
          title: report.title,
          department: report.department,
          depth: depth + 1,
          // Without this, "the team is slow" is unanswerable: 21 agents can
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
      if (actionHandlers[toolUse.name]) {
        try {
          // The acting agent is passed alongside the input so a handler can
          // attribute what just happened (see finance/profitShare.js). It's
          // the runner that knows this, not the agent — which is precisely
          // why credit can't be self-reported.
          resultText = await actionHandlers[toolUse.name](toolUse.input || {}, { agentId: agent.id });
        } catch (err) {
          resultText = `(Action ${toolUse.name} failed: ${err.message})`;
        }
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
      if (closing.usage) {
        usage.inputTokens += closing.usage.input_tokens || 0;
        usage.outputTokens += closing.usage.output_tokens || 0;
        usage.costUsd = (usage.costUsd || 0) + (closing.costUsd || 0);
      }
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

  return { text: finalText, trace, usage, durationMs: Date.now() - startedAt };
}
