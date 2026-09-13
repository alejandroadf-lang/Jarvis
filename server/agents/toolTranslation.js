// Translating tool use between the Anthropic shape this app speaks and the
// OpenAI shape every other provider speaks.
//
// ## Why this exists
//
// Ten of the twenty-two agents were locked to Anthropic — not because they
// needed Claude, but because the other clients were plain completion calls with
// no tool loop, and an orchestrator without tools cannot delegate. So
// canUseAlternativeModel refused any agent with reports or actions, which is
// every manager in the chart. The result: the entire C-suite ran on the most
// expensive model available, and the company's bill was Anthropic-shaped by
// accident of plumbing rather than by choice.
//
// The loop in agentRunner does not need to know about any of this. It reads
// Anthropic-shaped content blocks and writes Anthropic-shaped messages. So the
// translation happens at the edge, in both directions, and everything between
// stays one code path. That is the whole design: one loop, four providers.
//
// ## What is deliberately not handled
//
// Anthropic's *server* tools — web_search in particular — have no equivalent
// here. They execute inside Anthropic's infrastructure, so there is nothing to
// translate: an agent that searches the web has to run on Anthropic. The gate
// in models.js still enforces that, and it is the only thing it enforces now.

/**
 * Anthropic tool definitions to OpenAI function definitions.
 *
 * The shapes are close enough to be deceptive: `input_schema` becomes
 * `parameters`, and the whole thing nests under a `function` key. A tool with
 * no schema still needs an empty object parameters — several providers reject a
 * function declaration without one, which shows up as a 400 naming a field the
 * caller never set.
 */
export function toOpenAiTools(tools) {
  return (tools || [])
    // Server tools have a `type` and no schema of ours; they cannot cross over,
    // and sending one would be a 400 rather than a silent degradation.
    .filter((tool) => tool?.name && !tool.type)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    }));
}

/**
 * Anthropic messages to OpenAI messages.
 *
 * Three conversions, and the second is the one that bites:
 *
 *  - A plain string content passes through.
 *  - An assistant message's `tool_use` blocks become a `tool_calls` array, with
 *    the input re-serialised to the JSON *string* OpenAI expects. Anthropic
 *    carries it as an object.
 *  - A user message's `tool_result` blocks become **separate** messages with
 *    role "tool". This is the structural difference: Anthropic puts every
 *    result for a round inside one user message, OpenAI wants one message per
 *    result, each naming its `tool_call_id`. One message in can therefore be
 *    three messages out, and getting this wrong produces a provider error about
 *    an unanswered tool call rather than anything that points here.
 */
export function toOpenAiMessages(messages, system) {
  const out = system ? [{ role: 'system', content: system }] : [];

  for (const message of messages || []) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = message.content || [];
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (toolResults.length) {
      // Any text alongside results is kept as its own user message, before
      // them, rather than dropped.
      if (text) out.push({ role: 'user', content: text });
      for (const result of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: flattenResultContent(result.content),
        });
      }
      continue;
    }

    if (toolUses.length) {
      out.push({
        role: 'assistant',
        // Null rather than an empty string: some providers reject "" on a
        // message that carries tool_calls.
        content: text || null,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          type: 'function',
          function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
        })),
      });
      continue;
    }

    out.push({ role: message.role, content: text });
  }

  return out;
}

// A tool_result's content is a string in this app, but the Anthropic shape
// allows blocks. Flatten rather than send an object the OpenAI schema rejects.
function flattenResultContent(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * An OpenAI response to the Anthropic shape agentRunner reads.
 *
 * `stop_reason` is what the loop branches on, so the mapping matters more than
 * it looks: "tool_calls" must become "tool_use" or the loop treats a delegation
 * request as a final answer and the manager's reply is an empty string.
 *
 * ## Malformed arguments
 *
 * `arguments` arrives as a JSON string the model generated, and a weaker model
 * sometimes generates one that does not parse. Neither obvious handling is
 * acceptable: throwing kills the whole turn over one recoverable mistake, and
 * defaulting to `{}` silently invokes a real tool with no arguments — a
 * `consult_cto` with no question, or worse an action with a missing target.
 *
 * So a parse failure produces a tool_use carrying `parseError`, and the runner
 * answers it with a tool_result saying so. The model then gets to correct itself
 * inside the same turn, which is exactly how an unknown tool name is already
 * handled, and nothing silently runs on guessed input.
 */
export function fromOpenAiResponse(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message || {};
  const content = [];

  if (message.content) content.push({ type: 'text', text: String(message.content) });

  for (const call of message.tool_calls || []) {
    const raw = call?.function?.arguments;
    const parsed = parseArguments(raw);
    content.push({
      type: 'tool_use',
      id: call.id || `call_${content.length}`,
      name: call?.function?.name || '',
      input: parsed.ok ? parsed.value : {},
      ...(parsed.ok ? {} : { parseError: parsed.error, rawArguments: String(raw ?? '') }),
    });
  }

  // A response with neither text nor tool calls still needs a text block: the
  // loop joins text blocks to produce its answer, and an empty content array
  // reads as a successful turn that said nothing.
  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    stop_reason: stopReasonFor(choice?.finish_reason, message.tool_calls),
    content,
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
  };
}

function parseArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: {} };
  if (typeof raw === 'object') return { ok: true, value: raw };
  try {
    const value = JSON.parse(raw);
    // A JSON scalar parses fine and is not a tool input. Treated as malformed
    // so it takes the self-correcting path rather than reaching a handler that
    // expects to read fields off an object.
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'tool arguments must be a JSON object' };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function stopReasonFor(finishReason, toolCalls) {
  // The presence of tool calls wins over the finish reason. Some providers
  // report "stop" alongside tool_calls, and believing them would drop the
  // delegation on the floor.
  if (toolCalls?.length) return 'tool_use';
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}
