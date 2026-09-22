// The help desk, answering a WhatsApp message.
//
// On the Talk tab and the phone bridge the desk is a realtime speech model;
// here it is one ordinary agent turn, because a WhatsApp voice note is a
// message and not a call. Same brief, same two tools, same knowledge base —
// only the transport differs, which is the point: a customer should get the
// same procedure whichever way they reached the desk.
//
// It runs through runAgent rather than a bare completion for one reason that
// this repo learned the expensive way: runAgent offers the model only the
// tools in `agent.actions`, and a handler with no tool behind it is a door
// that never opens (the pitch that was never presented). So the desk is a
// real agent object with the tools in its action list, and the tests assert
// on what the runner is handed rather than on what the handlers would do.
//
// What is deliberately absent: the org chart, the company context, the
// founder's steering, ask_the_team. This agent has no reports and sees no
// state. What the prompt never contained cannot be leaked from it.

import { runAgent } from '../agents/agentRunner.js';
import { buildSupportInstructions, supportDeskName, LOOKUP_ISSUE, OPEN_TICKET, runSupportTool } from '../realtime/supportDesk.js';
import { replyLanguageInstruction } from '../language.js';
import { spokenReplyInstruction } from '../speech.js';

export const DESK_AGENT_ID = 'travel_desk';

// The desk's tools are declared once, in the realtime shape (`parameters`).
// runAgent's action tools use the Anthropic shape (`input_schema`). Same
// schema, different key — translated here rather than declared twice, so
// the two transports cannot drift apart on what a tool accepts.
function toAction(tool) {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/** The desk as an agent the runner can drive. One voice, two tools, nobody to delegate to. */
export function deskAgent() {
  return {
    id: DESK_AGENT_ID,
    title: supportDeskName(),
    department: 'Support',
    mission: 'Resolve a customer\'s problem from the procedures on record, or log it for a person.',
    reports: [],
    actions: [toAction(LOOKUP_ISSUE), toAction(OPEN_TICKET)],
    systemPrompt: buildSupportInstructions(),
  };
}

/**
 * One turn of a help-desk conversation.
 *
 * @param {object} opts
 * @param {object} opts.anthropic
 * @param {string} opts.from        the caller's number, recorded on any ticket
 * @param {string} opts.text        what they said, already transcribed if spoken
 * @param {Array}  [opts.history]   this caller's earlier turns, not mutated
 * @param {string} [opts.spokenIn]  the language Whisper heard, if a voice note
 * @param {boolean} [opts.arrivedAsVoice]
 * @param {number} [opts.deadlineAt]
 * @param {Function} [opts.runAgentImpl] injected for tests
 * @returns {Promise<{reply: string, trace: object[]}>}
 */
export async function runDeskTurn({
  anthropic,
  from,
  text,
  history = [],
  spokenIn = '',
  arrivedAsVoice = false,
  deadlineAt = null,
  runAgentImpl = runAgent,
}) {
  const agent = deskAgent();
  const messages = [...history, { role: 'user', content: text }];

  const { text: reply, trace } = await runAgentImpl({
    anthropic,
    agents: { [DESK_AGENT_ID]: agent },
    agentId: DESK_AGENT_ID,
    messages,
    deadlineAt,
    // The two things a WhatsApp turn knows that the brief does not: which
    // language to answer in, and that the answer is read aloud — so the
    // conclusion goes first, because only the top of it is spoken.
    extraContext: [replyLanguageInstruction({ detected: spokenIn }), spokenReplyInstruction({ arrivedAsVoice })]
      .filter(Boolean)
      .join('\n\n'),
    actionHandlers: {
      lookup_issue: (input) => runSupportTool('lookup_issue', input, { from }),
      // The caller's number and language ride along so the ticket carries
      // them even when the model forgot to ask.
      open_ticket: (input) => runSupportTool('open_ticket', { language: spokenIn, ...input }, { from }),
    },
  });

  return {
    // A turn that ended in tool calls and no words is asked once more by
    // runAgent; if it still says nothing, say so rather than invent a line.
    reply: (reply || '').trim() || 'Sorry — I lost the thread there. Could you say that again?',
    trace,
  };
}
