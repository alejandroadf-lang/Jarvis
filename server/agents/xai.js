// Grok, from xAI: a sixth model provider, and the one way this company can read X.
//
// Two separate uses, both behind XAI_API_KEY.
//
// 1. A model tier ('grok' in models.js), like DeepSeek or Gemini. xAI speaks the
//    OpenAI chat-completions protocol, so this is the same thin module the
//    others are: a URL, a key and a model default over openaiCompatible.js.
//
// 2. The x_search tool, which is the reason Grok is here at all. The research
//    agents search the web through Anthropic's hosted tool, and the web is
//    where things end up weeks after they are said. X is where people complain
//    about a product the day it breaks, and where a trend is visible before
//    anyone writes the article. Only xAI can search it.
//
//    The research agents have to stay on Claude for web search (see
//    canUseAlternativeModel), so X search cannot be Grok's own hosted tool on
//    the agent's turn. Instead it is a tool this server runs: the agent asks a
//    question, this module asks Grok with its x_search tool switched on, and
//    Grok's summary plus the posts it cited come back as the tool result.
//
// Both are metered through the same daily spend cap as every model call: the
// Grok tokens at the tier's prices, and each X search call at its own price.

import { readSecret, hasSecret } from '../env.js';
import { createChatCompletion } from './openaiCompatible.js';

const CHAT_URL = 'https://api.x.ai/v1/chat/completions';
const RESPONSES_URL = 'https://api.x.ai/v1/responses';
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARS = 6000;

export function isGrokConfigured() {
  return hasSecret('XAI_API_KEY');
}

// Read at call time, like every other provider's model name: xAI renames and
// retires models on its own schedule (grok-4-0709 now redirects), and a stale
// default should be a Railway variable to change, not a redeploy.
export function grokModel() {
  return (process.env.XAI_MODEL || '').trim() || 'grok-4.3';
}

/** One completion for an agent on the grok tier, in the Anthropic shape agentRunner reads. */
export async function createCompletion({ model, system, messages, maxTokens, tools }) {
  const apiKey = readSecret('XAI_API_KEY');
  if (!apiKey) throw new Error('XAI_API_KEY is not set');
  return createChatCompletion({
    url: CHAT_URL,
    apiKey,
    label: 'Grok',
    model: model || grokModel(),
    system,
    messages,
    maxTokens,
    tools,
  });
}

// --- X search ------------------------------------------------------------------------

/** The tool as the agent sees it. Added only for agents with `xSearch: true`, and only with a key set. */
export const X_SEARCH_TOOL = {
  name: 'x_search',
  description:
    'Search recent posts on X (Twitter) and get a summary with links to the posts it is based on. ' +
    'Use it for what people are saying right now: complaints about an existing product, what users wish ' +
    'something did, reactions to a launch, early signs of a trend. It does not replace web_search for ' +
    'figures, reports or pricing pages. Each search is billed, so ask one specific question per call.',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What to find out from X, as a specific question. Example: "What do Notion users complain about in its AI features?"',
      },
      handles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Only look at posts from these accounts, without the @. At most 10.',
      },
      days: {
        type: 'integer',
        description: 'Optional. How many days back to look, from 1 to 90. Default 30.',
      },
    },
    required: ['question'],
  },
};

// xAI's published price when this was written: $5 per 1,000 X search calls.
// A blank variable is the default, not zero (see numberFromEnv in models.js
// for the time a blank price metered a whole provider at nothing).
function searchPricePerCall() {
  const configured = (process.env.XAI_X_SEARCH_PRICE_PER_1K || '').trim();
  const raw = Number(configured);
  return (configured && Number.isFinite(raw) && raw >= 0 ? raw : 5) / 1000;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The request body for one X search. Exported for the test, which pins it:
 * a field xAI does not know is a 400 that names it, and nothing else here
 * would notice until an agent's search failed.
 */
export function xSearchRequest({ question, handles, days }, now = new Date()) {
  const lookback = Math.min(90, Math.max(1, Number.isInteger(days) ? days : 30));
  const accounts = (Array.isArray(handles) ? handles : [])
    .map((h) => String(h || '').trim().replace(/^@/, ''))
    .filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h))
    .slice(0, 10);
  return {
    model: grokModel(),
    input: [
      {
        role: 'system',
        content:
          'You research posts on X for a startup team. Answer the question from the posts you find, ' +
          'say how many posts the answer rests on, quote short phrases where the wording matters, and ' +
          'say plainly when there is little or nothing on X about it. Do not answer from general knowledge.',
      },
      { role: 'user', content: String(question || '').trim() },
    ],
    tools: [
      {
        type: 'x_search',
        from_date: isoDay(new Date(now.getTime() - lookback * 86_400_000)),
        to_date: isoDay(now),
        ...(accounts.length ? { allowed_x_handles: accounts } : {}),
      },
    ],
  };
}

/** The text of a Responses API answer, wherever xAI put it. */
function answerText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) return body.output_text.trim();
  const parts = [];
  for (const item of body?.output || []) {
    if (item?.type !== 'message') continue;
    for (const c of item.content || []) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

/** Every post URL the answer cites, once each, in the order given. */
function citedUrls(body) {
  const urls = [];
  for (const c of body?.citations || []) urls.push(typeof c === 'string' ? c : c?.url);
  for (const item of body?.output || []) {
    for (const c of item?.content || []) {
      for (const a of c?.annotations || []) urls.push(a?.url);
    }
  }
  return [...new Set(urls.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))];
}

function searchCalls(body) {
  const reported = body?.usage?.server_side_tool_usage_details?.x_search_calls;
  if (Number.isInteger(reported) && reported >= 0) return reported;
  const made = (body?.output || []).filter((item) => /x_search/.test(item?.type || '')).length;
  return made || 1;
}

/**
 * Runs one X search. Returns the text the agent gets back, never throws:
 * a failed search is something the agent should read and work around, not a
 * reason to lose the turn. `meter` receives the cost to record.
 *
 * @param {object} input the tool input from the agent
 * @param {{pricing: {inputPricePerMTok: number, outputPricePerMTok: number}, meter?: (usd: number, tokens: object) => void, now?: Date}} opts
 */
export async function searchX(input, { pricing, meter = () => {}, now = new Date() } = {}) {
  const apiKey = readSecret('XAI_API_KEY');
  if (!apiKey) return 'X search is not available: XAI_API_KEY is not set in Railway. Work from web search instead.';
  const question = String(input?.question || '').trim();
  if (!question) return 'X search needs a question. Ask one specific thing.';

  let response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(xSearchRequest({ ...input, question }, now)),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    return `X search did not answer (${err.name === 'TimeoutError' ? 'timed out after 60 s' : err.message}). Work from web search instead.`;
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    console.error(`X search failed (${response.status}): ${detail}`);
    const why =
      response.status === 401 || response.status === 403
        ? 'xAI refused the key; check XAI_API_KEY in Railway'
        : response.status === 404 || /model/i.test(detail)
          ? `xAI does not know the model "${grokModel()}"; set XAI_MODEL in Railway to a current Grok model`
          : response.status === 429
            ? 'xAI is rate limiting or the account is out of credit'
            : `xAI answered ${response.status}`;
    return `X search failed: ${why}. Work from web search instead.`;
  }

  const body = await response.json().catch(() => null);
  const tokens = {
    inputTokens: body?.usage?.input_tokens || 0,
    outputTokens: body?.usage?.output_tokens || 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  const calls = searchCalls(body);
  const usd =
    (tokens.inputTokens * (pricing?.inputPricePerMTok || 0) + tokens.outputTokens * (pricing?.outputPricePerMTok || 0)) / 1e6 +
    calls * searchPricePerCall();
  meter(usd, tokens);

  const text = answerText(body);
  if (!text) return 'X search came back empty. There may be nothing on X about this; try a broader question or web search.';
  const urls = citedUrls(body);
  const sources = urls.length ? `\n\nPosts cited:\n${urls.slice(0, 15).map((u) => `- ${u}`).join('\n')}` : '\n\n(No posts were cited.)';
  return (text.slice(0, MAX_RESULT_CHARS) + sources).trim();
}
