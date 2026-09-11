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
import { loadSessions, saveSession, deleteSession } from './sessionStore.js';
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
} from './channels/whatsapp.js';
import { recordInbound, recordReceipt, recentInbound, STAGES } from './channels/whatsappLog.js';
import { listWeeklyReflections, getWeeklyReflection, getLatestWeeklyReflection } from './weeklyReflections.js';
import { startWeeklyReflectionScheduler, runWeeklyReflectionNow, isWeeklyReflectionRunning } from './weeklyScheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Jarvis, a personal AI assistant. You are helpful, concise,
and quietly witty — never rambling. Address the user directly and skip unnecessary
preamble. When you don't know something, say so plainly instead of guessing.`;

const MAX_TURNS = 20; // messages kept per session (user+assistant combined)
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
    const trimmed = history.slice(-MAX_TURNS);
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

async function runCompanyTurn(sessionId, message) {
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

  const { text, trace } = await runAgent({
    anthropic,
    agents: COMPANY_AGENTS,
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
  const trimmed = history.slice(-MAX_TURNS);
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

  return { reply: text, trace };
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
    const { reply, trace } = await runCompanyTurn(sessionId, message);
    res.json({ reply, trace });
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
    const trimmed = history.slice(-MAX_TURNS);
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
  if (message.type !== 'text' || !message.text.trim()) {
    recordInbound({ stage: STAGES.UNSUPPORTED_TYPE, from: message.from, detail: `Type: ${message.type}` });
    await sendWhatsAppMessage(message.from, unsupportedTypeReply(message.type));
    return;
  }

  try {
    // The sender's number is the session key, so a WhatsApp conversation has
    // its own continuous history rather than colliding with the web app's.
    const { reply } = await runCompanyTurn(`whatsapp-${message.from}`, message.text.trim());
    await sendWhatsAppMessage(message.from, reply);
    recordInbound({ stage: STAGES.ANSWERED, from: message.from, text: message.text });
  } catch (err) {
    // The founder asked a question and is waiting on their phone. Silence is
    // the worst possible answer, so the real reason goes back to them — the
    // spend cap and a missing key both produce something actionable.
    //
    // Recorded before the apology is sent, because the send is the other
    // thing that fails here and it would otherwise take the reason with it.
    recordInbound({ stage: STAGES.FAILED, from: message.from, text: message.text, detail: err.message });
    await sendWhatsAppMessage(message.from, `The team couldn't answer that — ${err.message}`);
  }
}

// What the webhook has actually seen. An empty list here is a diagnosis in
// itself: Meta is not calling the webhook, so the problem is in the Meta
// dashboard rather than anywhere in this app.
app.get('/api/whatsapp/recent', (_req, res) => {
  res.json(recentInbound());
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

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Jarvis server listening on port ${PORT}`);
  startDailyMeetingScheduler({ anthropic });
  startWeeklyReflectionScheduler({ anthropic });
});
