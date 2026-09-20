// Outreach written before it can be sent.
//
// The company could build a prospect list and could not email anyone: SMTP and
// the allowlist are founder configuration, and until they exist `send_customer_email`
// refuses. That left the commercial side with nothing to do but wait, which is
// how a week passes with a report full of recommendations and no work.
//
// So drafting is separated from sending. A draft reaches nobody, costs nothing,
// and spends no cap — it is a file on this server. The team can write fifteen
// tonight; the founder reads them on a phone and releases them one at a time.
// When the config lands, a morning's outreach is already written.
//
// The rule that shapes everything here: **approval is an extra gate, never a
// substitute for one.** Saying yes to a draft does not widen the allowlist,
// lift a cap, skip the compliance footer or bypass the CEO's veto. It adds the
// founder's judgement to a message that must still pass every check it would
// have passed had an agent sent it directly. A queue that dissolved those
// checks would be a way around them wearing a helpful face — which is the
// exact mistake tasks.js warns about in its own header.

import { readJson, writeJson } from './store.js';

const FILE = 'outreachDrafts.json';
const MAX_KEPT = 200;

export const DRAFT_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  SENT: 'sent',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

function load() {
  return readJson(FILE, { drafts: [], nextId: 1 });
}

function save(data) {
  // Oldest resolved drafts fall off first; anything still awaiting the founder
  // is kept whatever the age, because dropping an unread draft silently is how
  // work disappears.
  if (data.drafts.length > MAX_KEPT) {
    const live = data.drafts.filter((d) => d.status === DRAFT_STATUS.PENDING || d.status === DRAFT_STATUS.APPROVED);
    const resolved = data.drafts.filter((d) => d.status !== DRAFT_STATUS.PENDING && d.status !== DRAFT_STATUS.APPROVED);
    data.drafts = [...live, ...resolved.slice(-Math.max(0, MAX_KEPT - live.length))];
  }
  writeJson(FILE, data);
}

// Short ids because the founder types these on a phone. "d7" is a thing you can
// thumb in one-handed; a uuid is a thing you paste, and there is nowhere to
// paste from in a WhatsApp thread.
function nextId(data) {
  const id = `d${data.nextId}`;
  data.nextId += 1;
  return id;
}

export function createDraft({ ventureId, to, subject, body, why, agentId }) {
  const recipient = String(to || '').trim().toLowerCase();
  if (!recipient.includes('@')) {
    throw new Error('A draft needs a real recipient address. Find it first, or keep the lead in the pipeline with a handle until you have one.');
  }
  if (!String(subject || '').trim()) throw new Error('A draft needs a subject.');
  if (!String(body || '').trim()) throw new Error('A draft needs a body.');

  const data = load();
  const draft = {
    id: nextId(data),
    ventureId: String(ventureId || ''),
    to: recipient,
    subject: String(subject).trim(),
    body: String(body).trim(),
    // Why this person, in one line. The founder is approving a message to a
    // stranger and the reason they were chosen is the part that decides it.
    why: String(why || '').trim(),
    agentId: agentId ? String(agentId) : null,
    status: DRAFT_STATUS.PENDING,
    createdAt: new Date().toISOString(),
  };
  data.drafts.push(draft);
  save(data);
  return draft;
}

export function listDrafts({ ventureId = null, status = null } = {}) {
  return load().drafts.filter(
    (draft) => (!ventureId || draft.ventureId === ventureId) && (!status || draft.status === status)
  );
}

export function getDraft(id) {
  return load().drafts.find((draft) => draft.id === String(id || '').trim().toLowerCase()) || null;
}

function update(id, changes) {
  const data = load();
  const draft = data.drafts.find((d) => d.id === String(id || '').trim().toLowerCase());
  if (!draft) throw new Error(`No draft "${id}". Send DRAFTS to see what is waiting.`);
  Object.assign(draft, changes, { updatedAt: new Date().toISOString() });
  save(data);
  return draft;
}

/**
 * The founder says yes. That is all this does.
 *
 * Deliberately does not send: the send goes through the ordinary outreach path
 * with every gate intact, and that path can refuse. Marking a draft approved
 * and then discovering the allowlist does not cover it is a normal outcome,
 * not a bug — and it is why "approved" and "sent" are different states rather
 * than one.
 */
export function approveDraft(id) {
  const draft = getDraft(id);
  if (!draft) throw new Error(`No draft "${id}". Send DRAFTS to see what is waiting.`);
  if (draft.status === DRAFT_STATUS.SENT) throw new Error(`Draft ${draft.id} has already been sent — nothing to approve.`);
  if (draft.status === DRAFT_STATUS.REJECTED) throw new Error(`Draft ${draft.id} was rejected. The team can write a new one.`);
  return update(id, { status: DRAFT_STATUS.APPROVED, approvedAt: new Date().toISOString() });
}

export function rejectDraft(id, reason) {
  const draft = getDraft(id);
  if (!draft) throw new Error(`No draft "${id}". Send DRAFTS to see what is waiting.`);
  if (draft.status === DRAFT_STATUS.SENT) throw new Error(`Draft ${draft.id} has already been sent — it cannot be un-sent.`);
  return update(id, { status: DRAFT_STATUS.REJECTED, reason: String(reason || '').trim() });
}

export function markSent(id, { sentAt = new Date().toISOString() } = {}) {
  return update(id, { status: DRAFT_STATUS.SENT, sentAt });
}

/**
 * The send was attempted and refused. Stays approved rather than failing.
 *
 * The common reason is that the founder has not finished configuring SMTP or
 * the allowlist, which is a temporary fact about the world and not a verdict on
 * the message. Marking it failed would take it out of the queue, and the whole
 * point of the queue is that it survives until the config arrives.
 */
export function recordSendFailure(id, reason) {
  return update(id, { lastError: String(reason || '').slice(0, 400), lastTriedAt: new Date().toISOString() });
}

/** What the founder has not looked at yet, oldest first. */
export function pendingDrafts(ventureId = null) {
  return listDrafts({ ventureId, status: DRAFT_STATUS.PENDING });
}

/** Said yes to, not yet gone out — the queue the sweep retries. */
export function releasableDrafts(ventureId = null) {
  return listDrafts({ ventureId, status: DRAFT_STATUS.APPROVED });
}

/** For the agents' context: what is waiting on the founder, without the bodies. */
export function describeDraftsForAgents() {
  const pending = pendingDrafts();
  const approved = releasableDrafts();
  if (!pending.length && !approved.length) return '';

  const lines = [];
  if (pending.length) {
    lines.push(
      `${pending.length} outreach draft${pending.length === 1 ? '' : 's'} waiting on the founder:`,
      ...pending.map((d) => `  ${d.id} → ${d.to}: "${d.subject}"`)
    );
  }
  if (approved.length) {
    // Approved but unsent almost always means the config is not finished. Say
    // that rather than letting it read as a send that failed on its merits.
    lines.push(
      `${approved.length} approved and not yet sent${approved[0]?.lastError ? ` (last attempt: ${approved[0].lastError})` : ''}.`
    );
  }
  lines.push(
    'Do not redraft these — they are queued. Write drafts for people not already on this list, and keep finding new ones.'
  );
  return lines.join('\n');
}
