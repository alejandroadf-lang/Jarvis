// What is actually stopping you.
//
// `deploy_code` passes eleven separate conditions before a commit happens: the
// global halt, the daily spend cap, a configured token, an active venture, a
// linked repo, an enabled flag, a path allowlist, a weekly cap, a daily cap, a
// cooldown, a checks-overdue rule — and, above all of those, an approved daily
// plan. Every one of them throws, which means an agent that tries to deploy
// learns exactly one of them per attempt.
//
// That is how a team ends up spending three turns discovering, one refusal at
// a time, that the repo was never enabled. It is also why the daily report
// keeps saying "blocked" without saying on what: nothing in this app could
// answer "what do you need from me" in one call, so the answer came out as a
// paragraph of guesses.
//
// This module answers it. It reports every gate at once, open and shut, and it
// deliberately reports the open ones too — a team that only ever sees failures
// cannot tell "one thing is missing" from "nothing works".
//
// The arithmetic is shared with the authorizers rather than copied (see
// rateLimitState and pathAllowed in finance/ventures.js). A readiness report
// that disagrees with the gate it describes would be worse than no report: a
// team told it is clear and then refused stops believing either.

import { getKillSwitch } from './killSwitch.js';
import { dailyCapUsd, getSpendToday } from './spend.js';
import { isPlanRequired, getApprovedPlan, isCoveredByApprovedPlan, getPlan } from './dailyPlan.js';
import { isGithubConfigured } from './deploy/github.js';
import { isEmailConfigured } from './email.js';
import { isInboxConfigured } from './inbox.js';
import { getVenture, rateLimitState, pathAllowed, assertChecksNotOverdue } from './finance/ventures.js';

/**
 * One gate's verdict.
 *
 * `fix` is the part that makes this worth building. "Deployments are not
 * enabled" tells an agent it is stuck; "the founder turns this on in the
 * Ventures panel" tells it what to ask for, which is the difference between a
 * blocked day and a one-line message to the founder.
 *
 * `founderCommand` is the same instruction for the founder rather than the
 * agent, and it exists because the founder reads this on a phone. "Turn it on
 * in the Ventures panel" is a task; "send DEPLOY ON v_123" is done before they
 * have put the phone down. Only the gates a founder can actually open from a
 * message carry one — a missing GITHUB_TOKEN is a Railway variable, and
 * pretending otherwise would be worse than saying nothing.
 */
function gate(name, open, detail, fix = '', founderCommand = '') {
  return { name, open, detail, fix, founderCommand };
}

function haltGate() {
  const state = getKillSwitch();
  return gate(
    'Real actions allowed',
    !state.halted,
    state.halted ? `Halted. ${state.reason}`.trim() : 'Not halted.',
    state.envLocked
      ? 'REAL_ACTIONS_DISABLED is set on the server — only the founder can unset it.'
      : 'The founder resumes real actions from the Ventures panel or by WhatsApp.',
    state.envLocked ? '' : 'RESUME',
  );
}

function spendGate() {
  const cap = dailyCapUsd();
  const spent = getSpendToday();
  if (!cap) return gate('Daily spend cap', true, 'No cap set.', '');
  const open = spent < cap;
  return gate(
    'Daily spend cap',
    open,
    `$${spent.toFixed(2)} of $${cap.toFixed(2)} used today.`,
    open ? '' : 'Nothing more runs today. The founder raises DAILY_SPEND_CAP_USD, or this waits for tomorrow.',
  );
}

function ventureGate(venture, id) {
  if (!venture) {
    return gate('Venture', false, `No venture with id "${id}".`, 'Check the id against the business context.');
  }
  return gate(
    'Venture active',
    venture.status === 'active',
    `"${venture.title}" is ${venture.status}.`,
    venture.status === 'active' ? '' : 'A killed venture cannot act. Nothing will change this.',
  );
}

// The plan gate is reported separately from the rest because it is the only
// one an agent can open by itself — every other shut gate is a message to the
// founder, this one is work.
function planGate(ventureId, action, target) {
  if (!isPlanRequired()) {
    return gate('Approved daily plan', true, 'Not required on this server.', '');
  }
  const approved = getApprovedPlan();
  if (!approved) {
    const plan = getPlan();
    const pending = plan?.pending;
    return gate(
      'Approved daily plan',
      false,
      pending ? 'A plan is waiting on the founder.' : 'No plan is approved.',
      pending
        ? 'The founder approves or rejects it. You can submit a better one at any time — there is no queue.'
        : 'Submit one with submit_daily_plan covering this action. It can be approved in one message.',
    );
  }
  const covered = isCoveredByApprovedPlan({ ventureId, action, target });
  return gate(
    'Approved daily plan',
    covered,
    covered ? `The approved plan covers "${action}".` : `The approved plan does not cover "${action}"${target ? ` on ${target}` : ''}.`,
    covered ? '' : 'Do what is in the plan, or submit a new one covering this — it replaces the current one on approval.',
  );
}

function capGates(entries, timestampKey, scope, label) {
  const state = rateLimitState({ entries, timestampKey, scope });
  return [
    gate(
      `Weekly ${label} cap`,
      state.weekOk,
      `${state.inWeek} of ${state.maxPerWeek} this week.`,
      state.weekOk ? '' : `The founder raises the weekly cap for this venture, or this waits.`,
      state.weekOk ? '' : 'CAPS <ventureId> <per day> <per week>',
    ),
    gate(
      `Daily ${label} cap`,
      state.dayOk,
      `${state.inDay} of ${state.maxPerDay} today.`,
      state.dayOk ? '' : 'The founder raises the daily cap, or this waits for tomorrow.',
      state.dayOk ? '' : 'CAPS <ventureId> <per day> <per week>',
    ),
    gate(
      'Cooldown',
      state.cooldownOk,
      state.cooldownOk ? 'Clear.' : `${Math.ceil(state.cooldownRemainingMs / 1000)}s left.`,
      state.cooldownOk ? '' : 'Wait it out. This one clears on its own.',
    ),
  ];
}

function checksGate(venture) {
  try {
    assertChecksNotOverdue(venture);
    return gate('Checks up to date', true, 'Nothing overdue.', '');
  } catch (err) {
    return gate('Checks up to date', false, err.message, 'Call run_checks. This one you can open yourself.');
  }
}

/**
 * Every gate on committing to a venture's repo, in the order they are checked.
 *
 * `path` is optional. Without it the allowlist gate reports what is allowed
 * rather than judging a specific file, which is the more useful answer to
 * "what can I touch" — the question that actually precedes a deploy.
 */
export function deployReadiness(ventureId, { path } = {}) {
  const venture = getVenture(ventureId);
  const gates = [
    gate(
      'GitHub configured',
      isGithubConfigured(),
      isGithubConfigured() ? 'GITHUB_TOKEN is set.' : 'No GITHUB_TOKEN on this server.',
      isGithubConfigured() ? '' : 'The founder sets GITHUB_TOKEN in the deployment environment.',
    ),
    haltGate(),
    spendGate(),
    ventureGate(venture, ventureId),
  ];

  if (!venture || venture.status !== 'active') return summarize(gates, 'deploy');

  gates.push(
    gate(
      'Repo linked',
      Boolean(venture.repo),
      venture.repo ? `${venture.repo.owner}/${venture.repo.name}, branch ${venture.repo.branch}.` : 'No repo linked.',
      venture.repo ? '' : 'The founder links one in the Ventures panel — or the team links it itself if the repo is in AUTONOMOUS_DEPLOY_REPOS.',
    ),
  );
  if (!venture.repo) return summarize(gates, 'deploy');

  gates.push(
    gate(
      'Deployments enabled',
      Boolean(venture.repo.enabled),
      venture.repo.enabled ? 'On.' : 'Off — the repo is linked but writes are not turned on.',
      venture.repo.enabled ? '' : 'The founder turns this on in the Ventures panel. One switch.',
      venture.repo.enabled ? '' : `DEPLOY ON ${ventureId}`,
    ),
    gate(
      'Path in scope',
      path ? pathAllowed(venture.repo, path) : true,
      path
        ? `"${path}" is ${pathAllowed(venture.repo, path) ? 'inside' : 'outside'} ${venture.repo.allowedPaths.join(', ') || 'no allowed paths'}.`
        : `Allowed: ${venture.repo.allowedPaths.join(', ') || 'nothing'}.`,
      path && !pathAllowed(venture.repo, path) ? 'Work inside the allowed paths, or ask the founder to widen the scope — naming the exact path.' : '',
      path && !pathAllowed(venture.repo, path)
        ? `LINK ${ventureId} ${venture.repo.owner}/${venture.repo.name} <paths including this one>`
        : '',
    ),
    ...capGates(venture.deployments, 'deployedAt', venture.repo, 'deployment'),
    checksGate(venture),
    planGate(ventureId, 'deploy_code', path),
  );

  return summarize(gates, 'deploy');
}

/**
 * Every gate on sending a real customer email.
 */
export function outreachReadiness(ventureId, { to } = {}) {
  const venture = getVenture(ventureId);
  const gates = [
    gate(
      'Email configured',
      isEmailConfigured(),
      isEmailConfigured() ? 'SMTP is set.' : 'No SMTP on this server.',
      isEmailConfigured() ? '' : 'The founder sets SMTP_HOST and REPORT_EMAIL_TO in the deployment environment.',
    ),
    // Reported even though nothing blocks on it, because a company that can
    // send and not receive is broken in a way no refusal will ever mention.
    gate(
      'Replies visible',
      isInboxConfigured(),
      isInboxConfigured() ? 'Inbound mail is readable with check_replies.' : 'No inbound mailbox — replies are invisible.',
      isInboxConfigured() ? '' : 'The founder sets IMAP_HOST, IMAP_USER and IMAP_PASS. Outreach works without it; you just never hear back.',
    ),
    haltGate(),
    spendGate(),
    ventureGate(venture, ventureId),
  ];

  if (!venture || venture.status !== 'active') return summarize(gates, 'outreach');

  gates.push(
    gate(
      'Outreach scope set',
      Boolean(venture.outreach),
      venture.outreach ? `Allowed: ${venture.outreach.allowedRecipients.join(', ') || 'nobody'}.` : 'No outreach scope.',
      venture.outreach ? '' : 'The founder sets an allowlist of recipients in the Ventures panel.',
      venture.outreach ? '' : `OUTREACH ${ventureId} <emails or @domains>`,
    ),
  );
  if (!venture.outreach) return summarize(gates, 'outreach');

  const allowed = to
    ? venture.outreach.allowedRecipients.some((entry) => {
        const normalized = String(entry).toLowerCase();
        const address = String(to).toLowerCase();
        return normalized.startsWith('@') ? address.endsWith(normalized) : address === normalized;
      })
    : true;

  gates.push(
    gate(
      'Outreach enabled',
      Boolean(venture.outreach.enabled),
      venture.outreach.enabled ? 'On.' : 'Off.',
      venture.outreach.enabled ? '' : 'The founder turns this on in the Ventures panel.',
      venture.outreach.enabled ? '' : `OUTREACH ON ${ventureId}`,
    ),
    gate(
      'Recipient allowed',
      allowed,
      to ? `"${to}" is ${allowed ? 'inside' : 'outside'} the allowlist.` : `Allowed: ${venture.outreach.allowedRecipients.join(', ') || 'nobody'}.`,
      to && !allowed ? 'Ask the founder to add this address, naming who they are and why.' : '',
      to && !allowed ? `OUTREACH ${ventureId} ${to}` : '',
    ),
    ...capGates(venture.sentEmails, 'sentAt', venture.outreach, 'outreach'),
    planGate(ventureId, 'send_customer_email', to),
  );

  return summarize(gates, 'outreach');
}

function summarize(gates, action) {
  const shut = gates.filter((g) => !g.open);
  return {
    action,
    ready: shut.length === 0,
    gates,
    shut,
    // The first shut gate is the one an attempt would actually hit, and saying
    // so stops a team from fixing the third thing on a list and trying again.
    blockedBy: shut[0] || null,
  };
}

/**
 * The report an agent reads.
 *
 * Deliberately shows the open gates too. A list containing only failures reads
 * as "everything is broken" whatever it actually says, and the difference
 * between one shut door and eleven is the difference between a message to the
 * founder and a strategy conversation.
 */
export function formatReadiness(report) {
  const lines = report.gates.map((g) => `  ${g.open ? '[ok]' : '[--]'} ${g.name}: ${g.detail}`);

  if (report.ready) {
    return [`Ready to ${report.action}. All ${report.gates.length} checks pass:`, ...lines].join('\n');
  }

  const asks = report.shut.filter((g) => g.fix).map((g) => `  · ${g.name} — ${g.fix}`);
  return [
    `Not ready to ${report.action}. ${report.shut.length} of ${report.gates.length} checks are shut:`,
    ...lines,
    '',
    `First thing an attempt would hit: ${report.blockedBy.name} — ${report.blockedBy.detail}`,
    ...(asks.length ? ['', 'What opens them:', ...asks] : []),
  ].join('\n');
}

/**
 * The same report for the founder, who is reading it on a phone.
 *
 * formatReadiness shows the open gates on purpose: an agent handed only
 * failures reads "everything is broken" whatever the text says, and the
 * difference between one shut door and eleven changes what it does next.
 *
 * None of that transfers to the founder. They are not going to conclude the
 * company is broken — they asked one question, "what is stopping it", and a
 * twelve-line audit with two lines of signal in it does not answer that on a
 * phone, it just gets scrolled. So this drops everything that already works
 * and leads with what they can type.
 */
export function formatReadinessBrief(report) {
  if (report.ready) return `Nothing is blocking ${report.action}.`;

  const lines = report.shut.map((g) => `  · ${g.name}: ${g.detail}`);
  const commands = [...new Set(report.shut.map((g) => g.founderCommand).filter(Boolean))];

  // Gates the founder cannot open from a message still get named — a missing
  // SMTP_HOST is a Railway variable, and silently omitting it would leave them
  // believing the two commands below are the whole story.
  const elsewhere = report.shut
    .filter((g) => !g.founderCommand && g.fix)
    .map((g) => `  · ${g.name} — ${g.fix}`);

  return [
    `Blocked on ${report.action} — ${report.shut.length} of ${report.gates.length}:`,
    ...lines,
    ...(commands.length ? ['', 'Send any of these to fix it:', ...commands.map((c) => `  ${c}`)] : []),
    ...(elsewhere.length ? ['', 'These are not a message — they need the Railway settings:', ...elsewhere] : []),
  ].join('\n');
}
