// Anthropic-hosted tools, declared once.
//
// These execute inside Anthropic's own infrastructure rather than in this
// server, which is why they are the one thing canUseAlternativeModel still
// refuses to let travel: there is no request to translate and no handler to
// call. An agent that holds one of these cannot be moved to Gemini or DeepSeek
// however AGENT_MODEL_TIERS is set.
//
// Shared rather than declared inline on each agent because four copies of a
// version string is four places for it to drift, and a stale tool type is a
// 400 that names a field nobody set.

// Search finds a page. Fetch opens it — and for a long time this company had
// only the first half, which meant four agents could locate a document and
// never read it. The CFO's open question about RapidAPI's fee split was
// literally unanswerable: the answer was one click away on a page no agent
// could open.
// The version pin matters and drifted: fetch was current while search sat on a
// string from March 2025, eighteen months stale, on the single highest-leverage
// tool the company owns. The comment above this block warns that a stale type
// is "a 400 that names a field nobody set" — it was right, just not watched.
export const WEB_SEARCH = {
  type: 'web_search_20260209',
  name: 'web_search',
  // Read at call time, like the model prices in models.js and for the same
  // reason: a number the founder may want to move is a variable to change,
  // not a constant frozen at import.
  get max_uses() {
    return numberFromEnv('SEARCH_MAX_USES', 15);
  },
};
export const WEB_FETCH = {
  type: 'web_fetch_20260209',
  name: 'web_fetch',
  get max_uses() {
    return numberFromEnv('FETCH_MAX_USES', 10);
  },
};

// How many lookups a research turn gets.
//
// It was 4 and 4. Two tooled agents at four searches each is sixteen retrievals
// behind a decision to start a company — against Anthropic's own published
// heuristic of 10-15 tool calls per subagent for anything it classes as complex
// research, and their finding that tool-call count is the second-largest term in
// research quality after token volume, while model choice is a distant third.
// A cap of 4 spends the cheap term to save the expensive one.
//
// Not unbounded, and env-tunable rather than pinned, because every search is
// billed and the daily spend cap is the real backstop. Raise SEARCH_MAX_USES on
// a day the team is chasing something hard; lower it if the bill says so.
function numberFromEnv(name, fallback) {
  const raw = Number((process.env[name] || '').trim());
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** The pair an agent needs to actually research something rather than skim it. */
export const RESEARCH_TOOLS = [WEB_SEARCH, WEB_FETCH];
