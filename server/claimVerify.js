// Fetching a cited page so the critic can check what it actually says.
//
// The measured design this implements is MARCH's: a checker validates each
// proposition against retrieved evidence *in isolation*, deprived of the
// proposer's original output. Chain-of-Verification reaches the same
// conclusion from a different direction — verification questions must be
// answered independently of the draft, and that independence "is the part
// most naive implementations drop". Every measured verification win in that
// literature has the property that the verifier cannot see the proposer's
// answer; every measured failure lacks it.
//
// Why this is a local action and not the hosted web_fetch tool, which already
// exists: an Anthropic-hosted tool cannot travel to another provider, so
// attaching one would force the Validation Critic onto an Anthropic model —
// and the critic's cheap non-Anthropic model is the one thing about it the
// evidence supports. The documented failure is *all roles on one model*; a
// different family is the heterogeneity that finding asks for. So the
// retrieval happens here, in this server, and the tool that calls it is an
// ordinary action that any provider can be handed.
//
// This does not need a search API and costs nothing. Verification is not
// discovery: the claim arrives carrying the URL it was sourced from, and the
// only question is whether that page says what the claim says it says.

const MAX_BYTES = 400_000;
const EXCERPT_CHARS = 6_000;
const TIMEOUT_MS = 15_000;

export function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

/**
 * Fetches one cited page and returns the text around the claim.
 *
 * Never throws: a verifier that crashes on a dead link would make the critic
 * the most fragile agent in the company rather than the most sceptical. A
 * failed fetch is itself a finding — a claim whose source cannot be opened is
 * not a supported claim.
 *
 * @returns {Promise<{ok: boolean, status?: number, excerpt?: string, error?: string}>}
 */
export async function fetchCitedPage(url, { claim = '' } = {}) {
  const target = String(url || '').trim();
  if (!isHttpUrl(target)) {
    return { ok: false, error: 'Not an http(s) URL. A claim with no openable source is unsupported by definition.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Named honestly. A verifier that disguises itself as a browser is a
        // scraper, and this company does not need that argument.
        'User-Agent': 'Jarvis-ClaimVerifier/1.0 (+agent research verification)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
      },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `The page returned HTTP ${response.status}.` };
    }
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !/text\/html|text\/plain|application\/xhtml|application\/json/.test(type)) {
      return { ok: false, error: `The page is ${type.split(';')[0]}, which this verifier cannot read as text.` };
    }

    const raw = await readCapped(response);
    const text = toPlainText(raw);
    if (!text.trim()) return { ok: false, error: 'The page fetched but contains no readable text.' };
    return { ok: true, status: response.status, excerpt: excerptAround(text, claim) };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `no response in ${TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, error: `Could not open the page: ${reason}.` };
  } finally {
    clearTimeout(timer);
  }
}

// Bounded read. A verifier that pulls a 50MB page into memory to check one
// sentence is a denial of service the company performs on itself.
async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return (await response.text()).slice(0, MAX_BYTES);

  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks, Math.min(total, MAX_BYTES)));
}

function concat(chunks, length) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    const room = length - at;
    if (room <= 0) break;
    out.set(chunk.subarray(0, Math.min(chunk.length, room)), at);
    at += chunk.length;
  }
  return out;
}

export function toPlainText(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The part of the page worth reading, centred on whatever the claim is about.
 *
 * A page is usually far longer than the excerpt budget, and the top of it is
 * navigation. Centring on the claim's own distinctive terms is what makes the
 * difference between "the source is topically relevant" — which the evidence
 * says models already achieve reliably — and "the source supports this exact
 * number", which is the dimension they fail on.
 */
export function excerptAround(text, claim) {
  if (text.length <= EXCERPT_CHARS) return text;

  const terms = distinctiveTerms(claim);
  let best = -1;
  let bestScore = 0;
  const haystack = text.toLowerCase();
  // Coarse windows rather than every offset: this runs on every claim and the
  // resolution that matters is "which part of the page", not which character.
  for (let start = 0; start < haystack.length; start += 500) {
    const window = haystack.slice(start, start + EXCERPT_CHARS);
    const score = terms.reduce((sum, term) => sum + (window.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  if (best < 0) return `${text.slice(0, EXCERPT_CHARS)}\n\n[...truncated]`;

  const from = Math.max(0, best - 200);
  return `${from > 0 ? '[...earlier text omitted]\n\n' : ''}${text.slice(from, from + EXCERPT_CHARS)}\n\n[...truncated]`;
}

// Numbers first: a market-sizing claim lives or dies on its figure, and the
// figure is the term most likely to appear near the sentence that supports it.
function distinctiveTerms(claim) {
  const text = String(claim || '').toLowerCase();
  const numbers = text.match(/\d[\d.,]*/g) || [];
  const words = (text.match(/[a-z][a-z-]{4,}/g) || []).filter((word) => !STOPWORDS.has(word));
  return [...new Set([...numbers, ...words])].slice(0, 12);
}

const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'their', 'there', 'these', 'those', 'which', 'while',
  'would', 'could', 'should', 'because', 'between', 'through', 'during', 'before', 'under',
  'market', 'company', 'business', 'report', 'according', 'estimated', 'approximately',
]);
