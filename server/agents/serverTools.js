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
export const WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: 4 };
export const WEB_FETCH = { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 4 };

/** The pair an agent needs to actually research something rather than skim it. */
export const RESEARCH_TOOLS = [WEB_SEARCH, WEB_FETCH];
