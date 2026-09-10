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
// So: presence of the env var is reported for everything, and the two that
// were just added are additionally *probed* — a real request that proves the
// credential is accepted, rather than merely present.

import { isOpenRouterConfigured } from './agents/openrouter.js';
import { isHonchoConfigured, FOUNDER_PEER_ID } from './memory/honcho.js';
import { isEmailConfigured } from './email.js';
import { isGithubConfigured } from './deploy/github.js';
import { MODELS, CHEAP_TIER } from './agents/models.js';

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
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
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
 * Everything the founder can switch on, and whether it's actually live.
 * The two probes run in parallel — neither depends on the other, and this
 * is fetched on page load.
 */
export async function getIntegrationStatus() {
  const [openrouter, honcho] = await Promise.all([probeOpenRouter(), probeHoncho()]);

  return {
    // Not optional: without it nothing runs at all, so it's reported for
    // completeness rather than probed.
    anthropic: {
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      ok: null,
      detail: process.env.ANTHROPIC_API_KEY ? 'Required, and set.' : 'Required. Nothing works without this.',
    },
    openrouter,
    honcho,
    // These two predate the probes and fail loudly at the point of use (an
    // action tool returns the reason), so presence is the useful signal.
    email: {
      configured: isEmailConfigured(),
      ok: null,
      detail: isEmailConfigured()
        ? 'Daily reports, alerts and real customer outreach can send.'
        : 'Not set — no report emails, and customer outreach is unavailable.',
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
