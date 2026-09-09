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
import { getLedger, addTransaction } from './finance/ledger.js';
import { listVentures, getVenture, activateVenture, approveTranche, denyTranche, killVenture } from './finance/ventures.js';
import { buildTreasuryContext, buildStudioContext } from './finance/context.js';
import {
  handleProposeVenture,
  handleLogRevenue,
  handleLogExpense,
  handleReportMilestoneProgress,
  handleRequestTranche,
  handleKillVenture,
} from './actionHandlers.js';
import { listDailyReports, getDailyReport, getLatestDailyReport } from './dailyReports.js';
import { startDailyMeetingScheduler, runDailyMeetingNow, isDailyMeetingRunning } from './scheduler.js';
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
app.use(express.json());

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

app.get('/api/company/org-chart', (_req, res) => {
  res.json({ rootAgentId: COMPANY_ROOT, agents: listAgents(COMPANY_AGENTS) });
});

async function runCompanyTurn(sessionId, message) {
  const history = companySessions.get(sessionId) || [];
  const workingMessages = [...history, { role: 'user', content: message }];

  const { text, trace } = await runAgent({
    anthropic,
    agents: COMPANY_AGENTS,
    agentId: COMPANY_ROOT,
    messages: workingMessages,
    actionHandlers: {
      log_revenue: handleLogRevenue,
      log_expense: handleLogExpense,
      report_milestone_progress: handleReportMilestoneProgress,
      request_tranche: handleRequestTranche,
      kill_venture: handleKillVenture,
    },
    extraContext: buildTreasuryContext(),
  });

  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: text });
  const trimmed = history.slice(-MAX_TURNS);
  companySessions.set(sessionId, trimmed);
  saveSession('company', sessionId, trimmed);

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
    console.error('Company agent error:', err);
    res.status(502).json({ error: 'Failed to reach the executive team' });
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
    const { text, trace } = await runAgent({
      anthropic,
      agents: STUDIO_AGENTS,
      agentId: STUDIO_ROOT,
      messages: workingMessages,
      actionHandlers: { propose_venture: handleProposeVenture },
      extraContext: buildStudioContext(),
    });

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: text });
    const trimmed = history.slice(-MAX_TURNS);
    studioSessions.set(sessionId, trimmed);
    saveSession('studio', sessionId, trimmed);

    res.json({ reply: text, trace });
  } catch (err) {
    console.error('Studio agent error:', err);
    res.status(502).json({ error: 'Failed to reach the venture studio' });
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
  const allocated = sumType('investment');
  const revenue = sumType('revenue');
  const expense = sumType('expense');

  return {
    ...venture,
    financials: { allocated, revenue, expense, net: revenue - expense },
    milestoneSummary: {
      total: venture.milestones.length,
      done: venture.milestones.filter((m) => m.status === 'done').length,
      missed: venture.milestones.filter((m) => m.status === 'missed').length,
    },
  };
}

// A portfolio-level view across every venture (proposed, active, and
// killed), each enriched with its own slice of the ledger — since the
// per-mode Ventures panel only ever shows one team's angle on "current"
// ventures, this is the place to compare all of them side by side.
app.get('/api/ventures/portfolio', (_req, res) => {
  const { transactions, balance, startingCapital } = getLedger();
  const ventures = listVentures().map((v) => computeVentureFinancials(v, transactions));
  const totals = ventures.reduce(
    (acc, v) => ({
      allocated: acc.allocated + v.financials.allocated,
      revenue: acc.revenue + v.financials.revenue,
      expense: acc.expense + v.financials.expense,
    }),
    { allocated: 0, revenue: 0, expense: 0 }
  );

  res.json({
    ventures,
    totals: { ...totals, net: totals.revenue - totals.expense },
    treasury: { balance, startingCapital },
  });
});

app.post('/api/ventures/:id/greenlight', async (req, res) => {
  const { id } = req.params;
  const { sessionId } = req.body || {};

  const venture = getVenture(id);
  if (!venture) return res.status(404).json({ error: 'Venture not found' });
  if (venture.status !== 'proposed') {
    return res.status(400).json({ error: `Venture is already ${venture.status}` });
  }

  const { balance } = getLedger();
  if (venture.budgetRequested > balance) {
    return res.status(400).json({
      error: `Not enough in the treasury: venture asks for $${venture.budgetRequested}, only $${balance.toFixed(2)} available.`,
    });
  }

  const activated = activateVenture(id);
  if (activated.budgetRequested > 0) {
    addTransaction({
      type: 'investment',
      amount: activated.budgetRequested,
      description: `Seed investment: ${activated.title}`,
      ventureId: activated.id,
    });
  }

  const result = { venture: activated, ledger: getLedger() };

  if (sessionId && process.env.ANTHROPIC_API_KEY) {
    const briefing = `The board just greenlit a new venture out of the studio: "${activated.title}".

One-liner: ${activated.oneLiner}
Problem: ${activated.problem}
Target customer: ${activated.targetCustomer}
Business model: ${activated.businessModel}
Approved budget: $${activated.budgetRequested} out of the company's $${result.ledger.balance.toFixed(2)} remaining treasury
Milestones: ${activated.milestones.map((m) => m.title).join('; ') || 'none specified'}

Put together an execution plan and tell me which departments start on what first.`;

    try {
      const { reply, trace } = await runCompanyTurn(sessionId, briefing);
      result.companyBriefing = { message: briefing, reply, trace };
    } catch (err) {
      console.error('Failed to push venture briefing to company:', err);
    }
  }

  res.json(result);
});

app.post('/api/ventures/:id/tranche/approve', async (req, res) => {
  const { id } = req.params;
  const { sessionId } = req.body || {};

  const venture = getVenture(id);
  if (!venture) return res.status(404).json({ error: 'Venture not found' });
  if (!venture.pendingTranche) {
    return res.status(400).json({ error: 'No pending tranche request for this venture' });
  }

  const { balance } = getLedger();
  if (venture.pendingTranche.amount > balance) {
    return res.status(400).json({
      error: `Not enough in the treasury: tranche asks for $${venture.pendingTranche.amount}, only $${balance.toFixed(2)} available.`,
    });
  }

  const { venture: updated, tranche } = approveTranche(id);
  addTransaction({
    type: 'investment',
    amount: tranche.amount,
    description: `Tranche: ${tranche.description || updated.title}`,
    ventureId: updated.id,
  });

  const result = { venture: updated, ledger: getLedger() };

  if (sessionId && process.env.ANTHROPIC_API_KEY) {
    const briefing = `The board approved a follow-on tranche of $${tranche.amount} for "${updated.title}": ${tranche.description}.

Remaining treasury: $${result.ledger.balance.toFixed(2)}.

Continue execution with this.`;

    try {
      const { reply, trace } = await runCompanyTurn(sessionId, briefing);
      result.companyBriefing = { message: briefing, reply, trace };
    } catch (err) {
      console.error('Failed to push tranche briefing to company:', err);
    }
  }

  res.json(result);
});

app.post('/api/ventures/:id/tranche/deny', (req, res) => {
  const { id } = req.params;
  try {
    const venture = denyTranche(id);
    res.json({ venture });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Killing doesn't move money, so — unlike greenlighting or a tranche — this
// is safe for the founder to do directly from the UI without a company
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
