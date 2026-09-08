// Orchestrator-workers engine for "The Company" org chart (see orgChart.js).
//
// Each agent that has direct reports is run through a Claude tool-use loop
// where every report is exposed as a callable tool named `consult_<id>`.
// When the agent calls one of those tools, we recursively run that report as
// its own (possibly further-delegating) agent, feed its answer back as a
// tool_result, and let the manager keep going until it produces a final
// text answer. This mirrors Anthropic's orchestrator-workers workflow and
// the Claude Agent SDK's subagent model, just applied to a company org
// chart instead of a coding task.

import { getAgent } from './orgChart.js';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const MAX_ROUNDS = 6; // safety cap on tool-calling rounds within one agent's turn

function buildTools(agent) {
  return agent.reports.map((reportId) => {
    const report = getAgent(reportId);
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
}

/**
 * Runs a single agent (and, transitively, any reports it delegates to) to
 * produce a final text answer.
 *
 * @param {object} opts
 * @param {import('@anthropic-ai/sdk').default} opts.anthropic
 * @param {string} opts.agentId
 * @param {Array<{role: string, content: any}>} opts.messages
 * @param {Array<object>} [opts.trace] - shared array collecting every agent consulted
 * @param {number} [opts.depth]
 * @returns {Promise<{text: string, trace: object[]}>}
 */
export async function runAgent({ anthropic, agentId, messages, trace = [], depth = 0 }) {
  const agent = getAgent(agentId);
  const tools = buildTools(agent);
  const working = [...messages];

  let finalText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: agent.systemPrompt,
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
      const reportId = toolUse.name.replace(/^consult_/, '');
      let resultText;
      try {
        const report = getAgent(reportId);
        const brief = typeof toolUse.input?.task === 'string' ? toolUse.input.task : '';
        const sub = await runAgent({
          anthropic,
          agentId: reportId,
          messages: [{ role: 'user', content: brief }],
          trace,
          depth: depth + 1,
        });
        resultText = sub.text;
        trace.push({ id: report.id, title: report.title, department: report.department, depth: depth + 1 });
      } catch (err) {
        resultText = `(Could not reach ${reportId}: ${err.message})`;
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
