import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from './agents/agentRunner.js';
import { listAgents } from './agents/registry.js';
import { AGENTS as COMPANY_AGENTS, ROOT_AGENT_ID as COMPANY_ROOT } from './agents/orgChart.js';
import { AGENTS as STUDIO_AGENTS, ROOT_AGENT_ID as STUDIO_ROOT } from './agents/ideationTeam.js';
import { loadSessions, saveSession, deleteSession,
  trimHistory,
} from './sessionStore.js';
import { getLedger } from './finance/ledger.js';
import { CIRCADIAN_PREFIX, circadianProxy, startCircadian, probeWhoop } from './circadian.js';
import {
  listVentures,
  getVenture,
  killVenture,
  linkRepo,
  setDeploymentEnabled,
  linkOutreachScope,
  setOutreachEnabled,
} from './finance/ventures.js';
import { buildCompanyContext, buildStudioContext, buildPerAgentContext, buildRepoManifests } from './finance/context.js';
import { recordExchange, buildFounderContext } from './memory/honcho.js';
import { readFounderSteering } from './workspace/vault.js';
import {
  handleProposeVenture,
  handleCalculate,
  handleVerifyClaim,
  handleLogRevenue,
  handleLogExpense,
  handleReportMilestoneProgress,
  handleKillVenture,
  handleDeployCode,
  handleDeployChanges,
  handleCheckReady,
  handleCheckUsage,
  handleCreatePaymentLink,
  handleUpdatePipeline,
  handleDraftCustomerEmail,
  handleListDrafts,
  handleSetObjective,
  handleOpenPullRequest,
  handleRevertCommit,
  handleSendCustomerEmail,
  handleCheckReplies,
  handleLogContactNote,
  handleRunChecks,
  handleListChecks,
  handleLinkVentureRepo,
  handleListApprovedRepos,
  handleSubmitDailyPlan,
  handleQueueWork,
  handleNextTask,
  handleStartTask,
  handleCompleteTask,
  handleFailTask,
  handleReadRepoFile,
  handleListRepoFiles,
  handleCheckService,
  handleLogVentureNote,
  handleCheckDailyPlan,
} from './actionHandlers.js';
import { listDailyReports, getDailyReport, getLatestDailyReport } from './dailyReports.js';
import { startDailyMeetingScheduler, runDailyMeetingNow, isDailyMeetingRunning } from './scheduler.js';
import { startWorkSessionScheduler } from './workSession.js';
import { studioActionHandlers } from './dailyMeeting.js';
import { getKillSwitch, haltRealActions, resumeRealActions } from './killSwitch.js';
import { getSpendSummary } from './spend.js';
import { getIntegrationStatus } from './integrations.js';
import { getProfitShare, listContributions, recordContribution } from './finance/profitShare.js';
import {
  verifyStripeSignature,
  interpretEvent,
  renewalTerms,
  cancelLink,
  contactEmail,
} from './payments.js';
import { showCancel, confirmCancel } from './billingCancel.js';
import { recordPayment, getVenture as getVentureForPayment } from './finance/ventures.js';
import { addTransaction as addLedgerTransaction } from './finance/ledger.js';
import { sendPaymentEmail, sendCallSummary, sendSubscriptionConfirmation } from './email.js';
import {
  isWhatsAppConfigured,
  verifyWebhookChallenge,
  sendWhatsAppMessage,
} from './channels/whatsapp.js';
import { recordInbound, recentInbound, STAGES } from './channels/whatsappLog.js';
import { listTasks } from './tasks.js';
import { getDegradationToday } from './degradation.js';
import { privacyPolicyHtml } from './privacy.js';
import { graphPageHtml } from './graphPage.js';
import { buildGraph } from './graph.js';
import { verifyViewToken } from './viewToken.js';
import { recordBoot, warnIfEphemeral } from './storage.js';
import {
  nextQueued,
  markRunning,
  complete as completeDeepDive,
  fail as failDeepDive,
  listDeepDives,
  queueDepth,
} from './deepDives.js';
import { recordUsage, mintIngestKey, verifyIngestKey, hasIngestKey, usageSummary } from './ventureUsage.js';
import { requireAccess, warnIfUnprotected, isAccessProtected, hasAppToken } from './auth.js';
import {
  getPlan,
  approvePlan,
  rejectPlan,
  listPlans,
  isPlanRequired,
} from './dailyPlan.js';
import { spokenReplyInstruction } from './speech.js';
import { attachCallStream, answerCallTwiml } from './realtime/twilioBridge.js';
import { isLanguageMenuEnabled, languageMenuTwiml, chosenLanguage } from './realtime/languageMenu.js';
import { verifyTwilioRequest } from './realtime/twilioAuth.js';
import { isDeskApiConfigured, verifyDeskKey, deskLookup, deskTicket, describeDeskApi } from './realtime/deskApi.js';
import { refuseCall, describeCalling, callMinutesRemaining, callMode } from './realtime/callPolicy.js';
import { mintBrowserSession, isBrowserCallConfigured } from './realtime/browserSession.js';
import { runSupportTool, supportDeskName } from './realtime/supportDesk.js';
import { replyLanguageInstruction, describeLanguageSetting } from './language.js';
import { listWeeklyReflections, getWeeklyReflection, getLatestWeeklyReflection } from './weeklyReflections.js';
import { startWeeklyReflectionScheduler, runWeeklyReflectionNow, isWeeklyReflectionRunning } from './weeklyScheduler.js';
import { startInboxWatcher } from './inboxWatch.js';
import { createWhatsAppInbound } from './channels/whatsappInbound.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// Above this, a turn is worth a line in the log saying who took the time.
const SLOW_TURN_MS = Number(process.env.SLOW_TURN_MS) > 0 ? Number(process.env.SLOW_TURN_MS) : 45000;

// How long a conversational turn gets before it stops widening and answers
// with what it has. Two minutes is about the limit of what someone holding a
// phone reads as thinking rather than broken. The question is not dropped —
// it goes to the deep-dive queue and comes back properly later.
const TURN_DEADLINE_MS = Number(process.env.TURN_DEADLINE_MS) > 0 ? Number(process.env.TURN_DEADLINE_MS) : 120000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Jarvis, a personal AI assistant. You are helpful, concise,
and quietly witty — never rambling. Address the user directly and skip unnecessary
preamble. When you don't know something, say so plainly instead of guessing.`;

// Trimming lives in sessionStore.js so all three chat modes share one policy
// — they used to share a constant, which is not the same thing as sharing a
// rule the moment one of them needs different handling.
// Each Map is seeded from disk at startup and kept in sync on every write
// via sessionStore.js, so conversation history survives a server restart.
const sessions = loadSessions('jarvis'); // sessionId -> [{ role, content }]
const companySessions = loadSessions('company'); // sessionId -> [{ role, content }], CEO-level only
const deskSessions = loadSessions('desk'); // sessionId -> [{ role, content }], one per stranger on the WhatsApp number
const studioSessions = loadSessions('studio'); // sessionId -> [{ role, content }], Venture Partner-level only

const app = express();
// First, ahead of the JSON parser (it would consume the body before it could be
// forwarded) and ahead of requireAccess (travellers never have the Jarvis
// token). See circadian.js.
app.use(CIRCADIAN_PREFIX, circadianProxy());
app.use(cors());
// The raw body is kept because Meta signs WhatsApp webhooks with an HMAC
// over exactly the bytes it sent; json() would parse and discard them, and
// re-serialising the parsed object does not reproduce the same bytes.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Before every route, so a new endpoint is protected by existing rather than
// by someone remembering to guard it.
app.use(requireAccess);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.ANTHROPIC_API_KEY) });
});

// Streams the reply back as plain text chunks (chunked transfer, no SSE
// framing needed) so the client can start speaking a sentence before the
// rest of the reply has even finished generating.
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
  }

  const history = sessions.get(sessionId) || [];
  history.push({ role: 'user', content: message });

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    stream.on('text', (delta) => res.write(delta));
    // Without a listener, the SDK also fires an independent unhandled promise
    // rejection on stream errors (on top of the one finalMessage() below
    // surfaces) — that can crash the process on newer Node versions. The
    // catch block already handles the real error via finalMessage() rejecting.
    stream.on('error', () => {});

    const finalMessage = await stream.finalMessage();
    const reply = finalMessage.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    history.push({ role: 'assistant', content: reply });
    const trimmed = trimHistory(history);
    sessions.set(sessionId, trimmed);
    saveSession('jarvis', sessionId, trimmed);

    res.end();
  } catch (err) {
    console.error('Anthropic API error:', err);
    if (res.headersSent) {
      res.end();
    } else {
      res.status(502).json({ error: 'Failed to reach the assistant' });
    }
  }
});

app.post('/api/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    sessions.delete(sessionId);
    deleteSession('jarvis', sessionId);
  }
  res.json({ ok: true });
});

// A spend-cap refusal (see spend.js) is a deliberate, actionable stop with a
// message worth reading — not a failure to reach the model, which is what a
// generic 502 would tell the founder.
function sendAgentError(res, err, fallbackMessage) {
  if (typeof err?.message === 'string' && err.message.startsWith('Daily spend cap reached')) {
    return res.status(429).json({ error: err.message });
  }
  console.error(fallbackMessage, err);
  return res.status(502).json({ error: fallbackMessage });
}

app.get('/api/company/org-chart', (_req, res) => {
  res.json({ rootAgentId: COMPANY_ROOT, agents: listAgents(COMPANY_AGENTS) });
});

// Honcho sessions are namespaced per chat mode so the Executive Team and
// the Venture Studio don't read as one rambling conversation — they're
// different rooms, and the founder behaves differently in each.
function companySessionKey(sessionId) {
  return `company-${sessionId}`;
}

function studioSessionKey(sessionId) {
  return `studio-${sessionId}`;
}

// buildFounderContext returns '' whenever Honcho is unconfigured or quiet,
// so this keeps the prompt free of the trailing blank lines that would
// otherwise appear on every single turn.
function joinContext(...parts) {
  return parts.filter((part) => part && part.trim()).join('\n\n');
}

async function runCompanyTurn(sessionId, message, { deadlineAt = null, image = null, spokenIn = '', arrivedAsVoice = false } = {}) {
  const history = companySessions.get(sessionId) || [];
  // What is already committed, for the agents that build. One call per repo,
  // never fatal — see buildRepoManifests for the week that bought this.
  const repoManifests = await buildRepoManifests().catch((err) => {
    console.error('Could not list the linked repos for context:', err.message);
    return '';
  });
  // An image goes to the CEO as a real image block. Delegation downstream is
  // text, which is the right shape anyway: the orchestrator looks at the
  // picture and tells its specialists what is in it, exactly as a person
  // would. That also keeps leaf agents on cheaper text-only models working.
  const content = image
    ? [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
        // The caption after the picture: the question usually refers to what
        // was just shown, and a model reads it the same way a person does.
        { type: 'text', text: message },
      ]
    : message;
  const workingMessages = [...history, { role: 'user', content }];
  // Awaited because it shapes the prompt, but it can only ever return a
  // string — buildFounderContext swallows its own failures (see
  // memory/honcho.js) rather than taking the turn down.
  // Two different kinds of founder knowledge: what Honcho inferred from past
  // conversations, and what they deliberately wrote down in their vault.
  // Fetched together since neither depends on the other.
  const [founderContext, steering] = await Promise.all([
    buildFounderContext(companySessionKey(sessionId)),
    readFounderSteering(),
  ]);

  const { text, trace, durationMs, ranOutOfTime } = await runAgent({
    anthropic,
    agents: COMPANY_AGENTS,
    deadlineAt,
    agentId: COMPANY_ROOT,
    messages: workingMessages,
    actionHandlers: {
      log_revenue: handleLogRevenue,
      log_expense: handleLogExpense,
      report_milestone_progress: handleReportMilestoneProgress,
      kill_venture: handleKillVenture,
      // deploy_code and send_customer_email are also wired into the
      // autonomous daily leadership sync (see dailyMeeting.js) — a
      // founder-granted scope (see finance/ventures.js's authorizeDeployment
      // and authorizeOutreach) is exactly the mechanism meant to let an
      // agent act without a human present, so there's no reason to require
      // one here specifically. The book-keeping and venture-status actions
      // stay interactive-only, since those depend on the founder having
      // actually reported a real outcome — see dailyMeeting.js's header.
      // 'interactive' is the triggeredBy tag recorded on the venture's
      // deployment/outreach log — see dailyMeeting.js for the 'daily_cycle'
      // counterpart.
      deploy_code: (input) => handleDeployCode(input, 'interactive'),
      // One commit for a change that spans several files, because four commits
      // for one change is how the deploy branch ends up holding half a refactor.
      deploy_changes: (input, ctx) => handleDeployChanges(input, 'interactive', ctx),
      // Reads the gates that already exist and reports every one at once, rather
      // than letting the team discover them one refusal per turn. Grants nothing
      // and reaches nothing.
      check_ready: (input) => handleCheckReady(input),
      // Whether anyone is actually calling the product. Reads counters the venture
      // reports itself; shipped and used are different facts and this is the only
      // place the second one exists.
      check_usage: (input) => handleCheckUsage(input),
      // Creating a link charges nobody; sending it goes through email and its
      // gates. Pipeline and objectives are internal book-keeping.
      create_payment_link: (input, ctx) => handleCreatePaymentLink(input, ctx),
      draft_customer_email: (input, ctx) => handleDraftCustomerEmail(input, ctx),
      list_drafts: (input) => handleListDrafts(input),
      update_pipeline: (input, ctx) => handleUpdatePipeline(input, ctx),
      set_objective: (input, ctx) => handleSetObjective(input, ctx),
      // Finished work that has not landed. Not behind the plan — see
      // authorizePullRequest for why gating a proposal on pre-approval is a
      // deadlock rather than a review.
      open_pull_request: (input, ctx) => handleOpenPullRequest(input, 'interactive', ctx),
      // The undo button. Also not behind the plan: the paths belong to the
      // commit being undone, so no plan could have named them, and a bad
      // commit waiting until tomorrow is worse than the revert.
      revert_commit: (input, ctx) => handleRevertCommit(input, 'interactive', ctx),
      // Execution is wired the same way as deploy_code: available in a live
      // conversation, where the founder is present to see a red run.
      // Self-service deployment, bounded by AUTONOMOUS_DEPLOY_REPOS. Wired
      // into the interactive path only, like every other real action — the
      // founder is present to see what the team just granted itself.
      submit_daily_plan: (input, ctx) => handleSubmitDailyPlan(input, 'interactive', ctx),
      check_daily_plan: () => handleCheckDailyPlan(),
      link_venture_repo: (input, ctx) => handleLinkVentureRepo(input, 'interactive', ctx),
      // Starting a venture is what made WhatsApp a complete interface rather
      // than an almost-complete one. The CEO could already end a venture here
      // but not begin one, so the founder had to open the Venture Studio in a
      // browser for the one step that every other step depends on. Safe to
      // wire in for the same reason the daily cycle's Studio phase already
      // creates ventures unattended: a new venture has no repo and no
      // outreach list until the founder grants it one, so starting it costs
      // nothing and grants nothing. Interactive-only, like every other
      // action here — the leadership sync is told not to manufacture
      // real-world activity, and a venture nobody asked for is exactly that.
      propose_venture: handleProposeVenture,
      list_approved_repos: () => handleListApprovedRepos(),
      run_checks: (input, ctx) => handleRunChecks(input, 'interactive', ctx),
      // Durable work: see tasks.js. These let a build survive a turn that
      // ends early, which is the failure that made them necessary.
      queue_work: (input, ctx) => handleQueueWork(input, ctx),
      next_task: (input) => handleNextTask(input),
      start_task: (input) => handleStartTask(input),
      complete_task: (input, ctx) => handleCompleteTask(input, ctx),
      fail_task: (input) => handleFailTask(input),
      // Reading before writing. No scope needed beyond the linked repo the
      // founder already granted — reading a file the team can already commit
      // to gives away nothing it did not already have.
      read_repo_file: (input) => handleReadRepoFile(input),
      list_repo_files: (input) => handleListRepoFiles(input),
      log_venture_note: (input, ctx) => handleLogVentureNote(input, ctx),
      list_checks: (input) => handleListChecks(input),
      // Evidence that the deployed thing answers, which no CI run provides.
      // The origin is founder-set (see finance/ventures.js setServiceUrl);
      // the agent supplies only a path.
      check_service: (input, ctx) => handleCheckService(input, ctx),
      send_customer_email: (input) => handleSendCustomerEmail(input, 'interactive'),
      // Reading the answers. Not gated like sending, because it reaches
      // nobody — and inbox.js will only surface mail from an address this
      // company already wrote to, so the founder's own inbox stays shut.
      check_replies: (input, ctx) => handleCheckReplies(input, 'interactive', ctx),
      // Internal memory only — no scope grant or cap, since nothing leaves
      // the building (see actionHandlers.js).
      log_contact_note: handleLogContactNote,
    },
    extraContext: joinContext(
      buildCompanyContext(),
      steering,
      founderContext,
      // That the founder spoke rather than typed, and that the answer is read
      // back to them. Without it the team answers a voice note insisting it
      // has no voice channel. Empty for a typed message.
      spokenReplyInstruction({ arrivedAsVoice }),
      // Last, so it is the nearest instruction to the answer. Empty for an
      // English question to an English-speaking team, which is most of them.
      replyLanguageInstruction({ detected: spokenIn })
    ),
    perAgentContext: (agentId) => buildPerAgentContext(agentId, { repoManifests }),
  });

  // The image itself is not kept in history. Every later turn would resend
  // those bytes to every agent, and a few screenshots would quietly become
  // the most expensive thing in the session. What the CEO said about it is
  // in its reply, which is the part worth remembering.
  // An image is already marked here; a voice note was not, so a later turn
  // reading back the session saw a typed message and lost the fact that the
  // founder had been speaking.
  const inboundMarker = image ? '[sent an image] ' : arrivedAsVoice ? '[sent a voice note] ' : '';
  history.push({ role: 'user', content: `${inboundMarker}${message}`.trim() });
  history.push({ role: 'assistant', content: text });
  const trimmed = trimHistory(history);
  companySessions.set(sessionId, trimmed);
  saveSession('company', sessionId, trimmed);

  // Not awaited: the reply is already final, and the founder shouldn't wait
  // on a memory write to see it.
  recordExchange({
    sessionKey: companySessionKey(sessionId),
    founderMessage: message,
    agentId: COMPANY_ROOT,
    agentReply: text,
  });

  // A slow turn is almost always a wide one. Logging the worst offenders
  // makes "the team is slow" answerable from the deploy log rather than by
  // guessing at which of twenty-two agents was the reason.
  if (durationMs > SLOW_TURN_MS) {
    const slowest = [...trace]
      .filter((entry) => entry.ms)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3)
      .map((entry) => `${entry.title} ${(entry.ms / 1000).toFixed(1)}s`)
      .join(', ');
    console.warn(
      `Slow turn: ${(durationMs / 1000).toFixed(1)}s across ${trace.length} agent${trace.length === 1 ? '' : 's'}` +
        (slowest ? ` — slowest: ${slowest}` : '')
    );
  }

  return { reply: text, trace, durationMs, ranOutOfTime };
}

app.post('/api/company/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
  }

  try {
    const { reply, trace, durationMs } = await runCompanyTurn(sessionId, message);
    res.json({ reply, trace, durationMs });
  } catch (err) {
    sendAgentError(res, err, 'Failed to reach the executive team');
  }
});

app.post('/api/company/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    companySessions.delete(sessionId);
    deleteSession('company', sessionId);
  }
  res.json({ ok: true });
});

app.get('/api/studio/org-chart', (_req, res) => {
  res.json({ rootAgentId: STUDIO_ROOT, agents: listAgents(STUDIO_AGENTS) });
});

app.post('/api/studio/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
  }

  const history = studioSessions.get(sessionId) || [];
  const workingMessages = [...history, { role: 'user', content: message }];

  try {
    const [founderContext, steering] = await Promise.all([
      buildFounderContext(studioSessionKey(sessionId)),
      readFounderSteering(),
    ]);
    const { text, trace } = await runAgent({
      anthropic,
      agents: STUDIO_AGENTS,
      agentId: STUDIO_ROOT,
      messages: workingMessages,
      actionHandlers: studioActionHandlers(),
      extraContext: joinContext(buildStudioContext(), steering, founderContext),
      perAgentContext: buildPerAgentContext,
    });

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: text });
    const trimmed = trimHistory(history);
    studioSessions.set(sessionId, trimmed);
    saveSession('studio', sessionId, trimmed);

    recordExchange({
      sessionKey: studioSessionKey(sessionId),
      founderMessage: message,
      agentId: STUDIO_ROOT,
      agentReply: text,
    });

    res.json({ reply: text, trace });
  } catch (err) {
    sendAgentError(res, err, 'Failed to reach the venture studio');
  }
});

app.post('/api/studio/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) {
    studioSessions.delete(sessionId);
    deleteSession('studio', sessionId);
  }
  res.json({ ok: true });
});

app.get('/api/ventures', (_req, res) => {
  res.json({ ventures: listVentures() });
});

app.get('/api/ventures/ledger', (_req, res) => {
  res.json(getLedger());
});

function computeVentureFinancials(venture, transactions) {
  const forVenture = transactions.filter((t) => t.ventureId === venture.id);
  const sumType = (type) => forVenture.filter((t) => t.type === type).reduce((sum, t) => sum + t.amount, 0);
  const revenue = sumType('revenue');
  const expense = sumType('expense');

  return {
    ...venture,
    financials: { revenue, expense, net: revenue - expense },
    milestoneSummary: {
      total: venture.milestones.length,
      done: venture.milestones.filter((m) => m.status === 'done').length,
      missed: venture.milestones.filter((m) => m.status === 'missed').length,
    },
  };
}

// A portfolio-level view across every venture, active and killed, each
// enriched with its own slice of the books — since the per-mode Ventures
// panel only ever shows one team's angle on current ventures, this is the
// place to compare all of them side by side. No allocated column: nothing
// is allocated to a venture, so the only figures that mean anything are
// what it earned and what it actually cost.
app.get('/api/ventures/portfolio', (_req, res) => {
  const { transactions, revenue, expenses, net } = getLedger();
  const ventures = listVentures().map((v) => computeVentureFinancials(v, transactions));
  const totals = ventures.reduce(
    (acc, v) => ({
      revenue: acc.revenue + v.financials.revenue,
      expense: acc.expense + v.financials.expense,
    }),
    { revenue: 0, expense: 0 }
  );

  res.json({
    ventures,
    totals: { ...totals, net: totals.revenue - totals.expense },
    business: { revenue, expenses, net },
  });
});

// Safe for the founder to do directly from the UI without a company
// briefing step; the CEO can also do it from a conversation via the
// kill_venture action.
app.post('/api/ventures/:id/kill', (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const venture = killVenture(id, reason);
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Real code deployment (see finance/ventures.js, deploy/github.js,
// actionHandlers.js's handleDeployCode): the founder links a real repo and
// explicitly turns deployments on for a venture, which is the one-time
// scope grant that then lets deploy_code run without a per-action approval.
// Nothing here performs a deploy itself — these just set the scope an
// active conversation with the Engineering Lead can later act inside.
app.post('/api/ventures/:id/repo', (req, res) => {
  const { id } = req.params;
  const { owner, name, branch, allowedPaths, maxPerWeek, maxPerDay } = req.body || {};
  try {
    const venture = linkRepo(id, { owner, name, branch, allowedPaths, maxPerWeek, maxPerDay });
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Usage ingest -------------------------------------------------------------
//
// The first endpoint in this app a machine outside the company calls, and the
// only one authenticated by something other than the founder's app token. A
// venture's deployed product holds a key that can increment that venture's
// counters and do nothing else — handing it the app token instead would mean
// a compromised product could disable the kill switch.
//
// Deliberately forgiving. A counter that 500s and takes a customer's request
// down with it would be a product outage caused by bookkeeping, which is an
// absurd trade; anything malformed is rejected with a 400 and a reason, and
// nothing here can throw its way into the venture's own latency.
app.post('/api/ventures/:id/usage/report', (req, res) => {
  const { id } = req.params;
  const key = (req.get('x-venture-key') || '').trim();
  if (!verifyIngestKey(id, key) && !hasAppToken(req)) {
    return res.status(401).json({ error: 'Bad or missing venture key.' });
  }
  try {
    const recorded = recordUsage(id, req.body || {});
    res.json({ recorded });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mints the key and returns it once. Founder-only, and it is the founder who
// puts it into the venture's own deployment environment — no agent tool reads
// it, because an agent that can read a credential is an agent that can commit
// one.
app.post('/api/ventures/:id/usage/key', (req, res) => {
  try {
    const key = mintIngestKey(req.params.id);
    res.json({
      key,
      variable: 'JARVIS_USAGE_KEY',
      endpoint: `/api/ventures/${req.params.id}/usage/report`,
      note: 'Put this in the venture\'s own deployment environment. It will not be shown again.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/ventures/:id/usage', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  res.json({ usage: usageSummary(req.params.id, { days }), configured: hasIngestKey(req.params.id) });
});

app.post('/api/ventures/:id/deployment/enable', (req, res) => {
  try {
    const venture = setDeploymentEnabled(req.params.id, true);
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ventures/:id/deployment/disable', (req, res) => {
  try {
    const venture = setDeploymentEnabled(req.params.id, false);
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The global halt (see killSwitch.js): one control that overrides every
// venture's own scope at once, flippable at runtime because an emergency
// shouldn't require a redeploy. Enforcement is inside authorizeDeployment
// and authorizeOutreach, so these endpoints only set state — nothing here
// needs to reach into individual ventures.
app.get('/api/kill-switch', (_req, res) => {
  res.json(getKillSwitch());
});

app.post('/api/kill-switch/halt', (req, res) => {
  const { reason } = req.body || {};
  res.json(haltRealActions(reason));
});

app.post('/api/kill-switch/resume', (_req, res) => {
  try {
    res.json(resumeRealActions());
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Today's model spend against the daily ceiling agentRunner.js enforces
// before every paid call (see spend.js).
// Who has earned what, and the events behind each balance — the founder's
// audit surface for the profit share. Agents see only their own line (see
// finance/context.js's buildPerAgentContext); this is the whole picture.
app.get('/api/profit-share', (_req, res) => {
  res.json({ ...getProfitShare(), contributions: listContributions().slice(-100).reverse() });
});

// --- WhatsApp -------------------------------------------------------------
// Meta's one-time handshake when the webhook URL is saved.
app.get('/api/whatsapp/webhook', (req, res) => {
  const challenge = verifyWebhookChallenge(req.query);
  if (challenge === null) return res.sendStatus(403);
  res.type('text/plain').send(challenge);
});

// --- Stripe: money arrived ------------------------------------------------------
//
// The only endpoint here whose caller is a payment processor. Authenticated by
// Stripe's signature over the raw body (see payments.js), which is why the
// JSON middleware keeps req.rawBody. Acknowledged with 200 quickly and always
// on a verified event: Stripe retries anything else, and a retry storm over a
// ledger write is how a payment gets booked three times.
app.post('/api/payments/webhook', async (req, res) => {
  if (!verifyStripeSignature(req.rawBody, req.get('stripe-signature'))) {
    return res.status(400).json({ error: 'Bad signature.' });
  }
  let outcome;
  try {
    outcome = interpretEvent(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json({ received: true, duplicate: Boolean(outcome.duplicate) });

  if (outcome.duplicate || !outcome.paid) return;
  const paid = outcome.paid;
  const venture = paid.ventureId ? getVentureForPayment(paid.ventureId) : null;
  try {
    addLedgerTransaction({
      type: 'revenue',
      amount: paid.amount,
      description: `Stripe ${paid.kind === 'monthly' ? 'subscription' : 'payment'} ${paid.currency} ${paid.amount.toFixed(2)}${
        paid.customerEmail ? ` from ${paid.customerEmail}` : ''
      } (${paid.reference})`,
      ventureId: venture ? venture.id : null,
    });
    if (venture) {
      recordPayment(venture.id, paid);
      // The agent that created the link earns the credit — the same rule as
      // every other real action, and the first time it has been for revenue
      // a customer actually sent rather than revenue the founder reported.
      if (paid.agentId) {
        recordContribution({ agentId: paid.agentId, kind: 'payment_received', ventureId: venture.id, detail: `${paid.currency} ${paid.amount}` });
      }
      sendPaymentEmail(venture, paid).catch((err) => console.error('Payment alert failed:', err.message));
    }
    // The renewal law's acknowledgment: terms and a way to cancel, once, on
    // the first payment of a monthly plan.
    if (paid.kind === 'monthly' && paid.firstPayment && paid.customerEmail && paid.subscriptionId) {
      sendSubscriptionConfirmation(paid.customerEmail, {
        productName: venture ? venture.title : 'your plan',
        terms: renewalTerms({ amount: paid.amount, currency: paid.currency }),
        cancelUrl: cancelLink(paid.subscriptionId),
        contact: contactEmail(),
      }).catch((err) => console.error('Subscription confirmation failed:', err.message));
    }
    console.log(`Payment booked: ${paid.currency} ${paid.amount} for ${venture ? venture.title : 'no venture'}`);
  } catch (err) {
    console.error('Payment webhook could not book the payment:', err.message);
  }
});

// Where a customer lands after paying. Plain text on purpose: the receipt is
// Stripe's, and the company's job here is to say thank you and stop.
app.get('/paid', (req, res) => {
  const cancelled = req.query.cancelled === '1';
  res.type('text/plain').send(
    cancelled
      ? 'No payment was made. If that was a mistake, the link still works.'
      : 'Thank you — your payment went through. A receipt is on its way from Stripe, and a person will be in touch.'
  );
});

// Cancelling a monthly plan, from the link in its confirmation email; see billingCancel.js.
app.get('/billing/cancel', showCancel);
app.post('/billing/cancel', confirmCancel);

const whatsappInbound = createWhatsAppInbound({
  anthropic,
  runCompanyTurn,
  drainDeepDives,
  deskSessions,
  turnDeadlineMs: TURN_DEADLINE_MS,
});

// Inbound messages and receipts; see channels/whatsappInbound.js.
app.post('/api/whatsapp/webhook', whatsappInbound.webhook);

// What the webhook has actually seen. An empty list here is a diagnosis in
// itself: Meta is not calling the webhook, so the problem is in the Meta
// dashboard rather than anywhere in this app.
app.get('/api/whatsapp/recent', (_req, res) => {
  res.json(recentInbound());
});

// The day's plan, and the founder's one decision on it. Approval is a founder
// endpoint and never an agent action — a team that can approve its own plan
// has not been approved, it has been asked politely.
app.get('/api/plan', (_req, res) => {
  res.json({ required: isPlanRequired(), plan: getPlan(), history: listPlans(14) });
});

app.post('/api/plan/approve', (req, res) => {
  try {
    res.json({ plan: approvePlan({ note: req.body?.note }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/plan/reject', (req, res) => {
  try {
    res.json({ plan: rejectPlan({ reason: req.body?.reason }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Deep dives -------------------------------------------------------------

// One at a time, deliberately. A dive is a full fan-out across the company;
// running several at once is the fastest way to hit a rate limit and turn one
// slow answer into several failed ones. They are not urgent by definition —
// they exist because the founder already has a quick answer.
let draining = false;

async function drainDeepDives() {
  if (draining) return;
  draining = true;
  try {
    for (let dive = nextQueued(); dive; dive = nextQueued()) {
      markRunning(dive.id);
      try {
        // No deadline here. The whole point is that this one gets the time
        // the conversational turn could not give it.
        const { reply } = await runCompanyTurn(dive.sessionId || `dive-${dive.id}`, dive.question);
        completeDeepDive(dive.id, reply);

        if (dive.deliverTo) {
          try {
            await sendWhatsAppMessage(
              dive.deliverTo,
              `Here's the full answer on: "${dive.question.slice(0, 80)}"\n\n${reply}`
            );
          } catch (err) {
            // The work is done and saved; only the delivery failed. Worth
            // saying loudly, because from the phone this is indistinguishable
            // from the dive never having run.
            console.error(`Deep dive ${dive.id} finished but could not be delivered: ${err.message}`);
          }
        }
      } catch (err) {
        failDeepDive(dive.id, err.message);
        console.error(`Deep dive ${dive.id} failed: ${err.message}`);
        if (dive.deliverTo) {
          try {
            await sendWhatsAppMessage(
              dive.deliverTo,
              `I couldn't finish the deeper answer on "${dive.question.slice(0, 80)}" — ${err.message}`
            );
          } catch {
            /* already logged above */
          }
        }
      }
    }
  } finally {
    draining = false;
  }
}

app.get('/api/deep-dives', (_req, res) => {
  res.json({ queued: queueDepth(), dives: listDeepDives() });
});

// Everything about how a venture is actually being built, in one call.
//
// The company gained a task queue, commit and check-run logs, and a venture
// notebook, and none of it rendered anywhere — so the founder could see
// which ventures existed but not what anyone was doing. Watching GitHub
// covers the code; it says nothing about what is queued, what failed and
// why, or what the team has learned.
//
// One endpoint rather than four, because this is read on a phone: four
// round trips is four chances to show a half-built screen.
app.get('/api/ventures/:id/build', (req, res) => {
  const venture = getVenture(req.params.id);
  if (!venture) return res.status(404).json({ error: 'No venture with that id.' });

  res.json({
    venture: {
      id: venture.id,
      title: venture.title,
      status: venture.status,
      repo: venture.repo || null,
    },
    tasks: listTasks({ ventureId: venture.id }),
    // Newest first: the useful end of a build log is the recent end.
    deployments: [...(venture.deployments || [])].reverse().slice(0, 20),
    runs: [...(venture.runs || [])].reverse().slice(0, 10),
    notes: [...(venture.notes || [])].reverse().slice(0, 20),
    milestones: venture.milestones || [],
    spend: getSpendSummary(),
    degradation: getDegradationToday(),
  });
});

app.get('/api/spend', (_req, res) => {
  res.json(getSpendSummary());
});

// Which optional integrations are actually live. Every one of them fails
// quietly by design, so without this the only way to tell a working key from
// a typo is to read deploy logs. The OpenRouter and Honcho entries are real
// probes, not just an env-var check — see integrations.js.
app.get('/api/integrations', async (_req, res) => {
  try {
    res.json(await getIntegrationStatus());
  } catch (err) {
    // getIntegrationStatus already catches per-probe failures, so reaching
    // here means something unexpected — still no reason to 500 a diagnostic.
    res.status(500).json({ error: `Couldn't read integration status: ${err.message}` });
  }
});

// Real customer email (see finance/ventures.js, email.js, actionHandlers.js's
// handleSendCustomerEmail): the same scope-grant shape as deployment above,
// applied to outbound email instead of a commit — an allowlist of
// recipients/domains and a weekly cap, set once and then enabled.
app.post('/api/ventures/:id/outreach', (req, res) => {
  const { id } = req.params;
  const { allowedRecipients, maxPerWeek, maxPerDay } = req.body || {};
  try {
    const venture = linkOutreachScope(id, { allowedRecipients, maxPerWeek, maxPerDay });
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ventures/:id/outreach/enable', (req, res) => {
  try {
    const venture = setOutreachEnabled(req.params.id, true);
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/ventures/:id/outreach/disable', (req, res) => {
  try {
    const venture = setOutreachEnabled(req.params.id, false);
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// The autonomous daily meeting cycle (see dailyMeeting.js + scheduler.js):
// the Executive Team runs a leadership sync and the Venture Studio takes a
// pass at anything worth proposing from it, without anyone having to start
// the conversation. These endpoints just read the results and let the
// founder trigger a run on demand — the cycle itself is a runAgent call
// like any other, not a new kind of action, so it can't move money or kill
// a venture on its own.
app.get('/api/reports/daily', (_req, res) => {
  res.json({ reports: listDailyReports() });
});

app.get('/api/reports/daily/latest', (_req, res) => {
  res.json({ report: getLatestDailyReport() });
});

app.get('/api/reports/daily/:date', (req, res) => {
  const report = getDailyReport(req.params.date);
  if (!report) return res.status(404).json({ error: 'No report for that date' });
  res.json({ report });
});

app.post('/api/reports/daily/run', async (_req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
  }
  if (isDailyMeetingRunning()) {
    return res.status(409).json({ error: 'A daily meeting is already in progress — try again shortly.' });
  }
  try {
    const report = await runDailyMeetingNow({ anthropic });
    res.json({ report });
  } catch (err) {
    console.error('Daily meeting run failed:', err);
    res.status(502).json({ error: 'Failed to run the daily meeting' });
  }
});

// The autonomous weekly reflection cycle (see weeklyReflection.js +
// weeklyScheduler.js): checks last week's flagged opportunities against
// what actually happened, and feeds the verdict into the Venture Studio's
// context (see finance/context.js) so ideation compounds week over week.
// Read-only, same as the daily cycle — it can't move money or kill a
// venture on its own.
app.get('/api/reports/weekly', (_req, res) => {
  res.json({ reflections: listWeeklyReflections() });
});

app.get('/api/reports/weekly/latest', (_req, res) => {
  res.json({ reflection: getLatestWeeklyReflection() });
});

app.get('/api/reports/weekly/:weekEnding', (req, res) => {
  const reflection = getWeeklyReflection(req.params.weekEnding);
  if (!reflection) return res.status(404).json({ error: 'No reflection for that week' });
  res.json({ reflection });
});

app.post('/api/reports/weekly/run', async (_req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
  }
  if (isWeeklyReflectionRunning()) {
    return res.status(409).json({ error: 'A weekly reflection is already in progress — try again shortly.' });
  }
  try {
    const reflection = await runWeeklyReflectionNow({ anthropic });
    res.json({ reflection });
  } catch (err) {
    console.error('Weekly reflection run failed:', err);
    res.status(502).json({ error: 'Failed to run the weekly reflection' });
  }
});

// The company as a live graph — see graph.js for the model and graphPage.html
// for the drawing.
//
// The page itself is public and deliberately so: it is an empty shell with no
// company data in it. Everything that matters comes from /api/graph below,
// which is authenticated. A browser following a WhatsApp link sends no custom
// headers, so the founder's token rides in the URL *fragment* and the page
// presents it as an Authorization header on its own fetch — a fragment never
// reaches the server, so it lands in no access log. See viewToken.js.
app.get('/graph', (_req, res) => {
  res.type('html').send(graphPageHtml());
});

// Read-only, and authorised by either the app token (the client bundle) or a
// short-lived view token (a link opened on a phone). requireAccess already
// admits the former; this adds the latter without widening anything else —
// a view token opens this one view until it expires and nothing more.
app.get('/api/graph', (req, res) => {
  if (isAccessProtected() && !hasAppToken(req)) {
    const presented = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const verdict = verifyViewToken(presented);
    if (!verdict.valid) {
      return res.status(401).json({
        error: 'This view link is not valid.',
        reason: verdict.reason,
        hint: 'Send GRAPH on WhatsApp for a fresh link.',
      });
    }
  }
  res.json(buildGraph());
});

// Public and unauthenticated by necessity: Meta requires a reachable privacy
// policy URL before a WhatsApp app can be published, and an unpublished app
// receives no production webhooks at all. Declared above the static handler
// so it wins over the client's catch-all route.
app.get('/privacy', (_req, res) => {
  res.type('html').send(privacyPolicyHtml());
});

/**
 * Twilio asks what to do with an incoming call, and gets back TwiML opening a
 * media stream to this same server.
 *
 * Twilio posts form-encoded, not JSON. A refusal is spoken rather than
 * dropped — a dead line is indistinguishable from a broken number, and the
 * founder would reasonably conclude the latter and stop calling.
 */
app.post('/api/calls/incoming', express.urlencoded({ extended: false }), (req, res) => {
  const from = req.body?.From || '';
  // Proof it is Twilio calling, not somebody who found the URL. Passes when
  // TWILIO_AUTH_TOKEN is unset, and the integration check says so.
  if (!verifyTwilioRequest(req)) {
    recordInbound({ stage: STAGES.BAD_SIGNATURE, from, detail: 'Twilio signature did not match TWILIO_AUTH_TOKEN' });
    return res.status(403).type('text/plain').send('forbidden');
  }
  // The public host Twilio reached us on, which is what the media stream must
  // dial back. Behind Railway's proxy the Host header is the public name.
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  const refusal = refuseCall(from);
  // A refused caller hears why before any menu — a menu followed by a
  // refusal is a minute of the caller's time spent for nothing.
  if (!refusal && isLanguageMenuEnabled()) {
    // "Welcome to the Amadeus help desk" (DESK_NAME in supportDesk.js)
    // before the menu. The founder's own line gets no welcome: they know
    // who they called.
    const welcome = callMode() === 'support' ? `Welcome to ${supportDeskName()}.` : '';
    recordInbound({ stage: STAGES.ANSWERED, from, detail: 'Language menu offered.' });
    return res.type('text/xml').send(languageMenuTwiml({ host, welcome }));
  }
  const twiml = answerCallTwiml({ from, host, callSid: req.body?.CallSid || '' });
  recordInbound({
    stage: refusal ? STAGES.NOT_ALLOWLISTED : STAGES.ANSWERED,
    from,
    detail: refusal || 'Call connected to the voice line.',
  });
  res.type('text/xml').send(twiml);
});

/**
 * The keypad choice from the language menu, then the same connection as
 * above with the language riding into the stream. Reached with no Digits when
 * the caller pressed nothing, in which case the desk opens in its default.
 * Signed by Twilio like the webhook above, and listed with it in
 * SELF_AUTHENTICATED_PATHS — the row that was missing for instance thirteen.
 */
app.post('/api/calls/language', express.urlencoded({ extended: false }), (req, res) => {
  const from = req.body?.From || '';
  if (!verifyTwilioRequest(req)) {
    recordInbound({ stage: STAGES.BAD_SIGNATURE, from, detail: 'Twilio signature did not match TWILIO_AUTH_TOKEN' });
    return res.status(403).type('text/plain').send('forbidden');
  }
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  const language = chosenLanguage(req.body?.Digits);
  const twiml = answerCallTwiml({ from, host, callSid: req.body?.CallSid || '', language });
  const refusal = refuseCall(from);
  recordInbound({
    stage: refusal ? STAGES.NOT_ALLOWLISTED : STAGES.ANSWERED,
    from,
    detail: refusal || (language ? `Call connected to the voice line in ${language}.` : 'Call connected to the voice line (no language chosen).'),
  });
  res.type('text/xml').send(twiml);
});

/**
 * A short-lived credential for one browser conversation.
 *
 * The page never sees OPENAI_API_KEY — anyone who opens devtools would own the
 * account. It gets a token scoped to one session, expiring in about a minute,
 * with the brief and the tools already fixed server-side so the page cannot
 * choose its own instructions.
 */
app.post('/api/calls/token', async (req, res) => {
  if (!isBrowserCallConfigured()) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not set, so there is nothing to talk to.' });
  }
  try {
    // A ventureId turns this into the customer desk: a different brief, no
    // company state, and no tools. The founder's own session is the one with
    // no desk named.
    res.json(
      await mintBrowserSession({
        desk: String(req.body?.desk || '').trim(),
        support: Boolean(req.body?.support),
      })
    );
  } catch (err) {
    console.error('Could not mint a browser session:', err.message);
    res.status(502).json({ error: err.message });
  }
});

/**
 * The slow path, reachable from the conversation.
 *
 * Same fifteen-second company turn the phone line uses. The page calls this
 * when the voice decides a question needs the real team, and speaks the answer
 * when it lands — so the conversation keeps going rather than going quiet.
 */
app.post('/api/calls/ask', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'No question was sent.' });
  try {
    const { reply } = await runCompanyTurn('call', question, {
      deadlineAt: Date.now() + TURN_DEADLINE_MS,
    });
    res.json({ answer: reply });
  } catch (err) {
    console.error('A question from a conversation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The support desk's tools, for a browser session.
 *
 * On the phone bridge these run server-side inside the call. In the browser
 * the model's tool calls arrive on the page's data channel, so the page has
 * to bring them here. Only the desk's own tools are dispatched — ask_the_team
 * keeps its own endpoint and its own keep-talking behaviour, and nothing else
 * is callable by name.
 */
app.post('/api/calls/tool', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!['lookup_issue', 'open_ticket'].includes(name)) {
    return res.status(400).json({ error: `"${name}" is not a tool a browser session may run.` });
  }
  try {
    res.json({ output: await runSupportTool(name, req.body?.args || {}, { from: 'browser' }) });
  } catch (err) {
    console.error(`Support tool ${name} failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The help desk for a voice bot that is not ours — the IONOS AI Receptionist
 * on its own number, or any IVR that can call a URL mid-call. Keyed on
 * DESK_API_KEY and closed without it; see realtime/deskApi.js for why the
 * request shape is forgiving and the response carries a `spoken` line.
 */
function requireDeskKey(req, res, next) {
  if (!isDeskApiConfigured()) {
    return res.status(503).json({ error: 'DESK_API_KEY is not set, so the desk is not reachable from outside.' });
  }
  if (!verifyDeskKey(req)) return res.status(401).json({ error: 'Bad or missing desk key.' });
  return next();
}

app.get('/api/desk/ping', requireDeskKey, (_req, res) => {
  res.json({ ok: true, desk: describeDeskApi() });
});

app.post('/api/desk/lookup', express.urlencoded({ extended: false }), requireDeskKey, (req, res) => {
  res.json(deskLookup(req.body || {}));
});

app.post('/api/desk/ticket', express.urlencoded({ extended: false }), requireDeskKey, async (req, res) => {
  try {
    res.json(await deskTicket(req.body || {}, { from: String(req.body?.from || '') }));
  } catch (err) {
    // A bot mid-call needs a sentence, not a stack. 400 with the reason, and
    // a spoken line so it can still say something useful.
    res.status(400).json({ error: err.message, spoken: 'I could not log that — could you describe the problem again?' });
  }
});

/** What the founder's calling setup actually does, in one line. */
app.get('/api/calls/status', (_req, res) => {
  res.json({ detail: describeCalling(), minutesLeftToday: Math.round(callMinutesRemaining()) });
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// An explicit http.Server rather than app.listen(), because the call media
// stream is a WebSocket upgrade on this same port and needs the server object
// to attach to. Railway gives one port; the phone line and the web app share
// it.
const httpServer = http.createServer(app);

attachCallStream(httpServer, {
  // The slow path, named at the wiring rather than buried inside the bridge.
  // This is the fifteen-second company turn the call talks over.
  askTheTeam: async (question) => {
    const { reply } = await runCompanyTurn('call', question, {
      deadlineAt: Date.now() + TURN_DEADLINE_MS,
    });
    return reply;
  },
  onCallEnded({ from, seconds, reason, transcript, turns = [] }) {
    // The wait per turn, on the same line as the call itself. Latency on a
    // call has four legs — phone network, Twilio to here, here to the
    // model, the model's own thinking — and this number is the last two
    // plus the silence window; anything the founder feels beyond it is the
    // phone network and the distance to Twilio's region.
    const replies = turns.filter((t) => t.what !== 'greeting').map((t) => t.ms);
    const avg = replies.length ? Math.round(replies.reduce((a, b) => a + b, 0) / replies.length) : 0;
    const timing = turns.length
      ? ` Model turns: ${turns.length}, first sound after ${avg}ms on average, slowest ${Math.max(...turns.map((t) => t.ms))}ms.`
      : '';
    console.log(`Call from ${from || 'unknown'} ended after ${Math.round(seconds)}s (${reason}).${timing}`);
    // The founder gets what was said in writing. A call leaves no record they
    // can search, and half of what gets discussed on one is a decision.
    if (transcript.length) sendCallSummary({ from, seconds, transcript }).catch((err) => {
      console.error('Could not send the call summary:', err.message);
    });
  },
});

httpServer.listen(PORT, () => {
  console.log(`Jarvis server listening on port ${PORT}`);
  // Leaves a mark and counts the ones already there. A count still at 1 after
  // a redeploy is proof the data directory was emptied — which is otherwise
  // only discoverable by noticing something has gone missing.
  recordBoot();
  warnIfEphemeral();
  warnIfUnprotected();
  startDailyMeetingScheduler({ anthropic });
  startWorkSessionScheduler({ anthropic });
  startWeeklyReflectionScheduler({ anthropic });
  startInboxWatcher({ anthropic });
  startCircadian();
  probeWhoop().catch(() => {});
});
