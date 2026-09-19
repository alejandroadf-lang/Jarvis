# The Company: a virtual IT-company executive team

"Executive Team" mode turns Jarvis from a single assistant into a small
company of Claude agents, organized as a real IT-company org chart. Ask it
anything — from "draft a Q4 marketing plan" to "what should our pricing
model be" — and the CEO agent figures out who on the team should actually
answer it, consults them, and gives you back one synthesized answer.

There's also a **Venture Studio** mode upstream of the company — a small
brainstorming team that turns a raw idea into a funded venture and hands it
to the CEO to execute, against a real (small!) cash balance. See
[Venture Studio: where ideas come from](#venture-studio-where-ideas-come-from)
below.

## Architecture: orchestrator-workers

This is Anthropic's **orchestrator-workers** workflow pattern (see
["Building Effective Agents"](https://www.anthropic.com/research/building-effective-agents))
applied to an org chart instead of a single task. The same shape shows up
in Anthropic's ["multi-agent research system"](https://www.anthropic.com/engineering/multi-agent-research-system)
post and in the Claude Agent SDK's subagent model: a **lead agent** breaks a
request down and delegates pieces of it to **specialized subagents**, then
synthesizes what comes back.

Here, every manager in the org chart is *itself* an orchestrator for its
own direct reports, so delegation recurses down the chart:

```
CEO
├── CTO (technology & product)
│   ├── Engineering Lead
│   ├── Product Manager
│   ├── Solutions Architect
│   ├── Security Reviewer
│   └── QA & Test Engineer
├── CFO (finance)
│   └── Finance & Accounting Manager
├── CMO (marketing)
│   ├── Marketing Manager
│   ├── SEO Specialist
│   └── Brand Strategist
├── COO (operations)
│   ├── Sales & Commercial Manager
│   ├── Customer Support Manager
│   ├── Implementation Manager
│   └── HR & People Manager
└── Devil's Advocate (argues against the plan)
```

Each agent that has direct reports gets them exposed as **tools** (e.g. the
CEO can call `consult_cto`, `consult_cfo`, `consult_cmo`, `consult_coo`).
When an agent calls one of those tools, the server runs that report as its
own agent (which may itself delegate further down), feeds the answer back
as a `tool_result`, and lets the manager keep going until it has a final
answer. A manager is free to just answer directly for anything in its own
remit — delegation only happens when a request genuinely needs a report's
domain expertise. See `server/agents/agentRunner.js` for the loop and
`server/agents/orgChart.js` for every role's system prompt.

`agentRunner.js` doesn't know or care which org chart it's driving — it
takes an `agents` map (see `server/agents/registry.js`) as a parameter, so
the exact same engine also runs the Venture Studio team below. An agent can
also define `actions`: extra tools that aren't delegation but a real side
effect (the Studio's `propose_venture` is one), handled by an
`actionHandlers` map the caller supplies.

The UI shows which agents actually contributed to a reply as small badges
under the message, so you can see the delegation path (e.g. `CEO → CTO →
Product Manager`).

## The roster

| Role | Reports to | Owns |
|---|---|---|
| CEO | — | Vision, strategy, cross-functional decisions |
| CTO | CEO | Technical strategy, architecture, engineering delivery, product roadmap |
| CFO | CEO | Financial strategy, pricing, fundraising, fiscal discipline |
| CMO | CEO | Brand, positioning, go-to-market strategy |
| COO | CEO | Day-to-day ops: sales execution, support, delivery, people |
| Devil's Advocate | CEO | Arguing the other side of any plan, claim, or decision |
| Engineering Lead | CTO | Software design and delivery |
| Product Manager | CTO | Requirements, prioritization, roadmap |
| Solutions Architect | CTO | Pre-sales technical scoping, solution design |
| Finance & Accounting Manager | CFO | Bookkeeping, invoicing, tax/compliance, reporting |
| Marketing Manager | CMO | Campaigns, content, channels |
| Sales & Commercial Manager | COO | Pipeline, proposals, negotiation, contracts |
| Customer Support Manager | COO | Post-sale support, ticket triage, customer health |
| Implementation Manager | COO | Onboarding and delivery of signed projects |
| HR & People Manager | COO | Hiring, onboarding, culture, policy |
| SEO Specialist | CMO | Technical SEO, on-page optimization, keyword/content strategy |
| Brand Strategist | CMO | Voice consistency, competitive positioning research |
| Security Reviewer | CTO | Vulnerability review (OWASP Top 10, secrets, unsafe patterns) |
| QA & Test Engineer | CTO | Code review rigor, test coverage, correctness |

This is deliberately close to how a real early-stage IT company is
structured — a lean C-suite, with one specialist owning each of the
functions a company actually needs to sell, build, deliver, and support a
product: marketing, engineering/product, commercial (solutions +
sales), customer support, implementation, and finance/accounting, plus
people operations to keep the team itself running.

### The one role a real company doesn't have

The Devil's Advocate is the exception, and it is there because of the shape
of the CEO's turn rather than anything a real company does. The CEO
synthesises four reports from four leads who each have a reason to want
their own department to look good. Nothing in that arrangement produces
"this won't work," so it was added as an agent instead of as a sentence in
the CEO's prompt — for the same reason the Venture Studio has a Validation
Critic. A paragraph asking you to be skeptical about your own plan loses to
the plan, every time; a separate turn whose entire job is the other side
does not.

It is deliberately a leaf with no actions: it argues and cannot act, which
is also what lets it run on a cheap tier (see `canUseAlternativeModel` in
`server/agents/models.js`). Its prompt is written against the failure mode
that kills critics — objecting to everything until nobody reads you — so it
is required to name the cheapest way to find out rather than only the risk,
and to say "nothing to add" when that is the honest answer.

### Credit: roles adapted from ECC

The SEO Specialist, Brand Strategist, Security Reviewer, and QA & Test
Engineer are adapted from [Affaan Mustafa](https://github.com/affaan-m)'s
["Everything Claude Code" (ECC)](https://github.com/affaan-m/ecc) — the
MIT-licensed library of Claude Code subagents and skills he open-sourced
after winning the Anthropic x Forum Ventures hackathon. Their
responsibilities, review priorities (e.g. the SEO Specialist's
critical/high/medium audit tiers, the Security Reviewer's OWASP-Top-10
pattern table, the QA Engineer's confidence-gated review checklist), and
quality bars are drawn from ECC's `seo-specialist`, `brand-voice`,
`security-reviewer`, and `code-reviewer` agents/skills — rewritten as
personas for this org chart's `agentRunner.js` rather than copied
verbatim. See `server/agents/orgChart.js` for the adapted prompts.

## How it works, end to end

1. `POST /api/company/chat` receives `{ sessionId, message }`.
2. The server loads that session's CEO-level conversation history (kept
   separate from Jarvis's personal-assistant history) and runs
   `runAgent({ agentId: 'ceo', ... })`.
3. `runAgent` calls the Claude API with the CEO's system prompt and a tool
   per direct report. If the CEO calls a tool, the server recursively runs
   that report as its own agent (with a fresh, single-turn brief — reports
   don't see the whole conversation, only the task they're given), and
   feeds the result back as a `tool_result`. This repeats until the agent
   produces a final text answer.
4. Only the **final** user message and assistant answer are persisted to
   session history — the intermediate delegation steps aren't replayed on
   the next turn, to keep the context small and the pattern composable.
5. `GET /api/company/org-chart` returns the sanitized org chart (no system
   prompts) so the UI can render the tree in the sidebar.

## Extending the team

To add a new department or role, add one entry to `AGENTS` in
`server/agents/orgChart.js`:

```js
legal_manager: {
  id: 'legal_manager',
  title: 'Legal & Compliance Manager',
  department: 'Operations',
  reportsTo: 'coo',
  reports: [],
  mission: 'Owns contracts review, compliance, and legal risk.',
  toolDescription: 'Consult for contract review, compliance questions, or legal risk.',
  systemPrompt: `You are the Legal & Compliance Manager. ...`,
},
```

Then add `'legal_manager'` to that manager's `reports` array (e.g. the
COO's). Nothing else needs to change — the orchestrator builds its tool
list from the org chart at request time, so the new role is reachable
immediately.

## Trying it

```bash
npm run install:all
npm run dev:server   # localhost:3001, needs ANTHROPIC_API_KEY in server/.env
npm run dev:client   # localhost:5173
```

Switch to the **Executive Team** tab in the header, and ask it something
that spans departments — e.g. "we want to launch a new product line, what
do we need to get there?" — to see it delegate across the org chart.

## Venture Studio: where ideas come from

The Executive Team is good at *executing* — it assumes you already know
what to build. The Studio is upstream of that: a small brainstorming team
that helps find the next idea, pressure-tests it, and turns it into a real
venture the Executive Team can pick up.

```
Venture Partner
├── Market Researcher       — market sizing, megatrends, competitors
├── Ideation Facilitator    — wide, divergent, ambitious raw idea generation
├── Business Case Analyst   — costs, pricing, path to $1M+ revenue, milestones
├── Scale Strategist        — TAM/ceiling sizing, expansion mechanism
└── Validation Critic       — deliberate skeptic (including "is this big enough")
```

It's the same orchestrator-workers engine as the Executive Team (see
`server/agents/ideationTeam.js`), just applied to brainstorming instead of
execution: the Venture Partner runs the session, pulls in whichever
specialist a step of the conversation actually needs, and converges on one
strong idea rather than assuming the first idea is the right one.

### Calibrated for ambition, not just cash-on-hand

Early versions of this team converged on trivially small ideas (a resume
app, a to-do list) because every prompt kept reminding agents how little
money was in the treasury — a classic failure mode where "budget is small"
quietly becomes "so pick something small." The treasury is gone now (see
[The economic model](#the-economic-model-no-capital-required) below), which
removes the cause rather than the symptom: there is no cash-on-hand figure
left to anchor on. The ambition bar is explicit on top of that
— a believable path to **$1M+ in annual revenue within a few years**, in a
market big enough to support that. The Ideation Facilitator has a standing
list of oversaturated, low-ambition categories (generic resume/CV builders,
to-do apps, habit trackers, note-taking apps) to skip by default unless
there's a real differentiated wedge, and the Validation Critic is
instructed to flag "too small to matter" with the same force it flags
infeasibility. `propose_venture` enforces this structurally too: `marketSize`
and `pathToMillions` are *required* fields, so the Venture Partner literally
cannot log a proposal without naming the market and the mechanism to real
scale.

### Grounded in real research, not just recall

The Market Researcher and Scale Strategist both have Anthropic's hosted
`web_search_20250305` tool enabled (`serverTools` on the agent definition
in `ideationTeam.js`, passed straight through to the API by
`agentRunner.js` — Anthropic executes the search server-side and folds the
results into the same response, so no extra round trip is needed in our
dispatch loop). This is what lets those two agents cite a real TAM figure,
recent funding activity, or actual competitor pricing instead of reciting
a number from training data that might be stale or simply invented-sounding.
Each is capped at `max_uses: 4` per invocation to bound cost and latency;
both are instructed to say when a claim came from a search versus their
own estimate. Web search is billed per search by Anthropic, separately
from token usage — a Studio conversation that leans on these two agents
will cost a bit more than one that doesn't.

### The economic model: no capital required

This company runs on **no seed capital at all**, and that's the deliberate
design, not a missing feature.

The reasoning is simple. The dominant cost in a normal business is people —
salaries are what makes a runway finite and what forces a business to raise
money before it can start. This company's people are agents. Their marginal
cost is model spend: cents per meeting, not thousands per month. Remove
the biggest line item from the cost side and the case for holding capital
before starting mostly evaporates with it.

An earlier version of this project modelled a **$100 seed** released to
ventures in staged tranches, and it actively made the company worse. Every
prompt carried a shrinking balance, and agents dutifully reasoned about
affordability on a business whose real costs were a rounding error. It
priced a constraint that doesn't exist and, worse, it put a human approval
gate in front of *starting* something that costs nothing to start.

What replaced it:

- **No seed, no balance, no budget ceiling.** Nothing is blocked for lack
  of money. `server/finance/ledger.js` no longer has a `capital` or
  `investment` transaction type, no starting balance, and no `getBalance()`.
- **A venture is `active` the moment the studio starts it.** There is no
  `proposed` waiting room and no greenlight step, because there was no
  money to release. `propose_venture` starts it outright.
- **Milestones survive; tranches don't.** How a venture proves itself is by
  hitting milestones, not by unlocking money. `report_milestone_progress`
  stays, `request_tranche` is gone entirely.

#### What the books still track

The ledger is now only the money that's genuinely real, as an append-only
transaction log (`server/data/ledger.json`, not committed — see
`.gitignore`), so every figure is a fold over auditable history:

- `revenue` — money a venture actually brought in
- `expense` — money actually paid out (a domain, an ad test, a subscription)

`GET /api/ventures/ledger` returns `{ revenue, expenses, net, transactions }`.
Net going negative is a legitimate state, not an error — there's no balance
to overdraw, so spending ahead of revenue simply reads as a loss.

#### What actually constrains the company

Removing a fake constraint doesn't make the company unconstrained, and
`buildBusinessContext()` in `server/finance/context.js` tells every agent
what the real ones are, in the same breath as telling it not to reason
about affordability or runway:

- **The founder's attention.** The genuinely scarce input. One thing can be
  the priority at a time.
- **Daily model spend.** Every agent turn draws on it, it's metered per UTC
  day in `server/spend.js`, and it's capped (`DAILY_SPEND_CAP_USD`, default
  $5) at the API gateway itself — so this is a hard limit enforced in code,
  unlike the seed it replaced.
- **Real-world reach.** Being active grants a venture nothing outside the
  app. Deploying code or emailing a customer needs a scope the founder
  grants that specific venture, with its own caps (see [Real code
  deployment](#real-code-deployment) and [Real customer
  email](#real-customer-email)).

So the question the agents are told to ask is never "can we afford this" —
it's "is this the most valuable thing to be working on."

### From brainstorm to venture to execution

1. You brainstorm with the Venture Partner and its team in **Venture
   Studio** mode. Every request also gets the current business picture
   (revenue, expenses, net, the active ventures and their milestones)
   injected into context.
2. Once you've converged on something real — and it clears the ambition
   bar — the Venture Partner calls its `propose_venture` action — a tool
   that isn't delegation but a genuine side effect: it starts a venture
   (title, problem, target customer, business model, market size, the path
   to $1M+ revenue, and milestones) via `server/finance/ventures.js`,
   already `active`. This shows up immediately in the **Ventures** panel in
   the sidebar, and sends you a notification email.
3. That's it — there's no approval step, because starting costs nothing.
   The Executive Team sees the venture in its context on the next turn and
   can begin executing against its milestones.

Auto-activation is safer than it sounds, and worth being precise about: an
active venture can't touch anything real. `authorizeDeployment()` and
`authorizeOutreach()` both still require a founder-linked repo or recipient
allowlist *plus* an explicit enable before a single commit or email is
possible. The greenlight gate protected a budget that no longer exists; the
scope grants that protect real-world actions are untouched.

### Money flowing in and out

There's no real payment integration in a personal project like this, so
neither revenue nor spending is detected automatically — but both are
trackable through the Executive Team. The Finance & Accounting Manager
(reports to the CFO) has two action tools, the same mechanism as
`propose_venture`:

- `log_revenue` — tell the CFO or Finance Manager that real money came in
  (e.g. "we got $200 from the newsletter's first paying subscribers"), and
  it records a `revenue` transaction.
- `log_expense` — tell them about real money you actually spent (e.g. "I
  just paid $12 for the domain"), and it records an `expense` transaction.

Both accept an optional venture id to attribute the transaction to a
specific venture, and both are instructed to only log money that's
actually moved — not a forecast, a verbal promise, or a planned purchase —
so the books stay an honest record rather than a wish list.

This is deliberately a **manual, human-in-the-loop** ledger: nothing in this
codebase can move real money on its own. Agents recommend what's worth
paying for, you make the purchase, then you tell Finance what actually
happened so the app's numbers track reality.

Both the Executive Team and Venture Studio sidebars show the Ventures
panel with the performance figures, and it refreshes after every chat turn
in either mode, so a logged transaction shows up immediately regardless of
which tab you're in.

## Killing a venture

Not every venture deserves to keep running. Killing matters *more* without
a funding gate, not less: when starting is free and nothing runs out on its
own, ending something deliberately is the only way a venture ever stops
competing for attention. The CEO owns the call via a `kill_venture` action
— sets status to `killed`, records `killedAt` and a `killReason`, and
revokes its real-world reach (a killed venture fails `authorizeDeployment`
and `authorizeOutreach` outright). It's also exposed as a direct,
human-in-the-loop route
(`POST /api/ventures/:id/kill`) with a "Kill venture" button on active
venture cards in the Ventures panel — no need to go through a conversation
if you've already decided. The CEO is instructed not to use it to hedge or
as a threat, and specifically not to let sunk cost talk it out of killing
something that genuinely isn't working.

## Portfolio view

The per-mode Ventures panel is deliberately narrow — a sidebar showing
"what's relevant to this conversation." The **Portfolio** tab
(`GET /api/ventures/portfolio`, `client/src/components/PortfolioView.jsx`)
is the company-wide view instead: every venture ever created — active or
killed — sorted active-first, each enriched with its own slice of the
ledger (`revenue`, `expense`, `net`, computed by filtering the ledger's
transactions by `ventureId`) and a milestone summary
(`done`/`missed`/`total`). Stat tiles at the top roll all of that up
across the whole portfolio.
This is the place to compare ventures side by side once there's more than
one running, rather than reacting to them one at a time in chat.

## Conversation history survives a restart

Originally every chat mode kept its history purely in an in-memory `Map`,
which is fine for a quick demo but not for something meant to run as an
ongoing company — a server restart (a crash, a deploy, an accidental
`Ctrl+C`) would silently wipe every conversation. `server/sessionStore.js`
persists all three modes' histories to `server/data/sessions.json` (same
`store.js` helper the ledger and ventures use, now relocated to
`server/store.js` since it was never actually finance-specific): each Map
is seeded from disk at startup, and every write (`.set`) or reset
(`.delete`) is mirrored to disk in the same call. Nothing else about the
chat flow changes — this is purely about not losing state you already
had.

## Wider web-search grounding

The Studio's Market Researcher and Scale Strategist were the first to get
Anthropic's hosted web search tool (see "Grounded in real research, not
just recall" above); the Executive Team's **Solutions Architect** (checks
a vendor's actual current API/pricing before committing to a technical
design) and **SEO Specialist** (checks who's actually ranking for a target
keyword right now, or whether a cited best practice is still current) now
have it too, the same way — `serverTools: [{ type: 'web_search_20250305',
name: 'web_search', max_uses: 4 }]` on the agent definition in
`orgChart.js`, no dispatch-loop changes required since Anthropic executes
these server-side.

## Autonomous daily meetings and reports

Every mode above still needs someone to start the conversation. The
**daily meeting cycle** (`server/dailyMeeting.js`, `server/scheduler.js`)
runs on its own, once a day, with nobody prompting it:

1. **Leadership sync.** The CEO is given a standing meeting brief:
   consult each direct report (CTO, CFO, CMO, COO), have them check in
   with their own team first if it would surface something real, and
   report back status, a blocker, and one concrete opportunity. The CEO
   synthesizes all of it into one Daily Company Report (department
   status, opportunities, risks, recommended actions) — the same
   `runAgent` orchestrator-workers recursion every other mode uses, just
   kicked off by a scheduler instead of a person typing a message. Real
   meetings can therefore go two or three levels deep (CEO → CTO →
   Engineering Lead, say) exactly like an interactive conversation could,
   entirely at each manager's own judgment about whether it's worth
   checking with their team.
2. **Opportunity review.** The Venture Studio then gets the leadership
   report as context and runs a quick pass: does anything in it (or
   anything the team notices on its own) clear the venture-scale ambition
   bar? If so, it starts one with the same `propose_venture` action used
   in an interactive brainstorm; if not, it says so plainly rather than
   forcing one.
3. **The report is saved, then emailed.** Both replies, their full
   delegation traces, any new venture ids, and a snapshot of the books are
   written to `server/dailyReports.json` (via `server/dailyReports.js`),
   keyed by date. A **Daily Report** tab
   (`client/src/components/DailyReportView.jsx`) lists every past report
   and shows the selected one; a "Run today's meeting now" button
   (`POST /api/reports/daily/run`) triggers a cycle on demand instead of
   waiting for the schedule. Right after saving, `server/email.js` sends
   the same report by email if `SMTP_HOST`/`REPORT_EMAIL_TO` are
   configured (see `server/.env.example`) — opt-in and best-effort: a
   failed send is logged but never fails the cycle, since the report is
   already saved and viewable either way.

**This cycle still cannot move money or kill a venture on its own.** The
leadership sync isn't given the book-keeping/venture action handlers that
depend on a real founder-reported outcome (`log_revenue`, `log_expense`,
`report_milestone_progress`, `kill_venture`) — it's
explicitly told this is an internal status meeting, not that kind of
event, and even a stray tool call would resolve as an unknown tool rather
than a silent no-op. It *does* now carry `deploy_code` and
`send_customer_email` — see "Full autonomy" further down for why those
two specifically were judged safe to run unattended, and why the rest
weren't. The Studio phase can also start a new venture on its own, which
costs nothing and grants it nothing: a new venture has no repo and no
outreach list until the founder gives it one, so the real-world reach
stays behind the same scope grants as ever. Autonomy here means the
*information gathering and recommending* runs itself, plus two
narrowly-scoped real actions the founder pre-authorized per venture.

`server/scheduler.js` targets a specific wall-clock time — **8:00 AM
Bangkok time**, which is always 01:00 UTC (`Asia/Bangkok` is a fixed
UTC+7 with no DST, so no timezone library is needed: `TARGET_UTC_HOUR =
1`). Rather than a real cron, it's a self-rescheduling `setTimeout` loop:
`nextTargetUTC()` computes today's 01:00 UTC if it hasn't passed yet, or
tomorrow's otherwise, and the cycle reschedules itself against that fresh
computation every time it runs — no drift from chaining `setInterval`.
That's enough for an app with no guaranteed uptime: a server that's
running at 8 AM ICT gets its report right on time; one that starts up
later the same day with nothing generated yet catches up soon rather
than waiting until tomorrow's slot; one that's down for a whole day just
picks up the next day it's running instead of going silently dark. It's
skipped entirely without `ANTHROPIC_API_KEY` configured, and can be
disabled outright with `DAILY_MEETING_DISABLED=true` if you'd rather
trigger it manually every time.

All of this still depends on the server actually being up at 8 AM ICT —
see README.md's "Deploy to Railway" section for running it on always-on
infrastructure (with a persistent volume for `JARVIS_DATA_DIR`, so state
survives a redeploy) instead of a machine that's only sometimes on.

## Ideation remembers what's already been killed

Every ideation session used to start cold: a venture killed months ago
carried no weight on today's brainstorm, so the Studio could re-pitch the
same idea (or a thin reskin of it) indefinitely. `buildPastLessonsContext()`
(`server/finance/context.js`) lists every killed venture's title, one-liner,
and `killReason`, scoped to what's actually on record rather than invented
"lessons learned." `buildStudioContext()` joins that with the existing
business context into what `venture_partner` and its whole team (including
`validation_critic`) see — used everywhere the Studio runs: the interactive
`/api/studio/chat` route and the daily meeting's opportunity-review phase.
Both prompts are updated to actually use it: the Venture Partner is told to
check every direction against the list before running with it, and the
Validation Critic is told to name which past venture a new pitch resembles
when the same failure reason would apply again — a sharper objection than a
generic one, since it's already been proven true once.

This is deliberately scoped to what the data model actually captures (a
title and a reason), not a general-purpose memory system. A real reflection
loop — comparing a week's flagged opportunities against what actually
happened, and writing that verdict back into the same context — is a
bigger, still-open version of this same gap.

## Resilience: one retry, and no more silent full-day gaps

Two related gaps in how the system survives a bad moment, both closed
without changing what any agent is allowed to do:

- **`server/agents/agentRunner.js`** now wraps every `messages.create` call
  in one extra retry (`createMessage()`) for a transient failure — a rate
  limit, a 5xx, or a dropped connection (`isRetryableError()` checks the
  SDK's `err.status`; `undefined`, `429`, or `>= 500` all qualify). The
  Anthropic SDK already retries a single request internally, but a daily
  cycle burning through 10-20 calls in a row can outlast that on its own;
  this adds one more attempt on top. It only wraps the raw API call, never
  a whole delegated `consult_*` conversation, so a retry can never re-run
  an action tool (`log_revenue`, `propose_venture`, ...) that already fired
  in an earlier round — the thing that would make a naive "just retry the
  whole sub-agent" approach unsafe.
- **`server/dailyMeeting.js`**'s two phases are now isolated symmetrically.
  Previously only the Venture Studio phase was wrapped in a try/catch; a
  persistent failure in the leadership sync threw before the Studio phase
  ever ran, so a bad day produced no report and no email at all. Now a
  failure in either phase still produces a report — the failed half says so
  plainly, the other half (if it ran) is unaffected — instead of the whole
  day going dark.

## Proactive alerting, not just a once-a-day digest

The daily report was the only email this app sent — useful for a summary,
useless the moment a real decision shows up mid-day and sits unseen in the
UI until the founder happens to check. `server/email.js` now sends narrower
emails the instant the thing they're about actually happens:

- **A new venture** (`sendVentureProposedEmail`) — fires from
  `handleProposeVenture` in `server/actionHandlers.js`, so it fires the same
  way whether the venture came from an interactive Venture Studio
  conversation or the autonomous daily cycle's opportunity-review phase.
  Since a venture is active on creation, this informs rather than asks: it
  names the venture and its first milestone, and says plainly that being
  active buys it no reach outside the app.
- **A real deployment** (`sendDeploymentEmail`) and **a real customer
  email** (`sendOutreachAlertEmail`) — the two actions that genuinely
  affect the outside world, so the founder hears about each one as it
  happens, including from an unattended daily cycle.

These share the same opt-in gate as the daily report (`SMTP_HOST` +
`REPORT_EMAIL_TO`) and the same failure isolation: a `notify()` wrapper in
`actionHandlers.js` logs a failed send but never lets it break the action
itself — the venture or the commit is already real either way, so a
bad SMTP config should show up as a log line, not a broken conversation.

## Cost and latency, not just "it ran"

A daily cycle fanning out through 10-20 model calls has a real dollar cost
and a real duration, and until now neither was visible anywhere — just
"the report exists" or it doesn't. `server/agents/agentRunner.js` threads a
shared `usage` accumulator through every recursive `runAgent()` call
(mutated in place, the same pattern `trace` already uses), summing
`response.usage.input_tokens`/`output_tokens` from every round of every
agent consulted — the root call and every delegated sub-agent, all folded
into one total. `server/usage.js` turns that into a dollar estimate
(`estimateCostUsd()`, pinned to `claude-sonnet-5`'s published per-token
price — $2.00/MTok in, $10.00/MTok out as of the pricing check run when
this was built; update the constants there if the model or its price
changes) and formats it for display (`formatUsd()`, more decimal places
under a cent since `$0.00` would otherwise hide a real cost).

`server/dailyMeeting.js` sums usage across both phases (`sumUsage()`),
times the whole cycle wall-clock (`Date.now()` at start and end), and
stores `usage`/`costUsd`/`durationMs` on the saved report alongside
everything else. The daily email (`server/email.js`) and the Daily Report
tab (`client/src/components/DailyReportView.jsx`) both show it — "47.3s ·
$0.08 · 18,342 in / 4,021 out tokens" next to the performance line — and both
guard for older reports saved before this existed, so a report from before
this feature just omits the line instead of printing `undefined`.

## Scaling the roster: what actually breaks

Growing from 27 agents to 150 isn't a prompt-writing problem. Measured on
the current chart and extrapolated:

```
agents reachable from the CEO   : 21
one full fan-out, mixed tiers   : ~$0.11

at 150 agents (same shape, x5.6):
  full fan-out                  : ~$0.61
  vs the $5/day cap             : ~8 full questions per day
  latency, sequential dispatch  : 117 calls x ~4s = ~8 minutes per question
```

Cost survives. **Latency was the blocker**: dispatch ran strictly
sequentially, so a turn's duration was proportional to how many agents were
consulted rather than to the depth of the chart. Eight minutes for one
question is unusable however cheap it is.

### Consultations parallelise; actions never do

`agentRunner` now runs delegations concurrently, bounded at 5 in flight.
That turns the ~8 minute worst case into roughly 2 — the remainder is chart
*depth*, which is genuinely serial because a manager can't synthesise before
its reports answer.

Action tools are deliberately excluded, and this is the load-bearing part. An
action has a real side effect governed by a per-venture daily cap and a
cooldown (see `finance/ventures.js`), and every one of those checks reads the
log that the *previous* action writes. Two running at once would both read
the same pre-action state and slip past a cap that should have stopped the
second. So actions stay strictly in order, in the order the model asked for
them, and a test asserts peak concurrency of exactly 1.

### Why bounded rather than unlimited

Two reasons, both of which cost money. The daily spend cap is checked
*before* each request, so N calls launched together can all pass the check
before any records what it spent — the cap can be overshot by roughly the
width of the limit, and no more. And an unbounded fan-out is the fastest way
to hit a provider rate limit, which converts a wide turn into a slow one
anyway.

### The part worth doing before growing the roster

At 27 agents, the Agent Operations Engineer's own data showed **18 were never
consulted**. Scaling the same shape to 150 multiplies unconsulted headcount,
not output. The machinery here makes a larger roster *viable*; it doesn't
make it *right*. Let the operations data decide the number.

## Three roles a conventional org chart wouldn't have

The roster grew to 27. Two of the new roles exist only because this
company's workforce *is* its software, and the third fills a gap that was
genuinely embarrassing once noticed.

**Agent Operations Engineer** (under the CTO). A normal company does this
work in management meetings; here it has to be a role. Its job is how the
company itself runs — which agents get consulted, where a fan-out wasted a
turn, whether a role is earning its place.

The trap with a role like this is building a nameplate: an agent asked to
improve operations it cannot see would just produce plausible-sounding
advice. So `server/agents/operations.js` feeds it the real data, which was
already sitting in every daily report and had never reached an agent —
consultations per agent, cost and duration per cycle, and the most useful
signal of all: **which agents were never consulted at all**.

That list is the point. An agent nobody asks isn't free — it dilutes the
profit-share pool and adds one more option every manager weighs on every
turn. The prompt tells it to treat that as the most actionable thing
available and to be willing to recommend cutting a role outright.

The operating data is scoped to this one agent via `buildPerAgentContext()`,
not broadcast. It's a wall of numbers that would be noise in a Marketing
Manager's prompt, and an agent reasoning about the org chart while doing its
actual job is exactly the distraction this company doesn't need.

**Automation Architect** (under the CTO). Sits in the gap between "we could
build this with agents" and "this only works because agents run it." Normal
architecture assumes human labour is the expensive part and automates around
it; this role designs for the inversion — labour nearly free, never
sleeping, instantiable a thousand times over. Batch becomes continuous,
sampling becomes exhaustive, per-customer work becomes the default. It's
also instructed to say plainly when parallelism buys nothing, because a
venture bottlenecked on a data source or a licence won't move for it.

**Data Analyst** (under the CFO). Across 24 roles, nobody was responsible
for looking at what actually happened — so the default failure mode was
confident narrative on no evidence. Its standing instruction is that *"three
data points over two weeks cannot tell us whether this is working"* is a
complete and useful answer. Small numbers are the normal state of a young
company, and treating them as signal is the most expensive mistake available
here.

### Which tier each runs on

The Data Analyst carries `CHEAP_TIER` — reading numbers already in front of
it and saying what they show is exactly the bounded, single-shot work that
tier exists for. The other two deliberately don't. Judging the company's own
behaviour and making architecture calls are the highest-reasoning tasks on
the chart, and both compound: a cheap wrong answer from the Automation
Architect is paid for over a venture's whole life.

## Talking to the company from WhatsApp

`POST /api/whatsapp/webhook` lets the founder ask the Executive Team a
question from their phone. Three things about it are load-bearing, and two
are easy to get wrong in ways that only surface in production.

### Acknowledge first, answer later

Meta expects a 200 within seconds and retries the delivery if it doesn't get
one. A team turn fans out from the CEO through the C-suite and takes 20
seconds to two minutes. Answering inline would guarantee a timeout on every
question *and* duplicate deliveries.

So the webhook returns 200 immediately and the reply goes back afterwards as
a separate outbound message through the Send API. This is also why chat was
the right channel and a phone call wasn't: a two-minute silence is normal in
messaging and a dropped call on the phone.

### The signature is the door

This endpoint is public, and what sits behind it can commit code and email
real customers. Meta signs every payload with HMAC-SHA256 over the **raw**
body — and `express.json()` parses and discards exactly those bytes, so
`index.js` captures them with a `verify` hook. Re-serialising the parsed
object does *not* reproduce the same bytes and would fail every check.

Comparison is constant-time. A plain `===` leaks how much of a forged
signature was correct, one byte at a time.

### A signature proves Meta sent it, not who typed it

Anyone who finds the number can message it. So there's a second, independent
gate: `WHATSAPP_ALLOWED_NUMBERS`, an explicit allowlist. It **fails closed** —
an empty or missing allowlist admits nobody, and `isWhatsAppConfigured()`
reports the channel as unconfigured until one exists, so there is no state
where the webhook is live and ungated. Numbers are compared digits-only, so
`+44 7700 900123` and `447700900123` match; a formatting mismatch that locked
the founder out of their own company would be a miserable thing to debug.

Verified against a running server rather than only stubs:

```
unsigned POST   -> 403
bad signature   -> 403
valid signature -> 200
handshake ok    -> 42
handshake bad   -> 403
```

### Smaller things that still matter

**Duplicates.** Meta retries a delivery it thinks failed, so the same message
id can arrive twice. Running the turn again would cost real money and could
fire an action tool a second time, so ids are remembered for ten minutes.

**Long replies.** WhatsApp rejects bodies over 4096 characters and a
synthesised team answer can exceed that, so replies split on paragraph
boundaries with a `(1/3)` marker rather than failing the send.

**Voice notes.** With `OPENAI_API_KEY` set, a voice note is transcribed and
reaches the team as text; without it, the note gets a plain explanation
naming the missing key rather than silence — silence reads as the company
ignoring you.

**More than one number.** Every message carries the id of the business
number it arrived at, and the webhook routes on it: the founder's line goes
to the company, the travel advisor's line (next section) goes to the
advisor. One Meta app, two products, no shared session.

**Session isolation.** The sender's number keys the conversation
(`whatsapp-<number>`), so a WhatsApp thread has its own continuous history
rather than colliding with the web app's.

## The first product: a travel voice advisor

Everything above is a company that can build and sell. This is the first
thing it has to sell: a voice-to-voice Amadeus and travel-industry helpdesk
on WhatsApp, in Spanish, French and English. A travel agent sends a voice
note — a PNR that will not price, a fare rule nobody can read, a client
shouting about a refund — and a senior advisor answers in a voice note in
the same language, within the time it takes to read a text. Code:
`server/travelVoice/`; the Travel Voice tab is the same advisor in a
browser.

### Not a member of the team

The advisor is one agent with a domain brief and at most two read-only
tools (an airport lookup and a fare search). It is deliberately *not* on the
org chart. The company's agents delegate to each other and can act — deploy,
email, book revenue — and a stranger on a phone must never reach any of
that. So the advisor has no way to reach the org chart, and its WhatsApp
number is open to any caller by default: behind it are a per-caller hourly
limit, the daily spend cap, and nothing that can act. The founder's line is
allowlisted because of what sits behind it; a helpdesk nobody can ring is
not a helpdesk.

### Language is decided before the model is asked

A text chat survives answering in the wrong language for a turn. A voice
reply in the wrong language is thirty seconds of noise on a phone. So the
language is resolved in `languages.js` and *stated* in the prompt rather
than left to the model's judgement, in a fixed order of trust: what the
caller chose, what Whisper heard, a word-frequency guess over the text, the
previous turn's language, then English. The guess says "don't know" on a
string of IATA codes rather than picking a side, and a weak guess cannot flip
a conversation out of its language mid-way. "En français, s'il vous plaît"
in any of the three switches for the rest of the conversation. Every message
the plumbing sends on its own behalf — "that note was empty", "you've sent a
lot in a short time" — exists in all three.

### Voice in, voice out, and the words as well

Transcription and synthesis both run on the OpenAI key that already
transcribes the founder's voice notes. Whisper reports the language it
heard; the reply is synthesised as Ogg Opus, which WhatsApp plays as a voice
note with a waveform rather than delivering as a file. A voice note is
answered with a voice note *and* the words as a text, because an Amadeus
entry is easier to copy than to remember from audio. Audio is billed by the
minute and the character rather than the token, so it is metered into the
daily spend cap with its own prices, pinned by hand like every price here.

### Three slots, several providers each

Whether a Spanish agency owner trusts a synthetic voice with their clients,
whether Scribe hears an Andalusian accent on a bad line better than Whisper,
whether Llama on a Berlin server explains a fare rule as well as Claude —
these are empirical questions, and a product that hard-codes the answers
has decided them from a datasheet. So the advisor has three slots — ears,
brain, voice — with one contract each and several providers behind it
(`server/travelVoice/providers/`): OpenAI Whisper, ElevenLabs Scribe and
Deepgram Nova for hearing; Claude, IONOS, OpenAI, Gemini, DeepSeek and
OpenRouter for thinking; OpenAI, ElevenLabs and Deepgram Aura for speaking.

A choice resolves in a fixed order: what the caller asked for on this turn
(the tab's dropdowns), the deployment's default (what WhatsApp callers get),
then the first provider in the slot with a key — which puts the one that was
here first ahead of the newcomers, so a deployment that sets nothing behaves
exactly as before. A provider named on a turn that has no key is refused
rather than swapped, because a comparison is only worth anything if it is of
the thing that was picked. Every reply carries which provider did each stage,
how long it took and what it cost, and the log keeps the same, so the
comparison has numbers on it.

IONOS is the odd one out and the reason the brain slot exists at all: an
EU-hosted provider serving open models under EU data rules. The advisor's
callers are agencies in Spain and France, and "where does my client's
booking question go" is a question they ask. The other brains already spoke
the OpenAI protocol this app translates tool calls through, so IONOS is a
URL, a key and a model default, and the advisor's tools work on it unchanged.

### Where the money actually goes on a voice channel

The instinct carried over from the rest of this company — the mixed-model
routing above, the cheap tier for leaf agents — is to economise on the model.
On the advisor that instinct is precisely wrong, and the arithmetic says so.
For one exchange of a twenty-second question and a hundred-and-fifty-word
answer, synthesising the reply costs a few cents, hearing it costs a fifth of
one, and thinking it costs well under one. The model is roughly 2 to 5
percent of the total.

So the advisor keeps its own model default rather than inheriting the
company's, and that default is the strongest model at low effort. The extra
fraction of a cent buys the failure this product can least afford: a travel
agent who is told a refund penalty that does not exist, acts on it, and never
comes back. Low effort is not a concession on that — the questions are
bounded ("what does this entry do", "which category holds the penalty")
rather than open problems that repay deliberation, and low effort on a
stronger model beats high effort on a weaker one for latency and accuracy
together. Every other agent in the chart is untouched by this; the change is
scoped to the one agent that talks to customers.

The same arithmetic decides the voice, in the opposite direction. The voice
is what an agency owner judges before they have read a word, so it is worth
paying for while there are agencies to win — and it is the first thing to
move once they are won, because it is the line that scales with use. That is
a dropdown, not a rewrite.

### The advisor checks its own answer

Opening the brain slot to open models created a failure the Anthropic-only
version did not have. The advisor leans on two instructions harder than
anything else in its prompt — answer entirely in the caller's language, keep
it short enough to hear — and a weaker model follows them less reliably.

The two failures are not equally bad, so they are not treated alike. A reply
in the **wrong language** is a total loss: a Spanish agent handed thirty
seconds of English audio has not received a worse answer, they have received
no answer, and unlike a text they cannot skim it to discover that. That is
worth a second model call, so the reply is checked and, if it confidently
came back in the wrong language, asked for again once. The correction is
written in the target language first, because a model that just ignored an
English instruction to speak Spanish is not obviously going to obey a second
one. A reply that is merely **too long** is a partial loss of a different
kind: the words are fine and the text message carries all of them, so nothing
is retried and only the audio is cut, at the last full sentence that fits.

The check is deliberately reluctant. A false positive costs a whole extra
call and doubles the wait of someone holding a phone, so it fires only on
strong evidence and stays silent on anything it cannot judge — a reply that
is mostly Amadeus entries and IATA codes has no language to detect, which is
the common shape of the shortest and best answers. A correction that itself
drifts is still used, because a second wrong-language answer is no worse than
the first and discarding it would throw away a call already paid for; a
correction that cannot run at all, because the spend cap closed in between,
leaves the first answer standing rather than turning a degraded reply into no
reply.

What this produces, beyond a better answer, is evidence. Every turn records
whether the brain drifted and whether the correction fixed it, so "this model
cannot be trusted on a Spanish line" stops being an impression and becomes a
count.

### It can look, not just explain

The advisor knows Amadeus the way a trainer does — the cryptic entries
agencies actually type, the PNR lifecycle, what the letters on a fare basis
signal, NDC, EU261, BSP — and is told never to invent a specific fare or a
named airline's rule. With Amadeus Self-Service credentials it searches: live
flight offers and airport codes, summarised to what a person would read out
over the phone, the cheapest first. Without them it says plainly that it
cannot see live fares and explains how the agent can.

### Calls: signalling now, audio when there is a bridge

Meta's Business Calling API has two halves. Signalling — asking a user's
permission to ring them, placing a call, accepting an incoming one, hanging
up, and every webhook event — is plain JSON and implemented in `calls.js`,
with permissions remembered per number and honoured with their expiry. The
audio itself travels over WebRTC and needs a media gateway that terminates
the call, feeds the caller's speech to transcription and plays synthesised
speech back — a media stack, not something a JavaScript server does on its
own. It plugs in through `setMediaBridge()`, and nothing above that file
changes when it arrives. Until then the advisor does not pretend: an
incoming call is declined and the caller is told, in their language, to send
a voice note; an outbound "call" is a permission request, an introduction
and the message spoken as a voice note. Live calls are the venture's fourth
milestone, recorded on the portfolio when the founder registers it from the
tab.

### The demo is a phone number, so it is run from a phone

Everything needed to show this thing to an agency lived in a browser tab:
which providers were live, the recent conversations, switching the voice,
inviting someone. That is the wrong place for all of it. The product is a
WhatsApp number, it gets demonstrated in someone's office or over coffee,
and the moment an agency owner says the voice sounds robotic is the moment
you want to change the voice — not the moment you want to find a laptop.

So the tab's controls are also WhatsApp commands, parsed by the same rules
as the founder commands: the command must be the whole message, matched
deterministically, never interpreted by a model. `TRAVEL STATUS` names what
is live and what the day has cost. `TRAVEL VOICE deepgram` pins a provider
at runtime, between the per-turn request and the environment default, and
survives a restart; `TRAVEL DEFAULTS` puts it back. `TRAVEL LOG` reads back
the recent conversations with a wrong-language answer called out, because
that is the one worth seeing at a glance.

### The dials, and why they are a registry

Switching the provider was the first thing that had to leave the browser,
but it was not the only one. An agency owner says the answer was too long,
or that they only ever want French, or that the voice is wrong — and each of
those was an environment variable, which is to say a redeploy, which is to
say not during this conversation.

So eight of them became dials settable from a phone: the voice of the live
speech provider, a pinned language, the spoken length, the brain's effort and
model, whether the text goes out alongside the voice note, whether a
wrong-language answer is re-asked, and the per-caller hourly limit. Each
resolves the same way — what was set from a phone, then the environment
variable, then the built-in default — so a redeploy still puts a deployment
where its config says, and the phone is an override on top. `TRAVEL SETTINGS`
says which of those three a value came from, because "it is 90" and "it is 90
because you set it five minutes ago" are different facts.

They are a registry rather than eight commands. One entry names the dial, how
to parse a value, and what to say when the value is wrong; the command, the
listing, the validation and the help text all read from it. Adding a dial is
that entry plus reading it where the value is used, which is the difference
between a mechanism and nine special cases.

Two of the words name two things. "Voice" is both which speech provider and
which voice within it; "model" is both which brain and which model. Rather
than invent `VOICEID`, the value decides: a provider id is one of a closed
set of three, a voice id is not, so `TRAVEL VOICE elevenlabs` switches the
provider and `TRAVEL VOICE JBFqnCBsd6RMkjVDRZzb` sets the voice. A voice is
stored against its provider, so switching provider and back remembers rather
than carrying an ElevenLabs id to OpenAI, where it would mean nothing. The
slot words that name no dial say "no such provider" instead of guessing.

### One number, two doors

The interesting part is `TRAVEL INVITE`. A demo needs a prospect to be able
to message the number, and the company's own line is allowlisted because
what sits behind it can commit code and email customers. Adding a prospect
to that allowlist to show them a demo would hand a stranger the Engineering
Lead.

So there is a second, much narrower door: a guest list. The webhook checks
it *before* the company allowlist and, on a match, calls exactly one thing —
the advisor. Not the company turn, not the founder commands, not the daily
plan. A guest who types `TRAVEL STATUS` gets it answered as a travel
question, because the branch that parses commands is one the guest's message
never reaches. The asymmetry is a property of the routing rather than
something a prompt asks for, which is the only kind of boundary worth having
when the thing on the other side is a stranger with a phone.

Inviting someone also sends them a hello — as text, and as a voice note in
the product's own voice, because an agency owner judges this on how it
sounds before they have read a word. If that hello fails to send, the
invitation is still live and the reply says so, since the failure mode to
avoid is a founder who thinks nothing happened and invites the same person
twice. A stranger who arrives on a dedicated advisor number and types
nothing but "hola" gets the same greeting, in their language, without a
model call: a fixed sentence says what this is and what to send next better
than a generated one would, and for nothing.

### Trying it from one phone

`TRAVEL ON` on the founder's own WhatsApp line routes every following
message, voice or text, to the advisor until `TRAVEL OFF` — persisted, so a
redeploy mid-demo does not silently hand the next voice note to the CEO.
The same advisor, with the same transcription, answers in the Travel Voice
tab, which is how it is tested without a Meta number at all.

## The company works in your tools: Obsidian and VS Code

Daily reports, weekly reflections and venture write-ups all lived in a web UI
nobody re-reads. They're written work, and written work belongs where the
founder actually thinks.

Both target tools are **git-native**, which is the whole design: one
mechanism serves both. Jarvis commits markdown into a repo the founder
nominates, and

- **Obsidian** opens that repo *as the vault*, synced by a git plugin
  ([SyncGit](https://community.obsidian.md/plugins/sync-git),
  [Obsidian Git](https://community.obsidian.md/plugins/obsidian-git),
  [Vault Sync](https://community.obsidian.md/plugins/vault-sync-rest)).
- **VS Code** opens the same repo as a folder — markdown preview, real
  diffs, and the full history of what the company decided, with no plugin at
  all.

This also settles a constraint worth recording: Obsidian's
[Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
runs *inside* Obsidian on the founder's machine, so a server on Railway can
never reach it. Git is not a workaround here, it's the only bridge that works
from a cloud host — and it happens to be the one both tools already speak.

### What gets written

```
Company/Daily Reports/2026-03-05.md
Company/Weekly Reflections/2026-01-04.md
Company/Ventures/Ledger Watch.md
Steering.md              ← yours, not the company's
```

The markdown is genuinely Obsidian-shaped rather than merely valid:
**YAML frontmatter** becomes note properties you can filter and sort on
(`type`, `status`, `net`, `tags`); **`[[wikilinks]]`** connect a daily report
to the ventures it started, so the graph view shows where an idea came from;
and milestones render as **real task checkboxes** (`- [x]`), so a venture
note is something you can tick off rather than only read. `noteName()` strips
the characters a vault or filesystem would reject, since a title that can't
be a filename would silently produce a broken link.

### `Steering.md` — the half that makes it an integration

Publishing alone would be an export. The return path is a single note at the
top of the vault, **yours rather than the company's**: whatever you write in
`Steering.md` is read back into every agent's context — interactive turns and
the autonomous daily cycle alike.

The daily cycle is where it matters most. An unattended 8am run is exactly
when you aren't there to say "focus on the newsletter this month, drop the
marketplace idea." Now you write it once, in the tool you were already in,
and the company reads it every morning. Frontmatter is stripped before the
text reaches an agent — it's metadata for Obsidian, not instruction for the
company.

### One fetch per conversation, not per message

`readFounderSteering()` runs on every interactive turn. Left uncached that's
a GitHub round-trip per message, for a note the founder edits maybe once a
week — it slows their chat and makes them wait on GitHub's availability.

It's cached for 60 seconds: long enough that a busy conversation costs one
fetch, short enough that a steering change goes live almost immediately. An
*absent* note is cached too, since that's the common case and re-fetching a
404 every message is the same problem wearing a different hat. A **failed**
read is deliberately not cached — a transient GitHub blip must not blind the
company to its own steering for the next minute.

### The usual three properties

- **Opt-in.** No `WORKSPACE_REPO_OWNER`/`WORKSPACE_REPO_NAME`, no calls,
  nothing changes.
- **Fail-quiet.** A publish failure is logged and returns `false`; it can
  never break the cycle that produced the report, which has already saved its
  real work. Same for reads: a missing `Steering.md` is a normal state, not
  an error, so it returns `''` like every other context builder.
- **Kill-switch-aware.** Unlike Honcho or the model router, this writes to a
  real external system, so halting real actions stops these writes too. A
  test asserts the halt stops the write *before* it goes out.

One supporting fix: `deploy/github.js` threw a plain `Error` on every
failure, which made "this file doesn't exist yet" — a normal state — look
identical to "the token is wrong". It now carries `.status`, so a 404 reads
as absence and everything else still throws.

## Ideas a company without payroll can actually win

The studio's ambition bar asked whether an idea was *big*. It never asked the
question that makes this particular company interesting: **why would an
agent-run company win at this?**

Without that filter, a studio with no payroll mostly finds cheaper versions
of ordinary businesses — and a funded team with real staff will out-execute
you on any of them. The premise is different: no payroll doesn't just make
normal businesses cheaper to run, it puts a different set of businesses
within reach. The ones worth the company's attention are those that were
previously **impossible** rather than merely expensive.

So `propose_venture` now *requires* an `agentNativeEdge`, alongside
`marketSize` and `pathToMillions` — the Venture Partner structurally cannot
log an idea without naming the advantage. What counts:

- **Labour that costs cents rather than salaries**, making a price point or a
  long tail viable that nobody could afford to staff. This is the big one.
- **Always-on** — responding in seconds at 3am is normal, not a night shift.
- **Parallelism** — a thousand instances on a thousand customers is a
  configuration choice, not a hiring plan.
- **Bespoke work at volume**, where the human version only ever penciled out
  as a template.
- **Perfect recall and consistency**, where people drift.

And what disqualifies an idea outright rather than merely making it harder:
anything physical; anything needing a licence, a signature, or a person who
can be held liable; relationship-led selling and long enterprise
procurement; holding money or acting as a legal entity.

The failure mode the whole filter exists to catch is *"a normal software
company, except the staff are agents."* That isn't an edge. The
`agentNativeEdge` field says so explicitly, and the **Validation Critic** has
a third standing job on top of feasibility and ambition: challenge the
agent-native claim, and treat "it's cheaper for us" as a non-answer, because
a well-funded competitor can absorb that and beat us everywhere else.

The brief is appended to **every** agent in `ideationTeam.js` by a loop
rather than pasted into six prompts, so a specialist added later inherits it
instead of quietly brainstorming for a company that doesn't exist. The
Executive Team deliberately doesn't get it — it executes what the studio
decided, and re-litigating the premise mid-build isn't its job. The stored
`agentNativeEdge` does travel into the shared context, so execution stays
pointed at the same edge that justified starting the venture.

## Paying the agents who don't have hands

A flaw that shipped with the profit share and was caught the same day: credit
came only from action tools, and most agents don't have one. **18 of the 24
agents could never earn a cent** — every researcher, analyst, architect and
critic, including the entire ideation bench — while all 24 were told they
had a stake. Telling an agent it has a share of a pool it is structurally
unable to touch is worse than not telling it at all.

Being consulted *is* the work for most of this org chart, so `agentRunner`
now records a `consulted` contribution when a delegated agent returns
substantive text. Three details matter:

- **Only if it actually answered.** An empty or errored consult earns
  nothing, and the failure path never reaches the recording call.
- **The manager earns nothing for delegating.** Otherwise the cheapest way to
  get paid would be to ask someone else to do the work.
- **It's weighted lowest**, tied with filing a note. Answering when asked is
  real work, but it must not out-earn doing the thing — and it's the one kind
  of credit a manager could hand out freely, so it's cheap, bounded by the
  runner's `MAX_ROUNDS`, and paid for out of the same daily model-spend
  budget that caps everything else.

## Every agent earns a share of what the company makes

The founder's framing: *"every single agent wins a percentage once we start
generating money."* The arithmetic is the easy part. The hard part is
honesty — you cannot pay an agent for work you never recorded, and until this
landed the app recorded *what* happened to a venture without ever recording
*who* did it. `recordDeployment` stored the path, the commit and whether the
run was interactive or autonomous, but not the agent.

So this is an **attribution system first and a payout second**, and the
attribution is worth having on its own: there's now an audit trail of which
agent made which commit and sent which email.

### How it works

`server/finance/profitShare.js` keeps an append-only log of contribution
events. `AGENT_PROFIT_SHARE_PCT` (default **10%**, hard-capped at **20%**) of
**net profit** forms a pool, split by weighted contribution:

| Action | Weight |
| --- | --- |
| Shipped code | 5 |
| Started a venture · contacted a customer | 3 |
| Recorded a milestone outcome · ended a venture | 2 |
| Recorded a contact note · booked revenue · booked an expense | 1 |

Net, not revenue, so nothing is owed while the company is unprofitable — but
weight keeps accruing, so the pool distributes the moment net turns positive
without any retroactive backfill.

The **20% cap is on the whole pool shared between all the agents**, not on
any one agent's slice, and it's enforced in `sharePct()` rather than left to
whoever edits the env var — this is the single number deciding how much of
the company's profit leaves it, and a fat-fingered `100` shouldn't be able to
give the entire thing away. A value above the cap is *clamped* (someone
setting 50 wants as much as they can have), while something that isn't a
usable percentage at all — a negative, a typo — falls back to the default,
since silently reading a config mistake as the maximum would be the worst
possible guess.

A worked example. Revenue $2,000, expenses $500 → net $1,500 → a $150 pool:

```
engineering_lead           58.8%   $88.24   (shipped twice)
sales_commercial_manager   17.6%   $26.47
venture_partner            17.6%   $26.47
finance_manager             5.9%    $8.82   (booked the revenue)
```

### The design problem this had to survive

The founder chose to let **each agent see its own balance**, over a
founder-only ledger. That's the honest reading of "every agent wins a
percentage" — a share nobody is told about isn't much of a share. But it
hands every agent an incentive to inflate the number it's paid on, and a
prompt saying "please don't" is the weakest possible answer.

Four things make it hard, and **only the last is a prompt**:

1. **Credit is recorded for the agent, never claimed by it.** It's written by
   the runner when an action actually *succeeds* — a failed deploy earns
   nothing. There is deliberately no `claim_credit` tool, and describing work
   you didn't do earns nothing. `agentRunner.js` passes the acting agent's id
   to the handler precisely because the runner knows it and the agent can't
   assert it.
2. **The pool is founder-gated.** It's a share of `net` in
   `finance/ledger.js`, whose only writers are `log_revenue` and
   `log_expense` — both requiring the founder to have reported real money,
   and *neither wired into the autonomous daily cycle*. No unattended run can
   move the figure agents are paid on. A test asserts this against the actual
   handler wiring rather than trusting the file's comments, because that's
   exactly the guardrail a later edit would quietly break.
3. **Credit can't be farmed.** The actions that earn it are already rate
   limited per venture — a per-day cap defaulting to 1, plus a cooldown.
4. **Then, and only then, framing.** Each agent is told the share follows real
   outcomes, that recording an expense *shrinks* the pool and still earns
   credit (so nobody is tempted to leave costs out), and that every event
   behind a balance is visible to the founder.

Two weighting decisions fall out of this. Booking revenue is weighted
**lowest of any action** — it moves the number the share is computed from, so
it must never be the most profitable thing an agent can do; a test asserts it
scores below shipping code. And **ending** a venture earns credit, because
otherwise the only incentive the share creates is to keep every venture
alive.

### Keeping the log from eating the server

`recordContribution()` fires on every consultation, and `store.js` is
synchronous — so each one does a blocking full-file read *and* rewrite, which
means the cost of a single write grew with the entire history. Measured:
**1.5ms after 1,000 events, 6.8ms after 5,000, and a 20,000-event benchmark
that never finished.** All of that blocks the event loop, so it stalls the
whole server rather than just the agent being consulted.

The log is now capped at 500 events, and the overflow is **folded into
per-agent totals rather than deleted**. That distinction is the whole point:
contributions *are* the basis for the share split, so dropping an agent's old
work would silently reduce what it has earned. Rolling the weight into a
running total preserves every share exactly — the founder loses the
individual event rows for old work, never the earnings behind them. A test
asserts that two agents with equal weight still earn equally after
compaction, and that the slices still sum to the pool.

Cost is now flat at roughly 0.8ms with the file bounded near 110 KB,
regardless of how long the company has been running.

### Auditing it

`GET /api/profit-share` returns the pool, every agent's slice, and the
contribution events behind them. The **Portfolio** tab renders it with a bar
per agent and a "show the events behind these numbers" toggle. An agent only
ever sees its own line — this is the only place the whole distribution is
visible, which is what makes any balance checkable rather than trusted.

Nothing here pays anyone: agents have no wallets. This is a record of who
earned what, which has to be right before settlement is even a meaningful
question.

## Telling a working key from a typo'd one

Every optional integration in this app fails **quietly** on purpose. Honcho
logs an error and the teams carry on memory-less; OpenRouter routes silently
back to Claude; SMTP skips the send. That's the right behaviour — none of
them should be able to take the company down — but it left the founder with
no way to tell a working key from a broken one short of reading deploy logs,
which is a poor answer for something you want to confirm on every redeploy.

`GET /api/integrations` (`server/integrations.js`) answers it. Presence of the
env var is reported for everything, and the two newest integrations are
additionally **probed** — a real request proving the credential is accepted,
not merely present:

- **OpenRouter** — `GET /api/v1/key`, the cheapest call that validates the
  credential, and free in tokens.
- **Honcho** — resolving the founder peer, the lightest call that proves both
  the key *and* the workspace id are right. A wrong workspace would otherwise
  build a second, empty memory in silence.

### Four states, not two

A plain "is the key set?" check isn't enough, because these all look
identical from outside — the app seems fine and the feature just isn't
happening:

| State | Reported as |
| --- | --- |
| Not configured | `configured: false, ok: null` |
| Key rejected | `ok: false` — "silently falling back to Claude" |
| Valid key, no credit | `ok: false` — "out of credit, so the model can't run" |
| Working | `ok: true`, naming the model it unlocks |

The third is the nastiest: the key is genuinely valid, so a naive auth check
passes, but the paid model still can't run. It gets its own test.

`ok: null` is deliberately distinct from `ok: false` — "you haven't set this
up" is not "this is broken", and colouring it as a failure would nag about
every feature the founder deliberately left off.

The Ventures panel renders this as a collapsible **Integrations** section with
a per-entry status dot and a "Re-check now" button. It's fetched separately
from the rest of the panel rather than inside its `Promise.all`, since it
makes real third-party calls and must not hold the panel behind it — or fail
it. Both probes carry an 8-second timeout: "couldn't reach it" is a more
useful answer than a spinner.

## Memory about the founder, not just about the business

Everything this app remembered was about the *business*: ventures,
milestones, killed ideas, who Sales has emailed. Nothing was ever about the
person running it — so every conversation started cold on the one subject
that never changes.

It's also worth noticing the shape of the existing memory. Each store is a
flat JSON list read back verbatim, and each one therefore carries an
arbitrary cap: five notes per contact, one weekly reflection, the last N
turns of history. A cap is what you reach for when you can't retrieve the
*relevant* memory, only the most recent few.

[Honcho](https://honcho.dev/) is built for that gap. Participants are
**peers**, conversations are **sessions**, and it derives a representation of
a peer from their messages asynchronously — which you then query in natural
language. `server/memory/honcho.js` maps the founder to a peer, each chat
mode to a session (namespaced `company-` / `studio-`, since the founder
behaves differently in each room), and attributes each turn to two peers
rather than one transcript: the founder, and the agent that actually
answered. The CEO and the Venture Partner are different voices, and keeping
them apart is what lets Honcho tell them apart later.

Two things then use it:

- **`buildFounderContext()`** joins the business context on every Executive
  Team and Venture Studio turn, wrapped in framing that keeps it as context
  on how the founder thinks — explicitly *not* as instructions, and never as
  a substitute for what they're asking for right now.
- **`askAboutFounder()`** answers the kind of question a JSON list
  structurally cannot: "what has the founder consistently pushed back on?"
  has no key to look up.

### Three properties, in priority order

**It's opt-in.** No `HONCHO_API_KEY`, no calls, no behaviour change anywhere.

**It's never load-bearing.** Recording is fire-and-forget — the reply is
already final, and the founder shouldn't wait on a memory write to see it.
Recall failures return an empty string, which every caller concatenates into
a system prompt, so "unconfigured", "nothing learned yet" and "the service is
down" all degrade to the same correct no-op. A memory outage taking down the
executive team would be a much worse failure than having no memory at all,
and a test asserts each function against exactly the failures it can actually
hit.

**Nothing there is a source of truth.** Ventures, the ledger and the outreach
log stay in `server/data/`. This is an additional lens on the founder, not a
second copy of the business — so losing the Honcho workspace costs the
company its recall, never its records.

## Mixed-model routing: paying frontier prices only where they buy something

With the capital model gone, model spend is the company's only real
recurring cost — so it's worth looking at where it actually goes. In a
fan-out it isn't the CEO: one CEO turn triggers four C-suite turns, which
trigger their own reports, and the **leaves** end up dominating the call
count. Those leaves are also doing the most bounded work in the company —
review this copy, poke holes in this idea, is this spec testable — which is
the kind of judgment a smaller model handles well.

So an agent can name a **tier**, and `server/agents/models.js` resolves that
to a concrete model and its price:

| Tier | Model | Input | Output |
| --- | --- | --- | --- |
| `frontier` (default) | `claude-sonnet-5` | $2.00/MTok | $10.00/MTok |
| `specialist` | `nousresearch/hermes-4-70b` (Nous Research, via OpenRouter) | $0.13/MTok | $0.40/MTok |

Eleven agents carry the `specialist` tier today — the Product Manager,
Marketing Manager, Customer Support Manager, Implementation Manager, HR
Manager, Brand Strategist, Security Reviewer and QA Engineer in the company,
and the Ideation Facilitator, Business Case Analyst and Validation Critic in
the studio.

### Two rules keep this from becoming a quality cliff

**It's opt-in.** With no `OPENROUTER_API_KEY` set, every tier collapses back
to the default and the company runs exactly as it did before. Nothing else
changes — no fallback behaviour to reason about, no half-configured state.

**Only leaves qualify, and that's enforced rather than trusted.** The
alternative path (`server/agents/openrouter.js`) is deliberately a plain
completion call — system prompt in, text out, no tool-use loop. That's what
lets it stay ~80 lines of `fetch` instead of a second dispatch loop to keep
in step with the Anthropic one. But it means an agent with reports, actions,
or web search would *silently lose them* if routed there — failing as a
vague answer rather than an error, which is the worst possible failure
shape. So `resolveModelForAgent()` overrides the tier for any agent that
orchestrates, acts, or searches. A future edit that adds an action to a
tiered agent can't quietly break it; the agent just goes back to Claude.

### The guardrails still cover it

Both providers are called through the same `createMessage()` in
`agentRunner.js`, which means the daily spend cap is checked *before* every
request regardless of provider, and every response's real token cost is
recorded against the same ledger. `openrouter.js` sets `.status` on its
errors exactly as the Anthropic SDK does, so a 429 from either retries
identically. Two tests assert the cap specifically — that it stops an
OpenRouter call before it goes out, and that spend from one counts against
the day's total.

### The cap was blind to most of the bill

Worth recording plainly, because it emptied an Anthropic balance while `SPEND`
reported room to spare.

`priceUsage` read `input_tokens` and `output_tokens` only. With prompt caching
on, `input_tokens` from the Anthropic API is the **uncached** input alone —
everything in the cached prefix arrives in `cache_creation_input_tokens` (billed
at 1.25x the base input rate) or `cache_read_input_tokens` (0.1x). This app
caches the two largest blocks it sends, and the tool schemas sit inside the same
prefix, so on a CEO call that is roughly 4,400 of 4,600 input tokens — all
billed, all counted as `$0.00`.

So `DAILY_SPEND_CAP_USD` was metering a fraction of reality and could never
fire. Nothing leaked; the meter could not see. A realistic call the old meter
priced at $0.0084 actually costs $0.0194.

Three things came out of fixing it:

- `tokensOf()` in `agentRunner.js` reads all four counts in one place, because
  they were previously read in three and two of those took only `input_tokens`.
- Caching is now **opt-in per agent**, not unconditional. Cache reads need the
  *entire* prefix to repeat, and tool schemas are sent ahead of the system
  blocks — so the shared-context block can never be reused across agents, no
  matter how identical its text is. What does hit is the same agent calling
  repeatedly: an orchestrator loops to issue consults, read results, then
  synthesise, and those rounds read back at a tenth of the price. A leaf makes
  exactly one call per turn, pays the 1.25x write, and never reads it — so for
  half the roster caching was a 25% surcharge dressed as an optimisation. Hence
  `cache: !isLeaf`.
- `SPEND` now reports the prompt-cache hit rate, and says so explicitly when it
  is under 20%. That number is the only thing that distinguishes a cache paying
  for itself from one quietly surcharging every call, and leaving it unmeasured
  is how the first version of this went wrong.

## The company as a picture

The org chart has always been a tree in a JS object and a list in a sidebar.
Neither answers the question a founder actually has at a glance: which parts of
the company moved this morning, which are expensive, and which have never done
anything at all. A list sorts by name; a graph sorts by structure, and
structure is the question — *who did the CEO actually talk to* is one look at a
picture and a paragraph of prose.

`GET /graph` draws all twenty-eight agents as a force-directed graph, live from
`server/graph.js` — **both teams**. The first version drew only the Executive
Team and reported "22 agents", which is not the company: the Venture Studio is
six more, it runs every morning in the second phase of the sync, and its trace
was being read and then silently discarded because none of its ids matched a
node. For a picture whose job is "which parts of the company moved this
morning", omitting a team that ran is the failure it exists to prevent.

Two roots, then — the CEO and the Venture Partner — drawn as two constellations
with no edge between them, which is exactly how the company works: the Studio
proposes ventures, the Executive Team builds them, and they never consult each
other mid-turn. The teams stack along whichever axis the screen has, because
side by side on a tall phone squeezes twenty-two nodes into a mat of
overlapping labels while the vertical room goes spare.

Every field comes from something already recorded, never computed for display:

- edges are the `reportsTo` links `validate.js` already enforces
- lit vs unlit is the latest daily report's delegation trace — a node glows if
  it was actually consulted, and an edge lights up if the question travelled it
- `provider` is what `resolveModelForAgent` would pick **right now**, which is
  the only honest answer when `AGENT_MODEL_TIERS` can change it without a deploy
- earnings come from the profit-share ledger

Agents that have never run stay in the picture, dimmed. A roster where half were
never consulted is a finding, and dropping them would hide exactly that — so
`meta.idleCount` names the number rather than leaving a viewer to count dots.

A count in prose goes stale silently: `validate.js` said "at 27 agents" from
before the Devil's Advocate was added, and three comments in `agentRunner.js`
still said twenty-one. Those are corrected, and one test now pins the real total
so the next roster change has to update it deliberately rather than leaving the
prose quietly wrong.

### Encoding

Hue is department — six of them now, the sixth added for the Studio and the
whole set re-validated rather than eyeballed — assigned in fixed order from a
palette checked for lightness, chroma, colourblind separation and contrast
against this surface.
Two things deliberately avoid becoming a sixth and seventh hue: **a ring** means
the agent cannot leave Anthropic because it uses a server tool (the first
question the picture prompts is "why is that one still expensive"), and
**dimming** means never consulted. Every structurally important node is directly
labelled, so identity never rests on colour alone.

The view fits itself to the screen on load, including the width of the labels —
fitting to node positions alone puts half the roster off the side of a phone
while every dot sits comfortably inside.

### Two views, one payload

`Graph` and `Office` toggle on the same page. Nothing is re-fetched when you
switch, because nothing about the company differs between them — they are two
projections of one `/api/graph` response, not two features.

The graph answers *who reports to whom, and where did this morning's question
travel*. The office answers *who is at their desk*: twenty-eight desks on two
floors, the monitor lit only for an agent that actually ran, the root at the
head of its floor. Same hues, same ring for the agents pinned to Anthropic, so
the two views never disagree.

Two things about the isometric layout are worth knowing, because both were
wrong first:

- **Rows step `+1` in x and `−1` in y.** `isoY` depends on `x + y`, so holding
  that constant keeps a row level on screen while `isoX` — which depends on
  `x − y` — marches it to the right. Laying a row out along x alone makes it run
  diagonally, and twenty-eight desks collapse into a thin band across one corner.
- **Nameplates are staggered by column.** They are far wider than the desks they
  label, so column pitch is set by the text, and alternating columns sit higher
  so two long titles side by side still cannot collide.

The office also has wall space the graph does not, so the payload carries
company-level state next to the per-agent state: tasks done, running, queued and
failed; today's spend against the cap; active ventures.

### Opening it from a phone

`GRAPH` on WhatsApp returns a link. The mechanism is the interesting part.

A browser following a link sends no custom headers, so the app's bearer token is
useless here. The obvious fix is `?token=…`, and this repo's own
`api-authentication` skill spends a paragraph on why not: a URL is logged by the
web server, the proxy, the CDN, the browser history and every error tracker in
between. Writing that down and then doing it anyway would be worse than never
writing it.

So the token rides in the **fragment** — `/graph#t=…`. Fragments are never sent
to the server, so it appears in no request line and no access log; the page reads
it from `location.hash` and presents it as a normal `Authorization` header on its
own fetch. Two further properties follow from the same reasoning: it **expires**
(a WhatsApp message gets forwarded, screenshotted and backed up, so a permanent
link is a credential in a chat log), and it is **derived from** `APP_ACCESS_TOKEN`
rather than being it, so a leaked view link opens one read-only view and cannot
be replayed against the mutating API.

`/graph` itself is public and contains no company data — it is an empty shell.
`/api/graph` is in `SELF_AUTHENTICATED_PATHS`, a set kept deliberately separate
from `PUBLIC_PATHS` so that a reader scanning for what is unauthenticated never
finds a path there that is in fact authenticated by other means.

Set `PUBLIC_URL` (or let Railway set `RAILWAY_PUBLIC_DOMAIN`) for the link to be
a link rather than a path; `VIEW_TOKEN_TTL_MINUTES` changes the 30-minute
default.

### The unattended cycle could deploy but not read

The daily cycle wired five action handlers against a roster that defines
twenty-one. The Engineering Lead has twelve tools and exactly one of them —
`deploy_code` — worked there. Every morning it could commit code to a real repo
and could not read that repo, claim a task, run the checks, or check whether the
deployed service answered. All of those returned "Unknown tool".

The outage was not the expensive part. The expensive part was that it looked
like an environment fault from the inside: the CTO reported "repo/task tools are
erroring on every call", called it distinct from an earlier access problem, and
recommended retrying next turn — which would have produced the identical failure
every morning indefinitely. An absent capability read as a transient one, and
nothing in the system could have told it otherwise.

Two of the gaps were newly self-inflicted: `list_repo_files` and `check_service`
were wired into `index.js` and not here, so the interactive path gained
capabilities the unattended one did not.

`dailyCycleActionHandlers()` now serves seventeen, and `BARRED_UNATTENDED` names
the six that are refused along with the reason each needs a founder:
`log_revenue`, `log_expense` and `report_milestone_progress` assert real-world
outcomes nobody is reporting at 08:00; `kill_venture` ends a venture;
`link_venture_repo` grants scope, and an agent widening its own allowlist would
make every other guardrail decorative; `propose_venture` belongs to the Studio
phase.

The split is about what a tool needs from the founder, not how risky it sounds.
Reading a repo, claiming a task and running CI have no external effect the
founder has not already sanctioned — and a cycle permitted to deploy but not to
verify is worse than one permitted to do neither, because it produces confident
status reports with nothing behind them.

#### The structural fix

Nothing connected the org chart to the handler map, which is why it drifted
silently as tools were added over weeks. `dailyCycleParity.test.js` is that
link: a tool on any agent must be wired or named as barred, and doing neither
fails the suite at the moment the tool is added rather than at 08:00 six weeks
later. It also refuses a barred entry for a tool no agent has, so the list
cannot come to read as more considered than it is.

This was the fourth capability in this codebase found behind a door nothing
opened, after `readFile`, `stalledTasks` and the missing DeepSeek dispatch
branch. It is the first one with a test that would have caught it.

### Orchestrators are no longer locked to Anthropic

Ten of the twenty-two agents — the whole C-suite, plus the Engineering Lead and
the other action-holders — ran on `claude-sonnet-5` and could not be moved. Not
because they needed Claude, but because `canUseAlternativeModel` refused any
agent with reports or actions, and it refused them for a good reason: the other
provider clients were plain completion calls with no tool loop, so an
orchestrator routed to one would have silently lost the ability to delegate. A
vague answer rather than an error, which is far worse than a bigger bill.

So the company's bill was Anthropic-shaped by accident of plumbing.

Two new modules change that, and neither touches the loop in `agentRunner`:

- **`agents/toolTranslation.js`** converts tool use between the Anthropic shape
  this app speaks and the OpenAI shape the other three speak. Tool definitions
  (`input_schema` → `parameters`), assistant tool calls (`tool_use` blocks →
  `tool_calls` with JSON-string arguments), and results — which is the
  structural one: Anthropic puts every result for a round inside **one** user
  message, OpenAI wants **one message per result** naming its `tool_call_id`.
  Getting that wrong produces a provider error about an unanswered tool call
  that points nowhere near the cause.
- **`agents/openaiCompatible.js`** is the single HTTP call all four providers
  now share. They each had a near-identical copy, which was tolerable while the
  only shape was "prompt in, text out" and stopped being tolerable the moment
  tool calling had to exist in all of them: four copies of a translation is four
  places for the `tool_call_id` handling to drift. `deepseek.js` had predicted
  exactly this moment in a comment — *"when a fourth arrives, that is the moment
  to extract, not before"* — and a fourth arrived.

Gemini moved to Google's **OpenAI-compatible** endpoint as part of this. Native
Gemini has function calling, but in its own vocabulary (`functionDeclarations`,
`functionCall`, `functionResponse`, a `parts` array), so supporting it natively
would have meant a second translation layer kept in step with the first forever.
`listModelsUrl` still points at the native API, which the integration probe uses.

`canUseAlternativeModel` now enforces exactly one rule: **no Anthropic server
tools.** `web_search` executes inside Anthropic's own infrastructure, so there
is nothing to translate and no variable that can move it — which leaves the
Solutions Architect and the SEO Specialist on Anthropic, and frees the other
twenty.

#### Possible is not default

The C-suite still runs on `claude-sonnet-5` after this change. `defaultTierFor`
distinguishes *bounded* (a leaf, which defaults cheap) from *possible* (anything
without a server tool), because conflating them would have re-homed the
company's decision-making on the next deploy because a gate was relaxed. Moving
the agent that decides what the company does is a decision to make deliberately
and then check the results of:

```
AGENT_MODEL_TIERS="ceo:reasoner,cto:reasoner,cfo:analyst,cmo:analyst,coo:reasoner"
```

#### The bug this surfaced

`createMessage` dispatched providers through a chain of `if` statements with no
branch for DeepSeek. The tier existed, `resolveModelForAgent` returned it, and
every call it resolved **fell through to Anthropic** — silently, on the wrong
model, at roughly 7x the price, with nothing reporting it. DeepSeek had only ever
been reachable as a backup.

That is the third capability in this codebase found sitting behind a door
nothing opened (after `readFile`, `run_checks`, and `stalledTasks`). The
dispatch is now a lookup table that throws on an unknown provider rather than a
chain that quietly picks one.

The old "(Answering without the team…)" note on a failed-over orchestrator is
gone too: the backups carry tools now, so it was telling the founder something
untrue. The provider swap is still visible in `SPEND` through `recordFallback`.

### The morning sync is now proportional to what moved

The largest single line item in the company's bill was a prompt instruction:

> Consult each of your direct reports (CTO, CFO, CMO, COO). Ask each of them to
> check in with their own team first.

That reaches 22 agents and costs a minimum of 27 Anthropic calls, plus the
Studio phase after it — and it ran identically on a day with three commits and a
day with nothing at all. On a dead day that spend does not buy better judgement:
it asks 22 agents for "one real, specific data point" about a company that did
nothing, and an agent asked for an observation it does not have will generally
produce one anyway. That is the failure `diagnosing-a-blocker` exists for, bought
daily at full price.

`server/movement.js` answers what actually moved, from the records of real
events: commits, customer emails, finished or failed tasks, newly queued tasks,
failing CI runs, a service probe that came back badly, ledger entries, ventures
started or killed. On a quiet morning the sync goes narrow — one CEO call, no
Studio phase — and the report says why it was short, so a one-line report does
not read as a failure.

Three things make this safe rather than merely cheap:

- **The narrow sync cannot fan out.** `soloRoster` hands `runAgent` a CEO with
  `reports: []`, so no `consult_*` tool is built and the delegation is
  structurally impossible. Every instruction in this codebase that was only a
  request has eventually been ignored by some turn; this one guards the biggest
  number in the bill.
- **The thresholds are deliberately generous.** A pending plan, an approved
  plan, or any real event forces the wide sync. Being wrong in the narrow
  direction means a real event goes unexamined, which costs more than the calls
  it saved. Writing this also surfaced that the plan check would have been dead
  code — `getPlan()` returns the plan itself, not a container keyed by status,
  so the original `plan?.pending` was always undefined and would have sent the
  company narrow on exactly the mornings it should look wide.
- **A quiet stretch still gets a full sync every `FULL_SYNC_MAX_GAP_DAYS`**
  (default 7). A company that goes permanently silent because nothing tripped a
  counter is the obvious way this change could go wrong, and "nothing changed"
  is exactly the state a wider look is most likely to have something to say
  about.

The quiet kickoff is not a shorter version of the same questions. It asks three:
confirm the company is quiet and for how long, name the single thing most worth
doing about that, and say what it is blocked on. A quiet week is information —
either the team is blocked on something the founder has not given them, or the
queued work is not work anyone actually wants done — and one honest line about
that is worth more than four manufactured status lines.

### A missing tier meant the frontier model, silently

`resolveModelForAgent` used to fall back to `DEFAULT_TIER` when an agent had no
`modelTier`. Two leaf agents — the Agent Operations Engineer and the Automation
Architect — had therefore been running on `claude-sonnet-5` for weeks at roughly
15x the necessary cost, looking exactly like every correctly-tagged agent from
the outside. Nothing reported it because nothing was wrong: a missing field read
as a deliberate default.

An untiered **leaf** now falls to the cheap tier instead. A forgotten field
costs quality rather than money, which is the better failure here —
`canUseAlternativeModel` has already established the agent needs no tools, every
leaf on the roster was deliberately cheap anyway, and `AGENT_MODEL_TIERS` moves
any single agent back without a deploy. An untiered orchestrator still gets the
default model, because it genuinely needs one.

One consequence worth naming: a run's total token count no longer has a
single price. `usage.js` therefore accumulates `costUsd` **at the point of
each call**, where the model is known, rather than multiplying one rate over
the total afterward. Daily reports saved before this existed carry tokens but
no `costUsd`; those are still priced at the default rate rather than dropped,
so historical costs don't silently read $0.00.

## A behavioral eval, not just data-layer tests

`server/test/` checks the data layer (ledger math, venture state
transitions) — none of it checks whether an agent's actual *judgment* is
any good, so a prompt change could quietly make the CFO worse at refusing
to record a milestone that hasn't happened and nothing would catch it.
`server/eval/` is a starter behavioral eval: 10 scenarios
(`scenarios.js`) run against the real org chart and real action handlers
via `server/eval/runner.mjs`, each targeting one judgment call — does the
CFO record a milestone the founder reports as genuinely shipped, and
correctly refuse to record one that's still just a plan; does the
Validation Critic flag a lifestyle idea as too small without also
flagging a genuinely large one; does the Venture Partner notice a pitch
resembles something already killed (exercising the `pastLessons` context
from earlier in this doc); does the CEO kill a venture on a clear reason
but not on vague doubt alone.

Most grades read real end state (did the milestone's status actually
change, did the ledger's net actually move) rather than parsing the reply text,
following the same principle as the Daily Cycle's own action handlers:
trust what actually happened over what was said. It reuses the
`JARVIS_DATA_DIR` isolation the unit tests already use, so it never
touches real `server/data/`, and it's deliberately named so `node --test`
never picks it up — an eval run makes real, billed API calls, which a CI
run without a key should never trigger by accident. See
`server/eval/README.md` for how to run it and how to extend it — it's a
first 10 cases, not a finished eval.

## A weekly reflection pass, so the same pattern doesn't repeat silently

The daily cycle and `buildPastLessonsContext()` both give the Studio a
memory of what's already been *killed*, but nothing looked back over a
week of daily reports to ask a harder question: of everything flagged as
worth pursuing, what actually got followed up on, and what quietly never
went anywhere? Without that, a real pattern — an opportunity type that
keeps getting flagged and dropped, a class of proposal that keeps
stalling at the same stage — never surfaces; each day's cycle only ever
sees itself.

`server/weeklyReflection.js` runs once a week, reading the last seven
days of saved daily reports (`reportsInWeek()`, a Monday-through-Sunday
window ending on the current `weekKey()`) plus the real, current
venture/ledger state, and asks the same root agent (`COMPANY_ROOT`) to
render a verdict: which flagged opportunities got real follow-up this
week versus which were mentioned once and dropped, and how the proposals
that did get made are actually doing. It's read-only by construction —
`actionHandlers: {}` — the same guarantee the daily cycle's own studio
phase relies on: a weekly reflection can look at everything and say
anything, but it can't move money, start or kill a venture, or touch the
ledger. `server/weeklyReflections.js` stores the result the same way
`dailyReports.js` stores daily ones, keyed by `weekEnding` so re-running
mid-week overwrites rather than duplicates.

The reflection then feeds back into the same context every ideation
session already reads: `buildWeeklyReflectionContext()` in
`server/finance/context.js` surfaces the latest reflection (or says
plainly that none has run yet), and `buildStudioContext()` now joins it
alongside the business and past-lessons context. The `venture_partner`
prompt in `server/agents/ideationTeam.js` is updated to actually treat it
as an input rather than a formality — told explicitly to let a named
pattern change what it pitches today rather than starting cold every
session, the same way it's already told to check `pastLessons` before
running with an idea.

`server/weeklyScheduler.js` mirrors `scheduler.js`'s self-rescheduling
`setTimeout` approach, targeting **Sunday 01:30 UTC** — 30 minutes after
the daily cycle's own 01:00 UTC slot, so a week's final daily report has
already landed before the reflection reads it. The catch-up logic uses
the same date-keyed check `hasReflectionForThisWeek()` relies on
(`weekKey(now)`) rather than a separate day-of-week test, so a server
that restarts mid-week after missing Sunday entirely still catches up
correctly instead of waiting for the following Sunday. Like the daily
cycle, it's skipped without `ANTHROPIC_API_KEY` and can be disabled with
`WEEKLY_REFLECTION_DISABLED=true`.

It shows up the same two ways the daily report does: an email
(`sendWeeklyReflectionEmail`, gated by the same `SMTP_HOST` +
`REPORT_EMAIL_TO` opt-in, with its own cost/duration line) and a section
in the Daily Report tab (`client/src/components/DailyReportView.jsx`,
above the daily sections, with its own "run now" button hitting
`POST /api/reports/weekly/run`) — so the founder sees the pattern, not
just this week's individual entries, without having to read seven days
of reports back to back to notice it themselves.

## Real code deployment: the first action that leaves the simulation

Everything above — revenue, expenses, milestones, kills, even the weekly
reflection — happens entirely inside this app's own data files. Nothing
touched a real, external system, so the worst-case blast radius of any
mistake was always "the numbers in `server/data/` are wrong." Real code
deployment is the first capability that doesn't have that property: the
Engineering Lead can now make an actual, permanent, publicly-visible commit
to a real GitHub repo. Getting that guardrail right mattered more than
getting it done fast.

The model isn't a per-deploy approval gate — asking the founder to sign off
on every commit would just be a slower way to do what the founder could do
themselves, not a new capability. Instead, the founder grants a bounded **scope** once per
venture, and every deploy inside that scope runs without asking again:

- **`linkRepo(id, { owner, name, branch, allowedPaths, maxPerWeek })`**
  (`server/finance/ventures.js`) points a venture at a real repo the
  founder already created — this app never creates a repo on its own — and
  sets an allowlist of paths the agent may touch (e.g. `content/`, a single
  config file) plus a weekly commit cap.
- **`setDeploymentEnabled(id, true)`** is the actual grant: a repo can be
  linked but left disabled indefinitely, e.g. while the founder reviews the
  scope before switching it on.
- **`authorizeDeployment(id, { path })`** is the enforcement point every
  real deploy passes through: venture must be active, a repo must be
  linked and enabled, the path must fall inside `allowedPaths`, and the
  venture must be under its `maxPerWeek` cap (computed from its own
  `deployments` log, not a separate counter that could drift). Any
  violation throws a specific, readable reason rather than silently
  narrowing the request.

`server/deploy/github.js` is the actual mechanism: a thin wrapper around
GitHub's Contents API that commits one file at a time (`commitFile()`),
guarded entirely by whether `GITHUB_TOKEN` is configured
(`isGithubConfigured()`). It's deliberately minimal — one file, one commit,
no repo creation, no shell/build execution — the scope this app grants is
"edit specific files in a specific, already-existing repo," not "run
arbitrary code on real infrastructure." If the target repo already has
CI/CD wired to that branch (Vercel or Railway auto-deploying on push, say),
this commit *is* the deploy; if not, it's still a real, permanent change to
a real repo, which is exactly the escalation this feature is about.

The Engineering Lead (`server/agents/orgChart.js`) is the one agent with
the `deploy_code` action tool — the natural owner, since "ships code" is
already their mission. `handleDeployCode`
(`server/actionHandlers.js`) validates input, calls `authorizeDeployment`,
commits via `deploy/github.js`, records the result with
`recordDeployment()`, and emails the founder immediately
(`sendDeploymentEmail` in `server/email.js`) — this is the one alert in the
app reporting something that already happened to a real system rather than
a pending decision, since there's nothing left to approve or deny after
the fact.

`deploy_code` is wired into the interactive Executive Team chat
(`runCompanyTurn` in `server/index.js`) and into the autonomous daily
leadership sync (`dailyMeeting.js`) — see "Full autonomy" below for why
the daily cycle earned that trust while the weekly reflection and every
other book-keeping/venture action still haven't.

### Seeing the repo, and seeing the deployed service

Two capabilities that turn out to be about the same thing: whether the team
is working from evidence or from memory.

**`list_repo_files`** returns every path in the venture's repo in one call
(`listFiles` in `server/deploy/github.js`, via the git trees API). Before it,
`read_repo_file` could answer "what is in this file" and nothing could answer
"what files are there" — so a guessed path came back as "that file does not
exist", and an agent acting on that writes the file fresh on top of a working
version sitting under a slightly different name. That is the same shape as
every confident wrong diagnosis this company has produced: an absent
observation promoted to a cause. The listing deliberately keeps three states
apart that a single failed read cannot — files present, no commits yet, and no
such branch — because the last two lead to opposite next actions.

**`check_service`** makes a real HTTP GET against the venture's deployed
service and reports what came back (`server/execute/probe.js`). `run_checks`
proves the tests passed inside a GitHub runner; it says nothing about whether
the service is deployed, whether the container booted, whether its environment
variables are set, or whether the promised route exists. Those fail
independently, and **green CI with a dead service** was invisible to a company
whose only product is an HTTP API — the gap that made `reporting-status`
structurally unfixable, since no tool could close it.

The probe distinguishes the two failures that matter: **no response at all**
(nothing listening — a deployment problem) from **a 500** (something is
listening and the code is broken — a different problem, in a different place).
Conflating them is how an afternoon goes into DNS over a missing environment
variable.

**The agent cannot choose the host.** An outbound GET with an agent-supplied
URL is a server-side request forgery primitive — reachable targets include the
platform's metadata service, which hands out credentials over plain HTTP to
anything that asks. So the origin is a founder-granted scope like every other:
`setServiceUrl(id, url)` stores one validated https origin on the venture, the
agent passes only a path, and a path that resolves away from that origin is
refused rather than followed. `assertProbeableUrl` also rejects http, IP
literals, credentials in the URL, single-label hosts, and the `.internal` /
`.local` / `localhost` families — both when the URL is set and again before
every probe, since a stored value can predate a rule that got stricter.
Redirects are reported, never followed.

Unlike a deploy or an email, the probe is **not** in the daily plan: plan
approval covers things that change the world, and putting the evidence that
the last commit worked behind the same door as the commit is how this codebase
has repeatedly ended up with a capability nobody could reach. It is still
gated on the kill switch, because "HALT means nothing leaves this server" is a
promise worth keeping whole, and rate-limited to six checks a minute per
venture — checking your work often is the behaviour to encourage; a retry loop
hammering the venture's own service for the same answer is not.

The founder grants it from WhatsApp: `URL <ventureId> <https://...>`, and
`URL CLEAR <ventureId>` to revoke. `VENTURES` shows a missing service URL
explicitly rather than leaving it to be inferred.

The Ventures panel (`client/src/components/VenturesPanel.jsx`) is where
the scope is actually granted: a form to link a repo (owner, name, branch,
allowed paths, weekly cap), an enable/disable toggle, and a running log of
every real deployment — timestamp, path, commit message, and a link to the
actual commit — so the founder can audit exactly what an agent has shipped
without leaving the app.

## Real customer email: the second action that leaves the simulation

Same escalation as real code deployment, applied to an actual outbound
message instead of a commit: the Sales & Commercial Manager can send a
real email to a real prospect or customer. It reuses the exact same
scope-grant shape proven out by deployment, because the two actions share
the same underlying question — "what's the smallest bounded box a founder
can hand an agent so it can act without asking every time?" — and that
box looks the same whether the real thing on the other side is a repo or
an inbox.

- **`linkOutreachScope(id, { allowedRecipients, maxPerWeek })`**
  (`server/finance/ventures.js`) sets an allowlist of who a venture is
  allowed to email — an exact address (`jane@acme.com`) or a whole domain
  via a leading `@` (`@acme.com`) — plus a weekly send cap.
- **`setOutreachEnabled(id, true)`** is the actual grant, kept as a
  separate step from linking so the founder can review the recipient list
  before switching it on — same two-step shape as deployment.
- **`authorizeOutreach(id, { to })`** is the enforcement point: venture
  must be active, a scope must be set up and enabled, the recipient must
  match the allowlist, and the venture must be under its `maxPerWeek` cap
  (computed from its own `sentEmails` log). Any violation throws a
  specific reason rather than silently dropping the message.

No new external service is needed — `server/email.js` already has a
working SMTP transport for founder notifications (the daily report, new
venture and real-action alerts). `sendCustomerEmail(to, subject, body)` is the
same `sendEmail()` used everywhere else, just given a real recipient
address instead of defaulting to `REPORT_EMAIL_TO`; `isEmailConfigured()`
exposes the same `SMTP_HOST` + `REPORT_EMAIL_TO` gate every other email in
this app already depends on, so there's no separate "is outreach enabled"
server config to set up beyond the per-venture scope. If SMTP was never
configured, this capability is simply unavailable — same fail-closed
behavior as `deploy_code` without `GITHUB_TOKEN`.

`handleSendCustomerEmail` (`server/actionHandlers.js`) checks
configuration and input first, then `authorizeOutreach`, then sends via
`sendCustomerEmail`, then `recordOutreach()`s the result and immediately
emails the founder an audit copy (`sendOutreachAlertEmail`) — recipient
and subject, not the full body, enough to know what went out without
duplicating the whole message. Like the deployment alert, this reports
something that already happened; there's nothing left to approve.

`send_customer_email` follows the identical wiring rule as `deploy_code`:
it's on the Sales & Commercial Manager, reachable from the interactive
Executive Team chat and the autonomous daily leadership sync — see "Full
autonomy" below.

The Ventures panel shows this scope right below the deployment one: set
allowed recipients and a weekly cap, flip outreach on or off, and see a
running log of every real email actually sent — timestamp, recipient, and
subject — the same audit-first pattern as the deployment log.

## Full autonomy: letting the daily cycle act, not just recommend

For a while, this app drew its autonomy boundary at "a human is in the
room": `deploy_code` and `send_customer_email` worked without a
per-action approval click, but only inside a live conversation the
founder was actually having. The daily and weekly cycles stayed
read-only — able to analyze and recommend, never to act on a real
external system.

That boundary has moved, deliberately and only this far: **the daily
leadership sync can now call `deploy_code` and `send_customer_email` too**
(`dailyMeeting.js`), with nobody watching it happen. The weekly reflection
still can't — it stays a pure retrospective, `actionHandlers: {}`, on
purpose (see `weeklyReflection.js`'s file header) — and every other
book-keeping/venture action (`log_revenue`, `log_expense`,
`report_milestone_progress`, `kill_venture`) is still
not wired into either autonomous cycle, because those specifically depend
on the founder having personally reported a real-world outcome; nobody
reports anything to an unattended run, so there's nothing genuine for them
to log.

The reasoning for singling out these two: unlike a logged expense or a
milestone update, `deploy_code` and `send_customer_email` don't need the
founder to say what happened — they act inside a scope (a linked repo, an
outreach allowlist) the founder already granted *in advance*, specifically
so an agent could act without asking again. That grant doesn't distinguish
between "while I'm watching" and "while I'm not" — a founder who links a
repo and flips deployments on has already decided the path allowlist and
weekly cap are enough of a leash, regardless of who's in the room when a
commit happens to land. Enabling a venture's scope now means both at
once: the same toggle in the Ventures panel governs interactive use and
the daily cycle, so a founder reviewing that switch should read "enabled"
as "this venture can act on this scope with or without me watching,"
not just "during our next conversation."

This makes the existing per-venture guardrails — the path/recipient
allowlist and the weekly cap enforced by `authorizeDeployment` and
`authorizeOutreach` — the only real backstop against a bad autonomous
call, since the human-in-the-room fallback is gone for these two actions.
That's exactly why those enforcement functions live at the data layer
(`server/finance/ventures.js`) rather than as prompt instructions the
model could talk itself out of: a venture with no scope granted, or scope
left disabled, still can't be touched by either action, in either cycle,
no matter what an agent decides to try. The alert emails
(`sendDeploymentEmail`, `sendOutreachAlertEmail`) matter more now than
they did before — they're no longer a courtesy copy of something the
founder just watched happen, but the actual mechanism by which an
unattended real action becomes visible at all.

`server/test/dailyMeeting.test.js` exercises this directly with a scripted
fake Anthropic client (no real model call, no real network): one test
proves a `deploy_code` call from the leadership sync's delegation tree
lands as a real, recorded deployment when a venture's scope is enabled;
another proves the same for `send_customer_email`; a third proves
`log_revenue` still resolves as an unknown tool there, confirming the
boundary didn't quietly widen further than intended.

## Knowing who was watching: `triggeredBy` on every real action

Once `deploy_code` and `send_customer_email` could fire from two different
places, the deployment and outreach logs had a gap: a log entry recorded
*what* happened but not whether a founder was actually present when it
did. That distinction is now the single most useful fact about any real
action in this app, so it's recorded directly rather than left to infer
from context.

`recordDeployment()` and `recordOutreach()` (`server/finance/ventures.js`)
both take a `triggeredBy` field, normalized to exactly `'interactive'` or
`'daily_cycle'` — anything else collapses to `'interactive'` rather than
storing an unrecognized value. `handleDeployCode` and
`handleSendCustomerEmail` (`server/actionHandlers.js`) accept it as a
second argument the model never sets and never sees; it's supplied by
whichever caller wires the handler in — `index.js`'s interactive chat
passes `'interactive'`, `dailyMeeting.js`'s leadership sync passes
`'daily_cycle'` — so the tag reflects which code path actually ran, not
something an agent could get wrong by describing its own actions
inaccurately.

It surfaces in both places a founder would look: the alert email
(`describeTrigger()` in `server/email.js` renders it as a plain sentence —
"a live Executive Team conversation" or "the unattended daily leadership
sync — nobody was watching when this happened") and the Ventures panel's
deployment/outreach logs, where a `daily_cycle` entry gets a visible
"unattended daily cycle" tag next to it
(`client/src/components/VenturesPanel.jsx`) rather than looking identical
to one from a live conversation. Nothing about this changes what's
allowed to happen — `authorizeDeployment` and `authorizeOutreach` enforce
the same scope regardless of the source — it only makes the already-real
consequences of "Full autonomy" (above) something a founder can actually
audit at a glance instead of having to reconstruct from timestamps.

## The stop button and the spend ceiling

A comparison against how real autonomous deployments are actually run
(Anthropic's Project Vend and Project Deal, Cognition's Devin, Sierra and
Decagon, and current agent-governance practice) turned up two gaps that
mattered more than anything else once unattended real actions shipped:
there was no single way to stop everything, and every limit in the app
counted *actions* while the runaway-cost failure mode happens in the model
calls *between* them.

**One halt, not a tour of settings pages.** `server/killSwitch.js` is the
single control that overrides every venture's scope at once. It has two
deliberately different strengths: a stored halt flipped at runtime from the
Ventures panel, which takes effect on the very next authorization check with
no restart (the point, when something is already going wrong), and
`REAL_ACTIONS_DISABLED=true` on the server, which halts everything and
*cannot* be lifted from the app — for when the deployed instance should be
incapable of real-world action until a human changes the environment and
restarts it. `assertRealActionsAllowed()` is called at the top of both
`authorizeDeployment` and `authorizeOutreach`, so the halt applies to
interactive chat and the unattended daily cycle identically, and nothing
added later can route around it by forgetting to check. It's checked before
the per-venture rules, so a halted agent is told "everything is stopped"
rather than whichever scope rule it would have hit next.

**A dollar ceiling where the money is actually spent.** `usage.js` already
converted tokens to dollars, but only to *report* a number after the fact —
no help against a delegation loop that keeps calling the API because nothing
tells it to stop, and no help from a per-venture action cap either, since
that loop can burn money without ever reaching an action. `server/spend.js`
keeps a UTC-day ledger of real per-call cost, and `agentRunner.js`'s
`createMessage()` — the one function every paid call in this app funnels
through — checks it *before* each request and records the response's real
token cost immediately after. Over the cap, agent runs stop with a plain,
actionable message (surfaced as a 429 rather than a generic 502, since "you
hit your own ceiling" is not "the model is unreachable"). The default is
$5/day, overridable with `DAILY_SPEND_CAP_USD`, and today's spend shows
under the performance figures in the Ventures panel. This is the company's
one genuine budget ceiling — and unlike the seed capital it outlived, it's
enforced in code at the gateway rather than described in a prompt.

**Caps that a single run can't spend all at once.** The weekly cap alone let
one unattended run use a whole week's allowance in a single pass, so both
scopes now also carry a `maxPerDay` (defaulting to **1** — enough for the
daily cycle to act every day, not enough for a bad day to compound) and a
60-second cooldown between real actions on the same venture. The cooldown
catches what a cap structurally can't see: the same agent firing the same
action repeatedly inside one turn because its reasoning looped. All three
limits — weekly, daily, cooldown — are enforced by one shared
`enforceRateLimits()` helper in `server/finance/ventures.js`, so deployment
and outreach can't drift apart in what they allow.

One related cleanup came out of building this: `store.js` now resolves its
data directory per call instead of once at import. It used to be captured
when the module first loaded, which meant a test that set `JARVIS_DATA_DIR`
in a `before()` hook could still be writing to the real `server/data/` —
which is exactly how a test run put fake spend into the real ledger the
first time this was wired up.

## What Sales knows before it writes

The outreach log was write-only. An agent could send a fourth unanswered
follow-up to the same person and have no way to know it, because the record
of the first three only existed somewhere nothing read before drafting.
Project Vend hit the same wall: its agent stopped repeating itself only once
it had a CRM to consult.

Two halves, matching the two kinds of thing worth remembering:

- **History is derived, never duplicated.** `listContacts()`
  (`server/finance/ventures.js`) aggregates the existing `sentEmails` log per
  address — how many, when last, about what — so it can't drift out of sync
  with what was actually sent. Addresses are matched case-insensitively, so
  `Jane@Acme.com` and `jane@acme.com` are one person rather than two
  half-remembered ones.
- **Notes are the part nothing else captures.** `recordContactNote()` stores
  what the agent learned from a reply — asked for pricing, revisit next
  quarter, address bounced — which no amount of re-reading the outbox would
  tell you. Capped at the five most recent per contact: this is working
  memory for the next email, not an archive.

`buildOutreachContext()` (`server/finance/context.js`) puts both in front of
the agent *before* it drafts, which is the only moment where knowing changes
what happens, and `buildCompanyContext()` is what the Executive Team now
gets — the business picture plus contact history. The Venture Studio deliberately still
gets `buildStudioContext()` without it: ideation doesn't send email, and the
contact list would be noise in a brainstorm.

The Sales & Commercial Manager writes those notes itself via
`log_contact_note`. That tool is wired into both the interactive chat and
the unattended daily cycle — safe in the daily cycle for the opposite reason
to `deploy_code` and `send_customer_email`: it has no real-world effect at
all, so it needs no scope grant, no cap, and no kill-switch check. It only
writes into the memory the next draft will read. The Ventures panel shows
the latest note per contact under "What Sales knows", so the founder can see
the same thing the agent will.

## Hearing the answer

`server/email.js` had six ways to send and zero ways to receive. The Sales &
Commercial Manager could write to a real prospect and never learn what they
said back. Every outreach was a broadcast into a room the company could not
hear, which is not a small gap: it is the difference between a mailing list
and a conversation, and a company that cannot hear "yes, tell me more" cannot
close anything.

The tell was that the loop was already closing — through a human. The founder
was reading replies in their own mail client and relaying them into WhatsApp
by hand. That is a person doing an integration's job.

`server/inbox.js` reads the mailbox over IMAP, and `check_replies` on the
Sales & Commercial Manager hands what it finds to the agent. It is wired into
both the interactive chat and the unattended daily cycle, and it belongs in
the cycle more than most things do: a reply that arrives at 9pm should be in
front of the team at 8am, not waiting for someone to notice it.

### The allowlist works in both directions

IMAP credentials open the founder's entire mailbox — bank mail, family,
everything. No agent has any business in most of it, and a system prompt
saying "only read customer replies" is not a control, it is a hope.

So `fetchReplies()` never returns a message from an address this company has
not already emailed. The set of known senders comes from `outreachRecipients()`,
which walks the `sentEmails` log across every venture. The founder's outreach
allowlist — the thing that already decides who the company may write to — is
therefore also the only door to who it may hear from, set once, in one place,
and not widenable by anything an agent says.

One detail there is load-bearing. Known senders are derived from what was
*sent*, not from the allowlist itself. An allowlist entry of `@acme.com`
permits writing to anyone at Acme, but it makes nobody at Acme readable: only
the specific people this company actually wrote to can be heard. The set grows
when the company acts, never when a scope is granted.

The filter also runs inside `fetchReplies()` rather than at the call site. A
function that returns everything and trusts its caller to discard the private
mail is one careless caller away from putting the founder's inbox into a model
context. The narrow return type is the control.

### Unread, not new

A reply is filed against its venture the moment it is seen, and marked read
only when an agent has actually been handed the text. Three consequences:

- A turn that dies halfway through reading its mail does not lose the mail.
- The daily report can say "two replies nobody has read" rather than
  re-listing everything that ever arrived.
- A reply filed by yesterday's cycle and never acted on stays just as loud as
  one that landed a minute ago, which is correct: both are open loops.

Messages are deduped on `messageId`, because the daily cycle runs every
morning over the same lookback window. Filing twice would have the Sales
Manager answer the same prospect twice — precisely the failure the contact log
exists to prevent.

`buildOutreachContext()` shows the unread *count* per venture, not the
bodies. The bodies come through `check_replies`, which marks them read as it
hands them over. Putting them in the shared context too would mean every agent
on every turn carried the same inbox, and nobody would ever be sure whether a
reply had been dealt with.

### Reading what actually arrives

Real replies are not clean text. They arrive base64'd inside a multipart
body, or as HTML only, or quoted-printable — and an agent handed
`PGRpdj5IaSE8L2Rpdj4=` learns nothing. `extractPlainText()` is just enough
MIME to get the text out: prefer `text/plain`, fall back to HTML with tags
stripped, decode both common transfer encodings.

The quoted-printable decoder goes through a `Buffer` rather than
`String.fromCharCode`, because `=C3=A9` is two bytes of UTF-8 and not two
characters. Decoding per character turns `Café` into `CafÃ©` — which is how a
prospect's name ends up mangled in the reply an agent then quotes back at
them. The test caught that; nothing else would have until a customer saw it.

Quoted history is cut before the agent sees it. It is most of a reply by
volume and none of it by information — the agent already knows what it sent —
and leaving it in makes a thread grow quadratically in the context window as
it goes back and forth.

### Configuring it

`IMAP_HOST`, `IMAP_USER`, `IMAP_PASS`, optionally `IMAP_PORT`, `IMAP_SECURE`
and `IMAP_MAILBOX`. Usually the same account as `SMTP_*`; for Gmail it is the
same app password. Leave them blank and the module is inert — `check_replies`
returns the reason rather than failing, and the integration status panel shows
inbound as unconfigured next to outbound, separately, because they are
separate credentials and for most of this company's life only one of them
existed.

## Hands that can do more than one thing

`commitFile` wrote exactly one file per commit, and that quietly decided how
this company could work. A change spanning seven files became seven commits.
A turn that ran out of room at the fourth left the deploy branch holding half
a refactor — pushed, live, on the branch a deploy watches. There was no way to
remove a file, no way to work on a branch, no way to propose a change rather
than land it, and no way to undo one.

The Contents API cannot express any of that. The git data API can: build a
tree, hang a commit off it, move the ref. Same token, same guardrails — a
wider hand, not a wider grant.

Four tools now, and picking between them is most of the judgment:

- **`deploy_code`** — one file. Unchanged.
- **`deploy_changes`** — several files, one commit, all of it or none of it.
  Also the only tool that can delete a file.
- **`open_pull_request`** — real, finished work on a branch, not landed.
- **`revert_commit`** — the undo button.

### Checked once per path

`authorizeDeploymentOfPaths()` runs the full nine-gate `authorizeDeployment()`
once for every path in the commit. Checking only the first would let six files
ride in on the seventh's approval, and writing a bespoke "multi" variant of a
nine-gate authorizer is how two authorizers drift apart until one of them is
wrong. Repeating the rate-limit check is harmless: it reads a log and writes
nothing.

Each path also gets its own entry in the deployment log, so a seven-file
commit counts as seven changes against the founder's caps rather than as one
small thing.

### Fast-forward only

The ref update passes `force: false`. Without it, a stale read followed by a
slow turn silently discards whatever landed in between. "The commit I made an
hour ago is gone" is the single failure that would end the founder's trust in
this entirely, and it costs one field to make impossible.

### A pull request does not need an approved plan

This is the one deliberate hole in the plan gate, and it is the point rather
than an oversight.

A PR is how work gets *proposed*. Requiring a pre-approved daily plan in order
to propose something means the only way to propose is to have already been
approved — which is not a review step, it is a deadlock. It is also a direct
answer to "why is the team constantly blocked": a plan gates what lands, and a
PR is precisely what does not land.

Everything else still applies: the kill switch, an active venture, a linked
and enabled repo, the path allowlist, and its own rate limit. That last part
is separate from the deploy caps on purpose — a team that has to spend its one
daily commit to open a PR will stop opening PRs and go back to committing
straight to the deploy branch, which is the opposite of the intent.

A PR also cannot start CI/CD on the deploy branch, cannot overwrite a file
anyone is running, and is undone by closing a tab. It is the only real-world
write in this app that is reversible by default.

### Undo does not need one either, for a different reason

The paths a revert touches are not the agent's to choose — they are whatever
the commit being undone changed. No plan written this morning could have named
them. Gating on the plan would therefore mean a bad commit stays live until
tomorrow, which inverts what the gate is for: a revert *shrinks* the blast
radius of something this company already did.

Every other gate holds, including the allowlist. A commit that reached outside
the allowed scope cannot be undone through here — correct, because this app
did not make that change.

Reverts do count against the deploy caps, and that is the one place a cap is
doing real work rather than bounding cost: two turns disagreeing about a file
will undo each other forever, and the cap stops the loop at a price the
founder set.

### Plan, then commit

`planRevert()` is split from the commit that applies it. The caller has to
learn from GitHub which paths that commit touched before it can check them
against the allowlist, so the order is: read what the commit did, authorize
against the truth, then write. Authorizing against a claim the agent made
would be authorizing nothing.

A revert is scoped to those paths rather than resetting the branch to the
parent commit. A hard reset would also discard everything that landed
afterwards — a much larger act than "undo that", and not what anyone asking
for an undo means. The tradeoff is real: if a later commit also edited one of
those files, the revert overwrites that later edit. So the handler says so,
every time, in the text the agent reads:

> This put those specific paths back to their state before that commit. If
> anything landed on them since, that work is now overwritten — check before
> moving on.

### Why this was the gap worth closing

The asymmetry mattered more than any individual missing verb. A team that can
commit but cannot un-commit gets more cautious over time, not less — every
change is permanent, so every change deserves another round of deliberation,
and caution of that kind looks exactly like never shipping. The Engineering
Lead's prompt now says the quiet part: *you can undo now, ship accordingly.*

## What is actually stopping you

`deploy_code` passes eleven separate conditions before a commit happens: the
global halt, the daily spend cap, a configured token, an active venture, a
linked repo, an enabled flag, a path allowlist, a weekly cap, a daily cap, a
cooldown, a checks-overdue rule — and above all of those, an approved daily
plan. Every one of them throws.

So an agent that tries to deploy learns exactly one of them per attempt. That
is how this team spent three turns discovering, one refusal at a time, that a
repo had never been enabled.

It is also why the daily report kept saying "blocked" without saying on what.
Nothing in this app could answer "what do you need from me" in a single call,
so the answer came out as a paragraph of guesses — and a guess in a status
report is worse than a blank, because the founder acts on it.

`check_ready` (`server/readiness.js`) reports every gate at once: which are
open, which are shut, and specifically what opens each shut one. It is on the
Engineering Lead and the Sales & Commercial Manager — the two agents that hold
the gated tools — and wired into both the interactive chat and the daily cycle.
It grants nothing, reaches nothing, and costs nothing: it only reads gates that
already existed.

### It reports the open gates too

A list containing only failures reads as "everything is broken" whatever it
actually says. The difference between one shut door and eleven is the
difference between a one-line message to the founder and a strategy
conversation, and a team that can only see its failures cannot tell them apart.

Each shut gate carries a `fix`. "Deployments are not enabled" tells an agent it
is stuck; "the founder turns this on in the Ventures panel" tells it what to
ask for. The report also names `blockedBy` — the first shut gate, the one an
attempt would actually hit — so nobody fixes the third item on the list and
tries again.

Without a `path`, the allowlist gate reports what is allowed rather than
judging a specific file. "What can I touch" is the question that actually
precedes a deploy.

### Shared arithmetic, not copied

`rateLimitState()` and `pathAllowed()` are exported from
`server/finance/ventures.js` and used by both the authorizer and the report.
Re-deriving the caps in a second place would have been quicker and would have
drifted, and a readiness report that disagrees with the gate it describes is
worse than no report at all: a team told it is clear and then refused stops
believing either, and the next thing it does is guess.

### The agreement test

`readiness.test.js` walks a venture through every state it can be in —
nothing set up, repo linked but disabled, fully enabled, halted, killed — and
asserts at each step that `ready` and "the authorizer does not throw" are the
same thing, in both directions.

Verified the way the daily-cycle parity test was: by injecting a divergence
(forcing `ready: true`) and watching the test fail. It does.

### It knows which gates a PR skips

`open_pull_request` and `revert_commit` deliberately do not require an approved
plan, so `check_ready` leaves that gate out when asked about them. That is not
cosmetic: the report is what an agent reads before deciding whether to propose
or to land, and one that hid the difference would send it back to asking
permission for the one thing that does not need it.

## Did anyone use it?

This company measures its own cost to the cent — every model call, every
token, priced and capped — and measured its product's use not at all. That is
the wrong half of the equation to know exactly. A venture with a linked repo, a
green deploy and zero users looked identical, in every view this app had, to
one that was working.

`server/ventureUsage.js` is the receiving end, and it was built deliberately
*before* the venture launches. Usage is the one number that cannot be
backfilled: a request that was not counted when it happened is gone, and "we
had customers that first week but no idea how many" is a permanent hole in the
only evidence that matters.

### Three states, not two

The distinction the whole module exists to preserve:

| State | What it means | What to do |
|---|---|---|
| **Not reporting** | Nothing is counting | Wire it up, or find out why the deployed code isn't calling home |
| **Silent** | Counting, and nobody is calling | A demand or distribution question. Not one more feature |
| **Used** | Real calls from real callers | Now the numbers mean something |

"Not reporting" and "silent" look the same from outside and lead to opposite
next actions — one is an engineering problem, the other is a business one.
Collapsing them sends the team to fix the wrong thing.

That distinction was almost lost to a one-line bug: minting a key creates the
venture's record, so `usageSummary` checking for the object's existence made an
un-instrumented venture read as "counting, and silent". The test caught it.

### A key that can do one thing

Ingest is the first endpoint in this app a machine outside the company calls,
and the only one not authenticated by the founder's app token. A venture's
deployed product holds a per-venture key that can increment that venture's
counters and nothing else. Handing it the app token instead would mean a
compromised product could disable the kill switch.

No agent tool can read the key. The founder mints it from the Ventures panel
and puts it in the venture's own deployment environment; the agent writing that
venture's code writes `os.environ["JARVIS_USAGE_KEY"]`, which needs the
variable's *name* and not its value. An agent that can read a credential is an
agent that can commit one.

### Counters, batched

Per-day counters rather than an event log: a product that succeeds would
outgrow this server's disk in a month, and nothing anyone asks — how many
calls, from how many customers, failing how often — needs the individual rows.
Ninety days kept, so the file stays small forever.

Reports are batched rather than per-request. A product calling this server once
per inbound request would make this server its latency floor and its
availability ceiling, which is an absurd thing to do to a product for the sake
of a counter. The venture accumulates and flushes on its own schedule, and a
flush that fails is dropped without the customer noticing.

The distinct-caller set is capped at 500 per day. It is the one unbounded thing
here, and past the cap the count keeps rising while the identities stop being
recorded — the right thing to lose first.

### In the context, not behind a tool

`buildUsageContext()` puts one line per deployed venture into the shared
business context, with the silent and unmeasured ones sorted first. The agent
most likely to need this number is the one least likely to think of asking for
it, and a week of silence on a deployed product is the most important sentence
in that context — buried under a table of zeros, it gets skimmed past.

`check_usage` on the CFO and the Engineering Lead gives the detail on demand.
Zero calls comes back as a finding, in those words: *silence is a finding, not
a gap in the data.*

## READY: the founder's half of the same question

`check_ready` answered "what is actually stopping you" for the agents. The
founder — who had asked that exact question, in those words, about why the team
was constantly blocked — could not reach it. `VENTURES` says what a venture is
*allowed* to do; nothing said what was stopping it right now.

`READY [ventureId]` on WhatsApp closes that. `BLOCKED` is the same command,
because that is the other word someone types at 7am.

Not `WHY`. A bare "why" is ordinary prose far more often than it is a command,
and hijacking it would swallow a real question meant for the team — the exact
failure that requiring a `v_` id in the other commands exists to prevent.

### Two audiences, two shapes

`formatReadiness` shows the open gates deliberately: an agent handed only
failures reads "everything is broken" whatever the text says, and the
difference between one shut door and eleven changes what it does next.

None of that transfers to the founder. They are not going to conclude the
company is broken — they asked one question, and a twelve-line audit with two
lines of signal does not answer it on a phone, it gets scrolled. So
`formatReadinessBrief` drops every gate that already passes and leads with
what they can type.

### What they can type, not what they must do

Each gate now carries a `founderCommand` alongside its `fix`. "Turn it on in
the Ventures panel" is a task; `DEPLOY ON v_123` is done before the phone goes
back in a pocket.

Only the gates a founder can genuinely open from a message carry one. A missing
`GITHUB_TOKEN` is a Railway variable, and pretending otherwise would be worse
than saying nothing — so those are still listed, under a heading that says they
are not a message.

A test asserts that every `founderCommand` the report suggests is one
`parseFounderCommand` actually accepts. A report that tells the founder to send
something the parser rejects is worse than one that stays quiet: they send it,
nothing happens, and they stop trusting the report.

## The €1M gap, applied

The deep-research assessment (September 2026) found the company ahead of most
enterprise agent programmes on governance and behind every startup that ever
reached a million on everything commercial: no way to take money, no price in
code, no lawful basis for the emails it was built to send, no loop that fed
what it measured back into what it did. This section is what closed.

### Money in

`server/payments.js` speaks to Stripe over plain fetch — the same reason the
GitHub client does. `create_payment_link` on the Sales Manager makes a Checkout
Session from the price on record and the customer's expected volume; an amount
the agent made up is Project Vend's discount problem with extra steps, so the
amount is derived unless the founder agreed a specific figure.

`POST /api/payments/webhook` is the first endpoint here whose caller is a
payment processor. It verifies Stripe's signature over the raw body (stronger
than the bearer check, not weaker), books the payment to the ledger, moves the
payer to the `paying` stage, credits the agent that created the link, and tells
the founder. Idempotent on event id: Stripe retries, and booking a payment
twice is worse than missing it once.

### Price, in code

`PRICE v_123 149 0.02 page` puts a hybrid price on the venture record — a
monthly floor plus a per-unit rate, which is what the vertical-AI cohort
converged on while accuracy was still being proven. `monthlyValue()` is the
number the CFO could not compute before: the prospect who asked about 50,000
pages is worth €1,149 a month, and a million is 73 of her.

### The law around the emails

`server/outreachCompliance.js`. Every outbound message now ends with an
AI-authorship disclosure (EU AI Act Article 50, in force since 2 August 2026)
and an opt-out line, appended by the handler after the draft so no message
leaves without them however it was written.

An "unsubscribe" in any reply blocks the address before an agent reads it. A
blocked address cannot be emailed by any agent; only the founder lifts it. The
allowlist says who may be written to. The block says who refused. The person
wins.

German and Italian addresses — jurisdictions where B2B cold email needs prior
consent in practice — are refused unless `CONSENT v_123 email` has recorded
it. Matched on top-level domain, which is a known limit and why `BLOCK` exists
by hand. `LEGITIMATE_INTEREST_ASSESSMENT.md` at the repo root is the document
the founder completes and signs; the code cannot do that part and says so.

### The supervisor's tool

In Project Vend the change that made the shop profitable was a CEO agent with
an objectives tool that vetoed bad discounts. This company had the CEO and not
the tool. `set_objective` writes one measurable objective per venture, in the
outcome the customer pays for, and every agent sees the open ones in context
before the task list. `PIPELINE` shows them to the founder next to the deals.

### The loops

**The eval is kept.** `server/evalRuns.js` stores every run; the runner now
prints the agent beside each scenario so a failure has a role. The weekly
reflection opens with the latest failures and is asked, per failure, what the
agent did instead and what would fix it — Ng's error analysis, which nothing
else in the company performed. The eval runs itself every Sunday after the
reflection (`EVAL_WEEKLY=false` to stop), and the knowledge pages compile
after that.

**A reply wakes one agent.** `server/inboxWatch.js` polls the mailbox every
fifteen minutes (`INBOX_POLL_MINUTES`) and, when a known contact writes, runs
one narrow Sales turn — the Sales Manager alone, with only the tools a reply
needs, on a four-minute deadline. An unsubscribe wakes nobody and blocks the
address. A same-day reply is most of what closes a first deal, and the daily
cycle left prospects unread for 23 hours.

**Knowledge that compiles.** `server/workspace/knowledge.js` has the CEO
rewrite one page per active venture each week — what it is, where it stands,
what was learned and on what evidence, what is believed but untested, what
contradicts what. Published to the vault under `Company/Knowledge/` and kept
locally so the shared context actually contains it. A wiki nobody reads is a
diary.

### The register and the trace

Every graph node now carries `realActions` — the tools whose effect leaves
this server — and `evalPassRate` from the latest run, null for an agent no
scenario exercises. That null is the finding: an agent with no eval is an
agent whose judgment nobody has measured.

The runner records every action-tool call in the trace beside the delegations,
with the tool, the agent, whether the handler refused, and how long it took.
"Why did the team do that" now has an answer after the fact.

### Outcomes and economics

Usage reports carry `outcomes` — pages processed, documents extracted — the
unit the customer pays for and the number objectives are written in. Calls are
activity; outcomes are what the activity was for. `buildEconomicsContext()`
relates thirty days of model spend to revenue and paying customers, and says
nothing until there is revenue, then one line: above 1.0 per unit, the company
loses money on every sale.

### The studio gate

`propose_venture` refuses while an active venture exists and recurring revenue
is under `STUDIO_MIN_MRR_USD` (default 1000). One expensive thing, completely.
The studio was the right tool for choosing a venture and the wrong tool for
the next eighteen months.

### Held

Exposing the venture's API as an MCP server waits for the API to exist. The
model tiers, the design partners, and sending `EVAL` for the first time are the
founder's, and no code changes that.

## Five turns against a wall nobody could see

The team shipped three files, then spent five turns failing to commit a fourth
— and one of those turns narrated a deploy it had not performed. The report
called it "purely mechanical execution, not design." That was right, and the
mechanism was three bugs in this repo, none of them in the agent.

### `LINK` handed a venture under construction a three-file week

`LINK v_123 owner/repo` passes no caps, so `linkRepo` used its defaults: **one
commit a day, three a week.** Three files is an afternoon on a product that
does not exist yet, and it was the entire weekly allowance. Every attempt at
`auth.py` came back:

> Weekly deployment cap reached (3/week) for this venture.

Those defaults were chosen when a commit was a rare and precious thing. They
are now 4/day and 20/week — still bounded, and `CAPS` moves either number in
one message.

### The refusal named a number and no door

Every other gate in `ventures.js` says what to ask the founder for: *the
founder turns this on in the Ventures panel*. The two cap refusals said only
that a limit had been reached. An agent that hits a wall with no door reads it
as a fault in itself, and tries again — which is exactly what happened, five
times. Both messages now name `CAPS <ventureId> <per day> <per week>` and say
plainly that re-attempting will not change it.

### One commit counted as one unit per file

The deployment log keeps a row per path, because "what changed" wants every
path. The caps were counting those rows. So a well-structured seven-file
commit cost seven times what the seven sloppy single-file commits it replaced
would have cost — `deploy_changes`, added to encourage coherent changes, was
the most expensive way to use the repo.

`countableTimes()` now collapses rows sharing a `commitSha` to one. The log is
unchanged; the cap counts acts.

Two further defects fell out of fixing it, both found by the tests rather than
by reading:

- **`authorizeDeploymentOfPaths` checked headroom for one and consumed N.**
  Every per-path call read the same pre-commit state, saw room for one, and
  passed — four of headroom admitted a six-file commit and recorded seven
  against a cap of five. The per-path gates (allowlist, plan) still run per
  path; the cap runs once, for one commit.
- **The checks-overdue gate counted rows too.** A seven-file commit read as
  seven and tripped a limit of five on its own — with no check run to clear it
  against, because the CI workflow was one of the files still unwritten. That
  is a deadlock, and it was one commit away from being the next blocker.

### A claim of work is now checkable

One turn reported deploying with no tool call behind it. A person caught it.
That is luck with a good habit attached, not a control — and the
`reporting-status` skill asking agents not to do it is a request, not a rule.

The runner records every action-tool call in the trace. `server/claimCheck.js`
reads a turn's text against that list and flags one shape only: the reply
asserts a real-world act was completed, and no successful action of that kind
happened in the same turn. Honest refusals, plans, and accurate summaries of
several commits all pass; a delegation to six specialists about a deploy does
not vouch for a deploy.

The warning goes at the *top* of the daily report email, before the report. A
warning that the report may be wrong is not a footnote to the report.

## The team could not read its own build logs

`run_checks` reported a failed run as the name of the step that failed — "Run
tests" — plus a conclusion and a link to a GitHub web page. No agent has a
browser. The error itself never reached the reply.

So a red build could only be answered with a theory. And in this company a
theory is expensive: testing one costs a commit against the venture's cap,
which is how five turns went into a guessing loop over a build failure whose
cause was one line of log:

```
src/test_auth.py:23: from src.auth import (
E   ModuleNotFoundError: No module named 'src'
```

That is not recoverable by reasoning. `pytest src/` under the bare console
script does not put the working directory on `sys.path`; `python -m pytest`
does. The tests passed locally and could not pass in CI, and nothing in the
tool result said why.

`jobLogTail()` now fetches the failing job's log and `failureSummary()`
attaches it, so `run_checks` returns the error text with the failure. Three
details earn their place:

- **Timestamps are stripped.** Every Actions line carries an ISO prefix that
  costs tokens and tells an agent nothing.
- **The cleanup epilogue is trimmed.** A run ends with a dozen lines of git
  plumbing and a Node deprecation warning, so an untrimmed 40-line tail is
  mostly noise and the error scrolls off the top. The tail now ends at the
  last line of real output.
- **A log that will not download comes back as `null`, never as a throw.** A
  missing log is worse than having one; it is not a reason to turn a red build
  into an error the agent cannot act on at all.

The reply also now says what to do with it: *that is the actual error, read it
before proposing a cause.* The evidence and the instruction to prefer it over
inference are the same fix — `diagnosing-a-blocker` has said so in prose since
the beginning, and prose was not enough while the evidence was unreachable.

This is the fifth capability in this codebase found sitting behind a door
nobody could open, and the most expensive of them: it did not remove an
ability the team had, it made every build failure cost a commit to diagnose.

## Every refusal names a way forward

The deployment cap refused with *"Weekly deployment cap reached (3/week)"* — a
number, and nothing else. An agent that hits a wall with no door reads it as a
fault in itself and tries again. Five turns went that way, and one of them
ended in a claim of work that had not happened.

That shape has now appeared five times in this codebase under five different
names. Fixing the sixth instance when it arrives is not a strategy, so
`refusalQuality.test.js` makes it a rule: **a refusal thrown by the gate layer
must tell whoever reads it what would change the answer.** Four things count,
and one of them is honesty about there being nothing:

1. **Something the founder does** — a named WhatsApp command, an environment
   variable, or "the founder needs to…". The agent can then ask for exactly
   that instead of guessing.
2. **Something the agent does** — "call `run_checks`", "submit a plan".
3. **Nothing, said out loud** — "nothing will change this", "wait it out; it
   clears on its own". A closed door is fine. A closed door with no sign is
   not.
4. **A description of malformed input** — "ventureId is required" already
   tells the caller what to fix.

The test scans `ventures.js`, `killSwitch.js`, `dailyPlan.js`, `spend.js` and
`probe.js` for every `throw new Error(...)`, reading the raw expression rather
than the evaluated string, because the question is whether the *wording*
offers a remedy. Two of its own cases guard the guard: one proves the
extractor captures whole multi-line throws rather than first lines, and one
proves every listed file is actually being read — a path typo would otherwise
make the whole thing a silent no-op.

On its first run it found **25 dead ends**, every one a blocker waiting to
happen. All 25 now say what to do:

| Was | Now says |
|---|---|
| `Venture not found` | …check the id against the business context, where every venture is listed |
| `must be active to deploy (is killed)` | …nothing will change this — a venture that is not active cannot act |
| `"x" is outside the allowed scope` | …ask the founder to widen it with `LINK <id> <owner/repo> <paths>`, naming this exact path |
| `Too soon after the last deployment` | …wait it out; it clears on its own. Do the next piece of work meanwhile |
| `Link a repo before enabling deployments` | …the founder sends `LINK <id> <owner/repo>` |
| `All real actions are halted. <reason>` | …the founder lifts it with `RESUME` |
| `"host" is not a public address` | …the origin is founder-set, so this is not something to work around |

Two of the original 25 turned out to be false positives — `spend.js` already
said *"Raise DAILY_SPEND_CAP_USD"* and `probe.js` builds its messages through
a `fail()` helper, so a bare `throw new Error(message)` is judged where the
wording is actually written. The patterns were widened rather than the
messages changed; a guard that flags good work teaches people to ignore it.

### Why this rather than another skill

`diagnosing-a-blocker` has asked agents to read the evidence since the first
week, and the team still guessed — because the evidence was unreachable and
the refusal was silent. A prompt is a request. This is the rule, and it fails
the build.

## The veto, the trace, and the door agents come through

Three things the €1M report asked for that were still outstanding after the
first two batches. One of them was a gap I had left in my own work: the
supervisor got the objectives tool and never got the veto.

### A rule the CEO can enforce, and one that needs no CEO at all

Project Vend's shop went from losing money every week to profitable, and the
change with the clearest causal link was a CEO agent who **vetoed** improper
discounts. This company had the CEO, the objectives and no veto. The only
thing that could say no was the founder, once a day, at plan-approval time —
which catches *"the plan does not cover emailing Ada"* and cannot catch *"the
plan said email Ada, and the email being sent offers her 60% off"*.

`server/review.js` adds two layers, deliberately different in cost:

**The price floor is arithmetic.** A payment link below what the venture
charges is the company giving its product away, and arithmetic does not need a
model. `priceFloorRefusal()` runs inside `create_payment_link` before anything
reaches Stripe. Free, always on, and there is no wording a customer can use to
get past it. Per the rule above, the refusal names the door: discounting is
the founder's decision, and `DISCOUNT v_123 99` is how they make one. It holds
until `DISCOUNT CLEAR v_123`, and a link below even the approved floor is
refused too.

**The review is judgment, so it costs a call.** `reviewOutbound()` asks the
CEO, on the cheap tier, whether one outbound message serves the open
objectives — after every other gate has passed and before the message leaves,
the last moment where saying no is free. It is opt-in (`CEO_REVIEW=true`) for
two reasons: a company with no revenue is protecting nothing, and a review
that fires on every draft becomes a rubber stamp.

Two properties are tested harder than the happy path. **A veto has to be the
easy answer**: the model is asked for one word, and anything that is not a
clear `VETO` passes, because a reviewer that has to argue its way to *yes*
blocks good work. And **the reviewer can never take the company down**: a
review that errors approves, logs, and reports `reviewed: false` rather than
claiming it looked. An unreachable supervisor must not become an outage — the
deterministic floor is still standing underneath it.

### Spans the rest of the world can read

The internal action trace answers *what did this company do today*. It cannot
answer *why was this turn slow* or *which agent burns the tokens*, and it
speaks a vocabulary only this repo knows.

`server/telemetry.js` emits the OpenTelemetry GenAI spans — `invoke_agent` per
agent turn, `execute_tool` per action — named exactly as the semantic
conventions name them, so an off-the-shelf backend groups them with no mapping
layer. A trace id is minted at the top of a run and threaded down through the
delegations, so a CEO turn and the four specialist turns it spawned are one
tree rather than five unrelated spans.

OTLP/HTTP JSON over plain `fetch`, no SDK — the same reasoning as the GitHub
and Stripe clients. Inert unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, which
matters more than usual: there is no observability backend today, and
telemetry that had to be configured before the app would run would be a vendor
decision smuggled in as a feature. Spans are batched, sent fire-and-forget,
and **dropped rather than retried** on failure — a queue that grows when the
collector is down is a memory leak in exactly the conditions where the server
is already unwell.

### The product a buyer's agent can call

In 2026 a prospect's first contact with an API is increasingly their own
assistant trying to use it. This repo has known that from the inside for
months — `server/agents/mcp.js` is how *these* agents reach other people's
services. The inverse was missing: nothing said how someone else's agent
reaches ours.

`MCP v_123 https://api.example/mcp` records the endpoint on the venture, and
the outreach context puts it in front of the team next to the price and the
booking link — so when a prospect asks how their tooling would call the thing,
the answer is in context rather than in a chat log. `https` only: an endpoint
quoted to a customer over an unencrypted connection is not one worth having,
and nothing in this app should ever guess a URL.

The 20th skill, `exposing-an-api-to-agents`, is the other half — what to
expose, how to name it, and why a tool description is now sales copy read by a
machine.

## The rehearsal

Everything on the outreach path is gated, footnoted, capped and reviewed. None
of it had ever run. The first end-to-end execution of that chain would have
been the moment a real prospect received a real email — the worst possible
time to find out that SMTP is misconfigured, the footer renders badly, or the
CEO vetoes every draft.

`DRYRUN <ventureId> <email>` runs the real pipeline against the real
recipient and delivers the result to the founder instead of to the prospect.
`DRYRUN <ventureId> <email> | subject | body` rehearses the founder's own
words; without them a plain sample draft is used, because the thing under test
is the pipeline and clever copy would only make the review harder to read.

Three properties make it a rehearsal rather than a demo.

### The gates are the same gates

`authorizeOutreach` used to be a straight-line function that threw on the
first problem. That is exactly right for a send — fail closed, say one thing,
stop — and exactly wrong for a founder asking *would this actually go out?*,
who would need six attempts to discover six shut gates.

So the gates became a list. `outreachGates()` evaluates all ten and returns
them; `authorizeOutreach()` runs the same list and throws the first shut one's
reason, word for word. A test asserts the two can never disagree, because the
whole value of a green dry run rests on that. A copy of the gate logic would
have rehearsed the wrong code — which is the same failure as a prompt that
asks for what the code should enforce, wearing a different hat.

A gate whose precondition is missing reports *not checked* rather than a
verdict. "Not checked" and "checked and fine" are different answers.

### Nothing is consumed

No cap is spent, no contact history is written, no profit share is credited.
The cooldown especially: a rehearsal that recorded itself would lock the
founder out of a real send for a minute afterwards, and three rehearsals in a
row would have been impossible.

### The prospect's address is evaluated and never delivered to

`sendOutreachDryRunEmail` takes no recipient parameter. Not "takes one and is
careful with it" — there is no argument to get wrong, which is the same
reasoning that made the price floor arithmetic instead of a prompt.

### What it caught

The refactor tripped `refusalQuality.test.js` immediately:
`throw new Error(shut.reason)` reads as a refusal with no way forward. It is
actually a re-throw of text written ten lines above, the same shape as
`probe.js`'s `fail()` helper — so the extractor was widened to skip a bare name
or a property read off one, and a new test pins the exemption to exactly that
so it can never grow into a hole. The guard flagging its own author's refactor
is the intended behaviour; being able to tell that from a real finding is why
the exemption is narrow.

## Giving the Venture Studio something to check with

A deep research pass asked whether the venture team was equipped to research
what it proposes. It was not, and the shape of the gap was specific enough to
fix precisely rather than generally. `reports/Venture research capability
gaps.md` carries the full answer; this is what changed in the code.

Of six Studio agents, two held research tools, capped at four searches and four
fetches each — about sixteen lookups behind a decision to start a company.
Anthropic's published heuristic for a task it classes as complex research is
10–15 tool calls *per subagent*, and their variance decomposition puts token
volume at ~80% of research quality, tool-call count at ~10%, and model choice
at ~5%. The cap was spending the cheap term to save the expensive one.

Worse, the three agents whose judgement decides anything — the Business Case
Analyst, the Validation Critic and the Venture Partner — held none.

### The search budget, and a pin that had drifted

`SEARCH_MAX_USES` and `FETCH_MAX_USES` now default to 15 and 10 and are read at
call time, so the founder can move them from Railway without a deploy. And
`web_search` was pinned to `web_search_20250305` while `web_fetch` sat on the
current `web_fetch_20260209` — eighteen months stale on the highest-leverage
tool in the company, in a file whose own header warns that a stale type is "a
400 that names a field nobody set."

### A calculator, not a bigger model

The Business Case Analyst sizes markets on the cheapest model in the company,
and that sounds like the defect until you read what small models actually get
wrong: they follow the right reasoning steps and then miss the sums, with
logical error rates climbing as the numbers get messier. That is
arithmetic-in-weights. Promoting the agent would cost roughly 15x and buy the
~5% that model choice explains; a calculator costs nothing and fixes the part
that was broken.

`arithmetic.js` is a recursive-descent parser rather than `eval()`, because the
expression arrives from a model and `eval()` on model output is remote code
execution with extra steps. Percent is postfix — `500 * 20%` is 100 — because
that is how a business case writes a conversion rate, and reading `%` as an
infix operator made the natural spelling a syntax error, which is how a
calculator ends up unused.

### A critic that can open a source, without changing model family

The obvious way to give the Validation Critic retrieval was the hosted
`web_fetch` tool, and it was the wrong one. A hosted tool cannot travel to
another provider, so attaching one silently promotes the agent onto Anthropic —
and the critic's cheap non-Anthropic model is the one thing about it the
evidence supports, because the measured multi-agent failure is *every role
running on one model*. So the fetch happens in this server (`claimVerify.js`)
and the tool is an ordinary action any provider can be handed. A test asserts
both agents stay off Anthropic, because this is easy to undo by accident.

Verification needs no search API and costs nothing: the claim arrives carrying
the URL it came from, and the only question is whether that page says what the
claim says it says. A source that will not open is a verdict, not an error.

The input contract changed with it. The Venture Partner now hands the critic a
numbered claim list with URLs rather than the finished case — the MARCH result
is that a checker validates propositions *in isolation*, deprived of the
proposer's output, and the cross-cutting pattern in that literature is that
every measured verification win has that property and every measured failure
lacks it. A critic reading your write-up grades your write-up.

### Sizing that can be checked

`propose_venture` now asks for an enumerable bottom-up SOM — a countable set of
accounts, where the count came from, times a defended ACV, times a justified
win rate — and names the "we capture 1%" fallacy as unacceptable. Published
figures for the same market differ several-fold between reputable firms, so
citing one is picking a side rather than sourcing a fact. At the $1M bar the
arithmetic is small enough to write out in full.

### What the parity test caught

`dailyCycleParity.test.js` failed immediately, because it pinned the Studio's
tool list as the literal `['propose_venture']`. That checked the roster of the
day rather than the property, so it now runs the same wired-or-barred check the
company side runs, plus its mirror: no handler served that no agent holds. The
two inline studio handler maps became one exported `studioActionHandlers()` —
a map that is a literal at each call site is a map that drifts, which is the
exact failure that test exists to catch.

### What none of this fixes

Willingness to pay, urgency and budget ownership are not written down anywhere,
for any unlaunched product. No retrieval budget reaches them and no database
sells them. Every "path to €1M" the Studio produces remains an assumption chain
in the shape of a forecast until someone talks to ten named buyers. The
engineering above raises the Studio from confident narration to competent desk
screen; the last step is not an engineering step.
