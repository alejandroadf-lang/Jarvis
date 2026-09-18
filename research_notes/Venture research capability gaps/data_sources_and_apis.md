# Data Sources and APIs Available to a Small Automated Agent Team (2026)

> **Methodological caveat for the report-writer — read this first.** During this research the sandbox's egress proxy blocked direct fetches of almost every vendor's own pricing page (brave.com, exa.ai, tavily.com, docs.perplexity.ai, parallel.ai, sec.gov, developer.company-information.service.gov.uk all returned `EGRESS_BLOCKED` / HTTP 403 via both WebFetch and curl). Findings below therefore rest largely on **search-result snippets and third-party aggregator/comparison sites**, many of which are SEO-driven content farms (costbench.com, dataforb2b.ai, zephira.ai, thatmarketingbuddy.com, apicostcalc.com, easyvc.ai, etc.) whose numbers I could not independently verify against the vendor. Where a number comes only from such a site I flag it as **[unverified aggregator]**. Anything the reader intends to spend money on should be re-checked against the vendor's own pricing page. Several vendor-hosted pages (e.g. `api-dashboard.search.brave.com/documentation/pricing`, `harmonic.ai/pricing`, `dealroom.co/api-access`, `tracxn.com/pricing`, `valyu.ai/pricing`, `parallel.ai/pricing`, `appfigures.com/platform/pricing`, `data.uspto.gov/apis/api-rate-limits`) appeared in search results and are the right primary sources to confirm against.

---

## Q1. What do the major private-market databases cost, and what API access do they offer?

### Takeaway
Every major private-market database is priced out of reach of a tens-of-dollars-a-month budget for anything resembling real API access: the cheapest credible API-bearing tier is Crunchbase at ~$99/mo (and even that is reported to be a crippled subset), while PitchBook, CB Insights, Dealroom and Harmonic all sit in the $12k–$100k+/year enterprise band with sales-led, unpublished pricing. Crunchbase's free API tier — historically the one on-ramp for small builders — was eliminated in 2025, and no 2026 entrant found in this research restores a free programmatic tier.

### Cited Findings

**Crunchbase**
- Crunchbase eliminated free API access entirely as of 2025; there is no trial key, sandbox, or developer plan, making pre-purchase testing impossible — [DEV Community: "Crunchbase API in 2026: Free Tier Gone"](https://dev.to/agenthustler/crunchbase-api-in-2026-free-tier-gone-what-startup-data-hunters-do-now-1177) **[unverified aggregator]**
- Cheapest paid plan is $49/month (Basic); the full-featured API is reported to require the Pro plan at $99/month — [nubela.co Crunchbase API guide](https://nubela.co/blog/crunchbase-api/) **[unverified aggregator]**
- Conflicting claim: *full* API access requires Enterprise or Applications licensing at custom pricing, with Enterprise contracts "typically starting at $50,000+ annually" — [DataForB2B Crunchbase API Review 2026](https://dataforb2b.ai/blog/crunchbase-api-review); this **contradicts** the $99/mo-gets-you-the-API claim above and I could not resolve it without reaching crunchbase.com directly.
- Rate limit reported as 200 calls/minute across all endpoints, uniform with no tiering by plan level — [ZoomInfo Pipeline: Crunchbase API Review, Aug 2026](https://pipeline.zoominfo.com/sales/crunchbase-api) **[unverified aggregator]**
- Crunchbase launched an **MCP server** in July 2026 to bring private-market intelligence into LLM workflows, targeting financial analysis, investing, revenue and product teams — [Crunchbase press release](https://about.crunchbase.com/press/press-releases/crunchbase-launches-mcp-to-bring-private-market-intelligence-into-ai-workflows) (primary source). The press coverage found did not state which subscription tier the MCP requires.

**PitchBook**
- PitchBook does not publish pricing; reported at $12k–$70k/year, "well into five figures per seat annually" — [VC Beast: PitchBook Alternatives 2026](https://vcbeast.com/pitchbook-alternatives) **[unverified aggregator]**

**CB Insights**
- Reported range: ~$29,800/year (Essential, individual) up to $100,000+/year (Enterprise with API access, CRM integrations, unlimited seats) — [CostBench: CB Insights Pricing 2026](https://costbench.com/software/financial-data-terminals/cb-insights/) **[unverified aggregator]**
- API access reported as an **add-on of ~$25,000–$50,000/year on top of** the base subscription — [CostBench](https://costbench.com/software/financial-data-terminals/cb-insights/) **[unverified aggregator]**; a second aggregator puts advanced team plans with ChatCBI at $50k–$70k/year — [EasyVC: CB Insights Pricing](https://easyvc.ai/vs/cb-insights-pricing/) **[unverified aggregator]**
- CB Insights' own 2026 positioning is agentic: a "Strategy Terminal" with 11 specialized AI agents and **ChatCBI 3.0**, which converts natural-language queries into 60+ search filters over 11M+ companies — [CB Insights March 2026 product launch](https://www.cbinsights.com/march-2026-product-launch) / [CB Insights "team of agents"](https://cbinsights.com/team-of-agents) (vendor primary pages, seen via search index only)

**Tracxn**
- Individual subscriptions reported at ~$199/month; enterprise plans are annual per-seat contracts negotiated with sales; one comparison puts Tracxn at "$500–$1,000/yr" — [VC Beast](https://vcbeast.com/pitchbook-alternatives), [Qubit Capital: Top 10 Investor Databases 2026](https://qubit.capital/blog/startup-databases-investors) **[unverified aggregators; these two figures are mutually inconsistent]**
- Tracxn publishes a pricing page at [tracxn.com/pricing](https://tracxn.com/pricing); no public API pricing was found in search results.

**Dealroom**
- No free plan or free tier; minimum ~€12,500/year for Premium with 3 seats; a 14-day free trial of Premium including 1,000 export credits, no credit card required — [Ellty: Dealroom Pricing 2026](https://www.ellty.com/blog/dealroom-pricing) **[unverified aggregator]**
- API access is **limited** under Premium; **full API access requires the Enterprise plan** at custom pricing — [Ellty](https://www.ellty.com/blog/dealroom-pricing) **[unverified aggregator]**; Dealroom's own API page is [dealroom.co/api-access](https://dealroom.co/api-access)
- A separate comparison quotes Dealroom at "$300–$1,500/mo" — [Qubit Capital](https://qubit.capital/blog/startup-databases-investors); **contradicts** the €12.5k/yr-minimum figure.
- Note a **name collision**: `dealroom.net` is an unrelated M&A-software vendor with its own [API docs](https://dealroom.net/api) and [pricing](https://dealroom.net/products/pricing). Do not confuse it with `dealroom.co`, the European startup database.

**Newer / adjacent entrants (Harmonic, Specter)**
- **Harmonic.ai**: no published prices; emerging-fund GPs report quotes of **$20k–$24k per seat per year** at 2026 list prices, custom above 5 seats. **No free tier, no trial.** Financing data and CRM sync are paid add-ons. Tiers are Enterprise Console, API Access, and Bulk Data (29M company records, 190M people records, weekly refresh, delivered via S3/BigQuery/Snowflake) — [Harmonic pricing page](https://harmonic.ai/pricing) (vendor, via search index) and [GitDealflow signals](https://signals.gitdealflow.com/answers/free-harmonic-ai-alternative-2026) **[unverified aggregator for the $20–24k figure]**
- **Specter** markets an API over "55M companies & 550M profiles" — [tryspecter.com/api](https://www.tryspecter.com/api) (vendor page, via search index). No pricing surfaced in search results.

### Inferences
- The gap the reader faces is structural, not a matter of shopping harder: the private-markets category has converged on sales-led, per-seat, four-to-five-figure annual contracts, and the one historically free programmatic door (Crunchbase's free API) was closed in 2025. A tens-of-dollars budget buys *zero* of this category.
- The realistic ceiling for a tiny team is Crunchbase Pro at ~$99/mo **if** the $99 tier genuinely includes usable API access — that single fact is worth verifying directly before any plan depends on it, because the two sources found disagree.
- Dealroom's 14-day full-Premium trial with 1,000 export credits is the cheapest way to get a one-off bulk snapshot of European private-company data, if a point-in-time extract (rather than an ongoing feed) is acceptable.
- Vendors are moving to MCP/agent interfaces (Crunchbase MCP, CB Insights' agent terminal), so the *interface* problem is being solved even as the *price* problem is not.

### Gaps
- Could not verify any of these prices against vendor pricing pages — all vendor domains were egress-blocked. Every number in this section should be treated as second-hand.
- Whether the Crunchbase MCP is available on the $99/mo Pro tier or only on Enterprise is unknown; the press release found did not say.
- No published per-call or metered API pricing was found for PitchBook, CB Insights, Tracxn or Dealroom — all appear to be contract-only.
- I found no genuinely new 2026 entrant offering a free or sub-$50/mo private-markets API. Absence of evidence here is weak evidence of absence; targeted searching for specific new names (e.g. Canonical, Rings, Signal-type products that appeared in result titles) was not done.

---

## Q2. What high-quality FREE or cheap structured sources exist for market and company research?

### Takeaway
There is a genuinely deep free tier for *fundamentals* — regulatory filings, company registries, patents, official statistics, developer-ecosystem telemetry and web archives — nearly all of it keyless or free-key, with generous rate limits. The expensive-and-closed zone is specifically **private-company funding data, software-review content, and social/community data**, which is exactly where venture research most wants to look.

### Cited Findings

**Regulatory filings (US) — SEC EDGAR**
- SEC EDGAR exposes public APIs (submissions, company concept, company facts, frames) plus full-text search, all free and keyless — [SEC.gov: Accessing EDGAR Data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) (primary source, seen via search index; direct fetch was blocked)
- Rate limit: **no more than 10 requests/second from a single IP**; exceeding it blocks the IP until the request rate stays below threshold for a full 10 minutes — [SEC.gov accessing-edgar-data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data), corroborated by [DealCharts: EDGAR rate limits](https://dealcharts.org/blog/edgar-scraping-rate-limits-explained) and [tldrfiling](https://tldrfiling.com/blog/sec-edgar-api-rate-limits-best-practices)
- A **declared User-Agent header is required**; SEC's fair-access policy asks users to script efficiently, download only what is needed, and moderate request rates — [SEC.gov](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data); [tldrfiling](https://tldrfiling.com/blog/sec-edgar-api-rate-limits-best-practices)
- SEC also published [new rate control limits](https://www.sec.gov/filergroup/announcements-old/new-rate-control-limits) for EDGAR websites — worth reading directly for the current thresholds.

**Company registries**
- **UK Companies House** public data API: free, documented, key-based. Rate limit reported as **600 requests per 5 minutes** (~7,200/hour); Companies House grants only small increases and points heavy users to bulk products or the streaming API — [Companies House developer forum: API limits](https://forum.companieshouse.gov.uk/t/companies-house-api-limits/8626); spec index at [developer-specs.company-information.service.gov.uk](https://developer-specs.company-information.service.gov.uk/)
- **GLEIF** (Legal Entity Identifier register) publishes an open API with **no API key required** — [GLEIF API](https://www.gleif.org/en/lei-data/gleif-api) (primary vendor page, via search index). Specific rate limits were not found.
- **OpenCorporates** is *not* free at scale: published self-serve plans are Essentials £2,250/yr (200 API calls/day), Starter £6,600/yr (500/day), Basic £12,000/yr (1,000/day); free at-scale access exists **only on application** for public-benefit projects (journalists, NGOs, universities, anti-crime research) — [Zephira: OpenCorporates Pricing Explained 2026](https://zephira.ai/opencorporates-pricing-explained-2026-plans-api-limits-licensing-and-what-it-means-in-production/) **[unverified aggregator]**; vendor page is [opencorporates.com/pricing](https://opencorporates.com/pricing/)

**Patents**
- **PatentsView** (USPTO-funded): free API, rate limit **45 API calls/minute**, plus free bulk CSV/data-table downloads — [Seibs: USPTO Patent API Free](https://www.seibs.co/blog/uspto-patent-api-free) **[unverified aggregator]**; bulk downloads at [PatentsView Data Downloads](https://patentsview.org/downloads/data-downloads) (primary)
- **USPTO Open Data Portal**: requires a free USPTO.gov account and API key; enforces **one request at a time** and a weekly quota, returning HTTP 429 when exceeded — [USPTO API Rate Limits](https://data.uspto.gov/apis/api-rate-limits) and [USPTO FAQs](https://data.uspto.gov/support) (primary pages, via search index); key management at [data.uspto.gov/apikey]
- **EPO Open Patent Services (OPS) v3.2**: fair-use policy limits **non-paying users to 4 GB/week**; paying users get higher quotas — [patent.dev: EPO OPS v3.2 Go client](https://patent.dev/epo-ops-v3-2-go-client-library/) and [github.com/patent-dev/epo-ops](https://github.com/patent-dev/epo-ops)

**Official statistics**
- **World Bank Indicators API**: "API keys and other authentication methods are no longer necessary" — free and keyless — [World Bank Data Help Desk: About the Indicators API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation); call structures at [API Basic Call Structures](https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-about-the-indicators-api-documentation)
- **Eurostat**: data freely accessible, **no API key required** — [Eurostat API getting started guide](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started)

**Developer-ecosystem telemetry**
- **GitHub REST API**: 60 requests/hour unauthenticated, **5,000/hour authenticated**, 15,000/hour for GitHub Apps owned by a GitHub Enterprise Cloud org — [GitHub Docs: Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) (primary)
- For bulk/historical GitHub activity, **GH Archive via Google BigQuery** avoids API polling entirely — [GitHub community discussion #180131](https://github.com/orgs/community/discussions/180131)
- **PyPI download stats**: the Linehaul project streams PyPI download logs into the **public BigQuery dataset `bigquery-public-data.pypi.file_downloads`**; BigQuery's free tier allows **up to 1 TB of queries/month without a credit card** — [Python Packaging User Guide: Analyzing PyPI package downloads](https://packaging.python.org/guides/analyzing-pypi-package-downloads/) and [PyPI BigQuery docs](https://docs.pypi.org/api/bigquery/) (both primary)
- **pypistats.org** offers a simple free JSON API with pre-aggregated daily/weekly/monthly package stats — [pypistats.org/about](https://pypistats.org/about); CLI wrapper [pypinfo](https://github.com/ofek/pypinfo)

**Community / forum signal**
- **Hacker News**: the Algolia-powered HN Search API is **completely free, no auth or API key**, limited to **10,000 requests/hour per IP** — [HN Search API docs](https://hn.algolia.com/api) (primary) and [SocialCrawl: Hacker News API](https://www.socialcrawl.dev/platforms/hackernews)
- **Reddit**: free tier is **100 queries/minute per OAuth client and is restricted to non-commercial use**; ~10 QPM unauthenticated. **Commercial use requires Reddit approval and is billed at $0.24 per 1,000 API calls**, with the commercial tier reported at **$12,000/month for up to 50M calls**. Since Reddit's Responsible Builder Policy closed self-service app registration in late 2025, **every new OAuth client — free or paid — goes through manual approval**, typically 2–4 weeks — [Prowlo: Reddit Data API terms & commercial use 2026](https://prowlo.com/blog/reddit-data-api) and [Prowlo: Reddit API Pricing 2026](https://prowlo.com/blog/reddit-api-pricing) **[unverified aggregators, but multiple independent sites agree on the $0.24/1k figure]**
- Note the sharp cliff: "there is nothing between the free tier's 100 queries per minute and a $12,000/month commitment" — [Xpoz: Reddit API Pricing 2026](https://www.xpoz.ai/blog/guides/reddit-api-pricing-tiers-and-alternatives/)

**Job postings (hiring signals)**
- **Adzuna** publishes a documented self-serve API with a free tier of **~1,000 calls/month**, covering job search and labour-market analytics across 16+ countries; instant free App ID and key at developer.adzuna.com; returns titles, company, location, salary ranges, category, contract type — [jobspipe.dev: Adzuna API field guide](https://jobspipe.dev/blog/adzuna-api) and [publicapis.io Adzuna](https://publicapis.io/adzuna-api)
- The **Indeed Publisher API is deprecated**; third-party aggregators (e.g. LoopCV, TheirStack) now resell Indeed-inclusive feeds — [LoopCV developers](https://www.loopcv.pro/developers/); [TheirStack Job Postings API](https://theirstack.com/en/job-posting-api). Pricing for these was not established.

**Software reviews (G2 / Capterra) — restricted**
- **Capterra's General User Terms explicitly prohibit** automated access: users agree not to "access, collect, copy, scrape, harvest, cache, index, store, archive, or otherwise extract any content or data from the Service, including user reviews, reviewer identities or metadata, ratings, badges, comments, product information, rankings, categories, analytics, derived data" by automated, programmatic or mechanical means without express prior written consent — [Capterra General User Terms](https://www.capterra.com/legal/terms-of-use/) (primary)
- **G2**: no public reviews API found; robots.txt takes a guarded stance with most site sections disallowed and only a few explicitly permitted — [Scrapfly: How to Scrape Capterra](https://scrapfly.io/blog/posts/how-to-scrape-capterra); [ScrapeOps G2 page](https://scrapeops.io/websites/g2/)
- Neither platform offers a public reviews API; scraping is the only technical route and is contractually barred at Capterra.

**App store rankings**
- Apple's **iTunes Search API** and App Store review RSS feeds are free — [Trends MCP: Sensor Tower alternatives](https://www.trendsmcp.ai/blog/sensor-tower-alternatives) **[unverified aggregator]**
- **Appfigures** has a documented [Ranks API](https://docs.appfigures.com/api/reference/v2/ranks); Appfigures Connect reported at **$9.99/month** ($7.99 yearly, 25 keywords / 5 apps) for own-app reporting, with **Market Intel Scout at $599.99/month** for competitive intelligence — [Appfigures pricing](https://appfigures.com/platform/pricing) (vendor page, via search index) **[per-tier figures unverified]**
- **Sensor Tower publishes no dollar grid and has no self-serve SKUs** — [Trends MCP](https://www.trendsmcp.ai/blog/sensor-tower-alternatives)
- Cheaper ASO alternatives cited: **MobileAction ASO Lite at $15/month**; **AppTweak Essential at £79/month** (grid opened 30 Aug 2026) — [Trends MCP](https://www.trendsmcp.ai/blog/sensor-tower-alternatives) **[unverified aggregator]**

**Web archives**
- **Wayback Machine CDX API** is free to query directly but rate-limited; batch users are advised to insert request delays. Commercial scrapers reselling Wayback captures charge ~$2 per 1,000 captures — [Smartial: Controlling result limits in Wayback CDX queries](https://smartial.net/how-to-control-result-limits-in-wayback-machine-cdx-queries/); [Apify Wayback CDX Scraper](https://apify.com/smorgi_apps/wayback-cdx-scraper)
- **Common Crawl** is an open repository of web crawl data, free to access and analyse, containing billions of pages — [comcrawl on PyPI](https://pypi.org/project/comcrawl/)

### Inferences
- A tiny agent team can assemble a *genuinely good* free stack for: public-company fundamentals (EDGAR XBRL), legal-entity identity (Companies House, GLEIF), innovation activity (PatentsView, EPO OPS), macro/market sizing (World Bank, Eurostat), developer traction (GitHub + PyPI BigQuery + pypistats), early technical buzz (HN Algolia), hiring signal (Adzuna free tier), and historical website/positioning change (Wayback CDX). Total marginal cost: ~$0.
- The free stack is strongest exactly where private-market vendors are weakest (verifiable primary-source facts) and weakest exactly where they are strongest (who raised what, from whom, at what valuation). This suggests a complementary rather than substitutive strategy.
- Reddit's structure — free-but-non-commercial, then a $12k/mo cliff, plus mandatory 2–4 week manual approval — makes it effectively unavailable to a commercial micro-team. Treat Reddit as reachable only through a general web-search API's index, not through Reddit's own API.
- Capterra's terms are the clearest hard legal blocker found in this research. An agent that scrapes Capterra is in explicit breach of contract, regardless of technical feasibility.

### Gaps
- Could not confirm SEC EDGAR, Companies House or USPTO details against the primary pages (egress blocked); all primary-source content here came through search-result summaries of those pages.
- No specific rate limits found for: GLEIF API, Eurostat API, World Bank API, Wayback CDX API.
- **US Census Bureau and UK ONS APIs were not covered** — searches returned no usable detail on their rate limits or key requirements. Both are known to exist and are free; the report should flag this as unresearched rather than absent.
- **Stack Overflow Developer Survey** was not researched. (It is distributed as a free annual CSV/ODbL download rather than an API, but I found no source for that in this session and will not assert it.)
- **npm download-count API** specifics were not found; the search returned only PyPI material. npm does expose `api.npmjs.org/downloads/...` but I have no source to cite for its limits.
- Common Crawl's access mechanics (index API, S3 requester-pays vs free, rate limits) were not established beyond "free and open".

---

## Q3. Which sources have documented public APIs an agent can call, with what limits and terms?

### Takeaway
Summarised as a decision table; the practical rule is that government and open-data sources are keyless-or-free-key with honour-system rate limits and fair-use terms, while commercial platforms (Reddit, Crunchbase, OpenCorporates, Capterra) gate on approval, contract value, or outright prohibition.

### Cited Findings — consolidated table

| Source | Public API? | Cost | Rate limit | Terms note |
|---|---|---|---|---|
| SEC EDGAR | Yes (submissions, companyconcept, companyfacts, frames, full-text search) | Free, no key | 10 req/sec per IP; breach = IP block until <threshold for 10 min | Declared User-Agent header required; fair-access policy — [SEC](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) |
| UK Companies House | Yes, keyed | Free | ~600 req / 5 min | Increases granted only in small amounts; bulk/streaming products for heavy use — [CH forum](https://forum.companieshouse.gov.uk/t/companies-house-api-limits/8626) |
| GLEIF | Yes | Free, **no key** | Not found | Open register — [GLEIF](https://www.gleif.org/en/lei-data/gleif-api) |
| OpenCorporates | Yes, keyed | £2,250–£12,000/yr self-serve | 200 / 500 / 1,000 calls **per day** by tier | Free at-scale only on application for public-benefit use — [Zephira](https://zephira.ai/opencorporates-pricing-explained-2026-plans-api-limits-licensing-and-what-it-means-in-production/) |
| PatentsView | Yes | Free | 45 calls/min | Bulk CSV downloads also free — [PatentsView](https://patentsview.org/downloads/data-downloads) |
| USPTO Open Data Portal | Yes, keyed | Free | 1 concurrent request; weekly quota; HTTP 429 on breach | USPTO.gov account required — [USPTO](https://data.uspto.gov/apis/api-rate-limits) |
| EPO OPS v3.2 | Yes | Free tier | **4 GB/week** for non-paying users | Fair-use policy — [patent.dev](https://patent.dev/epo-ops-v3-2-go-client-library/) |
| World Bank Indicators | Yes | Free, **no key** | Not found | — [World Bank](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation) |
| Eurostat | Yes | Free, **no key** | Not found | — [Eurostat](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started) |
| GitHub REST | Yes | Free | 60/hr anon; 5,000/hr authed; 15,000/hr Enterprise App | — [GitHub Docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| PyPI (BigQuery) | Public dataset, not REST | Free within BigQuery's 1 TB/mo free tier | BigQuery quota | — [Python Packaging Guide](https://packaging.python.org/guides/analyzing-pypi-package-downloads/) |
| pypistats.org | Yes, JSON | Free | Not found | — [pypistats](https://pypistats.org/about) |
| Hacker News (Algolia) | Yes | Free, **no auth** | 10,000 req/hr per IP | — [HN Search API](https://hn.algolia.com/api) |
| Reddit | Yes, OAuth | Free tier **non-commercial only**; commercial $0.24/1k calls | 100 QPM per OAuth client (free); ~10 QPM anon | **Manual approval required for every new client** since late 2025 — [Prowlo](https://prowlo.com/blog/reddit-data-api) |
| Adzuna | Yes | Free tier ~1,000 calls/mo | — | Self-serve instant key — [jobspipe](https://jobspipe.dev/blog/adzuna-api) |
| Appfigures | Yes (Ranks API) | From $9.99/mo (own apps); $599.99/mo Market Intel | — | — [Appfigures](https://docs.appfigures.com/api/reference/v2/ranks) |
| Wayback CDX | Yes | Free | Rate-limited, delays advised | — [Smartial](https://smartial.net/how-to-control-result-limits-in-wayback-machine-cdx-queries/) |
| Common Crawl | Open data | Free | — | — [comcrawl](https://pypi.org/project/comcrawl/) |
| G2 | **No public API** | — | — | robots.txt disallows most sections — [ScrapeOps](https://scrapeops.io/websites/g2/) |
| Capterra | **No public API** | — | — | **Terms explicitly prohibit automated extraction** — [Capterra Terms](https://www.capterra.com/legal/terms-of-use/) |
| Google Trends | **Alpha only, invite-gated** | No published pricing | — | Application-based — [Google Search blog](https://developers.google.com/search/blog/2025/07/trends-api) |
| Google Keyword Planner | **No public API for the free tool** | — | — | Volumes shown as broad ranges without ad spend — see Q4 |

### Inferences
- The binding constraint for an agent is rarely cost on the free sources — it is **request pacing** (10/sec at SEC, 45/min at PatentsView, 1-at-a-time at USPTO) and **daily caps** (OpenCorporates). An agent architecture should assume a token-bucket rate limiter and aggressive local caching per source rather than naive per-question fetching.
- Terms-of-use risk concentrates in three places: Capterra (explicit contractual prohibition), Reddit (commercial use requires approval and payment — using the free tier for a commercial agent product is a terms breach even though it is technically possible), and the SEC (not a prohibition, but an enforced fair-access policy with real IP blocking).
- EPO OPS's 4 GB/week is bandwidth-denominated rather than request-denominated, which favours narrow field selection over bulk pulls.

### Gaps
- Rate limits unknown for GLEIF, World Bank, Eurostat, Wayback CDX, pypistats — all likely permissive but unconfirmed.
- Did not review the licensing terms attached to redistribution of any of the free datasets (e.g. whether EDGAR-derived or PatentsView-derived data can be republished in a commercial product). This matters if the reader's agent output is sold.

---

## Q4. Demand-signal sources: keyword volume, ad costs, search intent

### Takeaway
The demand-signal layer is the most awkwardly priced part of the stack: Google offers no usable free API (Trends is invite-only alpha; Keyword Planner has no free API and degrades volumes to ranges without ad spend), Semrush and Ahrefs both impose four-figure-annual floors, and the only route that fits a tens-of-dollars budget is **DataForSEO's pay-as-you-go API at cents per request**, subject to a $50 minimum top-up.

### Cited Findings

**Google Trends**
- Google announced an official Trends API **alpha on 24 July 2025**; it offers a rolling five-year window, aggregation by day/week/month/year, and geographic data by region and subregion — [Google Search Central blog: Introducing the Google Trends API (alpha)](https://developers.google.com/search/blog/2025/07/trends-api) (primary)
- As of 2026 it remains **invite-only and application-based, with no public pricing page and no timeline for general availability**; it is not activatable from a standard Google Cloud console — [Google: Get early access to the Trends API alpha](https://developers.google.com/search/apis/trends) (primary) and [ScrapeBadger](https://scrapebadger.com/blog/does-google-trends-have-an-api-what-to-use-in-2026)
- Multiple 2026 writeups state flatly that Google Trends still has no generally available API — [DEV: "Google Trends still has no API in 2026"](https://dev.to/radevicb/google-trends-still-has-no-api-in-2026-heres-what-i-use-instead-1840)

**Google Keyword Planner**
- Keyword Planner itself is free with any Google Ads account and requires no ad spend — but **accounts without active spend see search volume only as broad ranges, not exact numbers** — [The Marketing Agency: Google Keyword Planner Review 2026](https://themarketingagency.ca/blog/google-keyword-planner/)
- **There is no free API for the Keyword Planner tool**; programmatic access to Keyword Planner–style data requires the Google Ads API (developer-token gated) or third-party resellers — [Google Ads API keyword planning docs](https://developers.google.com/google-ads/api/docs/keyword-planning/overview) (primary); [Digital Marketing Agency SG](https://www.digitalmarketingagency.sg/blog/google-keyword-planner)

**Semrush**
- API access requires the **$549/month Advanced tier** as a floor, and standalone API subscriptions are **restricted to existing account holders and start at an additional $500/month** on top — [ThatMarketingBuddy: Semrush API Pricing 2026](https://thatmarketingbuddy.com/blog/semrush-api-pricing) **[unverified aggregator]**
- Unit consumption: standard rows cost 1 unit each, but high-value parameters scale to 5 or 10 units per row; roughly $20–$250 per 1M credits plus the $500/mo subscription — [ThatMarketingBuddy](https://thatmarketingbuddy.com/blog/semrush-api-pricing) **[unverified aggregator]**

**Ahrefs**
- API v3 is **included from the Lite plan ($129/month) upward**, which Ahrefs widened from the Advanced tier in early 2026; heavy volume still requires paid API units on top — [SE Ranking: Ahrefs API alternatives](https://seranking.com/blog/ahrefs-api-alternatives/) and [ThatMarketingBuddy: Ahrefs pricing](https://thatmarketingbuddy.com/pricing/ahrefs) **[unverified aggregators]**
- **Contradiction:** another source in the same result set states Ahrefs API access costs "~$999/mo plus subscription" — [SE Ranking](https://seranking.com/blog/ahrefs-api-alternatives/). The $129 Lite-includes-API claim and the $999 claim cannot both be right; verify at ahrefs.com/pricing.

**DataForSEO — the budget-viable option**
- Pure **pay-as-you-go, billed per API request**, with a **free $1 credit on signup** and a **$50 minimum top-up** thereafter — [ThatMarketingBuddy: DataForSEO Pricing 2026](https://thatmarketingbuddy.com/pricing/dataforseo) and [NextGrowth: DataForSEO API guide](https://nextgrowth.ai/dataforseo-api-guide/) **[unverified aggregators]**
- Search volume: one request covering **up to 1,000 keywords costs $0.06** on the queue, or **$0.09** for a live/seconds-latency response — [DataForSEO Keywords Data API pricing](https://dataforseo.com/pricing/keywords-data) (vendor page, via search index)
- Keyword suggestions: **$0.012 per request + $0.00012 per keyword**, so a 1,000-keyword response is ~$0.13 — [DataForSEO](https://dataforseo.com/pricing/keywords-data)
- A conflicting figure of "$0.18 per task" for Global Search Volume / DataForSEO Search Volume also appeared — [DataForSEO Google Ads API pricing](https://dataforseo.com/pricing/keywords-data/google-ads). Likely a different endpoint; treat the $0.06–$0.18 band as the realistic range per search-volume call.
- DataForSEO also resells **Google Ads / Keyword Planner data** programmatically — [DataForSEO Google Ads pricing](https://dataforseo.com/pricing/keywords-data/google-ads)

**Bing / Microsoft**
- **The Bing Search APIs were retired on 11 August 2025**; announced 12 May 2025, new resource creation disabled February 2025, and public endpoints now return **HTTP 410 Gone** — [Microsoft Learn: Bing Search APIs Retiring on August 11, 2025](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) (primary)
- Legacy Bing Web Search v7 pricing for reference: free F1 tier (1,000 transactions/month), then S1 $25/1k, S2 $15/1k, S3 $6/1k — [Searlo](https://searlo.tech/bing-search-api-alternative) **[unverified aggregator]**
- Replacement is **Grounding with Bing Search inside Azure AI Agents**, which is a platform commitment (resource group + model deployment), not a drop-in API. Pricing sources **conflict**: one reports **$14 per 1,000 transactions as of August 2026** — [CostBench-style summary via search]; another reports **$35 per 1,000 calls**, a 40–483% increase over legacy tiers — [PPC Land: Microsoft ends Bing Search APIs](https://ppc.land/microsoft-ends-bing-search-apis-on-august-11-alternative-costs-40-483-more/). Either way it is 3–7x the cost of Brave or Exa.

### Inferences
- For a tens-of-dollars budget, the demand-signal answer is: **DataForSEO pay-as-you-go**, accepting the $50 minimum top-up as a one-time prepayment that will last months at $0.06–$0.13 per thousand-keyword call. At those unit prices, 100 keyword-volume lookups per month costs single-digit dollars.
- Semrush and Ahrefs are both structurally unavailable at this budget — their *floor* ($129–$549/mo before API units) exceeds the reader's entire monthly budget.
- Google Trends should be treated as a *manual/UI* source or accessed via third-party resellers, not as an agent-callable API, until the alpha opens. Any architecture that assumes a free Trends API will break.
- Bing's retirement removed the last big free-tier general web search API (1,000 txn/month on F1), which is a material part of why the Exa/Tavily/Brave category grew in 2025–26 — and why "just use Bing" is no longer advice anyone can follow.

### Gaps
- Bing Grounding price is genuinely unresolved ($14 vs $35 per 1,000) — Microsoft's own Azure AI Foundry pricing page should settle it.
- Ahrefs API pricing is unresolved ($129/mo Lite-inclusive vs ~$999/mo).
- **Bing Webmaster Tools API** (a separate, free product from the retired Search API, offering query/impression data for sites you own) was not researched. It only covers your own verified properties, so it is likely irrelevant for competitive research, but the report should not assert that without checking.
- No source found for ad-cost/CPC data availability outside the Semrush/Ahrefs/DataForSEO triangle.

---

## Q5. "Research API" products for AI agents in 2026 — pricing and what they add

### Takeaway
This is the one category where the reader's budget genuinely works: Exa, Tavily, Firecrawl, Brave, Linkup and Parallel all offer free tiers or $5-in-credits, and marginal pricing clusters around **$4–$8 per 1,000 searches** — meaning tens of dollars a month buys thousands to tens of thousands of agent queries. What they add over a raw web-search tool is full page content returned inline (no separate fetch step), semantic/neural retrieval, per-request deterministic pricing, and in several cases a hosted MCP endpoint.

### Cited Findings — pricing

| Product | Free tier | Marginal price | Notes |
|---|---|---|---|
| **Brave Search API** | **$5/month in credits auto-applied** (~1,000 queries) | **$4.00–$5.00 per 1,000 queries** (Aug 2026) | Brave **removed its traditional free tier in February** (2026), replacing it with credit-based metered billing; paid Base/Pro/enterprise tiers raise rate limits, unlock the AI Summarizer, and grant **commercial usage rights** — [Implicator: Brave drops free Search API tier](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/); [CostBench Brave pricing](https://costbench.com/software/ai-search-apis/brave-search-api/); vendor docs at [api-dashboard.search.brave.com/documentation/pricing](https://api-dashboard.search.brave.com/documentation/pricing) |
| **Exa** | **1,000 credits** free | **$7 per 1,000 requests, content included**; credits vary by query complexity | [Firecrawl: Exa alternatives](https://www.firecrawl.dev/blog/exa-alternatives) **[competitor-authored — treat with caution]**; vendor page [exa.ai/pricing](https://exa.ai/pricing) |
| **Tavily** | **1,000 credits/month, no card** | PAYG **$0.008/credit**; monthly plans **$0.005–$0.0075/credit**; entry **Bootstrap $100/mo for 15,000 credits** | [codenote: Tavily alternatives cost comparison](https://codenote.net/en/posts/tavily-alternatives-cost-comparison-search-extract-api/) |
| **Firecrawl** | Free tier: 10 scrapes/min, 10 maps/min, 10 searches/min, 2 crawls/min; no card | **1 credit = 1 page**; from **$16/mo for 5,000 pages**; **Standard $99/mo for 100,000 credits** ($83/mo annual) | [Firecrawl AI MCPs page](https://www.firecrawl.dev/use-cases/ai-mcps); [Firecrawl vs Exa](https://www.firecrawl.dev/alternatives/firecrawl-vs-exa) |
| **Linkup** | **€5 in free queries each month** | **€5 per 1,000 searches** | Claims **#1 on OpenAI's SimpleQA factuality benchmark** — [Firecrawl: Parallel alternatives](https://www.firecrawl.dev/blog/parallel-alternatives) **[competitor-authored]** |
| **Perplexity API** | Not established | Reported **$5 per 1,000 queries** list for basic search; actual cost = token costs + a per-request fee that **varies by search context size**, applying to Sonar, Sonar Pro and Sonar Reasoning Pro | [Perplexity pricing docs](https://docs.perplexity.ai/docs/getting-started/pricing) (primary, via search index) |
| **SerpAPI** | Not established | **Starter $25/mo for 1,000 searches ($0.025/query)**; **$75/mo for 5,000 ($0.015/query)** | Notably 3–5x the price of Brave/Linkup — [Olostep: Best Web Search APIs](https://www.olostep.com/blog/best-web-search-apis) |
| **Parallel** | Not established | Priced **per request, not per token**, so cost is known before the query runs. **Extract $0.001/request**; **Task API $0.12 (Basic) to $2.40 (Ultra8x) per request** | Raised at a **$2B valuation** — [Parallel pricing](https://parallel.ai/pricing) (vendor, via search index); [Firecrawl: Parallel alternatives](https://www.firecrawl.dev/blog/parallel-alternatives) |
| **Valyu** | Has a free tier | **From $29/mo**; pay-per-retrieval, no subscription required to start | Bundles **web search plus proprietary sources — PubMed, SEC filings, clinical trials, patents, financial data — in one API**; claims to outperform Google, Parallel and Exa on SimpleQA and FreshQA plus finance/healthcare/economics domain benchmarks — [Valyu pricing](https://www.valyu.ai/pricing) and [Valyu docs](https://docs.valyu.ai/overview) (vendor, via search index) **[benchmark claims are vendor self-reported]** |
| **Azure Grounding with Bing** | None | **$14/1,000** or **$35/1,000** (sources conflict) | Replacement for retired Bing APIs; requires full Azure project setup — [Microsoft Learn](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement); [PPC Land](https://ppc.land/microsoft-ends-bing-search-apis-on-august-11-alternative-costs-40-483-more/) |

### Cited Findings — what they add over raw web search
- **Content included in the search response**: Exa's $7/1,000 is explicitly "with content included", collapsing the search→fetch→parse loop into one call — [Firecrawl: Exa alternatives](https://www.firecrawl.dev/blog/exa-alternatives)
- **Deterministic per-request pricing** rather than token-metered cost, so an agent's budget per question is knowable in advance — [Parallel pricing](https://parallel.ai/pricing)
- **Domain-specialised corpora** beyond the open web: Valyu bundles PubMed, SEC filings, clinical trials, patents and financial data behind the same endpoint — [Valyu](https://www.valyu.ai/index)
- **Factuality benchmarking** is the main quality claim in this category (SimpleQA, FreshQA); Linkup and Valyu both claim leadership, which cannot both be true and are self-reported — [Firecrawl: Parallel alternatives](https://www.firecrawl.dev/blog/parallel-alternatives); [Valyu](https://www.valyu.ai/index)
- **Commercial rights** are a real differentiator: Brave's paid tiers specifically confer commercial usage rights that the credit/free usage does not — [CostBench Brave](https://costbench.com/software/ai-search-apis/brave-search-api/)

### Inferences
- At $4–$8 per 1,000 searches, a **$30/month budget buys roughly 4,000–7,000 agent search calls** — far more than a small research team will use. This category is not the reader's cost problem; the private-markets databases are.
- The cheapest credible starting configuration is: **Brave ($5/mo free credits, then $5/1k) or Linkup (€5/mo free, then €5/1k) for breadth + Firecrawl free tier or $16/mo for page extraction**, which together land comfortably under $25/month.
- **Valyu deserves specific attention for this use case**: it is the only product found that bundles SEC filings and patents into the same agent-callable endpoint as web search, which maps directly onto the free-source stack in Q2 without the reader having to build and rate-limit five separate integrations. At $29/mo it is at the top of the stated budget, so the build-vs-buy question is whether their aggregation is worth more than a month of integration work.
- Beware that much of the comparison content in this space is **authored by competitors** (Firecrawl's blog comparing Exa/Tavily/Parallel; Exa's blog comparing Tavily). These are useful for surfacing price points but not for quality rankings.

### Gaps
- Could not reach any vendor pricing page directly; all figures are second-hand. Prices in this category change fast (Brave changed its free tier in Feb 2026).
- Perplexity's actual per-request search fees by context size, and whether it has any free monthly allowance, were not established.
- SerpAPI's free tier (historically 100 searches/month) was not confirmed for 2026.
- No independent third-party benchmark of result quality across these APIs was found — only vendor and competitor claims.
- Exa's credit-consumption rules ("credits vary by query complexity") were not pinned down, so the effective cost per query could exceed the headline $7/1,000.

---

## Q6. Are there MCP servers exposing these sources to agents directly?

### Takeaway
Yes, extensively — the MCP ecosystem now spans 20,000–50,000 catalogued servers, the major search APIs all ship hosted MCP endpoints (two of which work with **no API key at all**), SEC EDGAR has multiple independent community MCP servers, and Crunchbase shipped an official MCP in July 2026. The practical caveat is that directory counts are inflated by unmaintained duplicates.

### Cited Findings

**Registries and scale**
- Mid-2026 server counts: **Glama ~37,800 servers** (~6,000 hosted connectors), **PulseMCP 20,000+** (July 2026), **Smithery 7,000+**; the official MCP Registry tracked **36,950 servers** split into publisher-verified "Official" and a larger author-verified "Claimed" tier — [ThinkNEO: MCP registries compared](https://thinkneo.ai/blog/mcp-registries-compared-20260714); [TrueFoundry: Best MCP Registries 2026](https://www.truefoundry.com/blog/best-mcp-registries)
- Caveat from the same sources: counts range 20,000+ to 50,000+ but "the large majority are unmaintained experiments or duplicates" — [ThinkNEO](https://thinkneo.ai/blog/mcp-registries-compared-20260714)
- Main directories to search: [Glama](https://glama.ai/mcp/), [Smithery](https://smithery.ai), [PulseMCP](https://pulsemcp.com), mcp.so, and the official MCP Registry — [Tallyfy: How to list your MCP server](https://tallyfy.com/how-to-list-mcp-server-registry-smithery-glama-pulsemcp/); [OpenHelm: MCP Registry & Directory Guide](https://openhelm.ai/blog/mcp-registry-directory-guide)

**Search/research API MCP servers — including keyless options**
- **Firecrawl** runs a **keyless hosted MCP** at `https://mcp.firecrawl.dev/v2/mcp` exposing Search, Scrape and Parse with **no account required**, IP rate-limited — [Firecrawl AI MCPs](https://www.firecrawl.dev/use-cases/ai-mcps); [Firecrawl: Best web search MCP](https://www.firecrawl.dev/blog/best-web-search-mcp)
- **Exa's remote MCP URL works without an API key on the free tier**, at lower rate limits — [Firecrawl: Best web search MCP](https://www.firecrawl.dev/blog/best-web-search-mcp) **[competitor-authored, but the claim is about a competitor's generosity so bias runs against it]**
- **Tavily's MCP** has a free tier but **requires account registration** (1,000 credits/month, no card) — [Firecrawl: Best web search MCP](https://www.firecrawl.dev/blog/best-web-search-mcp)
- General roundups of research-oriented MCP servers: [Parallel: Best Web Search MCP Server in 2026](https://parallel.ai/articles/best-web-search-mcp); [ContextBolt: Web Search MCP Servers, 7 compared and what each costs](https://contextbolt.com/blog/web-search-mcp-servers/); [Top-MCPs: Best MCPs for Research 2026](https://top-mcps.com/guides/best-mcps-for-research)

**Company/financial data MCP servers**
- **SEC EDGAR** has multiple independent MCP servers, all free and open source:
  - [stefanoamorelli/sec-edgar-mcp](https://github.com/stefanoamorelli/sec-edgar-mcp) — filings, financial statements and insider trading with exact numeric precision; also on [PyPI as `sec-edgar-mcp`](https://pypi.org/project/sec-edgar-mcp/)
  - [cyanheads/secedgar-mcp-server](https://github.com/cyanheads/secedgar-mcp-server) — EDGAR filings, XBRL financials and company data over STDIO and Streamable HTTP, covering filings since 1993
  - [asp53826/edgar-mcp](https://github.com/asp53826/edgar-mcp) — EDGAR filings and XBRL financial facts
  - Also listed on directories: [Glama SEC EDGAR Financial Data connector](https://glama.ai/mcp/connectors/io.github.Taru0208/sec-edgar-mcp-server); [mcpservers.org EDGAR MCP](https://mcpservers.org/servers/leopoldodonnell/edgar-mcp)
- **Companies House** has a community MCP connector — [Glama: Companies House MCP connector](https://glama.ai/mcp/connectors/io.github.pipeworx-io/companies-house)
- **Crunchbase** launched an official MCP in July 2026 for financial analysis, investing, revenue and product workflows — [Crunchbase press release](https://about.crunchbase.com/press/press-releases/crunchbase-launches-mcp-to-bring-private-market-intelligence-into-ai-workflows)
- Broader financial-data MCP landscape, including providers exposing 70,000+ data points per company (income statements, balance sheets, cash flow, ratios, analyst estimates, full SEC filing content) — [Medium/Data Science Collective: Top 10 MCP Servers for Financial Data in 2026](https://medium.com/data-science-collective/top-10-mcp-servers-for-financial-data-in-2026-3927fa3d4636) **[Medium post, low authority]**
- A **Google Trends MCP** exists as a third-party product — [trendsmcp.ai](https://www.trendsmcp.ai/google-trends-api-pricing-comparison) — i.e. Trends data is reachable via MCP through resellers even though Google's own API is invite-gated.
- A **Google Keyword Planner MCP** is available on Apify — [Apify: Google Keyword Planner MCP](https://apify.com/khadinakbar/google-keyword-planner-mcp/api)

### Inferences
- The single highest-leverage, zero-cost move available to the reader is wiring up an **SEC EDGAR MCP server** plus **Firecrawl's keyless MCP** and/or **Exa's keyless MCP tier**. That is a material capability upgrade over generic web search for $0 and roughly an hour of configuration.
- MCP has effectively solved the *plumbing* problem for the free-source stack: EDGAR, Companies House, Trends-via-reseller and Keyword-Planner-via-Apify all have off-the-shelf servers, so the reader does not need to write rate-limited HTTP clients for each.
- The inflated directory counts mean server selection matters: prefer servers with a named GitHub repo, recent commits, and a listing in more than one registry, over whatever ranks first in a directory search.
- Crunchbase shipping an MCP while removing its free API tier is the clearest signal of where this market is heading: agent-native interfaces gated behind paid subscriptions, with the free on-ramp closed.

### Gaps
- Could not determine which Crunchbase subscription tier the Crunchbase MCP requires, or its per-call cost.
- Did not verify that any specific SEC EDGAR MCP server is actively maintained as of September 2026 (repos were found via search results, not inspected).
- No MCP servers were identified for: World Bank, Eurostat, PatentsView/EPO, Adzuna, or Common Crawl. They may well exist in the 20,000+ directories; this research did not search for them individually.
- The terms-of-use position of reseller MCPs (e.g. Google Trends MCP, Keyword Planner MCP on Apify) relative to Google's own terms was not examined and could be a compliance risk.

---

## Cross-cutting synthesis for the report-writer

### A concrete sub-$40/month stack, assembled from the findings above
- **$0** — SEC EDGAR API/MCP (10 req/sec), Companies House (600/5min), GLEIF, PatentsView (45/min), EPO OPS (4 GB/wk), World Bank, Eurostat, GitHub (5,000/hr authed), PyPI via BigQuery (1 TB/mo free), pypistats, HN Algolia (10,000/hr), Adzuna (1,000 calls/mo), Wayback CDX, Common Crawl
- **$0** — Brave Search API's $5/mo auto-credits (~1,000 queries) and/or Linkup's €5/mo free queries; Firecrawl and Exa keyless MCP tiers
- **~$16/mo** — Firecrawl paid entry (5,000 pages) if extraction volume outgrows the free tier
- **~$5–10/mo** — Brave or Linkup metered overage at $4–5 per 1,000 queries
- **$50 one-time prepay, then cents per call** — DataForSEO for keyword volume ($0.06–$0.13 per 1,000-keyword request)
- **Optional ~$29/mo** — Valyu, if bundling SEC/patents/web into one endpoint is worth more than self-integration
- **Excluded by price**: Crunchbase ($49–$99/mo minimum, API tier disputed), OpenCorporates (£2,250/yr), Semrush ($549+$500/mo), Ahrefs ($129–$999/mo), Dealroom (€12.5k/yr), Tracxn, PitchBook ($12–70k/yr), CB Insights ($29.8k–$100k/yr), Harmonic ($20–24k/seat/yr), Reddit commercial ($12k/mo), Sensor Tower (no self-serve)

### Hard terms-of-use blockers to carry into the report
1. **Capterra** — contractually prohibits all automated extraction of reviews, ratings, rankings and derived data without written consent — [Capterra Terms](https://www.capterra.com/legal/terms-of-use/)
2. **Reddit** — free tier is non-commercial-use-only; commercial use needs approval (2–4 weeks) and payment; self-service app registration closed late 2025 — [Prowlo](https://prowlo.com/blog/reddit-data-api)
3. **SEC EDGAR** — not prohibited, but enforced: >10 req/sec triggers IP blocking, and a declared User-Agent is mandatory — [SEC](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
4. **Brave** — commercial usage rights attach to paid tiers, not to free/credit usage — [CostBench](https://costbench.com/software/ai-search-apis/brave-search-api/)
5. **G2** — robots.txt disallows most sections; no public API — [ScrapeOps](https://scrapeops.io/websites/g2/)

### Unresolved conflicts the report should surface rather than paper over
- Crunchbase: $99/mo Pro includes the API **vs** API requires $50k+ Enterprise
- Ahrefs: API included from $129/mo Lite **vs** ~$999/mo
- Dealroom: €12,500/yr minimum **vs** "$300–$1,500/mo"
- Tracxn: ~$199/month **vs** "$500–$1,000/yr"
- Azure Grounding with Bing: $14/1,000 **vs** $35/1,000
- Brave: "free plan, 2,000 queries/month at 1 QPS, no card" **vs** "free tier removed in February, all developers on metered billing with $5/mo credits"
