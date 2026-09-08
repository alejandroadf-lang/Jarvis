import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from './agents/agentRunner.js';
import { ROOT_AGENT_ID, listOrgChart } from './agents/orgChart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Jarvis, a personal AI assistant. You are helpful, concise,
and quietly witty — never rambling. Address the user directly and skip unnecessary
preamble. When you don't know something, say so plainly instead of guessing.`;

const MAX_TURNS = 20; // messages kept per session (user+assistant combined)
const sessions = new Map(); // sessionId -> [{ role, content }]
const companySessions = new Map(); // sessionId -> [{ role, content }], CEO-level only

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.ANTHROPIC_API_KEY) });
});

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
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });

    const reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    history.push({ role: 'assistant', content: reply });
    sessions.set(sessionId, history.slice(-MAX_TURNS));

    res.json({ reply });
  } catch (err) {
    console.error('Anthropic API error:', err);
    res.status(502).json({ error: 'Failed to reach the assistant' });
  }
});

app.post('/api/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

app.get('/api/company/org-chart', (_req, res) => {
  res.json({ rootAgentId: ROOT_AGENT_ID, agents: listOrgChart() });
});

app.post('/api/company/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
  }

  const history = companySessions.get(sessionId) || [];
  const workingMessages = [...history, { role: 'user', content: message }];

  try {
    const { text, trace } = await runAgent({
      anthropic,
      agentId: ROOT_AGENT_ID,
      messages: workingMessages,
    });

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: text });
    companySessions.set(sessionId, history.slice(-MAX_TURNS));

    res.json({ reply: text, trace });
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

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Jarvis server listening on port ${PORT}`);
});
