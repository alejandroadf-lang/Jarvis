// Is the briefing running on the best models the founder can already use?
//
// The panel's reviewers are whatever model names are configured, and model names
// age quickly: a default pinned when the code was written is often not the newest
// the account can call, and a model can be renamed or retired without a word. The
// review of the reviewers is cheap to do and no model has to be trusted to do it:
// ask each provider's own list what the account can use, and compare with what is
// configured.
//
// What it reports is a fact ("configured X, created on D; newer on this account:
// Y, Z") and never a switch. Changing a model changes what a briefing costs, and
// the spend meter needs the new model's price set beside it (see agents/models.js),
// so the improvement it suggests says both. Weekly, cached, and fail-quiet per
// provider.

import { readJson, writeJson } from '../store.js';
import { readSecret } from '../env.js';
import { MODELS, DEFAULT_TIER, OPENAI_TIER, GEMINI_TIER, GROK_TIER, DEEPSEEK_TIER, CHEAP_TIER } from '../agents/models.js';
import { listModelsUrl } from '../agents/gemini.js';

const FILE = 'consultant-models.json';
const MAX_AGE_DAYS = 7;
const iso = (t) => (Number.isFinite(t) ? new Date(t * 1000).toISOString().slice(0, 10) : null);

// Tested on the model's own name, not its maker's: "nousresearch/…" contains "search".
const OTHER_MODALITIES = /embed|tts|whisper|dall|audio|image|imagine|moderation|transcribe|realtime|search|davinci|babbage|codex|vision-preview/i;
const bearer = (name) => () => ({ Authorization: `Bearer ${readSecret(name)}` });
const openaiShape = (b) => (b?.data || []).map((m) => ({ id: m.id, created: Number(m.created) }));

const PROVIDERS = [
  {
    name: 'Anthropic', tier: DEFAULT_TIER, key: 'ANTHROPIC_API_KEY', family: /^claude-/,
    url: () => 'https://api.anthropic.com/v1/models?limit=100',
    headers: () => ({ 'x-api-key': readSecret('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }),
    parse: (b) => (b?.data || []).map((m) => ({ id: m.id, created: Date.parse(m.created_at) / 1000 })),
  },
  { name: 'OpenAI', tier: OPENAI_TIER, key: 'OPENAI_API_KEY', family: /^(gpt-|o\d)/, url: () => 'https://api.openai.com/v1/models', headers: bearer('OPENAI_API_KEY'), parse: openaiShape },
  { name: 'Grok', tier: GROK_TIER, key: 'XAI_API_KEY', family: /^grok-/, url: () => 'https://api.x.ai/v1/models', headers: bearer('XAI_API_KEY'), parse: openaiShape },
  { name: 'DeepSeek', tier: DEEPSEEK_TIER, key: 'DEEPSEEK_API_KEY', family: /^deepseek-/, url: () => 'https://api.deepseek.com/models', headers: bearer('DEEPSEEK_API_KEY'), parse: openaiShape },
  {
    // OpenRouter's catalogue is public; only newer models from the same maker count.
    name: 'OpenRouter', tier: CHEAP_TIER, key: 'OPENROUTER_API_KEY', family: null,
    url: () => 'https://openrouter.ai/api/v1/models', headers: () => ({}), parse: openaiShape,
  },
  {
    // Gemini's list carries no dates, so "newer" is a higher version of the same kind (flash, pro).
    name: 'Gemini', tier: GEMINI_TIER, key: 'GEMINI_API_KEY', family: /^gemini-/, url: () => listModelsUrl(), headers: () => ({}),
    parse: (b) => (b?.models || []).map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), created: NaN })),
  },
];

const geminiVersion = (id) => {
  const m = String(id).match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro)\b/);
  return m ? { v: Number(m[1]), kind: m[2] } : null;
};

/** What is newer than the configured model on one provider's list. Pure. */
export function compareModels(provider, configured, list) {
  const usable = list.filter((m) => m.id && (!provider.family || provider.family.test(m.id)) && !OTHER_MODALITIES.test(m.id.split('/').pop()));
  const current = list.find((m) => m.id === configured);
  if (provider.name === 'Gemini') {
    const cur = geminiVersion(configured);
    const newer = cur ? usable.filter((m) => { const g = geminiVersion(m.id); return g && g.kind === cur.kind && g.v > cur.v; }).map((m) => m.id) : [];
    return { configured, found: Boolean(current), createdOn: null, newer: [...new Set(newer)].slice(0, 3).map((id) => ({ id, created: null })) };
  }
  const maker = provider.name === 'OpenRouter' ? String(configured).split('/')[0] : null;
  const pool = usable.filter((m) => !maker || m.id.startsWith(`${maker}/`));
  const cut = current && Number.isFinite(current.created) ? current.created : null;
  const newer = pool
    .filter((m) => Number.isFinite(m.created) && (cut === null ? false : m.created > cut) && m.id !== configured)
    .sort((a, b) => b.created - a.created)
    .slice(0, 3)
    .map((m) => ({ id: m.id, created: iso(m.created) }));
  return { configured, found: Boolean(current), createdOn: current ? iso(current.created) : null, newer };
}

export const getModelScout = () => readJson(FILE, null);

export function modelScoutIsStale(now = new Date()) {
  const s = getModelScout();
  return !s?.checkedAt || now.getTime() - Date.parse(s.checkedAt) > MAX_AGE_DAYS * 86_400_000;
}

/** Asks every configured provider what it offers. Never throws. Resolves to the stored result. */
export async function scoutModels({ fetchImpl = fetch, now = new Date(), env = process.env, tiers = MODELS } = {}) {
  const results = [];
  for (const p of PROVIDERS) {
    if (p.name !== 'OpenRouter' ? !env[p.key] : !env.OPENROUTER_API_KEY) continue;
    const configured = tiers[p.tier].model;
    try {
      const res = await fetchImpl(p.url(), { headers: p.headers(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      results.push({ provider: p.name, ...compareModels(p, configured, p.parse(await res.json())) });
    } catch (err) {
      results.push({ provider: p.name, configured, error: err.message });
    }
  }
  const stored = { checkedAt: now.toISOString(), results };
  writeJson(FILE, stored);
  return stored;
}

/** One fact per provider, for the email and the models. Pure. */
export function scoutFacts(scout) {
  return (scout?.results || []).map((r) => {
    if (r.error) return `Model check, ${r.provider}: could not list the account's models (${r.error}); the configured model is ${r.configured}.`;
    if (!r.found && r.provider !== 'Gemini') return `Model check, ${r.provider}: the configured model ${r.configured} is not in the account's list, so it may have been renamed or retired.`;
    return r.newer.length
      ? `Model check, ${r.provider}: configured ${r.configured}${r.createdOn ? ` (created ${r.createdOn})` : ''}; newer on this account: ${r.newer.map((n) => `${n.id}${n.created ? ` (${n.created})` : ''}`).join(', ')}.`
      : `Model check, ${r.provider}: configured ${r.configured}${r.createdOn ? ` (created ${r.createdOn})` : ''} is the newest of its kind on this account.`;
  });
}
