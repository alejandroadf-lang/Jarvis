// Whether the company may spend money on models at all.
//
// The founder's rule: pay for models only when they decide it makes sense, and
// have free ones to fall back on. Paid models are ON until PAID MODELS OFF (or
// PAID_MODELS=false) says otherwise, because the Anthropic API credit exists to
// be spent and a default of "off" stalled every agent the day the one free
// quota ran out. When a paid provider is down the free ones are tried first (see
// failOverToBackup). That is one switch, not a per-agent setting,
// because the failure it prevents is quiet: a fallback chain that tries Claude,
// then OpenAI, then DeepSeek will happily use whichever paid account still has
// credit, and nothing reports it until the balance is gone. (That is how an
// empty Anthropic account turned into a month of agents silently running on
// whatever else answered.)
//
// What counts as "free" is decided in models.js, by price: a model whose input
// and output prices are both 0. A free-tier Gemini key or an OpenRouter ":free"
// model is declared free by setting its price variables to 0, which also keeps
// the spend meter honest.
//
// Precedence: the founder's PAID MODELS ON/OFF from WhatsApp wins once given;
// until then the PAID_MODELS environment variable is the default, and unset
// means on. It is kept in the data directory rather than the environment so it
// can change without a redeploy, and so the answer survives one.

import { readJson, writeJson } from '../store.js';

const FILE = 'model-policy.json';
const FALSE = /^(0|false|no|off)$/i;

const saved = () => {
  const v = readJson(FILE, {}).paid;
  return typeof v === 'boolean' ? v : null;
};

export function paidModelsAllowed() {
  const chosen = saved();
  if (chosen !== null) return chosen;
  return !FALSE.test((process.env.PAID_MODELS || '').trim());
}

/** Where the current answer comes from, for the status line. */
export function paidModelsSource() {
  if (saved() !== null) return 'your PAID MODELS command';
  return (process.env.PAID_MODELS || '').trim() ? 'the PAID_MODELS variable' : 'the default (on)';
}

export function setPaidModels(on) {
  writeJson(FILE, { paid: Boolean(on), at: new Date().toISOString() });
  return Boolean(on);
}
