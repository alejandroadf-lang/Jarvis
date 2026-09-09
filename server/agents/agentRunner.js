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

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const MAX_ROUNDS = 6; // safety cap on tool-calling rounds within one agent's turn

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
 * @param {Record<string, (input: object) => Promise<string>>} [opts.actionHandlers]
 * @param {string} [opts.extraContext] - extra text appended to every agent's system prompt for this run
 * @returns {Promise<{text: string, trace: object[]}>}
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
}) {
  const agent = getAgent(agents, agentId);
  const tools = buildTools(agents, agent);
  const system = extraContext ? `${agent.systemPrompt}\n\n${extraContext}` : agent.systemPrompt;
  const working = [...messages];

  let finalText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: working,
      ...(tools.length ? { tools } : {}),
    });

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

    const toolResults = [];
    for (const toolUse of toolUses) {
      let resultText;
      if (toolUse.name.startsWith('consult_')) {
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
          });
          resultText = sub.text;
          trace.push({ id: report.id, title: report.title, department: report.department, depth: depth + 1 });
        } catch (err) {
          resultText = `(Could not reach ${toolUse.name}: ${err.message})`;
        }
      } else if (actionHandlers[toolUse.name]) {
        try {
          resultText = await actionHandlers[toolUse.name](toolUse.input || {});
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

  if (!finalText) {
    finalText = "I wasn't able to land on a final answer — could you narrow the ask?";
  }

  return { text: finalText, trace };
}
