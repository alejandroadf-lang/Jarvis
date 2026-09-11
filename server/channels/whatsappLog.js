// A record of what actually arrived on the WhatsApp webhook.
//
// This exists because of a specific, repeated failure: the founder sends a
// message from their phone, nothing comes back, and there is no way to tell
// *which* of six things went wrong without SSH-ing into deploy logs. Two grey
// ticks in WhatsApp prove Meta delivered the message to the business number
// and nothing after that — whether Meta called the webhook, whether the
// signature checked out, whether the sender was allowlisted, whether the team
// answered, whether the reply made it back out.
//
// So every inbound request lands here with the stage it reached. Silence in
// this log is itself the diagnosis: it means Meta never called at all, which
// is a Meta-dashboard problem rather than an app problem.

import { readJson, writeJson } from '../store.js';

const FILE = 'whatsappLog.json';

// Enough to cover a debugging session, small enough that the file stays
// trivial to read by hand. Older entries are the least useful thing here.
const MAX_EVENTS = 50;

// What a message body is truncated to before it's stored. The log is a
// diagnostic, not a second copy of the conversation — sessions.json already
// holds the real history.
const PREVIEW_CHARS = 80;

export const STAGES = {
  BAD_SIGNATURE: 'bad_signature',
  NOT_ALLOWLISTED: 'not_allowlisted',
  DUPLICATE: 'duplicate',
  UNSUPPORTED_TYPE: 'unsupported_type',
  ANSWERED: 'answered',
  FAILED: 'failed',
};

// Read as "how far did it get", worst to best. The client colours on this.
const STAGE_SUMMARY = {
  [STAGES.BAD_SIGNATURE]: 'Rejected — the signature did not match WHATSAPP_APP_SECRET.',
  [STAGES.NOT_ALLOWLISTED]: 'Ignored — this number is not in WHATSAPP_ALLOWED_NUMBERS.',
  [STAGES.DUPLICATE]: 'Skipped — Meta redelivered a message already handled.',
  [STAGES.UNSUPPORTED_TYPE]: 'Received, but not a text message.',
  [STAGES.ANSWERED]: 'Answered — the reply was sent back.',
  [STAGES.FAILED]: 'Reached the team, but answering failed.',
};

export function summarize(stage) {
  return STAGE_SUMMARY[stage] || stage;
}

function emptyLog() {
  // Receipts are counted rather than listed: delivery and read receipts hit
  // this webhook constantly and would push every real message out of a
  // 50-entry window within a minute. The count still carries the one thing
  // they prove, which is that Meta is calling the webhook at all.
  return { events: [], receipts: { count: 0, lastAt: null } };
}

function read() {
  const data = readJson(FILE, emptyLog());
  if (!Array.isArray(data.events)) data.events = [];
  if (!data.receipts) data.receipts = { count: 0, lastAt: null };
  return data;
}

/**
 * Records one inbound webhook call that carried a message.
 *
 * Never throws: this is instrumentation, and a failure to write a diagnostic
 * must not be the reason the founder's question goes unanswered.
 */
export function recordInbound({ stage, from = null, text = '', detail = null }) {
  try {
    const data = read();
    data.events.push({
      at: new Date().toISOString(),
      stage,
      from,
      preview: text ? String(text).slice(0, PREVIEW_CHARS) : null,
      detail,
    });
    if (data.events.length > MAX_EVENTS) data.events = data.events.slice(-MAX_EVENTS);
    writeJson(FILE, data);
  } catch (err) {
    console.error('WhatsApp: could not record an inbound event:', err.message);
  }
}

/** Records a delivery/read receipt — counted, not listed. See emptyLog(). */
export function recordReceipt() {
  try {
    const data = read();
    data.receipts = { count: (data.receipts.count || 0) + 1, lastAt: new Date().toISOString() };
    writeJson(FILE, data);
  } catch (err) {
    console.error('WhatsApp: could not record a receipt:', err.message);
  }
}

/** Newest first, which is the order anyone debugging this wants. */
export function recentInbound(limit = MAX_EVENTS) {
  const data = read();
  return {
    events: data.events.slice(-limit).reverse().map((e) => ({ ...e, summary: summarize(e.stage) })),
    receipts: data.receipts,
  };
}

export function __resetLogForTests() {
  writeJson(FILE, emptyLog());
}
