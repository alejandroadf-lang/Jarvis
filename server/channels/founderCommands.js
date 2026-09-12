// The founder's own controls, reachable from WhatsApp.
//
// Everything an *agent* may do already worked from a phone: the company turn
// carries the whole action set. What didn't were the controls that exist
// specifically to bound agents — the kill switch, the outreach allowlist,
// turning a venture's deployment off. Those lived only on founder-only HTTP
// endpoints, which in practice meant "open a browser", which in practice
// meant the founder couldn't stop the company from a phone.
//
// They are parsed here, before the company turn ever sees the words, for the
// same reason plan approval is (see dailyPlan.js's parsePlanCommand): an
// agent that interprets "halt" is an agent that can conclude it was resumed.
// These are precisely the powers the scope model says an agent must not
// grant itself — a tool that widens an outreach allowlist is an allowlist
// that bounds nothing, and a tool that lifts the founder's halt is not a
// halt. So they are deterministic string matches on the founder's own
// message, never a capability handed to a model.
//
// The matching is deliberately strict: a command has to be the whole
// message. "We should halt the Acme rollout" is a sentence about work, not
// an instruction to stop the company, and treating it as one would be the
// worst kind of helpful.

import { haltRealActions, resumeRealActions } from '../killSwitch.js';
import { getSpendSummary } from '../spend.js';
import {
  listVentures,
  linkRepo,
  linkOutreachScope,
  setOutreachEnabled,
  setDeploymentEnabled,
  setDeploymentCaps,
} from '../finance/ventures.js';
import { getLatestDailyReport } from '../dailyReports.js';
import { withdrawPlan, getApprovedPlan } from '../dailyPlan.js';
import { listAffordableModels } from '../agents/openrouter.js';
import { describeDegradation } from '../degradation.js';
import { isEvalRunning } from '../eval/run.js';

const COMMANDS = [
  { kind: 'help', re: /^(help|commands|\?)$/i },
  { kind: 'halt', re: /^(halt|stop|freeze)(?:\s+[:,\-–—]?\s*(.+))?$/i, arg: 'reason' },
  { kind: 'resume', re: /^(resume|unhalt|go\s+live)$/i },
  { kind: 'spend', re: /^(spend|cost|budget)$/i },
  { kind: 'integrations', re: /^(integrations|connections|health)$/i },
  { kind: 'ventures', re: /^(ventures|portfolio|list\s+ventures)$/i },
  { kind: 'models', re: /^models(?:\s+(\S+))?$/i, arg: 'search' },
  // Withdrawing an approval the founder already gave.
  //
  // approvePlan was a one-way door. submitPlan refuses while today's plan is
  // APPROVED, and parsePlanCommand only offers APPROVE/REJECT while one is
  // PENDING — so an approval, once given, locked the whole day with no
  // founder override anywhere. Approve a plan naming a venture that turns
  // out not to exist and the company is stuck until midnight UTC, unable to
  // do the work or to propose different work.
  //
  // rejectPlan already handled any status; it simply had no route to it.
  { kind: 'plan_clear', re: /^plan\s+clear(?:\s+(.+))?$|^(?:withdraw|unapprove)$/i, arg: 'reason' },
  { kind: 'report', re: /^(report|daily\s+report|latest\s+report)$/i },
  // Running the behavioural eval. It costs real money and takes minutes, so
  // it is started here and delivered when it finishes rather than awaited.
  { kind: 'eval', re: /^eval(?:\s+(\S+))?$/i, arg: 'scenarioId' },
  // Scope switches. Venture ids are v_<digits>_<suffix>, which is not
  // something a sentence produces by accident — requiring one is most of
  // what keeps these from firing on ordinary prose.
  { kind: 'outreach_off', re: /^outreach\s+off\s+(\S+)$/i, arg: 'ventureId' },
  { kind: 'outreach_on', re: /^outreach\s+on\s+(\S+)$/i, arg: 'ventureId' },
  { kind: 'deploy_off', re: /^deploy(?:ments?)?\s+off\s+(\S+)$/i, arg: 'ventureId' },
  { kind: 'deploy_on', re: /^deploy(?:ments?)?\s+on\s+(\S+)$/i, arg: 'ventureId' },
  // "caps v_123 12 40" — commits per day, then per week.
  { kind: 'caps', re: /^caps\s+(v_\S+)\s+(\d+)(?:\s+(\d+))?$/i },
];

// "outreach v_123 @acme.com, someone@corp.com" — the grant itself, which
// needs two captures and so doesn't fit the table above.
const OUTREACH_GRANT = /^outreach\s+(v_\S+)\s+(.+)$/i;

// "link v_123 owner/repo [src/ .github/workflows/]" — the founder granting a
// repo scope directly.
//
// This is the command that should have existed from the start. Without it,
// granting a repo was reachable only from the Ventures panel in a browser,
// or by an agent calling link_venture_repo — and the agent path runs through
// assertRepoIsPreApproved, so it needs AUTONOMOUS_DEPLOY_REPOS set in the
// environment first. Both routes mean leaving the conversation, which is how
// a company with a ready spec and a real repo spent a day blocked on the act
// of pointing one at the other.
//
// The founder path deliberately skips the pre-approval list: that list exists
// to bound what agents may grant themselves, and the founder granting a scope
// in person is the thing it was always deferring to.
const LINK_GRANT = /^link\s+(v_\S+)\s+([\w.-]+\/[\w.-]+)(?:\s+(.+))?$/i;

/**
 * Reads a founder's message as a control command, or null when it isn't one.
 * Null is the overwhelmingly common case: anything that isn't an exact match
 * falls through to the company turn, unchanged.
 */
export function parseFounderCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  for (const { kind, re, arg } of COMMANDS) {
    const match = raw.match(re);
    if (match) {
      if (kind === 'caps') {
        return {
          kind,
          ventureId: match[1],
          maxPerDay: Number(match[2]),
          // Default the weekly cap to five working days of the daily one,
          // rather than leaving a raised daily cap trapped under an old
          // weekly one it can never reach.
          maxPerWeek: match[3] ? Number(match[3]) : Number(match[2]) * 5,
        };
      }
      // The argument is always the last capture group: some patterns group
      // the verb's synonyms first ("halt|stop|freeze") and some don't, so a
      // fixed index silently reads the wrong group for half the table.
      const value = (match[match.length - 1] || '').trim();
      return arg ? { kind, [arg]: value || null } : { kind };
    }
  }

  const link = raw.match(LINK_GRANT);
  if (link) {
    const [owner, name] = link[2].split('/');
    const paths = (link[3] || '')
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return {
      kind: 'link_repo',
      ventureId: link[1],
      owner,
      name,
      // Defaults that match what the team actually needs: source, and the
      // workflow directory, without which run_checks has nothing to run.
      allowedPaths: paths.length ? paths : ['src/', '.github/workflows/'],
    };
  }

  const grant = raw.match(OUTREACH_GRANT);
  if (grant) {
    const recipients = grant[2]
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    // A grant with nothing to grant is a typo, and silently creating an
    // empty allowlist would read as success while blocking every send.
    if (recipients.length) {
      return { kind: 'outreach_grant', ventureId: grant[1], recipients };
    }
  }

  return null;
}

function describeVenture(venture) {
  const repo = venture.repo
    ? `${venture.repo.owner}/${venture.repo.name} (${venture.repo.enabled ? 'deploy ON' : 'deploy off'})`
    : 'no repo';
  const outreach = venture.outreach
    ? `outreach ${venture.outreach.enabled ? 'ON' : 'off'} → ${venture.outreach.allowedRecipients.join(', ') || 'nobody'}`
    : 'no outreach scope';
  return `${venture.title}\n  ${venture.id}\n  ${repo}\n  ${outreach}`;
}

// Three states, not two. ok === null means "set, but deliberately not
// probed" — Anthropic, email, GitHub — and rendering that as a warning told
// the founder their working Anthropic key was a problem, right above a line
// that actually was one.
function statusIcon(value) {
  if (value.ok === true) return '✅';
  if (value.ok === false) return '⚠️';
  return value.configured ? 'ℹ️' : '—';
}

const HELP = `Founder controls — send any of these on their own:

HALT <reason> — stop every real action now
RESUME — lift the halt
VENTURES — every venture, its id and what it's allowed to do
SPEND — today's model spend against the cap
INTEGRATIONS — what's actually connected
MODELS [search] — live OpenRouter models and their prices
REPORT — the latest daily report
EVAL [scenario] — grade the agents' judgment against the eval scenarios
PLAN — today's plan (APPROVE / REJECT <reason> to decide it)
PLAN CLEAR <reason> — withdraw clearance you already gave

LINK <ventureId> <owner/repo> [paths] — grant a repo and turn deploys on
OUTREACH <ventureId> <emails or @domains> — grant and enable an outreach scope
OUTREACH OFF <ventureId> — revoke it
CAPS <ventureId> <per day> [per week] — how often they may commit
DEPLOY OFF <ventureId> — stop commits for one venture
DEPLOY ON <ventureId> — allow them again

Anything else goes to the team as an ordinary message.`;

/**
 * Runs a parsed command and returns the reply to send back.
 *
 * The integration probe is injected rather than imported so this stays
 * testable without a network, and so importing the command layer never
 * drags the live probes in with it.
 *
 * @param {{kind: string}} command
 * @param {{probeIntegrations?: Function}} deps
 */
export async function runFounderCommand(command, deps = {}) {
  switch (command.kind) {
    case 'help':
      return HELP;

    case 'halt': {
      const state = haltRealActions(command.reason || 'Halted from WhatsApp.');
      return `Halted. Every real action — commits, customer email, workflow runs — is refused until you send RESUME.\n\nReason on record: ${state.reason}`;
    }

    case 'resume': {
      const state = resumeRealActions();
      return `Resumed at ${state.changedAt}. Real actions are live again, still inside whatever scopes each venture has.`;
    }

    case 'spend': {
      const { spentUsd, capUsd, date, overCap } = getSpendSummary();
      const pct = capUsd > 0 ? Math.round((spentUsd / capUsd) * 100) : 0;
      const headline = overCap
        ? `$${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} for ${date} — over the cap. Agent turns are being refused until tomorrow.`
        : `$${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} for ${date} (${pct}%).`;
      // Spend is exactly where a silent fallback shows up as a number the
      // founder is already looking at.
      const degraded = describeDegradation();
      return degraded ? `${headline}\n\n${degraded}` : headline;
    }

    case 'ventures': {
      const ventures = listVentures().filter((v) => v.status === 'active');
      if (!ventures.length) {
        return 'No active ventures. Ask the team to start one and they will send you the id.';
      }
      return `${ventures.length} active venture${ventures.length === 1 ? '' : 's'}:\n\n${ventures
        .map(describeVenture)
        .join('\n\n')}`;
    }

    case 'eval': {
      if (!deps.startEval) return 'Running the eval is not available on this build.';
      if (isEvalRunning()) return 'An eval is already running. I\'ll send the result when it lands.';
      deps.startEval(command.scenarioId || null);
      return command.scenarioId
        ? `Running the "${command.scenarioId}" scenario against the real agents. This makes billed API calls; I'll send the result when it finishes.`
        : 'Running all eval scenarios against the real agents. This takes a few minutes and makes billed API calls — it counts against today\'s spend cap like any other work. I\'ll send the score and every failure when it finishes.';
    }

    case 'report': {
      const report = getLatestDailyReport();
      if (!report) return 'No daily report yet — the first one lands after tomorrow morning\'s sync.';
      return `Daily report — ${report.date}\n\n${report.leadership.reply}`;
    }

    case 'plan_clear': {
      if (!getApprovedPlan()) return 'No plan is approved, so there is nothing to withdraw. The team can submit one at any time.';
      const plan = withdrawPlan({ reason: command.reason || 'Withdrawn by the founder.' });
      return `The approved plan is withdrawn${plan.note ? `: ${plan.note}` : '.'}\n\nNothing from it runs any more. The team can submit a new one right away — it takes effect the moment you approve it.`;
    }

    case 'models': {
      // A pinned model id is a hostage to someone else's catalogue. When one
      // retires, this is how the founder finds a live replacement without
      // leaving the conversation.
      const models = await listAffordableModels({ search: command.search || '' });
      if (!models.length) {
        return command.search
          ? `Nothing on OpenRouter matches "${command.search}".`
          : 'OpenRouter returned no models in that price range.';
      }
      const lines = models.map(
        (m) => `${m.id}\n  $${m.inputPricePerMTok.toFixed(2)} in / $${m.outputPricePerMTok.toFixed(2)} out per MTok`
      );
      return `${lines.join('\n')}\n\nTo switch, set OPENROUTER_MODEL in Railway to one of these ids — and set OPENROUTER_INPUT_PRICE_PER_MTOK and OPENROUTER_OUTPUT_PRICE_PER_MTOK to match, or the spend cap counts the wrong number.`;
    }

    case 'integrations': {
      if (!deps.probeIntegrations) return 'Integration status is not available on this build.';
      const status = await deps.probeIntegrations();
      const lines = Object.entries(status)
        .filter(([, value]) => value && typeof value === 'object' && 'detail' in value)
        .map(([name, value]) => `${statusIcon(value)} ${name}: ${value.detail}`);
      const degraded = describeDegradation();
      const body = lines.length ? lines.join('\n') : 'Nothing reported a status.';
      return degraded ? `${body}\n\n${degraded}` : body;
    }

    case 'link_repo': {
      linkRepo(command.ventureId, {
        owner: command.owner,
        name: command.name,
        branch: 'main',
        allowedPaths: command.allowedPaths,
      });
      const venture = setDeploymentEnabled(command.ventureId, true);
      return `"${venture.title}" is linked to ${command.owner}/${command.name} (branch main) and deployments are ON.\n\nThey may write: ${command.allowedPaths.join(', ')}\nCaps: ${venture.repo.maxPerDay}/day, ${venture.repo.maxPerWeek}/week.\n\nDEPLOY OFF ${command.ventureId} stops it.`;
    }

    case 'outreach_grant': {
      linkOutreachScope(command.ventureId, { allowedRecipients: command.recipients });
      const venture = setOutreachEnabled(command.ventureId, true);
      return `Outreach on for "${venture.title}". They may email: ${command.recipients.join(', ')}.\nCaps: ${venture.outreach.maxPerDay}/day, ${venture.outreach.maxPerWeek}/week. Send OUTREACH OFF ${command.ventureId} to revoke.`;
    }

    case 'outreach_on': {
      const venture = setOutreachEnabled(command.ventureId, true);
      return `Outreach on for "${venture.title}" — ${venture.outreach.allowedRecipients.join(', ')}.`;
    }

    case 'outreach_off': {
      const venture = setOutreachEnabled(command.ventureId, false);
      return `Outreach off for "${venture.title}". The allowlist is kept, so OUTREACH ON ${command.ventureId} brings it back.`;
    }

    case 'caps': {
      const venture = setDeploymentCaps(command.ventureId, {
        maxPerDay: command.maxPerDay,
        maxPerWeek: command.maxPerWeek,
      });
      return `"${venture.title}" can now commit ${venture.repo.maxPerDay} time${venture.repo.maxPerDay === 1 ? '' : 's'} a day, ${venture.repo.maxPerWeek} a week. Deployments stay ${venture.repo.enabled ? 'ON' : 'off'}.`;
    }

    case 'deploy_on': {
      const venture = setDeploymentEnabled(command.ventureId, true);
      return `Deployments on for "${venture.title}" → ${venture.repo.owner}/${venture.repo.name}.`;
    }

    case 'deploy_off': {
      const venture = setDeploymentEnabled(command.ventureId, false);
      return `Deployments off for "${venture.title}". The repo link is kept, so DEPLOY ON ${command.ventureId} brings it back.`;
    }

    default:
      return null;
  }
}

export const __helpForTests = HELP;
