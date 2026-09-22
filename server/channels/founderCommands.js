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

import { pendingDrafts, releasableDrafts, getDraft, approveDraft, rejectDraft } from '../outreachDrafts.js';
import { listSearches, searchBalance } from '../searchLog.js';
import { haltRealActions, resumeRealActions } from '../killSwitch.js';
import { getSpendSummary } from '../spend.js';
import {
  listVentures,
  getVenture,
  linkRepo,
  linkOutreachScope,
  setOutreachEnabled,
  setDeploymentEnabled,
  setDeploymentCaps,
  setServiceUrl,
  clearServiceUrl,
  setPricing,
  describePricing,
  setBookingUrl,
  recordConsent,
  blockContact,
  unblockContact,
  pipelineSummary,
  listObjectives,
  setDiscountFloor,
  setMcpEndpoint,
  clearDiscountFloor,
  describePricing as describeVenturePricing,
} from '../finance/ventures.js';
import { getLatestDailyReport } from '../dailyReports.js';
import { withdrawPlan, getApprovedPlan } from '../dailyPlan.js';
import { listAffordableModels } from '../agents/openrouter.js';
import { listTasks } from '../tasks.js';
import { describeDegradation } from '../degradation.js';
import { isEvalRunning } from '../eval/run.js';
import { deployReadiness, outreachReadiness, formatReadinessBrief } from '../readiness.js';

const COMMANDS = [
  { kind: 'help', re: /^(help|commands|\?)$/i },
  { kind: 'halt', re: /^(halt|stop|freeze)(?:\s+[:,\-–—]?\s*(.+))?$/i, arg: 'reason' },
  { kind: 'resume', re: /^(resume|unhalt|go\s+live)$/i },
  { kind: 'spend', re: /^(spend|cost|budget)$/i },
  { kind: 'integrations', re: /^(integrations|connections|health)$/i },
  { kind: 'pitch', re: /^(pitch|pitch now|pitch of the day)$/i },
  { kind: 'ventures', re: /^(ventures|portfolio|list\s+ventures)$/i },
  // The founder's own version of the team's check_ready.
  //
  // The report that names every shut gate was built for agents and reachable
  // only by them, which left the founder's actual question — "why is the team
  // blocked and what can I do" — answerable by the company and not askable by
  // the person who needed it. VENTURES says what a venture is allowed to do;
  // this says what is stopping it right now, which is a different question and
  // the one that gets typed at 7am.
  //
  // No venture id shows every active venture, because the founder asking this
  // usually does not have an id to hand and should not need one.
  // Not "why". A bare "why" is ordinary prose far more often than it is a
  // command, and hijacking it would swallow a real message to the team — the
  // exact failure the venture-id requirement above exists to prevent.
  { kind: 'ready', re: /^(ready|blocked)(?:\s+(v_\S+))?$/i, arg: 'ventureId' },
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
  // The company as a picture. A list sorts by name; a graph sorts by
  // structure, and "who did the CEO actually talk to" is one look at a picture
  // and a paragraph of text.
  { kind: 'graph', re: /^(graph|map|org\s+chart|chart)$/i },
  // The Build tab, as text. The tab is the better view; this is the one that
  // works without leaving the conversation the founder is already in.
  { kind: 'build', re: /^build(?:\s+(v_\S+))?$/i, arg: 'ventureId' },
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
  { kind: 'service_url_clear', re: /^url\s+clear\s+(v_\S+)$/i, arg: 'ventureId' },
  // Price, on the record. "price v_123 149 0.02 page" — floor per month, then
  // the per-unit rate and its unit. Either number may be 0.
  { kind: 'price', re: /^price\s+(v_\S+)\s+([\d.]+)(?:\s+([\d.]+)\s+([a-z_-]+))?(?:\s+([a-z]{3}))?$/i },
  // Where "let's talk" lands.
  { kind: 'booking', re: /^booking\s+(v_\S+)\s+(https:\/\/\S+)$/i },
  { kind: 'booking_clear', re: /^booking\s+clear\s+(v_\S+)$/i, arg: 'ventureId' },
  // The legal record: consent from an address that needs it, and the stop
  // list. See outreachCompliance.js.
  { kind: 'consent', re: /^consent\s+(v_\S+)\s+(\S+@\S+)$/i },
  { kind: 'block', re: /^block\s+(v_\S+)\s+(\S+@\S+)(?:\s+(.+))?$/i },
  { kind: 'unblock', re: /^unblock\s+(v_\S+)\s+(\S+@\S+)$/i },
  // The deal board and the objectives, as a message.
  { kind: 'pipeline', re: /^(pipeline|deals)(?:\s+(v_\S+))?$/i, arg: 'ventureId' },
  // Discounting is the founder's call, never the team's — see review.js. The
  // floor is arithmetic an agent cannot argue with; moving it is a message.
  { kind: 'discount_clear', re: /^discount\s+clear\s+(v_\S+)$/i, arg: 'ventureId' },
  { kind: 'discount', re: /^discount\s+(v_\S+)\s+([\d.]+)$/i },
  // Where an agent — someone else's, not ours — can reach the product.
  { kind: 'mcp_clear', re: /^mcp\s+clear\s+(v_\S+)$/i, arg: 'ventureId' },
  { kind: 'mcp', re: /^mcp\s+(v_\S+)\s+(https:\/\/\S+)$/i },
  // The rehearsal. Everything after the address is optional: "| subject |
  // body" to rehearse the founder's own words instead of the sample.
  { kind: 'dryrun', re: /^dry\s*run\s+(v_\S+)\s+(\S+@\S+)\s*(?:\|([^|]*)(?:\|([\s\S]*))?)?$/i },
  // Outreach the team wrote and cannot send. Short ids because these are typed
  // on a phone: "SEND d7", not a uuid pasted from somewhere there is nothing
  // to paste from.
  // What the team went looking for. The bias that matters lives in the
  // queries, not the findings — see searchLog.js.
  { kind: 'searches', re: /^searches?$/i },
  // Does our own output survive being checked? Costs a fetch and a cheap call
  // per claim, so it runs when asked.
  { kind: 'factcheck', re: /^fact\s*check$/i },
  { kind: 'drafts', re: /^drafts?$/i },
  { kind: 'draft_show', re: /^draft\s+(d\d+)$/i, arg: 'draftId' },
  { kind: 'draft_send', re: /^send\s+(d\d+)$/i, arg: 'draftId' },
  { kind: 'draft_bin', re: /^bin\s+(d\d+)(?:\s+(.+))?$/i },
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

// "url v_123 https://circadian-api.up.railway.app" — where the venture is
// actually deployed, so the team can check its own work with check_service.
//
// Founder-only on purpose. An agent naming the host would make check_service a
// server-side request forgery primitive (see execute/probe.js); the founder
// setting it once turns that into a narrow, read-only grant against one origin.
const SERVICE_URL_GRANT = /^url\s+(v_\S+)\s+(\S+)$/i;

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
      // The same reason caps is special-cased: more than one capture, and the
      // last one is not the argument.
      if (kind === 'price') {
        return {
          kind,
          ventureId: match[1],
          floorMonthly: Number(match[2]),
          perUnit: match[3] !== undefined ? Number(match[3]) : 0,
          unit: match[4] || '',
          currency: (match[5] || 'EUR').toUpperCase(),
        };
      }
      if (kind === 'booking') return { kind, ventureId: match[1], url: match[2] };
      if (kind === 'consent') return { kind, ventureId: match[1], email: match[2] };
      if (kind === 'block') return { kind, ventureId: match[1], email: match[2], reason: (match[3] || 'blocked by founder').trim() };
      if (kind === 'unblock') return { kind, ventureId: match[1], email: match[2] };
      if (kind === 'discount') return { kind, ventureId: match[1], floor: Number(match[2]) };
      if (kind === 'mcp') return { kind, ventureId: match[1], url: match[2] };
      if (kind === 'draft_bin') return { kind, draftId: match[1].toLowerCase(), reason: (match[2] || '').trim() };
      if (kind === 'dryrun') {
        return {
          kind,
          ventureId: match[1],
          to: match[2],
          subject: (match[3] || '').trim(),
          body: (match[4] || '').trim(),
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

  const serviceUrl = raw.match(SERVICE_URL_GRANT);
  if (serviceUrl) {
    return { kind: 'service_url', ventureId: serviceUrl[1], url: serviceUrl[2] };
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
  const service = venture.service?.origin
    ? venture.service.origin
    : 'no service URL — they cannot check if it is up';
  return `${venture.title}\n  ${venture.id}\n  ${repo}\n  ${outreach}\n  ${service}`;
}

// The build, as a phone message.
//
// The Build tab in the app shows the same thing and shows it better. This
// exists because the founder lives in WhatsApp, and a view that requires
// opening another app is a view that gets checked once a day instead of
// whenever they wonder.
//
// Ordered the way the tab is, for the same reason: what is happening now,
// what landed, what broke. Symbols rather than words for the task states —
// on a narrow screen a column of ticks is scannable in a way that "done /
// done / in progress" is not.
const TASK_SYMBOL = {
  done: '✅',
  running: '⏳',
  queued: '⬜',
  failed: '❌',
  cancelled: '⊘',
};

function formatBuildForWhatsApp(venture) {
  const tasks = listTasks({ ventureId: venture.id });
  const done = tasks.filter((t) => t.status === 'done').length;
  const open = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
  const { spentUsd, capUsd } = getSpendSummary();

  const repo = venture.repo
    ? `${venture.repo.owner}/${venture.repo.name}${venture.repo.enabled ? '' : ' (deploys OFF)'}`
    : 'no repo linked — nothing can ship until there is one';

  const lines = [`${venture.title} — ${repo}`];
  lines.push(`${done} done · ${open} to go · $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} today`);

  if (tasks.length) {
    lines.push('');
    for (const t of tasks) {
      // The failure reason is the whole reason to look at this on a phone:
      // it is what decides between waiting and stepping in.
      const why = t.error ? `\n     ${t.error}` : '';
      lines.push(`${TASK_SYMBOL[t.status] || '⬜'} ${t.title}${why}`);
    }
  } else {
    lines.push('', 'No work written down yet.');
  }

  const lastCommit = (venture.deployments || []).slice(-1)[0];
  if (lastCommit) {
    lines.push('', `Last commit: ${lastCommit.path}`);
    if (lastCommit.commitUrl) lines.push(lastCommit.commitUrl);
  }

  const lastRun = (venture.runs || []).slice(-1)[0];
  if (lastRun) {
    const ok = lastRun.conclusion === 'success';
    lines.push('', `Checks: ${ok ? '✅' : '❌'} ${lastRun.workflow} — ${lastRun.conclusion || lastRun.status}`);
    for (const failure of (lastRun.failures || []).slice(0, 3)) lines.push(`   ${failure}`);
  } else {
    lines.push('', 'Checks have never run — nobody knows yet whether this works.');
  }

  const degraded = describeDegradation();
  if (degraded) lines.push('', degraded);

  return lines.join('\n');
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
READY [ventureId] — what is actually stopping the team, and what opens it
BUILD [ventureId] — what the team is building right now
SPEND — today's model spend against the cap
INTEGRATIONS — what's actually connected
MODELS [search] — live OpenRouter models and their prices
REPORT — the latest daily report
PITCH — generate today's pitch now and email it, exactly as the 8am one
GRAPH — the company as a live picture, as a link
EVAL [scenario] — grade the agents' judgment against the eval scenarios
PLAN — today's plan (APPROVE / REJECT <reason> to decide it)
PLAN CLEAR <reason> — withdraw clearance you already gave

LINK <ventureId> <owner/repo> [paths] — grant a repo and turn deploys on
URL <ventureId> <https://...> — where it's deployed, so they can check it's up
URL CLEAR <ventureId> — revoke that
OUTREACH <ventureId> <emails or @domains> — grant and enable an outreach scope
OUTREACH OFF <ventureId> — revoke it
CAPS <ventureId> <per day> [per week] — how often they may commit
PRICE <ventureId> <floor/month> [<per unit> <unit>] [ccy] — the price, on record
BOOKING <ventureId> <https://...> — where a prospect books a call
CONSENT <ventureId> <email> — record consent from a .de/.it address
BLOCK <ventureId> <email> — never contact this person again
UNBLOCK <ventureId> <email> — lift that
PIPELINE [ventureId] — every deal, its stage and value, and open objectives
DISCOUNT <ventureId> <floor> — authorise quoting below list, until you clear it
DISCOUNT CLEAR <ventureId> — back to list price
MCP <ventureId> <https://...> — where other people's agents can reach the product
MCP CLEAR <ventureId> — remove it
DRYRUN <ventureId> <email> — rehearse the whole outreach path; the message comes to you, never to them
DRYRUN <ventureId> <email> | subject | body — same, with your own words
SEARCHES — what the team actually went looking for
FACTCHECK — open the sources the team cited and see if they say what was claimed
DRAFTS — outreach the team has written and is waiting on you
DRAFT d1 — read one in full
SEND d1 — release it (still passes every gate a normal send passes)
BIN d1 <reason> — bin it
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
      const { spentUsd, capUsd, date, overCap, cache } = getSpendSummary();
      const pct = capUsd > 0 ? Math.round((spentUsd / capUsd) * 100) : 0;
      const headline = overCap
        ? `$${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} for ${date} — over the cap. Agent turns are being refused until tomorrow.`
        : `$${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} for ${date} (${pct}%).`;
      // Spend is exactly where a silent fallback shows up as a number the
      // founder is already looking at.
      // Whether caching is paying for itself, in the one place the founder
      // already looks at cost. A low rate is not a curiosity: it means the
      // company is paying a 25% surcharge on input it never reads back.
      const cacheLine = cache
        ? `\n\nPrompt cache: ${Math.round(cache.hitRate * 100)}% of cached input was reused.` +
          (cache.hitRate < 0.2
            ? ' That is low — at this rate caching costs more than sending the tokens plainly.'
            : '')
        : '';
      const degraded = describeDegradation();
      return [headline + cacheLine, degraded].filter(Boolean).join('\n\n');
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

    case 'ready': {
      const ventures = command.ventureId
        ? [getVenture(command.ventureId)].filter(Boolean)
        : listVentures().filter((v) => v.status === 'active');

      if (!ventures.length) {
        return command.ventureId
          ? `No venture with id ${command.ventureId}.`
          : 'No active ventures, so nothing is blocked. Ask the team to start one.';
      }

      const sections = ventures.map((venture) => {
        const deploy = deployReadiness(venture.id);
        // Outreach is only worth reporting once the founder has set a scope up.
        // Before that the answer is always the same missing scope, and printing
        // it next to every venture teaches the founder to skim the whole thing.
        const outreach = venture.outreach ? outreachReadiness(venture.id) : null;

        const parts = [`"${venture.title}" [${venture.id}]`, formatReadinessBrief(deploy)];
        if (outreach && !outreach.ready) parts.push('', formatReadinessBrief(outreach));
        return parts.join('\n');
      });

      const stuck = ventures.filter((v) => !deployReadiness(v.id).ready).length;
      const headline = stuck
        ? `${stuck} of ${ventures.length} venture${ventures.length === 1 ? '' : 's'} cannot commit right now.`
        : `Nothing is blocking ${ventures.length === 1 ? 'the venture' : 'any venture'} from committing. If the team says it is blocked, the blocker is not a permission.`;

      return `${headline}\n\n${sections.join('\n\n---\n\n')}`;
    }

    case 'eval': {
      if (!deps.startEval) return 'Running the eval is not available on this build.';
      if (isEvalRunning()) return 'An eval is already running. I\'ll send the result when it lands.';
      deps.startEval(command.scenarioId || null);
      return command.scenarioId
        ? `Running the "${command.scenarioId}" scenario against the real agents. This makes billed API calls; I'll send the result when it finishes.`
        : 'Running all eval scenarios against the real agents. This takes a few minutes and makes billed API calls — it counts against today\'s spend cap like any other work. I\'ll send the score and every failure when it finishes.';
    }

    case 'build': {
      const venture = command.ventureId
        ? getVenture(command.ventureId)
        : listVentures().filter((v) => v.status === 'active').slice(-1)[0];
      if (!venture) {
        return command.ventureId
          ? `No venture with id ${command.ventureId}.`
          : 'No active ventures yet. Ask the team to start one.';
      }
      return formatBuildForWhatsApp(venture);
    }

    case 'price': {
      const venture = setPricing(command.ventureId, {
        currency: command.currency,
        floorMonthly: command.floorMonthly,
        unit: command.unit,
        perUnit: command.perUnit,
      });
      return `Price set on "${venture.title}": ${describePricing(venture)}. The team can now create payment links from it and the CFO can value a customer.`;
    }

    case 'booking': {
      const venture = setBookingUrl(command.ventureId, command.url);
      return `Booking link set on "${venture.title}". Sales will include it whenever a prospect wants to talk.`;
    }

    case 'booking_clear': {
      const venture = setBookingUrl(command.ventureId, '');
      return `Booking link removed from "${venture.title}".`;
    }

    case 'consent': {
      const venture = recordConsent(command.ventureId, command.email);
      return `Consent recorded for ${command.email.toLowerCase()} on "${venture.title}". Keep the written consent somewhere you can produce it — this records that you have it, not the thing itself.`;
    }

    case 'block': {
      const venture = blockContact(command.ventureId, command.email, command.reason);
      return `${command.email.toLowerCase()} is blocked on "${venture.title}". No agent can email them again unless you UNBLOCK.`;
    }

    case 'unblock': {
      const venture = unblockContact(command.ventureId, command.email);
      return `${command.email.toLowerCase()} is no longer blocked on "${venture.title}".`;
    }

    case 'factcheck': {
      if (!deps.startFactCheck) return 'The fact check is not available on this build.';
      deps.startFactCheck();
      return 'Checking the claims the team has cited over the last fortnight against the pages they cite. It costs a fetch and a cheap model call each, so it takes a minute — the result finds you when it is done.';
    }

    case 'searches': {
      const recent = listSearches({ limit: 25 });
      if (!recent.length) return 'No searches on record yet. They are captured from the team\'s own turns, not self-reported.';
      const { total, disconfirming } = searchBalance();
      const lines = recent.map((entry) => `${entry.disconfirming ? '↯' : ' '} ${entry.agentId || '?'}: ${entry.query}`);
      return [
        `${total} search${total === 1 ? '' : 'es'} on record, ${disconfirming} of them looking for a reason something would not work (marked ↯).`,
        '',
        ...lines,
        '',
        'A pass with none of these produces supportive citations whether the idea is good or not — which is why the findings alone cannot tell you.',
      ].join('\n');
    }

    case 'drafts': {
      const waiting = pendingDrafts();
      const approved = releasableDrafts();
      if (!waiting.length && !approved.length) {
        return 'No outreach drafts are queued. The team writes them with draft_customer_email; nothing is sent until you release it.';
      }
      const lines = [];
      if (waiting.length) {
        lines.push(`${waiting.length} waiting on you:`);
        for (const d of waiting) lines.push(`  ${d.id} → ${d.to}\n     "${d.subject}"${d.why ? `\n     why: ${d.why}` : ''}`);
      }
      if (approved.length) {
        lines.push('', `${approved.length} approved, not yet gone out:`);
        for (const d of approved) lines.push(`  ${d.id} → ${d.to}${d.lastError ? `\n     stuck: ${d.lastError}` : ''}`);
      }
      lines.push('', 'DRAFT d1 to read one in full. SEND d1 to release it. BIN d1 <reason> to bin it.');
      return lines.join('\n');
    }

    case 'draft_show': {
      const draft = getDraft(command.draftId);
      if (!draft) return `No draft "${command.draftId}". Send DRAFTS to see what is queued.`;
      return [
        `${draft.id} — ${draft.status}`,
        `To: ${draft.to}`,
        `Subject: ${draft.subject}`,
        draft.why ? `Why them: ${draft.why}` : '',
        '',
        draft.body,
        '',
        '(The AI disclosure and opt-out line are added on send, not shown here.)',
        draft.status === 'pending' ? `\nSEND ${draft.id} to release it, BIN ${draft.id} <reason> to bin it.` : '',
      ]
        .filter((line) => line !== '')
        .join('\n');
    }

    case 'draft_send': {
      if (!deps.releaseDraft) return 'Releasing drafts is not available on this build.';
      const draft = getDraft(command.draftId);
      if (!draft) return `No draft "${command.draftId}". Send DRAFTS to see what is queued.`;
      try {
        approveDraft(command.draftId);
      } catch (err) {
        return err.message;
      }
      const { ok, message } = await deps.releaseDraft(command.draftId);
      if (ok) return `Sent ${draft.id} to ${draft.to}.\n\n${message}`;
      // Approved and refused is the normal state before the mailbox is
      // configured, so this says what is missing rather than reading as a
      // verdict on the message.
      return [
        `${draft.id} is approved but did not go out yet.`,
        '',
        message,
        '',
        'It stays in the queue and goes out on its own once that is fixed — you do not need to approve it again.',
      ].join('\n');
    }

    case 'draft_bin': {
      try {
        const draft = rejectDraft(command.draftId, command.reason);
        return `Binned ${draft.id}${command.reason ? `: ${command.reason}` : '.'} The team can write another.`;
      } catch (err) {
        return err.message;
      }
    }

    case 'dryrun': {
      if (!deps.dryRunOutreach) return 'The outreach dry run is not available on this build.';
      const { wouldSend, delivered, text } = await deps.dryRunOutreach({
        ventureId: command.ventureId,
        to: command.to,
        subject: command.subject,
        body: command.body,
      });
      // The full report is long for a phone. The verdict and anything shut
      // go here; the rendered message goes to the inbox.
      const shut = text
        .split('\n')
        .filter((line) => line.includes('SHUT') || line.includes('VETOED'))
        .map((line) => line.trim());
      return [
        wouldSend
          ? `Dry run passed: this would have gone to ${command.to}. Nothing was sent.`
          : `Dry run stopped: this would NOT have reached ${command.to}. Nothing was sent.`,
        shut.length ? `\n${shut.join('\n')}` : '',
        delivered
          ? '\nThe full report, with the message exactly as a prospect would have read it, is in your inbox.'
          : '\nNo email configured, so there is no inbox copy — set SMTP_HOST and REPORT_EMAIL_TO to get one.',
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'mcp': {
      const venture = setMcpEndpoint(command.ventureId, command.url);
      return `MCP endpoint recorded for "${venture.title}". The team will cite it when a prospect asks how their own tools can reach the product.`;
    }

    case 'mcp_clear': {
      const venture = setMcpEndpoint(command.ventureId, '');
      return `MCP endpoint cleared from "${venture.title}".`;
    }

    case 'discount': {
      const venture = setDiscountFloor(command.ventureId, command.floor);
      return `Discount floor set on "${venture.title}": the team may now quote down to ${venture.pricing?.currency || 'EUR'} ${command.floor.toFixed(2)} (list price is ${describeVenturePricing(venture)}). It applies until you send "DISCOUNT CLEAR ${command.ventureId}".`;
    }

    case 'discount_clear': {
      const venture = clearDiscountFloor(command.ventureId);
      return `Discount cleared on "${venture.title}". Back to list price: ${describeVenturePricing(venture)}.`;
    }

    case 'pipeline': {
      const ventures = command.ventureId
        ? [getVenture(command.ventureId)].filter(Boolean)
        : listVentures().filter((v) => v.status === 'active');
      if (!ventures.length) return command.ventureId ? `No venture with id ${command.ventureId}.` : 'No active ventures.';
      return ventures
        .map((v) => {
          const summary = pipelineSummary(v.id);
          const stages = Object.entries(summary.byStage).map(([k, n]) => `${k} ${n}`).join(', ') || 'empty';
          const objectives = listObjectives(v.id);
          const rows = Object.entries(v.pipeline || {})
            .sort((a, b) => (b[1].dealValueMonthly || 0) - (a[1].dealValueMonthly || 0))
            .slice(0, 8)
            .map(([email, d]) => `  · ${email} — ${d.stage || 'lead'}${d.dealValueMonthly ? `, ${d.dealValueMonthly}/mo` : ''}${d.nextAction ? ` — next: ${d.nextAction}` : ''}`);
          return [
            `"${v.title}" [${v.id}] — price: ${describePricing(v)}`,
            `Pipeline: ${stages}. Open: ${summary.pipelineMonthly.toFixed(0)}/mo. Paying: ${summary.payingMonthly.toFixed(0)}/mo.`,
            ...rows,
            objectives.length ? `Objectives: ${objectives.map((o) => `${o.key} → ${o.target}${o.by ? ` by ${o.by}` : ''}`).join('; ')}` : 'No open objectives.',
          ].join('\n');
        })
        .join('\n\n');
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

    case 'pitch': {
      // Runs the same code the 8am cycle runs, so what comes back is what
      // tomorrow's email will look like — not a preview of it. The email is
      // sent as well; the text is returned so the founder reads it here
      // without switching apps.
      if (!deps.runPitch) return 'The pitch generator is not available on this build.';
      const { email, pitch, sent } = await deps.runPitch();
      const head = pitch
        ? `Pitched, and ${sent ? 'emailed' : 'not emailed'}. This is what the 8am one will look like:`
        : 'No pitch came back. This is exactly the email the morning cycle would have sent:';
      return `${head}\n\n${email.subject}\n\n${email.text}`;
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

    case 'graph': {
      const { graphLink, viewTokenTtlMs } = await import('../viewToken.js');
      const link = graphLink();
      if (!link.startsWith('http')) {
        return (
          'The graph is at /graph on this server, but I do not know the public URL to build you a link.\n\n' +
          'Set PUBLIC_URL in Railway (or let RAILWAY_PUBLIC_DOMAIN be set) and send GRAPH again.'
        );
      }
      const minutes = Math.round(viewTokenTtlMs() / 60000);
      return (
        `${link}\n\n` +
        `Tap to open. Drag to pan, pinch to zoom, drag a node to pull it, tap a node for its model, ` +
        `cost and whether it ran this morning.\n\n` +
        `The link expires in ${minutes} minutes — a WhatsApp message gets forwarded and backed up, so ` +
        `it is deliberately not a permanent key. Send GRAPH again for a fresh one.`
      );
    }

    case 'service_url': {
      // setServiceUrl validates the URL and throws with the reason, which is
      // the message the founder needs — "that is http" rather than "invalid".
      const venture = setServiceUrl(command.ventureId, command.url);
      return `"${venture.title}" is deployed at ${venture.service.origin}.\n\nThe team can now run a real request against it and see what comes back, which is the only thing that proves the product works — a passing CI run does not.\n\nURL CLEAR ${command.ventureId} revokes it.`;
    }

    case 'service_url_clear': {
      const venture = clearServiceUrl(command.ventureId);
      return `Cleared the service URL for "${venture.title}". They can no longer check whether it is up, so they will have to take CI's word for it.`;
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
