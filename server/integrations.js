// Answers one question the app previously couldn't: "are my keys actually
// working?"
//
// Every optional integration here fails *quietly* on purpose. Honcho logs an
// error and the teams carry on with no founder memory; OpenRouter routes
// silently back to Claude; SMTP skips the send. That's the right behaviour —
// none of them should be able to take the company down — but it left the
// founder with no way to tell a working key from a typo'd one short of
// reading deploy logs, which is a bad answer for something you want to check
// on every redeploy.
//
// So: presence of the env var is reported for everything, and the ones whose
// failure is otherwise invisible are additionally *probed* — a real request
// that proves the credential is accepted, rather than merely present.

import { isOpenRouterConfigured } from './agents/openrouter.js';
import { isHonchoConfigured, FOUNDER_PEER_ID } from './memory/honcho.js';
import { isEmailConfigured } from './email.js';
import { isGithubConfigured } from './deploy/github.js';
import { isWorkspaceConfigured, workspaceConfig } from './workspace/vault.js';
import { isWhatsAppConfigured, allowedNumbers, GRAPH_API } from './channels/whatsapp.js';
import { isOpenAIConfigured, chatModel, fallbackModel, transcribeModel } from './agents/openai.js';
import { isGeminiConfigured, geminiModel, listModelsUrl } from './agents/gemini.js';
import { MODELS, CHEAP_TIER } from './agents/models.js';
import { readSecret } from './env.js';
import { getStorageStatus } from './storage.js';
import { accessStatus } from './auth.js';

// A probe must never hang a page load. Both services are normally fast; if
// one isn't, "couldn't reach it" is a more useful answer than a spinner.
const PROBE_TIMEOUT_MS = 8000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not respond within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS)
    ),
  ]);
}

function notConfigured(hint) {
  return { configured: false, ok: null, detail: hint };
}

/**
 * Asks OpenRouter about the key itself — the cheapest call that proves the
 * credential is accepted, and it costs nothing in tokens.
 */
async function probeOpenRouter() {
  if (!isOpenRouterConfigured()) {
    return notConfigured('Not set — every agent runs on Claude, which is the default.');
  }

  try {
    const res = await withTimeout(
      fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${readSecret('OPENROUTER_API_KEY')}` },
      }),
      'OpenRouter'
    );

    if (res.status === 401 || res.status === 403) {
      return { configured: true, ok: false, detail: 'Key rejected. The specialist agents are silently falling back to Claude.' };
    }
    if (!res.ok) {
      return { configured: true, ok: false, detail: `OpenRouter returned ${res.status}.` };
    }

    const body = await res.json().catch(() => ({}));
    const data = body?.data || {};
    // A valid key with no credit still can't run a paid model, which would
    // otherwise look identical to "working" right up until the first call.
    const limitRemaining = data.limit_remaining;
    if (typeof limitRemaining === 'number' && limitRemaining <= 0) {
      return {
        configured: true,
        ok: false,
        detail: `Key is valid but out of credit, so ${MODELS[CHEAP_TIER].model} can't run. Add credit at openrouter.ai/credits.`,
      };
    }

    const usage = typeof data.usage === 'number' ? ` $${data.usage.toFixed(2)} used so far.` : '';
    return { configured: true, ok: true, detail: `Key accepted — specialist agents run on ${MODELS[CHEAP_TIER].model}.${usage}` };
  } catch (err) {
    return { configured: true, ok: false, detail: `Couldn't reach OpenRouter: ${err.message}` };
  }
}

/**
 * Resolving the founder peer is the lightest call that proves the key and
 * workspace are both right — a wrong workspace id fails here rather than
 * silently building a second, empty memory.
 */
async function probeHoncho() {
  if (!isHonchoConfigured()) {
    return notConfigured('Not set — the teams keep their file-backed memory about the business, but learn nothing about you.');
  }

  try {
    const { getClientForProbe } = await import('./memory/honcho.js');
    const honcho = getClientForProbe();
    if (!honcho) return notConfigured('Not set.');

    await withTimeout(honcho.peer(FOUNDER_PEER_ID), 'Honcho');
    return {
      configured: true,
      ok: true,
      detail: 'Key accepted. The founder representation builds up asynchronously over several conversations.',
    };
  } catch (err) {
    return { configured: true, ok: false, detail: `Honcho rejected the request: ${err.message}` };
  }
}

/**
 * Reads back the phone number the token is supposed to control. This is the
 * one probe worth making here: a webhook that verified green proves only that
 * Meta could reach the app, and says nothing about whether the app can send
 * *back* — which is a separate token, and the failure mode is silence on the
 * founder's phone rather than an error anywhere they'd look.
 */
async function probeWhatsApp() {
  if (!isWhatsAppConfigured()) {
    const partial = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET']
      .filter((name) => !process.env[name]);
    if (!allowedNumbers().length) partial.push('WHATSAPP_ALLOWED_NUMBERS');
    return notConfigured(
      partial.length === 4
        ? 'Not set — the company can only be reached through this app.'
        : `Half-configured — still needs ${partial.join(', ')}.`
    );
  }

  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    const res = await withTimeout(
      fetch(`${GRAPH_API}/${id}?fields=display_phone_number,verified_name`, {
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      }),
      'WhatsApp'
    );
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Meta's temporary tokens last 24 hours, so an expired token is the
      // single likeliest reason this stops working with nothing else changed.
      const reason = body?.error?.message || `Graph API returned ${res.status}`;
      const expired = /expire|session|OAuth/i.test(reason);
      return {
        configured: true,
        ok: false,
        detail: expired
          ? `Token rejected: ${reason} Temporary tokens last 24 hours — generate a System User token for a permanent one.`
          : `Token rejected: ${reason}`,
      };
    }

    const number = body.display_phone_number ? ` from ${body.display_phone_number}` : '';
    const allowed = allowedNumbers();
    return {
      configured: true,
      ok: true,
      detail: `Token accepted — the company can reply${number} to ${allowed.length} allowlisted number${allowed.length === 1 ? '' : 's'}.`,
    };
  } catch (err) {
    return { configured: true, ok: false, detail: `Couldn't reach the Graph API: ${err.message}` };
  }
}

/**
 * Lists the models the key can see. It proves the credential and, unlike a
 * completion, costs nothing — which matters for something fetched on every
 * page load. It also catches the failure this app is most exposed to: a
 * pinned model name that OpenAI has since retired, which would otherwise
 * surface as a 404 only at the moment the founder needed an answer.
 */
async function probeOpenAI() {
  if (!isOpenAIConfigured()) {
    return notConfigured('Not set — no voice notes, and no fallback if Anthropic is down or out of credit.');
  }

  try {
    const res = await withTimeout(
      fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${readSecret('OPENAI_API_KEY')}` },
      }),
      'OpenAI'
    );

    if (res.status === 401 || res.status === 403) {
      return { configured: true, ok: false, detail: 'Key rejected. Voice notes and the Anthropic fallback are both unavailable.' };
    }
    if (!res.ok) {
      return { configured: true, ok: false, detail: `OpenAI returned ${res.status}.` };
    }

    const body = await res.json().catch(() => ({}));
    const available = new Set((body?.data || []).map((m) => m.id));
    const missing = [chatModel(), fallbackModel(), transcribeModel()].filter(
      (name) => available.size > 0 && !available.has(name)
    );
    if (missing.length) {
      return {
        configured: true,
        ok: false,
        detail: `Key works, but this account can't use ${missing.join(', ')}. Set OPENAI_MODEL / OPENAI_FALLBACK_MODEL / OPENAI_TRANSCRIBE_MODEL to names it can.`,
      };
    }

    return {
      configured: true,
      ok: true,
      detail: `Key accepted — voice notes transcribe with ${transcribeModel()}, and ${fallbackModel()} covers an Anthropic outage.`,
    };
  } catch (err) {
    return { configured: true, ok: false, detail: `Couldn't reach OpenAI: ${err.message}` };
  }
}

/**
 * Lists the models the key can see — free, and it catches the same trap as
 * the OpenAI probe: a pinned model name Google has since retired, which
 * otherwise surfaces as a 404 at the moment an answer is needed.
 */
async function probeGemini() {
  if (!isGeminiConfigured()) {
    return notConfigured('Not set — one fewer backup if Anthropic is down or out of credit.');
  }

  try {
    const res = await withTimeout(fetch(listModelsUrl()), 'Gemini');

    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { configured: true, ok: false, detail: 'Key rejected, so Gemini cannot cover an Anthropic outage.' };
    }
    if (!res.ok) {
      return { configured: true, ok: false, detail: `Gemini returned ${res.status}.` };
    }

    const body = await res.json().catch(() => ({}));
    // Google returns names as "models/gemini-…"; compare on the bare name.
    const available = new Set((body?.models || []).map((m) => String(m.name || '').replace(/^models\//, '')));
    const wanted = geminiModel().replace(/^models\//, '');
    if (available.size > 0 && !available.has(wanted)) {
      return {
        configured: true,
        ok: false,
        detail: `Key works, but this account can't use ${wanted}. Set GEMINI_MODEL to a name it can.`,
      };
    }

    return { configured: true, ok: true, detail: `Key accepted — ${wanted} can cover an Anthropic outage.` };
  } catch (err) {
    return { configured: true, ok: false, detail: `Couldn't reach Gemini: ${err.message}` };
  }
}

/**
 * Everything the founder can switch on, and whether it's actually live.
 * The probes run in parallel — none depends on another, and this is fetched
 * on page load.
 */
export async function getIntegrationStatus() {
  const [openrouter, honcho, whatsapp, openai, gemini] = await Promise.all([
    probeOpenRouter(),
    probeHoncho(),
    probeWhatsApp(),
    probeOpenAI(),
    probeGemini(),
  ]);

  return {
    // Not optional: without it nothing runs at all, so it's reported for
    // completeness rather than probed.
    anthropic: {
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      ok: null,
      detail: process.env.ANTHROPIC_API_KEY ? 'Required, and set.' : 'Required. Nothing works without this.',
    },
    // Reported here because it is the one that makes every other guardrail
    // conditional: a kill switch anyone can resume is not a kill switch.
    access: accessStatus(),
    // Not an integration, but it belongs on the same panel: it fails exactly
    // the way the others do — silently, and only noticed once something has
    // already been lost.
    storage: (() => {
      const status = getStorageStatus();
      return { configured: status.dirConfigured, ok: status.persistent, detail: status.detail };
    })(),
    openrouter,
    openai,
    gemini,
    honcho,
    whatsapp,
    // These two predate the probes and fail loudly at the point of use (an
    // action tool returns the reason), so presence is the useful signal.
    email: {
      configured: isEmailConfigured(),
      ok: null,
      detail: isEmailConfigured()
        ? 'Daily reports, alerts and real customer outreach can send.'
        : 'Not set — no report emails, and customer outreach is unavailable.',
    },
    // Reported rather than probed: a bad repo name surfaces loudly at the
    // point of use (the publish logs the GitHub error), and probing would
    // mean a read against the founder's private vault on every page load.
    workspace: {
      configured: isWorkspaceConfigured(),
      ok: null,
      detail: isWorkspaceConfigured()
        ? `Reports, reflections and venture notes publish to ${workspaceConfig().owner}/${workspaceConfig().repo} (${workspaceConfig().branch}).`
        : process.env.WORKSPACE_REPO_OWNER || process.env.WORKSPACE_REPO_NAME
          ? 'Half-configured — needs WORKSPACE_REPO_OWNER, WORKSPACE_REPO_NAME and a GITHUB_TOKEN.'
          : 'Not set — the company keeps its written output in this app only.',
    },
    github: {
      configured: isGithubConfigured(),
      ok: null,
      detail: isGithubConfigured()
        ? 'Real commits are possible for ventures with a linked, enabled repo.'
        : 'Not set — code deployment stays simulated.',
    },
  };
}
