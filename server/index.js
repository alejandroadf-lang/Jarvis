import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
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
import {
  listVentures,
  getVenture,
  killVenture,
  linkRepo,
  setDeploymentEnabled,
  linkOutreachScope,
  setOutreachEnabled,
} from './finance/ventures.js';
import { buildCompanyContext, buildStudioContext, buildPerAgentContext } from './finance/context.js';
import { recordExchange, buildFounderContext } from './memory/honcho.js';
import { readFounderSteering } from './workspace/vault.js';
import {
  handleProposeVenture,
  handleLogRevenue,
  handleLogExpense,
  handleReportMilestoneProgress,
  handleKillVenture,
  handleDeployCode,
  handleSendCustomerEmail,
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
  handleLogVentureNote,
  handleCheckDailyPlan,
} from './actionHandlers.js';
import { listDailyReports, getDailyReport, getLatestDailyReport } from './dailyReports.js';
import { startDailyMeetingScheduler, runDailyMeetingNow, isDailyMeetingRunning } from './scheduler.js';
import { getKillSwitch, haltRealActions, resumeRealActions } from './killSwitch.js';
import { getSpendSummary } from './spend.js';
import { getIntegrationStatus } from './integrations.js';
import { getProfitShare, listContributions } from './finance/profitShare.js';
import {
  isWhatsAppConfigured,
  verifyWebhookChallenge,
  verifySignature,
  extractMessage,
  isAllowedSender,
  sendWhatsAppMessage,
  isDuplicate,
  unsupportedTypeReply,
  downloadMedia,
} from './channels/whatsapp.js';
import { recordInbound, recordReceipt, recentInbound, waitingMessage, STAGES } from './channels/whatsappLog.js';
import { parseFounderCommand, runFounderCommand } from './channels/founderCommands.js';
import { runEval } from './eval/run.js';
import { listTasks } from './tasks.js';
import { getDegradationToday } from './degradation.js';
import { privacyPolicyHtml } from './privacy.js';
import { recordBoot, warnIfEphemeral } from './storage.js';
import {
  enqueue as enqueueDeepDive,
  nextQueued,
  markRunning,
  complete as completeDeepDive,
  fail as failDeepDive,
  listDeepDives,
  queueDepth,
} from './deepDives.js';
import { requireAccess, warnIfUnprotected } from './auth.js';
import {
  getPlan,
  approvePlan,
  rejectPlan,
  listPlans,
  isPlanRequired,
  parsePlanCommand,
  formatPlanForWhatsApp,
} from './dailyPlan.js';
import { isOpenAIConfigured, transcribeAudio } from './agents/openai.js';
import { listWeeklyReflections, getWeeklyReflection, getLatestWeeklyReflection } from './weeklyReflections.js';
import { startWeeklyReflectionScheduler, runWeeklyReflectionNow, isWeeklyReflectionRunning } from './weeklyScheduler.js';

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
const studioSessions = loadSessions('studio'); // sessionId -> [{ role, content }], Venture Partner-level only

const app = express();
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

async function runCompanyTurn(sessionId, message, { deadlineAt = null } = {}) {
  const history = companySessions.get(sessionId) || [];
  const workingMessages = [...history, { role: 'user', content: message }];
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
      log_venture_note: (input, ctx) => handleLogVentureNote(input, ctx),
      list_checks: (input) => handleListChecks(input),
      send_customer_email: (input) => handleSendCustomerEmail(input, 'interactive'),
      // Internal memory only — no scope grant or cap, since nothing leaves
      // the building (see actionHandlers.js).
      log_contact_note: handleLogContactNote,
    },
    extraContext: joinContext(buildCompanyContext(), steering, founderContext),
    perAgentContext: buildPerAgentContext,
  });

  history.push({ role: 'user', content: message });
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
  // guessing at which of twenty-one agents was the reason.
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
      actionHandlers: { propose_venture: handleProposeVenture },
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

// Inbound messages. Everything here is ordered around one constraint: Meta
// wants a 200 within seconds and retries if it doesn't get one, while a team
// turn takes 20 seconds to two minutes. So this acknowledges immediately and
// answers afterwards through the Send API — see channels/whatsapp.js.
app.post('/api/whatsapp/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
    // Refused before anything is read out of the body: this endpoint is
    // public and what's behind it can commit code and email customers.
    recordInbound({ stage: STAGES.BAD_SIGNATURE });
    return res.sendStatus(403);
  }

  // Acknowledge now. Every path below this line runs after the response.
  res.sendStatus(200);

  const message = extractMessage(req.body);
  if (!message) {
    // Delivery and read receipts arrive here too. Worth counting even though
    // there's nothing to answer: they're the proof that Meta is calling this
    // webhook at all, which is the first thing in question when a message
    // seems to vanish.
    recordReceipt();
    return;
  }

  // A signature proves Meta sent it, not who typed it. The allowlist is the
  // gate that decides whose messages actually reach the company.
  if (!isAllowedSender(message.from)) {
    console.warn(`WhatsApp: ignoring a message from an un-allowlisted number (${message.from}).`);
    recordInbound({ stage: STAGES.NOT_ALLOWLISTED, from: message.from, text: message.text });
    return;
  }

  // A retried delivery must not run the turn — or fire an action — twice.
  if (isDuplicate(message.id)) {
    recordInbound({ stage: STAGES.DUPLICATE, from: message.from, text: message.text });
    return;
  }

  handleWhatsAppMessage(message).catch((err) => {
    console.error('WhatsApp: failed to handle a message:', err);
  });
});

async function handleWhatsAppMessage(message) {
  let text = message.text.trim();

  // A voice note is the natural way to brief a team while walking, and it
  // used to get an apology. Transcribed here rather than inside the company
  // turn so everything downstream — session history, the profit share, the
  // inbound log — sees an ordinary text message.
  if (isVoiceNote(message) && message.mediaId && isOpenAIConfigured()) {
    try {
      const { buffer, filename } = await downloadMedia(message.mediaId);
      text = (await transcribeAudio(buffer, filename)).trim();
      if (!text) {
        recordInbound({ stage: STAGES.UNSUPPORTED_TYPE, from: message.from, detail: 'Voice note had no speech in it' });
        await sendWhatsAppMessage(message.from, "I couldn't make out any words in that one — try again?");
        return;
      }
    } catch (err) {
      // The founder is holding their phone waiting. The reason beats silence.
      recordInbound({ stage: STAGES.FAILED, from: message.from, detail: err.message });
      await sendWhatsAppMessage(message.from, `I couldn't transcribe that voice note — ${err.message}`);
      return;
    }
  }

  if (!text) {
    recordInbound({ stage: STAGES.UNSUPPORTED_TYPE, from: message.from, detail: `Type: ${message.type}` });
    await sendWhatsAppMessage(message.from, unsupportedTypeReply(message.type));
    return;
  }

  // Approval is decided here, before the company turn ever sees the words.
  // An agent that interprets "approve" is an agent that can conclude it was
  // approved — so the founder's reply goes straight to the function that
  // records the decision, and the team finds out by reading the plan.
  const command = parsePlanCommand(text);
  if (command) {
    try {
      if (command.kind === 'status') {
        await sendWhatsAppMessage(message.from, formatPlanForWhatsApp(getPlan()));
      } else if (command.kind === 'approve') {
        const plan = approvePlan({ note: command.note });
        recordInbound({ stage: STAGES.ANSWERED, from: message.from, text, detail: 'approved the daily plan' });
        await sendWhatsAppMessage(
          message.from,
          `Approved — ${plan.items.length} item${plan.items.length === 1 ? '' : 's'} cleared for ${plan.date}. ` +
            'Anything not on that list is still refused.'
        );
      } else {
        const plan = rejectPlan({ reason: command.reason });
        recordInbound({ stage: STAGES.ANSWERED, from: message.from, text, detail: 'rejected the daily plan' });
        await sendWhatsAppMessage(
          message.from,
          `Rejected${plan.note ? `: ${plan.note}` : ''}. Nothing runs; the team can send a revised plan today.`
        );
      }
    } catch (err) {
      await sendWhatsAppMessage(message.from, `Couldn't record that — ${err.message}`);
    }
    return;
  }

  // The founder's own controls — halt, scope grants, status — decided the
  // same way and for the same reason: these are the powers that bound
  // agents, so an agent never gets to interpret them. See
  // channels/founderCommands.js.
  const founderCommand = parseFounderCommand(text);
  if (founderCommand) {
    try {
      const reply = await runFounderCommand(founderCommand, {
        probeIntegrations: getIntegrationStatus,
        // Started, not awaited: the eval takes minutes of real API calls, and
        // holding the webhook open for it would time out long before it
        // finished. The result finds the founder when it exists.
        startEval: (scenarioId) => {
          runEval({ scenarioId })
            .then(({ summary }) => sendWhatsAppMessage(message.from, `Eval finished.\n\n${summary}`))
            .catch((evalErr) => sendWhatsAppMessage(message.from, `The eval could not finish — ${evalErr.message}`))
            .catch((sendErr) => console.error('Could not deliver the eval result:', sendErr));
        },
      });
      recordInbound({ stage: STAGES.ANSWERED, from: message.from, text, detail: `founder command: ${founderCommand.kind}` });
      await sendWhatsAppMessage(message.from, reply);
    } catch (err) {
      // A mistyped venture id is the common case, and the founder needs to
      // see which one it was rather than a generic failure.
      await sendWhatsAppMessage(message.from, `Couldn't do that — ${err.message}`);
    }
    return;
  }

  // Acknowledge before thinking. A real turn takes minutes — the CEO asks
  // around before replying — and from a phone that is indistinguishable from
  // the thing being broken, which it has been more than once. The estimate is
  // the median of turns that actually completed, so it is a measurement
  // rather than a number someone guessed and never revisited.
  //
  // Failing to acknowledge must never cost the answer: if this send fails the
  // turn still runs, and the reply carries its own send attempt.
  if (!ackDisabled()) {
    try {
      await sendWhatsAppMessage(message.from, waitingMessage());
    } catch (err) {
      console.warn(`WhatsApp: could not send the acknowledgement: ${err.message}`);
    }
  }

  const startedAt = Date.now();
  try {
    // The sender's number is the session key, so a WhatsApp conversation has
    // its own continuous history rather than colliding with the web app's.
    const { reply, ranOutOfTime } = await runCompanyTurn(`whatsapp-${message.from}`, text, {
      deadlineAt: Date.now() + TURN_DEADLINE_MS,
    });

    if (ranOutOfTime) {
      // The question was bigger than the clock. Send what the team has, say
      // plainly that it is the quick version, and queue the real one —
      // rather than letting a rushed answer pass for a considered one.
      const dive = enqueueDeepDive({
        question: text,
        sessionId: `whatsapp-${message.from}`,
        deliverTo: message.from,
        reason: 'ran past the conversational deadline',
      });
      await sendWhatsAppMessage(
        message.from,
        `${reply}\n\n— That's the quick read; the question was bigger than the two minutes I give a chat reply. ` +
          'The team is working it through properly now and I\'ll send the full answer when it lands.'
      );
      drainDeepDives();
      recordInbound({
        stage: STAGES.ANSWERED,
        from: message.from,
        text,
        detail: `answered briefly; queued ${dive.id} for the full version`,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await sendWhatsAppMessage(message.from, reply);
    recordInbound({
      stage: STAGES.ANSWERED,
      from: message.from,
      text,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    // The founder asked a question and is waiting on their phone. Silence is
    // the worst possible answer, so the real reason goes back to them — the
    // spend cap and a missing key both produce something actionable.
    //
    // Recorded before the apology is sent, because the send is the other
    // thing that fails here and it would otherwise take the reason with it.
    // The elapsed time goes in too: a config error that fails instantly and a
    // turn that ran for four minutes and then broke are different problems,
    // and the message alone does not tell them apart.
    const elapsed = Date.now() - startedAt;
    recordInbound({ stage: STAGES.FAILED, from: message.from, text, detail: err.message, durationMs: elapsed });
    try {
      await sendWhatsAppMessage(
        message.from,
        `The team couldn't answer that — ${err.message}\n\n(Failed after ${Math.round(elapsed / 1000)}s.)`
      );
    } catch (sendErr) {
      // Both the answer and the apology failed. Nothing reaches the phone, so
      // the log is the only record there is — say so where it will be read.
      console.error(
        `WhatsApp: could not deliver the failure to ${message.from} either: ${sendErr.message}. ` +
          `Original failure: ${err.message}`
      );
    }
  }
}

// Some people would rather have silence than a message every time they ask
// something. Off by default because not knowing whether it is working has
// cost more than an extra line ever will.
function ackDisabled() {
  return (process.env.WHATSAPP_ACK_DISABLED || '').trim().toLowerCase() === 'true';
}

function isVoiceNote(message) {
  return message.type === 'audio' || message.type === 'voice';
}

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

// Public and unauthenticated by necessity: Meta requires a reachable privacy
// policy URL before a WhatsApp app can be published, and an unpublished app
// receives no production webhooks at all. Declared above the static handler
// so it wins over the client's catch-all route.
app.get('/privacy', (_req, res) => {
  res.type('html').send(privacyPolicyHtml());
});

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Jarvis server listening on port ${PORT}`);
  // Leaves a mark and counts the ones already there. A count still at 1 after
  // a redeploy is proof the data directory was emptied — which is otherwise
  // only discoverable by noticing something has gone missing.
  recordBoot();
  warnIfEphemeral();
  warnIfUnprotected();
  startDailyMeetingScheduler({ anthropic });
  startWeeklyReflectionScheduler({ anthropic });
});
