// Action-tool handlers shared by every place agents can actually touch the
// treasury or a venture: the interactive Executive Team / Venture Studio
// chat routes in index.js, and the autonomous daily-meeting cycle in
// dailyMeeting.js. Keeping them here (rather than inline in index.js) means
// the autonomous cycle can choose exactly which of these it wires up —
// today, only propose_venture (never money-moving or venture-killing
// actions; see dailyMeeting.js for why).

import { getLedger, addTransaction } from './finance/ledger.js';
import {
  getVenture,
  createVenture,
  setMilestoneStatus,
  killVenture,
  authorizeDeployment,
  recordDeployment,
  authorizeOutreach,
  recordOutreach,
  recordContactNote,
  recordVentureNote,
  authorizeExecution,
  recordRun,
  assertRepoIsPreApproved,
  autonomousRepos,
  linkRepo,
  setDeploymentEnabled,
  authorizeProbe,
  recordProbe,
  authorizeDeploymentOfPaths,
  authorizePullRequest,
  recordPullRequest,
  authorizeRevert,
  outreachRecipients,
  ventureForRecipient,
  recordReply,
  listReplies,
  markRepliesRead,
} from './finance/ventures.js';
import { recordContribution, distributeRevenue } from './finance/profitShare.js';
import { submitPlan, getPlan, formatPlanForWhatsApp } from './dailyPlan.js';
import {
  enqueueTasks,
  nextTask,
  startTask,
  completeTask,
  failTask,
  listTasks,
} from './tasks.js';
import { allowedNumbers, sendWhatsAppMessage, isWhatsAppConfigured } from './channels/whatsapp.js';
import {
  sendVentureProposedEmail,
  sendDeploymentEmail,
  sendCustomerEmail,
  sendOutreachAlertEmail,
  sendReplyAlertEmail,
  isEmailConfigured,
} from './email.js';
import {
  commitFile,
  commitFiles,
  createBranch,
  openPullRequest,
  planRevert,
  readFile as readRepoFile,
  listFiles as listRepoFiles,
  isGithubConfigured,
} from './deploy/github.js';
import { probeEndpoint } from './execute/probe.js';
import { fetchReplies, isInboxConfigured } from './inbox.js';
import { deployReadiness, outreachReadiness, formatReadiness } from './readiness.js';
import {
  isExecutionConfigured,
  dispatchWorkflow,
  findRunAfter,
  waitForRun,
  failureSummary,
  listWorkflows,
} from './execute/githubActions.js';

// Some things shouldn't wait for the next daily digest: a venture starting
// on its own, a real commit, a real email going out. Never lets a send
// failure break the action itself — the thing already happened either way,
// so a bad SMTP config should show up as a log line, not a broken
// conversation.
async function notify(sendFn, ...args) {
  try {
    await sendFn(...args);
  } catch (err) {
    console.error(`Failed to send ${sendFn.name}:`, err);
  }
}

export async function handleProposeVenture(input, ctx = {}) {
  const venture = createVenture(input);
  // Recorded only after the underlying action actually succeeded — a failed
  // one earns nothing. See finance/profitShare.js for why credit is never
  // self-reported.
  recordContribution({ agentId: ctx.agentId, kind: 'propose_venture', ventureId: venture.id, detail: venture.title });
  await notify(sendVentureProposedEmail, venture);
  return `Started venture ${venture.id} ("${venture.title}") — it's active now and the executive team can pick it up. It has no real-world reach yet: linking a repo or an outreach list is something the founder grants it from the Ventures panel.`;
}

// Shared validation for log_revenue/log_expense: a positive amount and,
// when given, a ventureId that actually exists. Returns either
// { amount, ventureId, description } or { error }.
function resolveTransactionInput(input, defaultDescription) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'amount must be a positive number.' };
  }

  let ventureId = null;
  if (input.ventureId) {
    const venture = getVenture(input.ventureId);
    if (!venture) {
      return { error: `no venture found with id "${input.ventureId}". Log it without a ventureId, or double-check the id.` };
    }
    ventureId = venture.id;
  }

  const description =
    typeof input.description === 'string' && input.description.trim() ? input.description.trim() : defaultDescription;

  return { amount, ventureId, description };
}

// The one pair worth being careful about: these two write the ledger the
// profit share is computed from, so an agent that books revenue is moving
// the number it gets paid on. Two things make that safe rather than a
// conflict of interest, and neither is a prompt: the amount has to come from
// the founder reporting real money, and neither tool is wired into the
// autonomous daily cycle (see dailyMeeting.js), so nothing unattended can
// touch it. Credit here is weighted lowest of any action for the same
// reason — booking the number should never out-earn doing the work.
export async function handleLogRevenue(input, ctx = {}) {
  const resolved = resolveTransactionInput(input, 'Revenue');
  if (resolved.error) return `Could not log revenue: ${resolved.error}`;

  const { amount, ventureId, description } = resolved;
  addTransaction({ type: 'revenue', amount, description, ventureId });
  recordContribution({ agentId: ctx.agentId, kind: 'log_revenue', ventureId, detail: description });
  // The outcome feeding back to the people who caused it. Until this
  // existed, shipping a file paid five times what booking revenue did, so
  // the company's incentives argued against the thing it exists to do.
  const credited = distributeRevenue({ ventureId, amountUsd: amount });
  const { revenue, net } = getLedger();
  const shared = credited.length
    ? ` Credit for it went to the ${credited.length} agent${credited.length === 1 ? '' : 's'} whose work is on this venture.`
    : '';
  return `Logged $${amount} in revenue${ventureId ? ` for venture ${ventureId}` : ''} ("${description}"). Revenue to date is now $${revenue.toFixed(2)}, net $${net.toFixed(2)}.${shared}`;
}

export async function handleLogExpense(input, ctx = {}) {
  const resolved = resolveTransactionInput(input, 'Expense');
  if (resolved.error) return `Could not log expense: ${resolved.error}`;

  const { amount, ventureId, description } = resolved;
  addTransaction({ type: 'expense', amount, description, ventureId });
  // Logging an expense *shrinks* the pool, and it still earns credit. That's
  // deliberate: an agent that's paid on net must not be quietly incentivised
  // to leave costs unrecorded.
  recordContribution({ agentId: ctx.agentId, kind: 'log_expense', ventureId, detail: description });
  const { expenses, net } = getLedger();
  return `Logged $${amount} in expenses${ventureId ? ` for venture ${ventureId}` : ''} ("${description}"). Expenses to date are now $${expenses.toFixed(2)}, net $${net.toFixed(2)}.`;
}

export async function handleReportMilestoneProgress(input, ctx = {}) {
  const index = Number(input.milestoneIndex);
  if (!Number.isInteger(index) || index < 0) {
    return 'Could not update milestone: milestoneIndex must be a non-negative integer.';
  }
  if (!['done', 'missed'].includes(input.status)) {
    return 'Could not update milestone: status must be "done" or "missed".';
  }
  try {
    const venture = setMilestoneStatus(input.ventureId, index, input.status, input.note);
    const milestone = venture.milestones[index];
    recordContribution({
      agentId: ctx.agentId,
      kind: 'report_milestone_progress',
      ventureId: venture.id,
      detail: `${milestone.title} → ${input.status}`,
    });
    return `Marked milestone [${index}] "${milestone.title}" as ${input.status} for "${venture.title}".`;
  } catch (err) {
    return `Could not update milestone: ${err.message}`;
  }
}

export async function handleKillVenture(input, ctx = {}) {
  try {
    const venture = killVenture(input.ventureId, input.reason);
    // Ending something that isn't working is real work, and pays — otherwise
    // the only incentive the share creates is to keep every venture alive.
    recordContribution({ agentId: ctx.agentId, kind: 'kill_venture', ventureId: venture.id, detail: venture.title });
    return `Killed "${venture.title}". Reason: ${venture.killReason}.`;
  } catch (err) {
    return `Could not kill venture: ${err.message}`;
  }
}

// The one action tool that reaches a real, live system outside the
// simulation (see finance/ventures.js's authorizeDeployment for the scope
// the founder has to grant before this can succeed at all). Every step here
// is fail-closed: no GITHUB_TOKEN, no repo link, deployments not enabled, an
// out-of-scope path, or a spent weekly cap all return a plain refusal
// instead of attempting a partial or best-effort commit.
//
// `triggeredBy` isn't part of the tool's own input_schema — the model never
// sets it. It's supplied by the caller (index.js passes 'interactive', the
// daily cycle passes 'daily_cycle' — see dailyMeeting.js), so the log
// records which of the two actually fired without asking the agent to
// self-report something it has no reason to get right.
export async function handleDeployCode(input, triggeredBy = 'interactive', ctx = {}) {
  const { ventureId, path, content, message, rationale } = input;
  if (!isGithubConfigured()) {
    return 'Could not deploy: this server has no GITHUB_TOKEN configured, so real deployments are unavailable.';
  }
  if (typeof path !== 'string' || !path.trim()) {
    return 'Could not deploy: path is required.';
  }
  if (typeof content !== 'string' || !content.trim()) {
    return 'Could not deploy: content is required.';
  }
  try {
    const venture = authorizeDeployment(ventureId, { path });
    const { commitSha, commitUrl } = await commitFile({
      owner: venture.repo.owner,
      repo: venture.repo.name,
      branch: venture.repo.branch,
      path,
      content,
      message: message?.trim() || `Update ${path} for ${venture.title}`,
    });
    recordDeployment(ventureId, { path, message, commitSha, commitUrl, rationale, triggeredBy, agentId: ctx.agentId });
    recordContribution({ agentId: ctx.agentId, kind: 'deploy_code', ventureId, detail: path });
    await notify(sendDeploymentEmail, venture, { path, commitUrl, triggeredBy });
    return `Deployed a real commit to "${venture.title}"'s repo (${venture.repo.owner}/${venture.repo.name}, branch ${venture.repo.branch}): ${path}. Commit: ${commitUrl || commitSha}.`;
  } catch (err) {
    return `Could not deploy: ${err.message}`;
  }
}

// Normalizes the `changes` array the three tools below all take. Tolerant of
// what a model actually emits — a missing `deleted` flag, a numeric path, an
// empty-string body that is a legitimate "make this file empty" — and strict
// about the one thing that is genuinely ambiguous: a change with no path.
function readChanges(input) {
  const raw = Array.isArray(input?.changes) ? input.changes : [];
  const changes = [];
  for (const item of raw) {
    const path = typeof item?.path === 'string' ? item.path.trim() : '';
    if (!path) continue;
    if (item.deleted === true) {
      changes.push({ path, deleted: true });
    } else {
      changes.push({ path, content: typeof item.content === 'string' ? item.content : '' });
    }
  }
  return changes;
}

function describeChanges(changes) {
  return changes
    .map((c) => (c.deleted ? `  - deleted ${c.path}` : `  - ${c.path}`))
    .join('\n');
}

// One commit, several files, all of it or none of it.
//
// deploy_code writes one file per commit, which quietly decided how this
// company could work: a change spanning seven files became seven commits, and
// a turn that ran out of room at the fourth left the deploy branch holding
// half a refactor. Every gate deploy_code passes, this passes — once per path,
// so six files cannot ride in on the seventh's approval.
export async function handleDeployChanges(input, triggeredBy = 'interactive', ctx = {}) {
  if (!isGithubConfigured()) {
    return 'Could not deploy: this server has no GITHUB_TOKEN configured, so real deployments are unavailable.';
  }
  const changes = readChanges(input);
  if (!changes.length) {
    return 'Could not deploy: changes is required — a list of { path, content } to write, or { path, deleted: true } to remove.';
  }
  const { ventureId, message, rationale } = input;
  try {
    const venture = authorizeDeploymentOfPaths(ventureId, changes.map((c) => c.path));
    const { commitSha, commitUrl, files } = await commitFiles({
      owner: venture.repo.owner,
      repo: venture.repo.name,
      branch: venture.repo.branch,
      changes,
      message: message?.trim() || `Update ${changeLabel(changes)} for ${venture.title}`,
    });
    // One ledger entry per path, so the deploy caps and the founder's log both
    // count what actually changed rather than counting a seven-file commit as
    // one small thing.
    for (const change of changes) {
      recordDeployment(ventureId, {
        path: change.path,
        message,
        commitSha,
        commitUrl,
        rationale,
        triggeredBy,
        agentId: ctx.agentId,
      });
    }
    recordContribution({
      agentId: ctx.agentId,
      kind: 'deploy_code',
      ventureId,
      detail: `${files} files in one commit`,
    });
    await notify(sendDeploymentEmail, venture, { path: `${files} files`, commitUrl, triggeredBy });
    return `Deployed one commit touching ${files} file${files === 1 ? '' : 's'} to "${venture.title}"'s repo (${venture.repo.owner}/${venture.repo.name}, branch ${venture.repo.branch}):\n${describeChanges(changes)}\nCommit: ${commitUrl || commitSha}.`;
  } catch (err) {
    return `Could not deploy: ${err.message}`;
  }
}

function changeLabel(changes) {
  if (changes.length === 1) return changes[0].path;
  return `${changes.length} files`;
}

// Real work, finished, on a branch, not landed.
//
// Until now every option was binary: commit to the branch a deploy watches, or
// write a paragraph describing what you would have committed. This is the
// third thing, and it is the one a real engineering team uses by default.
//
// Deliberately not gated on the approved daily plan (see authorizePullRequest):
// a PR is how work gets proposed, and requiring pre-approval to propose
// something means the only way to propose is to have already been approved.
export async function handleOpenPullRequest(input, triggeredBy = 'interactive', ctx = {}) {
  if (!isGithubConfigured()) {
    return 'Could not open a pull request: this server has no GITHUB_TOKEN configured.';
  }
  const changes = readChanges(input);
  if (!changes.length) {
    return 'Could not open a pull request: changes is required — a list of { path, content }, or { path, deleted: true }.';
  }
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title) return 'Could not open a pull request: title is required.';

  const { ventureId, body } = input;
  // A branch name the founder can read at a glance in the repo's branch list,
  // and one that cannot collide with a second PR the same day.
  const branch =
    (typeof input?.branch === 'string' && input.branch.trim()) ||
    `agents/${slugify(title)}-${Date.now().toString(36)}`;

  try {
    const venture = authorizePullRequest(ventureId, { paths: changes.map((c) => c.path) });
    const base = venture.repo.branch;
    await createBranch({ owner: venture.repo.owner, repo: venture.repo.name, branch, fromBranch: base });
    await commitFiles({
      owner: venture.repo.owner,
      repo: venture.repo.name,
      branch,
      changes,
      message: title,
    });
    const pr = await openPullRequest({
      owner: venture.repo.owner,
      repo: venture.repo.name,
      head: branch,
      base,
      title,
      body: typeof body === 'string' ? body : '',
    });
    recordPullRequest(ventureId, {
      number: pr.number,
      url: pr.url,
      title,
      branch,
      paths: changes.map((c) => c.path),
      triggeredBy,
      agentId: ctx.agentId,
    });
    recordContribution({ agentId: ctx.agentId, kind: 'open_pull_request', ventureId, detail: title });
    return `Opened pull request #${pr.number} on ${venture.repo.owner}/${venture.repo.name}: "${title}".\nBranch ${branch} -> ${base}, ${changes.length} file${changes.length === 1 ? '' : 's'}:\n${describeChanges(changes)}\n${pr.url}\n\nNothing has landed. The founder reviews and merges, or closes it and nothing happened.`;
  } catch (err) {
    return `Could not open a pull request: ${err.message}`;
  }
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'change';
}

// The undo button.
//
// This company could commit and could not un-commit, which made a bad change
// the founder's problem on a laptop the founder does not always have. The
// asymmetry was more dangerous than any individual commit: a team that can
// only move forward gets more cautious over time, not less, and caution here
// looks like never shipping.
export async function handleRevertCommit(input, triggeredBy = 'interactive', ctx = {}) {
  if (!isGithubConfigured()) {
    return 'Could not revert: this server has no GITHUB_TOKEN configured.';
  }
  const sha = typeof input?.sha === 'string' ? input.sha.trim() : '';
  if (!sha) return 'Could not revert: sha is required — the commit to undo.';

  const { ventureId } = input;
  const venture = getVenture(ventureId);
  if (!venture) return 'Could not revert: venture not found.';
  if (!venture.repo) return 'Could not revert: no repo is linked to this venture.';

  try {
    // Read what that commit did before deciding whether it may be undone. The
    // paths are not the agent's to supply — they are whatever the commit
    // touched — so the allowlist gets checked against the truth rather than
    // against a claim.
    const plan = await planRevert({ owner: venture.repo.owner, repo: venture.repo.name, sha });
    authorizeRevert(ventureId, { paths: plan.paths });

    const { commitSha, commitUrl, files } = await commitFiles({
      owner: venture.repo.owner,
      repo: venture.repo.name,
      branch: venture.repo.branch,
      changes: plan.changes,
      message: `Revert "${plan.subject}"\n\nThis reverts commit ${sha}.`,
    });

    for (const change of plan.changes) {
      recordDeployment(ventureId, {
        path: change.path,
        message: `Revert ${sha.slice(0, 7)}`,
        commitSha,
        commitUrl,
        rationale: typeof input?.rationale === 'string' ? input.rationale : '',
        triggeredBy,
        agentId: ctx.agentId,
      });
    }
    recordContribution({ agentId: ctx.agentId, kind: 'revert_commit', ventureId, detail: sha.slice(0, 7) });
    await notify(sendDeploymentEmail, venture, { path: `revert of ${sha.slice(0, 7)}`, commitUrl, triggeredBy });

    // The caveat is stated every time rather than buried in a doc. A revert is
    // scoped to the paths that commit touched, so if something later also
    // edited one of them, this just overwrote that later edit — and the agent
    // is the only one positioned to notice before the founder does.
    return [
      `Reverted ${sha.slice(0, 7)} ("${plan.subject}") on "${venture.title}" — one commit putting ${files} file${files === 1 ? '' : 's'} back:`,
      describeChanges(plan.changes),
      `Commit: ${commitUrl || commitSha}.`,
      '',
      'This put those specific paths back to their state before that commit. If anything landed on them since, ' +
        'that work is now overwritten — check before moving on.',
    ].join('\n');
  } catch (err) {
    return `Could not revert: ${err.message}`;
  }
}

// The second action reaching a real, live system outside the simulation —
// same shape as handleDeployCode: fail-closed on every check (SMTP not
// configured, missing input, an out-of-scope recipient, a spent weekly
// cap) before ever attempting a real send. Same caller-supplied
// `triggeredBy` as handleDeployCode, for the same reason.
export async function handleSendCustomerEmail(input, triggeredBy = 'interactive', ctx = {}) {
  const { ventureId, to, subject, body } = input;
  if (!isEmailConfigured()) {
    return 'Could not send: this server has no email delivery configured, so real outreach is unavailable.';
  }
  if (typeof to !== 'string' || !to.trim()) {
    return 'Could not send: to is required.';
  }
  if (typeof subject !== 'string' || !subject.trim()) {
    return 'Could not send: subject is required.';
  }
  if (typeof body !== 'string' || !body.trim()) {
    return 'Could not send: body is required.';
  }
  try {
    const venture = authorizeOutreach(ventureId, { to });
    const sent = await sendCustomerEmail(to, subject, body);
    if (!sent) return 'Could not send: the email server rejected the send.';
    recordOutreach(ventureId, { to, subject, body, triggeredBy, agentId: ctx.agentId });
    recordContribution({ agentId: ctx.agentId, kind: 'send_customer_email', ventureId, detail: `to ${to}` });
    await notify(sendOutreachAlertEmail, venture, { to, subject, triggeredBy });
    return `Sent a real email to ${to} on behalf of "${venture.title}": "${subject}".`;
  } catch (err) {
    return `Could not send: ${err.message}`;
  }
}

// The other half of send_customer_email, and the reason that tool stopped
// being a broadcast.
//
// No scope grant of its own, and that is deliberate rather than an oversight.
// Sending is gated because it reaches a real person; reading a reply from
// someone this company already wrote to reaches nobody. Putting it behind the
// same door as sending would be the mistake this codebase has now made four
// times: a capability the team holds and cannot open (see the READY check).
//
// It is still not unguarded. inbox.js will not return a message from an
// address the company never emailed, so the founder's private mail is
// unreachable from here no matter what an agent asks for.
export async function handleCheckReplies(input, triggeredBy = 'interactive', ctx = {}) {
  if (!isInboxConfigured()) {
    return (
      'Could not check: this server has no inbound mailbox configured, so replies are invisible to the company. ' +
      'The founder needs to set IMAP_HOST, IMAP_USER and IMAP_PASS.'
    );
  }

  const known = outreachRecipients();
  if (!known.size) {
    return 'Nothing to check: this company has not sent a customer email yet, so there is nobody who could be replying.';
  }

  let result;
  try {
    result = await fetchReplies({ isKnownSender: (address) => known.has(address) });
  } catch (err) {
    return `Could not check the mailbox: ${err.message}`;
  }

  // Filing happens before reading. A reply is recorded against its venture on
  // arrival so that a turn which runs out of room halfway through still leaves
  // the mail where the next turn will find it.
  const filed = [];
  for (const message of result.messages) {
    const venture = ventureForRecipient(message.from);
    if (!venture) continue; // sent from a venture that has since been deleted
    const { entry, duplicate } = recordReply(venture.id, message);
    if (duplicate || !entry) continue;
    filed.push({ venture, entry });
    recordContribution({
      agentId: ctx.agentId,
      kind: 'check_replies',
      ventureId: venture.id,
      detail: `reply from ${message.from}`,
    });
    await notify(sendReplyAlertEmail, venture, { from: message.from, subject: entry.subject, triggeredBy });
  }

  // Unread, not new: a reply filed by yesterday's daily cycle and never acted
  // on is exactly as much of an open loop as one that arrived this minute.
  const ventureId = typeof input?.ventureId === 'string' ? input.ventureId : null;
  const ventureIds = ventureId ? [ventureId] : [...new Set(filed.map((f) => f.venture.id))];
  const unread = [];
  for (const id of ventureIds) {
    for (const reply of listReplies(id, { unreadOnly: true })) unread.push({ id, reply });
  }

  if (!unread.length) {
    const checked = result.scanned ? ` Checked ${result.scanned} message${result.scanned === 1 ? '' : 's'}.` : '';
    return `No unread replies.${checked} Silence is data too — if a prospect has been quiet for a week, that is worth a note rather than another email.`;
  }

  const lines = unread.map(({ id, reply }) => {
    const who = reply.fromName ? `${reply.fromName} <${reply.from}>` : reply.from;
    return [
      `From: ${who}`,
      `Subject: ${reply.subject || '(no subject)'}`,
      `Received: ${reply.receivedAt}`,
      `Venture: ${id}`,
      '',
      reply.body || '(empty body)',
    ].join('\n');
  });

  // Marked read only now — after the text is in hand and about to be returned
  // into the turn. Marking earlier would lose a reply to a crash in between.
  for (const id of ventureIds) {
    markRepliesRead(id, unread.filter((u) => u.id === id).map((u) => u.reply.messageId));
  }

  return [
    `${unread.length} unread repl${unread.length === 1 ? 'y' : 'ies'}:`,
    '',
    lines.join('\n\n---\n\n'),
    '',
    'Log what you learned with log_contact_note before you answer — the note is what the next draft reads, ' +
      'and this reply is not going to be in your context next week.',
  ].join('\n');
}

// Purely internal memory — no scope grant, no kill switch, no cap, because
// nothing leaves the building. It's the counterpart to send_customer_email:
// what the agent learned, recorded where the next draft will actually see it
// (see finance/context.js's buildOutreachContext).
// --- Durable work ------------------------------------------------------------
//
// See tasks.js for why this exists. In short: an agent decided on seven files,
// produced none, and the intent died with the turn because nothing had written
// it down. These let the team write work down first and pick it up again after
// a turn ends for any reason.
//
// None of them grant anything. A queued task still has to pass the scope
// model, the approved plan, the rate limits and the kill switch when it is
// actually carried out — a queue that bypassed those would dissolve them.

export function handleQueueWork(input, ctx = {}) {
  try {
    const items = Array.isArray(input.tasks) ? input.tasks : [];
    if (!items.length) return 'Could not queue work: give at least one task.';
    const queued = enqueueTasks(input.ventureId, items, ctx.agentId || null);
    return `Wrote down ${queued.length} task${queued.length === 1 ? '' : 's'}. They survive this turn, so a run that stops early costs one task rather than the whole plan:\n${queued
      .map((t) => `  [${t.id}] ${t.title}`)
      .join('\n')}\n\nClaim the first with start_task.`;
  } catch (err) {
    return `Could not queue the work: ${err.message}`;
  }
}

export function handleNextTask(input) {
  try {
    const task = nextTask(input.ventureId);
    if (!task) return 'Nothing is queued for that venture. If there is work to do, write it down with queue_work first.';
    const abandoned = task.stalled
      ? '\n\nThis was claimed by an earlier turn that never reported back, so it is yours now. ' +
        'Nothing was skipped — the work behind it was waiting on this.'
      : '';
    return `Next: [${task.id}] ${task.title}${task.detail ? `\n${task.detail}` : ''}${
      task.attempts ? `\n\nAttempted ${task.attempts} time(s) already. Last failure: ${task.error}` : ''
    }${abandoned}\n\nCall start_task with this id before doing it.`;
  } catch (err) {
    return `Could not read the queue: ${err.message}`;
  }
}

export function handleStartTask(input) {
  try {
    const task = startTask(input.taskId);
    return `Claimed [${task.id}] ${task.title} (attempt ${task.attempts}). Report the outcome with complete_task or fail_task — a task left claimed blocks the queue.`;
  } catch (err) {
    return `Could not start that task: ${err.message}`;
  }
}

export function handleCompleteTask(input, ctx = {}) {
  try {
    const task = completeTask(input.taskId, input.result);
    recordContribution({ agentId: ctx.agentId, kind: 'complete_task', ventureId: task.ventureId, detail: task.title });
    const left = listTasks({ ventureId: task.ventureId }).filter((t) => t.status === 'queued').length;
    return `Done: ${task.title}.${left ? ` ${left} task(s) still queued — call next_task.` : ' Nothing else is queued.'}`;
  } catch (err) {
    return `Could not complete that task: ${err.message}`;
  }
}

export function handleFailTask(input) {
  try {
    const task = failTask(input.taskId, input.error);
    return task.status === 'queued'
      ? `Recorded the failure on "${task.title}" and put it back in the queue (attempt ${task.attempts}). The reason is kept, so the next attempt starts knowing what went wrong rather than repeating it.`
      : `"${task.title}" has now failed ${task.attempts} times and stays failed. Retrying identically would only spend money to learn the same thing — say what is actually blocking it.`;
  } catch (err) {
    return `Could not record that failure: ${err.message}`;
  }
}

// --- Reading the repo --------------------------------------------------------
//
// The team could write files and never read them. On a second commit it was
// working from its own memory of what it wrote in a previous turn, which is
// exactly where a model confabulates — and the contradiction only surfaces
// when CI goes red, long after the cheap moment to catch it.

export async function handleReadRepoFile(input) {
  const { ventureId, path } = input;
  if (!isGithubConfigured()) {
    return 'Could not read the file: this server has no GITHUB_TOKEN configured.';
  }
  try {
    const venture = getVenture(ventureId);
    if (!venture) return `Could not read the file: no venture with id "${ventureId}".`;
    if (!venture.repo) return 'Could not read the file: no repo is linked to this venture yet.';

    const content = await readRepoFile({
      owner: venture.repo.owner,
      repo: venture.repo.name,
      branch: venture.repo.branch || 'main',
      path,
    });
    if (content === null) {
      return `"${path}" does not exist in ${venture.repo.owner}/${venture.repo.name} yet. That is an answer, not an error — write it rather than assuming what is in it.`;
    }
    return `${venture.repo.owner}/${venture.repo.name}:${path}\n\n${content}`;
  } catch (err) {
    return `Could not read the file: ${err.message}`;
  }
}

/**
 * What is actually in the repo.
 *
 * The companion to handleReadRepoFile, and the reason it exists: that one
 * answers a path you already know. An agent picking up work it did not start
 * — a new turn, a queued task, a venture it has not touched in a week — knows
 * no paths at all, and guessing produced "does not exist", which reads as
 * permission to write the file fresh and overwrite whatever is really there.
 */
export async function handleListRepoFiles(input) {
  const { ventureId } = input;
  if (!isGithubConfigured()) {
    return 'Could not list the repo: this server has no GITHUB_TOKEN configured.';
  }
  try {
    const venture = getVenture(ventureId);
    if (!venture) return `Could not list the repo: no venture with id "${ventureId}".`;
    if (!venture.repo) return 'Could not list the repo: no repo is linked to this venture yet.';

    const { owner, name } = venture.repo;
    const branch = venture.repo.branch || 'main';
    const result = await listRepoFiles({ owner, repo: name, branch });
    const where = `${owner}/${name}@${branch}`;

    // Both of these are answers. Kept distinct because they lead to opposite
    // next actions — write the first file, versus stop and fix the branch.
    if (result.state === 'empty') {
      return `${where} has no commits yet, so there are no files. That is an answer, not an error: the first commit creates the repo's history.`;
    }
    if (result.state === 'no-such-ref') {
      return `${where} does not exist — the repo is reachable but has no branch called "${branch}". Do not treat this as an empty repo; the files are on some other branch. Tell the founder the linked branch is wrong rather than committing to a branch you invented.`;
    }
    if (!result.files.length) {
      return `${where} has a commit history but no files in the tree, which is unusual — check the branch before writing anything.`;
    }

    const lines = result.files.map((file) => `  ${file.path}${file.bytes ? `  (${file.bytes} bytes)` : ''}`);
    const note = result.truncated
      ? `\n\nThis list is truncated at ${result.files.length} of ${result.total}. Anything you did not see may still exist — read a path before assuming it does not.`
      : '';
    return `${where} — ${result.total} file${result.total === 1 ? '' : 's'}:\n${lines.join('\n')}${note}`;
  } catch (err) {
    return `Could not list the repo: ${err.message}`;
  }
}

/**
 * Is the deployed service actually answering?
 *
 * The one question nothing here could answer. `run_checks` proves the tests
 * pass in a GitHub runner; this proves something is listening on the internet
 * and what it says back. The two fail independently, and the combination that
 * matters most — green CI, dead service — was invisible.
 *
 * Reports a 500 as a successful probe with a bad result, because that is what
 * it is, and the distinction from "nothing is listening" is the most useful bit
 * of information this returns. Conflating them is how a broken deploy gets
 * diagnosed as a DNS problem.
 */
export async function handleCheckService(input, ctx = {}) {
  const { ventureId, path = '/' } = input;
  try {
    const origin = authorizeProbe(ventureId);
    const result = await probeEndpoint({ origin, path });
    recordProbe(ventureId, { path, status: result.status, ok: result.ok, ms: result.ms, agentId: ctx.agentId });

    if (result.unreachable) {
      return `${result.url} did not respond: ${result.reason}. Nothing is listening, or DNS does not resolve — this is not a bad response, it is no response. Check the service is deployed and running before looking at the code.`;
    }

    const head = `${result.url} -> ${result.status} in ${result.ms}ms`;
    if (result.status >= 300 && result.status < 400) {
      return `${head}. It redirects${result.location ? ` to ${result.location}` : ''}, which was not followed. If a customer calls this path they get the redirect, not the data.`;
    }

    const body = result.body?.trim()
      ? `\n\n${result.body}${result.truncated ? '\n… (truncated)' : ''}`
      : '\n\nThe response had an empty body.';

    if (!result.ok) {
      return `${head} — the service is up and this path is failing. That is a real bug in deployed code, not a deployment problem.${body}`;
    }
    return `${head}. The service is up and this path works.${body}`;
  } catch (err) {
    return `Could not check the service: ${err.message}`;
  }
}

export function handleLogVentureNote(input, ctx = {}) {
  try {
    const note = recordVentureNote(input.ventureId, { note: input.note, agentId: ctx.agentId });
    return `Noted against this venture: "${note.note}". Every agent working on it reads this before the next attempt.`;
  } catch (err) {
    return `Could not log the note: ${err.message}`;
  }
}

export async function handleLogContactNote(input, ctx = {}) {
  try {
    const { note } = recordContactNote(input.ventureId, { email: input.email, note: input.note });
    recordContribution({ agentId: ctx.agentId, kind: 'log_contact_note', ventureId: input.ventureId, detail: note.email });
    return `Noted against ${note.email}: "${note.note}". It'll be in the contact history before the next email to them is drafted.`;
  } catch (err) {
    return `Could not log the contact note: ${err.message}`;
  }
}

/**
 * Runs a workflow in the venture's repo and reports what happened.
 *
 * This is the loop the company was missing: agents could write code and ship
 * it, but never find out whether it worked. "The tests pass" was a claim
 * nobody could check — including the agent making it.
 *
 * The reply is written for an agent that has to act on it. A bare "failure"
 * is not actionable; the failing job and step are.
 */
export async function handleRunChecks(input, triggeredBy = 'interactive', ctx = {}) {
  const { ventureId, workflow, rationale } = input;
  if (!isExecutionConfigured()) {
    return 'Could not run checks: this server has no GITHUB_TOKEN configured, so there is no execution environment.';
  }

  let venture;
  try {
    venture = authorizeExecution(ventureId);
  } catch (err) {
    return `Could not run checks: ${err.message}`;
  }

  const { owner, name: repo, branch } = venture.repo;
  const file = (workflow || '').trim() || 'ci.yml';

  try {
    const startedAt = Date.now();
    await dispatchWorkflow({ owner, repo, workflow: file, ref: branch });
    const run = await findRunAfter({ owner, repo, workflow: file, branch, since: startedAt });

    if (!run) {
      // Dispatch succeeded but no run appeared. Almost always the workflow
      // lacks a workflow_dispatch trigger, which is a fixable thing to say.
      recordRun(ventureId, { workflow: file, status: 'not_found', triggeredBy, agentId: ctx.agentId });
      return `Started ${file} on ${owner}/${repo}@${branch}, but no run appeared. The workflow probably has no "workflow_dispatch:" trigger — add one to .github/workflows/${file} and it becomes runnable.`;
    }

    const finished = await waitForRun({ owner, repo, runId: run.id });

    if (finished.status !== 'completed') {
      recordRun(ventureId, {
        workflow: file, runId: run.id, url: run.html_url, status: finished.status, triggeredBy, agentId: ctx.agentId,
      });
      return `${file} is still running after 5 minutes — check back rather than waiting. ${run.html_url}`;
    }

    if (finished.conclusion === 'success') {
      recordRun(ventureId, {
        workflow: file, runId: run.id, url: run.html_url, status: 'completed', conclusion: 'success',
        triggeredBy, agentId: ctx.agentId,
      });
      return `${file} passed on ${owner}/${repo}@${branch}. ${run.html_url}`;
    }

    const failures = await failureSummary({ owner, repo, runId: run.id });
    recordRun(ventureId, {
      workflow: file, runId: run.id, url: run.html_url, status: 'completed', conclusion: finished.conclusion,
      failures, triggeredBy, agentId: ctx.agentId,
    });

    const detail = failures.length
      ? failures
          .map((f) => `${f.job} (${f.conclusion})${f.failedSteps.length ? ` at: ${f.failedSteps.join(', ')}` : ''}`)
          .join('; ')
      : 'no job-level detail available';
    return `${file} failed on ${owner}/${repo}@${branch} — ${detail}. Full logs: ${run.html_url}. Fix the cause and run it again; do not report this as passing.`;
  } catch (err) {
    recordRun(ventureId, { workflow: file, status: 'error', conclusion: err.message, triggeredBy, agentId: ctx.agentId });
    return `Could not run checks: ${err.message}`;
  }
}

/** What an agent is allowed to run, so it can stop guessing at filenames. */
export async function handleListChecks(input) {
  const { ventureId } = input;
  if (!isExecutionConfigured()) return 'No GITHUB_TOKEN is configured, so there is no execution environment.';
  let venture;
  try {
    venture = authorizeExecution(ventureId);
  } catch (err) {
    return `Could not list checks: ${err.message}`;
  }
  try {
    const workflows = await listWorkflows({ owner: venture.repo.owner, repo: venture.repo.name });
    if (!workflows.length) {
      return `${venture.repo.owner}/${venture.repo.name} has no workflows yet. Commit one to .github/workflows/ci.yml with a "workflow_dispatch:" trigger, then it can be run.`;
    }
    return `Runnable in ${venture.repo.owner}/${venture.repo.name}: ${workflows.map((w) => `${w.file} (${w.name})`).join(', ')}.`;
  } catch (err) {
    return `Could not list checks: ${err.message}`;
  }
}

/**
 * Points a venture at a repo and turns deployment on, without waiting for the
 * founder — but only for repos they pre-approved in AUTONOMOUS_DEPLOY_REPOS.
 *
 * Both halves in one action on purpose. Linking without enabling is a state
 * nobody wants and the team would immediately have to ask about, and every
 * extra round trip is the thing this exists to remove.
 */
export async function handleLinkVentureRepo(input, triggeredBy = 'interactive', ctx = {}) {
  const { ventureId, owner, name, branch, allowedPaths, maxPerDay, maxPerWeek, rationale } = input;
  if (!isGithubConfigured()) {
    return 'Could not link a repo: this server has no GITHUB_TOKEN configured.';
  }
  if (!owner || !name) return 'Could not link a repo: owner and name are both required.';

  try {
    assertRepoIsPreApproved(owner, name, ventureId);
  } catch (err) {
    return `Could not link a repo: ${err.message}`;
  }

  const paths = Array.isArray(allowedPaths) ? allowedPaths.filter(Boolean) : [];
  if (!paths.length) {
    // An empty allowlist permits nothing, so linking with one would produce a
    // venture that looks ready and refuses every commit.
    return 'Could not link a repo: allowedPaths is required, and must name the paths you actually intend to write.';
  }

  try {
    const venture = getVenture(ventureId);
    if (!venture) return 'Could not link a repo: no venture with that id.';
    if (venture.status !== 'active') return `Could not link a repo: the venture is ${venture.status}.`;

    linkRepo(ventureId, { owner, name, branch, allowedPaths: paths, maxPerDay, maxPerWeek });
    setDeploymentEnabled(ventureId, true);
    recordContribution({ agentId: ctx.agentId, kind: 'deploy_code', ventureId, detail: `linked ${owner}/${name}` });

    const linked = getVenture(ventureId);
    return (
      `Linked ${owner}/${name} (branch ${linked.repo.branch}) to "${linked.title}" and enabled deployment. ` +
      `Writable paths: ${paths.join(', ')}. Caps: ${linked.repo.maxPerDay}/day, ${linked.repo.maxPerWeek}/week. ` +
      `Rationale recorded: ${rationale || '(none given)'}.`
    );
  } catch (err) {
    return `Could not link a repo: ${err.message}`;
  }
}

/** What the founder has pre-approved, so nobody guesses at a repo name. */
export async function handleListApprovedRepos() {
  const repos = autonomousRepos();
  if (!repos.length) {
    return 'No repos are pre-approved for self-service. The founder links repos and enables deployment themselves.';
  }
  return `Repos you can link and deploy to without asking: ${repos.join(', ')}.`;
}

/**
 * The team's plan for the day, submitted for one approval rather than many.
 *
 * Resubmitting replaces a pending or rejected plan, so a "no" can be answered
 * the same day. An approved one cannot be edited — work has already been
 * authorised against it, and quietly changing what was agreed is the move
 * this whole mechanism exists to prevent.
 */
export async function handleSubmitDailyPlan(input, triggeredBy = 'interactive', ctx = {}) {
  const { items, summary } = input;
  try {
    const plan = submitPlan({ items, summary, submittedBy: ctx.agentId || 'ceo' });
    // Pushed to the phone rather than left for the founder to come looking.
    // The team is stopped until this is answered, so a plan sitting unread in
    // a panel costs a day of work, not a scroll.
    const pushed = await pushPlanToFounder(plan);
    const lines = plan.items.map(
      (item) => `  • ${item.action}${item.target ? ` on ${item.target}` : ''} (${item.ventureId}) — ${item.intent}`
    );
    return (
      `Plan submitted for ${plan.date} and waiting on the founder. Nothing runs until they approve it.\n` +
      `${lines.join('\n')}\n` +
      (pushed
        ? 'Sent to their phone; they can reply APPROVE or REJECT there. Do not start the work yet.'
        : 'Tell the founder it is ready to look at, and do not start the work yet.')
    );
  } catch (err) {
    return `Could not submit the plan: ${err.message}`;
  }
}

/** Where the plan stands, so nobody guesses at whether they are cleared. */
export async function handleCheckDailyPlan() {
  const plan = getPlan();
  if (!plan) return 'No plan has been submitted today. Real actions are blocked until one is submitted and approved.';
  const lines = plan.items.map(
    (item) => `  • ${item.action}${item.target ? ` on ${item.target}` : ''} (${item.ventureId}) — ${item.intent}`
  );
  return `The current plan is ${plan.status.toUpperCase()}${plan.note ? ` — "${plan.note}"` : ''}.\n${lines.join('\n')}\n\nA new plan can be submitted at any time and takes effect as soon as the founder approves it.`;
}

/**
 * Sends a pending plan to every allowlisted number. Best-effort by design: a
 * notification that fails must not lose the plan, which is already saved and
 * visible in the app either way.
 */
async function pushPlanToFounder(plan) {
  if (!isWhatsAppConfigured()) return false;
  const numbers = allowedNumbers();
  if (!numbers.length) return false;

  const body = formatPlanForWhatsApp(plan);
  let delivered = false;
  for (const number of numbers) {
    try {
      await sendWhatsAppMessage(number, body);
      delivered = true;
    } catch (err) {
      console.error(`Could not send the daily plan to ${number}: ${err.message}`);
    }
  }
  return delivered;
}

// --- Is the door open? --------------------------------------------------------
//
// Eleven conditions guard a commit and nine guard an email, and every one of
// them throws. An agent that tries to deploy therefore learns exactly one of
// them per attempt, which is how this team spent three turns discovering, one
// refusal at a time, that a repo had never been enabled.
//
// It is also why the daily report kept saying "blocked" without saying on
// what. Nothing in this app could answer "what do you need from me" in a
// single call, so the answer came out as a paragraph of guesses — and a guess
// in a status report is worse than a blank, because the founder acts on it.
//
// Grants nothing, reaches nothing, costs nothing. It only reads the gates that
// were already there.
export function handleCheckReady(input) {
  const ventureId = typeof input?.ventureId === 'string' ? input.ventureId : '';
  if (!ventureId) return 'Could not check: ventureId is required.';

  const action = typeof input?.action === 'string' ? input.action : 'deploy_code';
  const target = typeof input?.target === 'string' && input.target.trim() ? input.target.trim() : undefined;

  try {
    if (action === 'send_customer_email') {
      return formatReadiness(outreachReadiness(ventureId, { to: target }));
    }
    if (action === 'deploy_code' || action === 'deploy_changes' || action === 'open_pull_request' || action === 'revert_commit') {
      const report = deployReadiness(ventureId, { path: target });
      // open_pull_request and revert_commit skip the plan gate by design (see
      // authorizePullRequest). Saying so here is the point: the report is what
      // an agent reads before deciding whether to propose or to land, and a
      // report that hid the difference would send it back to asking permission
      // for the one thing that does not need it.
      if (action === 'open_pull_request' || action === 'revert_commit') {
        const withoutPlan = {
          ...report,
          gates: report.gates.filter((g) => g.name !== 'Approved daily plan'),
        };
        const shut = withoutPlan.gates.filter((g) => !g.open);
        return formatReadiness({
          ...withoutPlan,
          action,
          shut,
          ready: shut.length === 0,
          blockedBy: shut[0] || null,
        });
      }
      return formatReadiness({ ...report, action });
    }
    return `Could not check: "${action}" is not a gated action. Gated actions are deploy_code, deploy_changes, open_pull_request, revert_commit and send_customer_email.`;
  } catch (err) {
    return `Could not check: ${err.message}`;
  }
}
