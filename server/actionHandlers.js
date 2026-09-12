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
  authorizeExecution,
  recordRun,
} from './finance/ventures.js';
import { recordContribution } from './finance/profitShare.js';
import {
  sendVentureProposedEmail,
  sendDeploymentEmail,
  sendCustomerEmail,
  sendOutreachAlertEmail,
  isEmailConfigured,
} from './email.js';
import { commitFile, isGithubConfigured } from './deploy/github.js';
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
  const { revenue, net } = getLedger();
  return `Logged $${amount} in revenue${ventureId ? ` for venture ${ventureId}` : ''} ("${description}"). Revenue to date is now $${revenue.toFixed(2)}, net $${net.toFixed(2)}.`;
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

// Purely internal memory — no scope grant, no kill switch, no cap, because
// nothing leaves the building. It's the counterpart to send_customer_email:
// what the agent learned, recorded where the next draft will actually see it
// (see finance/context.js's buildOutreachContext).
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
