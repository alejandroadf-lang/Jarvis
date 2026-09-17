// A reply should wake the team, not wait for morning.
//
// The daily cycle runs once. A prospect who answers at 09:00 sat unread until
// 08:00 the next day, and a same-day reply is most of what closes a first
// deal. This polls the mailbox on a short interval and, when a known contact
// writes, runs one narrow Sales turn — the Sales Manager alone, with only the
// tools a reply needs, on a short deadline.
//
// Narrow on purpose. A reply is not a reason to convene the executive team;
// it is a reason for one person to answer one email. The full roster is what
// the morning is for.
//
// Off unless the mailbox is configured. INBOX_POLL_MINUTES=0 disables it
// explicitly; the default is fifteen minutes, which is faster than any human
// sales team and slow enough that a quiet mailbox costs nothing.

import { fetchReplies, isInboxConfigured } from './inbox.js';
import {
  outreachRecipients,
  ventureForRecipient,
  recordReply,
  blockContact,
  markRepliesRead,
  recordVentureNote,
} from './finance/ventures.js';
import { isUnsubscribe } from './outreachCompliance.js';
import { runAgent } from './agents/agentRunner.js';
import { AGENTS as COMPANY_AGENTS } from './agents/orgChart.js';
import { buildCompanyContext } from './finance/context.js';
import { buildPerAgentContext } from './finance/context.js';
import {
  handleCheckReplies,
  handleLogContactNote,
  handleUpdatePipeline,
  handleCreatePaymentLink,
  handleSendCustomerEmail,
  handleCheckReady,
} from './actionHandlers.js';
import { getKillSwitch } from './killSwitch.js';

const SALES = 'sales_commercial_manager';
const TURN_DEADLINE_MS = 4 * 60 * 1000;

let running = false;

export function pollMinutes() {
  const raw = process.env.INBOX_POLL_MINUTES;
  if (raw === undefined || raw === '') return 15;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isInboxWatchRunning() {
  return running;
}

// The Sales Manager alone. soloRoster in dailyMeeting.js does the same to the
// CEO for a quiet morning; here the agent has no reports anyway, so the roster
// is the whole company and the runner simply never fans out.
function salesHandlers() {
  return {
    check_replies: (input, ctx) => handleCheckReplies(input, 'inbox', ctx),
    log_contact_note: handleLogContactNote,
    update_pipeline: (input, ctx) => handleUpdatePipeline(input, ctx),
    create_payment_link: (input, ctx) => handleCreatePaymentLink(input, ctx),
    send_customer_email: (input) => handleSendCustomerEmail(input, 'inbox'),
    check_ready: (input) => handleCheckReady(input),
  };
}

/**
 * One pass: read the mailbox, file what is new, and for each new reply from a
 * known contact run a Sales turn. Returns what it did, for tests and logs.
 *
 * The two collaborators are injectable because ES module bindings cannot be
 * stubbed from a test, and a watcher that can only be tested against a live
 * mailbox and a billed model is a watcher that never gets tested.
 */
export async function pollInboxOnce({ anthropic, fetchRepliesImpl = fetchReplies, runAgentImpl = runAgent } = {}) {
  if (!isInboxConfigured()) return { skipped: 'inbox not configured' };
  if (getKillSwitch().halted) return { skipped: 'halted' };
  if (running) return { skipped: 'already running' };
  running = true;
  const handled = [];
  try {
    const known = outreachRecipients();
    if (!known.size) return { skipped: 'nobody to hear from' };
    const { messages } = await fetchRepliesImpl({ isKnownSender: (a) => known.has(a) });

    for (const message of messages) {
      const venture = ventureForRecipient(message.from);
      if (!venture) continue;
      const { entry, duplicate } = recordReply(venture.id, message);
      if (duplicate || !entry) continue;

      if (isUnsubscribe(entry.body)) {
        blockContact(venture.id, message.from, 'unsubscribed by reply');
        markRepliesRead(venture.id, [entry.messageId]);
        handled.push({ from: message.from, action: 'blocked' });
        continue;
      }

      const kickoff =
        `A reply just arrived from ${message.fromName ? `${message.fromName} <${message.from}>` : message.from} ` +
        `on venture ${venture.id} ("${venture.title}"). Call check_replies to read it, then act on it in this turn: ` +
        'update the pipeline, log what you learned, and answer them if an answer is warranted — with a payment link if they said yes ' +
        'or asked the price, with the booking link if they want to talk. If nothing needs sending, say why in one line.';

      let text = '';
      try {
        const result = await runAgentImpl({
          anthropic,
          agents: COMPANY_AGENTS,
          agentId: SALES,
          messages: [{ role: 'user', content: kickoff }],
          actionHandlers: salesHandlers(),
          extraContext: buildCompanyContext(),
          perAgentContext: buildPerAgentContext,
          deadlineAt: Date.now() + TURN_DEADLINE_MS,
        });
        text = result.text || '';
      } catch (err) {
        text = `(Sales turn failed: ${err.message})`;
      }
      // Kept on the venture so the morning sync sees what happened overnight,
      // in the same place it looks for everything else it did not witness.
      recordVentureNote(venture.id, {
        agentId: SALES,
        note: `Reply from ${message.from} handled between cycles: ${text.slice(0, 400).replace(/\s+/g, ' ')}`,
      });
      handled.push({ from: message.from, action: 'turn', text });
    }
    return { handled, scanned: messages.length };
  } finally {
    running = false;
  }
}

export function startInboxWatcher({ anthropic }) {
  const minutes = pollMinutes();
  if (!isInboxConfigured()) {
    console.log('Inbox watcher disabled: no IMAP configured.');
    return null;
  }
  if (!minutes) {
    console.log('Inbox watcher disabled via INBOX_POLL_MINUTES=0.');
    return null;
  }
  console.log(`Inbox watcher: every ${minutes} min, a reply from a known contact wakes the Sales Manager.`);
  const timer = setInterval(() => {
    pollInboxOnce({ anthropic }).catch((err) => console.error('Inbox watcher:', err.message));
  }, minutes * 60 * 1000);
  timer.unref?.();
  return timer;
}
