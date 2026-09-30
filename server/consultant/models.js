// The models the consultant can put on a question, and the meter on each.
//
// One question, several model families, each answering alone: that is the
// point of the panel. A single model reviewing this company's plan will be
// wrong in its own consistent way; two or three that disagree show where the
// judgement is soft. So this offers every model that is configured (Claude
// always, then OpenAI, Gemini, Grok, DeepSeek and the OpenRouter tier when their
// keys are set) behind one call, priced with the same tables the rest of the
// company is metered by, and counted against the daily cap and the digest's own
// budget. Nothing here has tools: a consultant reads and writes, it acts on
// nothing.

import { MODELS, DEFAULT_TIER, CHEAP_TIER, OPENAI_TIER, GEMINI_TIER, DEEPSEEK_TIER, GROK_TIER } from '../agents/models.js';
import { isOpenAIConfigured, createCompletion as openai } from '../agents/openai.js';
import { isGeminiConfigured, createCompletion as gemini } from '../agents/gemini.js';
import { isGrokConfigured, createCompletion as grok } from '../agents/xai.js';
import { isDeepSeekConfigured, createCompletion as deepseek } from '../agents/deepseek.js';
import { isOpenRouterConfigured, createCompletion as openrouter } from '../agents/openrouter.js';
import { priceUsage } from '../usage.js';
import { recordSpend, assertUnderDailyCap, withSpendContext } from '../spend.js';

/** A ceiling for one digest, shared by every call it makes. */
export function createBudget(limitUsd) {
  let spent = 0;
  return {
    limit: limitUsd,
    add(usd) {
      spent += Number(usd) || 0;
    },
    get spent() {
      return spent;
    },
    remaining: () => Math.max(0, limitUsd - spent),
    assertRoom() {
      if (spent >= limitUsd) throw new Error(`the consultant's budget for one digest ($${limitUsd}) is spent`);
    },
  };
}

const tokens = (u = {}) => ({
  inputTokens: u.input_tokens || 0,
  outputTokens: u.output_tokens || 0,
  cacheWriteTokens: u.cache_creation_input_tokens || 0,
  cacheReadTokens: u.cache_read_input_tokens || 0,
});

const textOf = (res) => (res?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

/**
 * The models to ask, most trusted first. Claude is always there (the company
 * cannot run without it); the others are there when their keys are.
 */
export function panelMembers({ anthropic } = {}) {
  const members = [
    // retryEmpty: a Claude model can spend the whole token allowance thinking and
    // return no text at all (stop_reason max_tokens); ask() then tries once more
    // with thinking off and more room, which a written review does not need.
    { name: 'Claude', tier: DEFAULT_TIER, retryEmpty: true, create: (p) => anthropic.messages.create({ model: p.model, system: p.system, messages: p.messages, max_tokens: p.maxTokens, ...(p.thinkingOff ? { thinking: { type: 'disabled' } } : {}) }) },
  ];
  const add = (name, tier, configured, create) => configured() && members.push({ name, tier, create: (p) => create({ model: p.model, system: p.system, messages: p.messages, maxTokens: p.maxTokens }) });
  add('OpenAI', OPENAI_TIER, isOpenAIConfigured, openai);
  add('Gemini', GEMINI_TIER, isGeminiConfigured, gemini);
  add('Grok', GROK_TIER, isGrokConfigured, grok);
  add('DeepSeek', DEEPSEEK_TIER, isDeepSeekConfigured, deepseek);
  add('Hermes (OpenRouter)', CHEAP_TIER, isOpenRouterConfigured, openrouter);
  return members;
}

/**
 * One completion from one member: checked against the daily cap first,
 * metered into it after, and added to the digest's budget. Resolves to
 * { text, usd, model, stopReason }. An empty text is returned, not thrown, so
 * the caller can still count what the call cost.
 */
export async function ask(member, { system, user, maxTokens = 1800 }, budget) {
  budget?.assertRoom();
  assertUnderDailyCap();
  const spec = MODELS[member.tier];
  const model = spec.model;
  const call = async (extra = {}) => {
    const res = await withSpendContext({ source: 'consultant', agentId: member.name }, () =>
      member.create({ model, system, messages: [{ role: 'user', content: user }], maxTokens, ...extra }),
    );
    const t = tokens(res?.usage);
    const usd = priceUsage(t, spec);
    recordSpend(usd, { cacheWriteTokens: t.cacheWriteTokens, cacheReadTokens: t.cacheReadTokens });
    budget?.add(usd);
    return { text: textOf(res), usd, stopReason: res?.stop_reason || null };
  };
  let out = await call();
  if (!out.text && out.stopReason === 'max_tokens' && member.retryEmpty) {
    budget?.assertRoom();
    assertUnderDailyCap();
    const again = await call({ maxTokens: maxTokens * 2, thinkingOff: true });
    out = { ...again, usd: out.usd + again.usd };
  }
  return { ...out, model };
}
