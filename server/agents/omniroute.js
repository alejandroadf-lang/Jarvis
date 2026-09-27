// OmniRoute: a self-hosted AI gateway (github.com/diegosouzapw/OmniRoute, MIT).
//
// One OpenAI-compatible endpoint in front of many providers, with its own
// quota-aware fallback between them. That is the problem this company kept
// hitting: Anthropic's credit ran out and the team fell back one provider at a
// time, each with its own key and balance to keep topped up. With OmniRoute,
// Jarvis makes one call and the gateway decides where it goes, including to
// free providers.
//
// It is a separate service the founder runs (on Railway, next to Jarvis), so
// this file is only the client: its URL, its key, its model. The HTTP call and
// the tool translation are the shared ones in openaiCompatible.js, which is
// why an orchestrator on OmniRoute can still delegate.
//
// The key is required, not optional. OmniRoute can run without keys, but on a
// public URL that means anyone who finds it spends the founder's provider
// quota. Refusing to use a keyless gateway is the one check this side can make.

import { readSecret, hasSecret } from '../env.js';
import { createChatCompletion } from './openaiCompatible.js';

// Plain http only where nothing leaves a private network: Railway's internal
// DNS and this machine.
const PRIVATE_HTTP_HOST = /(^localhost$)|(^127\.0\.0\.1$)|(\.railway\.internal$)/;

/**
 * The gateway's /v1 base, from whatever form the founder pasted: the bare
 * host, the /v1 base, or the full chat-completions URL. Null when unusable;
 * omniRouteProblem() says why.
 */
export function omniRouteBase(raw = process.env.OMNIROUTE_URL) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && PRIVATE_HTTP_HOST.test(url.hostname))) {
    return null;
  }
  if (url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
  return `${url.origin}${path}/v1`;
}

export function isOmniRouteConfigured() {
  return Boolean(omniRouteBase()) && hasSecret('OMNIROUTE_API_KEY');
}

/** What is missing, in the words the founder needs to fix it. Empty when configured. */
export function omniRouteProblem() {
  const raw = (process.env.OMNIROUTE_URL || '').trim();
  if (!raw) return 'OMNIROUTE_URL is not set.';
  if (!omniRouteBase(raw)) {
    return `OMNIROUTE_URL "${raw}" is not usable. It needs https (plain http only for *.railway.internal or localhost) and no password in it.`;
  }
  if (!hasSecret('OMNIROUTE_API_KEY')) {
    return 'OMNIROUTE_API_KEY is not set. Create one in the OmniRoute dashboard; a gateway without a key can be used by anyone who finds it.';
  }
  return '';
}

/**
 * The model OmniRoute is asked for. "auto" lets the gateway choose and fall
 * back on its own, which is the point of running it. A "provider/model" name
 * pins one instead.
 */
export function omniRouteModel() {
  return (process.env.OMNIROUTE_MODEL || '').trim() || 'auto';
}

/**
 * One completion, in the shape agentRunner reads from the Anthropic SDK.
 *
 * @param {{model: string, system: string, messages: Array<{role: string, content: any}>, maxTokens: number, tools?: Array}} opts
 */
export async function createCompletion({ model, system, messages, maxTokens, tools }) {
  const problem = omniRouteProblem();
  if (problem) throw new Error(problem);

  return createChatCompletion({
    url: `${omniRouteBase()}/chat/completions`,
    apiKey: readSecret('OMNIROUTE_API_KEY'),
    label: 'OmniRoute',
    model: model || omniRouteModel(),
    system,
    messages,
    maxTokens,
    tools,
  });
}
