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
  linkOutreachScope,
  setOutreachEnabled,
  setDeploymentEnabled,
} from '../finance/ventures.js';
import { getLatestDailyReport } from '../dailyReports.js';

const COMMANDS = [
  { kind: 'help', re: /^(help|commands|\?)$/i },
  { kind: 'halt', re: /^(halt|stop|freeze)(?:\s+[:,\-–—]?\s*(.+))?$/i, arg: 'reason' },
  { kind: 'resume', re: /^(resume|unhalt|go\s+live)$/i },
  { kind: 'spend', re: /^(spend|cost|budget)$/i },
  { kind: 'integrations', re: /^(integrations|connections|health)$/i },
  { kind: 'ventures', re: /^(ventures|portfolio|list\s+ventures)$/i },
  { kind: 'report', re: /^(report|daily\s+report|latest\s+report)$/i },
  // Scope switches. Venture ids are v_<digits>_<suffix>, which is not
  // something a sentence produces by accident — requiring one is most of
  // what keeps these from firing on ordinary prose.
  { kind: 'outreach_off', re: /^outreach\s+off\s+(\S+)$/i, arg: 'ventureId' },
  { kind: 'outreach_on', re: /^outreach\s+on\s+(\S+)$/i, arg: 'ventureId' },
  { kind: 'deploy_off', re: /^deploy(?:ments?)?\s+off\s+(\S+)$/i, arg: 'ventureId' },
  { kind: 'deploy_on', re: /^deploy(?:ments?)?\s+on\s+(\S+)$/i, arg: 'ventureId' },
];

// "outreach v_123 @acme.com, someone@corp.com" — the grant itself, which
// needs two captures and so doesn't fit the table above.
const OUTREACH_GRANT = /^outreach\s+(v_\S+)\s+(.+)$/i;

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
      // The argument is always the last capture group: some patterns group
      // the verb's synonyms first ("halt|stop|freeze") and some don't, so a
      // fixed index silently reads the wrong group for half the table.
      const value = (match[match.length - 1] || '').trim();
      return arg ? { kind, [arg]: value || null } : { kind };
    }
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

const HELP = `Founder controls — send any of these on their own:

HALT <reason> — stop every real action now
RESUME — lift the halt
VENTURES — every venture, its id and what it's allowed to do
SPEND — today's model spend against the cap
INTEGRATIONS — what's actually connected
REPORT — the latest daily report
PLAN — today's plan (APPROVE / REJECT <reason> to decide it)

OUTREACH <ventureId> <emails or @domains> — grant and enable an outreach scope
OUTREACH OFF <ventureId> — revoke it
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
      return overCap
        ? `$${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} for ${date} — over the cap. Agent turns are being refused until tomorrow.`
        : `$${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} for ${date} (${pct}%).`;
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

    case 'report': {
      const report = getLatestDailyReport();
      if (!report) return 'No daily report yet — the first one lands after tomorrow morning\'s sync.';
      return `Daily report — ${report.date}\n\n${report.leadership.reply}`;
    }

    case 'integrations': {
      if (!deps.probeIntegrations) return 'Integration status is not available on this build.';
      const status = await deps.probeIntegrations();
      const lines = Object.entries(status)
        .filter(([, value]) => value && typeof value === 'object' && 'detail' in value)
        .map(([name, value]) => `${value.ok ? '✅' : value.configured ? '⚠️' : '—'} ${name}: ${value.detail}`);
      return lines.length ? lines.join('\n') : 'Nothing reported a status.';
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
