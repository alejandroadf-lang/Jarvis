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
import { getLedger, addTransaction } from './finance/ledger.js';
import { listVentures, getVenture, createVenture, activateVenture } from './finance/ventures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Jarvis, a personal AI assistant. You are helpful, concise,
and quietly witty — never rambling. Address the user directly and skip unnecessary
preamble. When you don't know something, say so plainly instead of guessing.`;

const MAX_TURNS = 20; // messages kept per session (user+assistant combined)
const sessions = new Map(); // sessionId -> [{ role, content }]
const companySessions = new Map(); // sessionId -> [{ role, content }], CEO-level only
const studioSessions = new Map(); // sessionId -> [{ role, content }], Venture Partner-level only

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
    sessions.set(sessionId, history.slice(-MAX_TURNS));

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
  if (sessionId) sessions.delete(sessionId);
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
    actionHandlers: { log_revenue: handleLogRevenue },
    extraContext: buildTreasuryContext(),
  });

  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: text });
  companySessions.set(sessionId, history.slice(-MAX_TURNS));

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
  if (sessionId) companySessions.delete(sessionId);
  res.json({ ok: true });
});

function buildTreasuryContext() {
  const { balance, startingCapital } = getLedger();
  const ventures = listVentures();
  const summarize = (list) =>
    list.length ? list.map((v) => `${v.title} ($${v.budgetRequested})`).join('; ') : 'none yet';

  return `Company treasury: $${balance.toFixed(2)} available out of a $${startingCapital} starting seed.
Active (funded) ventures: ${summarize(ventures.filter((v) => v.status === 'active'))}
Proposed (not yet funded) ventures: ${summarize(ventures.filter((v) => v.status === 'proposed'))}
Keep any budget ask realistic against what is actually left in the treasury.`;
}

async function handleProposeVenture(input) {
  const venture = createVenture(input);
  return `Logged venture proposal ${venture.id} ("${venture.title}"), asking $${venture.budgetRequested}. Status: proposed. Tell the founder they can greenlight it from the Ventures panel to allocate budget and hand it to the executive team.`;
}

async function handleLogRevenue(input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 'Could not log revenue: amount must be a positive number.';
  }

  let ventureId = null;
  if (input.ventureId) {
    const venture = getVenture(input.ventureId);
    if (!venture) {
      return `Could not log revenue: no venture found with id "${input.ventureId}". Log it without a ventureId, or double-check the id.`;
    }
    ventureId = venture.id;
  }

  const description =
    typeof input.description === 'string' && input.description.trim() ? input.description.trim() : 'Revenue';

  addTransaction({ type: 'revenue', amount, description, ventureId });
  const { balance } = getLedger();
  return `Logged $${amount} in revenue${ventureId ? ` for venture ${ventureId}` : ''} ("${description}"). Treasury balance is now $${balance.toFixed(2)}.`;
}

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
      extraContext: buildTreasuryContext(),
    });

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: text });
    studioSessions.set(sessionId, history.slice(-MAX_TURNS));

    res.json({ reply: text, trace });
  } catch (err) {
    console.error('Studio agent error:', err);
    res.status(502).json({ error: 'Failed to reach the venture studio' });
  }
});

app.post('/api/studio/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) studioSessions.delete(sessionId);
  res.json({ ok: true });
});

app.get('/api/ventures', (_req, res) => {
  res.json({ ventures: listVentures() });
});

app.get('/api/ventures/ledger', (_req, res) => {
  res.json(getLedger());
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
Milestones: ${activated.milestones.join('; ') || 'none specified'}

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

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Jarvis server listening on port ${PORT}`);
});
