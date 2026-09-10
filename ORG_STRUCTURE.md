# The Company: a virtual IT-company executive team

"Executive Team" mode turns Jarvis from a single assistant into a small
company of Claude agents, organized as a real IT-company org chart. Ask it
anything — from "draft a Q4 marketing plan" to "what should our pricing
model be" — and the CEO agent figures out who on the team should actually
answer it, consults them, and gives you back one synthesized answer.

There's also a **Venture Studio** mode upstream of the company — a small
brainstorming team that turns a raw idea into a funded venture and hands it
to the CEO to execute, against a real (small!) cash balance. See
[Venture Studio: ideation and capital](#venture-studio-ideation-and-capital)
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
└── COO (operations)
    ├── Sales & Commercial Manager
    ├── Customer Support Manager
    ├── Implementation Manager
    └── HR & People Manager
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

## Venture Studio: ideation and capital

The Executive Team is good at *executing* — it assumes you already know
what to build. The Studio is upstream of that: a small brainstorming team
that helps find the next idea, pressure-tests it, and turns it into a
venture proposal sized against the company's actual cash.

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
quietly becomes "so pick something small." That's fixed at the prompt
level: every agent is told the treasury funds the *first cheap experiment*,
never the ceiling on the business itself, and the ambition bar is explicit
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

### The treasury

The company starts with **$100 in seed capital** — a small, real (if
fictional) constraint meant to force actual prioritization instead of
infinite-budget brainstorming. It's tracked as an append-only transaction
log in `server/finance/ledger.js` (`server/data/ledger.json` on disk, not
committed to git — see `.gitignore`), so the balance is always just a fold
over history:

- `capital` — money added to the treasury (the initial $100 seed)
- `investment` — budget allocated to a greenlit venture (reduces balance)
- `expense` — money spent that isn't tied to a specific venture allocation
- `revenue` — money a venture brings in (increases balance)

`GET /api/ventures/ledger` returns the current balance and full transaction
history; the Studio sidebar shows the balance live.

### Progressive capital: staged funding, not one check

A venture's initial `budgetRequested` at greenlight only funds its first
milestone — capital into a venture grows in tranches as it actually proves
itself, not all at once. The CFO (`server/agents/orgChart.js`) owns this:

- `report_milestone_progress` — records whether a specific milestone (by
  index) was actually hit or missed, with a note. Call this when the
  founder reports a real outcome, not a plan.
- `request_tranche` — once a venture's current milestone is marked `done`
  and there's a concrete next step, asks the founder to fund it. Only one
  tranche request can be pending per venture at a time.

Every venture the CFO can see comes with its id, its milestones (with
index and status), and any pending tranche request injected into context
by `buildTreasuryContext()` in `index.js` — that's what lets the CFO call
these tools with the right ids without guessing.

A requested tranche doesn't touch the treasury until the founder approves
it — `POST /api/ventures/:id/tranche/approve` checks the ask against the
current balance (same insufficient-funds guard as the initial greenlight),
records an `investment` transaction, and pushes a briefing into the
Executive Team conversation the same way greenlighting does.
`POST /api/ventures/:id/tranche/deny` clears the request without spending
anything. Both the pending request and every milestone's status show up on
the venture's card in the Ventures panel, with Approve/Deny buttons when
there's something to act on.

### From brainstorm to venture to execution

1. You brainstorm with the Venture Partner and its team in **Venture
   Studio** mode. Every request also gets the current treasury balance and
   existing ventures injected into context, so the Business Case Analyst
   sizes its numbers against what's actually left, not a hypothetical
   budget.
2. Once you've converged on something real — and it clears the ambition
   bar — the Venture Partner calls its `propose_venture` action — a tool
   that isn't delegation but a genuine side effect: it logs a venture
   (title, problem, target customer, business model, market size, the path
   to $1M+ revenue, a budget ask, and milestones) via
   `server/finance/ventures.js`, with status `proposed`. This shows up
   immediately in the **Ventures** panel in the sidebar.
3. You **greenlight** a proposed venture from that panel
   (`POST /api/ventures/:id/greenlight`). The server checks the ask against
   the current balance (rejecting it if the treasury can't cover it),
   records an `investment` transaction for the budget, and flips the
   venture to `active`.
4. Greenlighting also **pushes the venture straight into the Executive
   Team's conversation**: the server synthesizes a briefing (the venture's
   one-liner, business model, approved budget, and milestones) and runs it
   through the CEO agent immediately, the same way a normal Executive Team
   chat turn works. The CEO's kickoff response is appended to your
   Executive Team conversation, and the UI switches you to that tab so you
   can see the company start planning execution right away.

### Money flowing in and out

There's no real payment integration in a personal project like this, so
neither revenue nor spending is detected automatically — but both are
trackable through the Executive Team. The Finance & Accounting Manager
(reports to the CFO) has two action tools, the same mechanism as
`propose_venture`:

- `log_revenue` — tell the CFO or Finance Manager that real money came in
  (e.g. "we got $200 from the newsletter's first paying subscribers"), and
  it records a `revenue` transaction against the treasury.
- `log_expense` — tell them about real money you actually spent (e.g. "I
  just paid $12 for the domain"), and it records an `expense` transaction.

Both accept an optional venture id to attribute the transaction to a
specific venture, and both are instructed to only log money that's
actually moved — not a forecast, a verbal promise, or a planned purchase —
so the treasury stays an honest running total rather than a wish list.

This is deliberately a **manual, human-in-the-loop** ledger, not an
autonomous one: nothing in this codebase can move real money on its own.
The intended workflow is to fund a venture with real capital yourself
(e.g. a $100-capped virtual card, so nothing can ever go over budget no
matter what happens on the software side), have the agents recommend what
to spend it on, make each purchase yourself, and then tell Finance what
actually happened so the app's numbers track reality.

Both the Executive Team and Venture Studio sidebars show the Treasury
panel, and it refreshes after every chat turn in either mode, so a logged
transaction shows up immediately regardless of which tab you're in.

## Killing a venture

Not every venture earns its next tranche. The CEO owns the call to end one
via a `kill_venture` action — sets status to `killed`, records `killedAt`
and a `killReason`, and clears any pending tranche request. Unlike
greenlighting or approving a tranche, killing doesn't move any money, so
it's also exposed as a direct, human-in-the-loop route
(`POST /api/ventures/:id/kill`) with a "Kill venture" button on active
venture cards in the Ventures panel — no need to go through a conversation
if you've already decided. The CEO is instructed not to use it to hedge or
as a threat, and specifically not to let sunk cost talk it out of killing
something that genuinely isn't working.

## Portfolio view

The per-mode Ventures panel is deliberately narrow — a sidebar showing
"what's relevant to this conversation." The **Portfolio** tab
(`GET /api/ventures/portfolio`, `client/src/components/PortfolioView.jsx`)
is the company-wide view instead: every venture ever created — proposed,
active, or killed — sorted active-first, each enriched with its own slice
of the ledger (`allocated`, `revenue`, `expense`, `net`, computed by
filtering the ledger's transactions by `ventureId`) and a milestone
summary (`done`/`missed`/`total`). Stat tiles at the top roll all of that
up across the whole portfolio, alongside the current treasury balance.
This is the place to compare ventures side by side once there's more than
one running, rather than reacting to them one at a time in chat.

## Conversation history survives a restart

Originally every chat mode kept its history purely in an in-memory `Map`,
which is fine for a quick demo but not for something meant to run as an
ongoing company — a server restart (a crash, a deploy, an accidental
`Ctrl+C`) would silently wipe every conversation. `server/sessionStore.js`
persists all three modes' histories to `server/data/sessions.json` (same
`store.js` helper the treasury and ventures use, now relocated to
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
   bar? If so, it logs a proposal with the same `propose_venture` action
   used in an interactive brainstorm; if not, it says so plainly rather
   than forcing one.
3. **The report is saved, then emailed.** Both replies, their full
   delegation traces, any new venture ids, and a treasury snapshot are
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
leadership sync isn't given the treasury/venture action handlers that
depend on a real founder-reported outcome (`log_revenue`, `log_expense`,
`report_milestone_progress`, `request_tranche`, `kill_venture`) — it's
explicitly told this is an internal status meeting, not that kind of
event, and even a stray tool call would resolve as an unknown tool rather
than a silent no-op. It *does* now carry `deploy_code` and
`send_customer_email` — see "Full autonomy" further down for why those
two specifically were judged safe to run unattended, and why the rest
weren't. The Studio phase can still also cause a new venture *proposal*,
which spends nothing and still needs the founder's greenlight
(`POST /api/ventures/:id/greenlight`) before any budget is allocated —
the same human-in-the-loop guarantee every other capital-moving action in
this app still has. Autonomy here means the *information gathering and
recommending* runs itself, plus — now — two narrowly-scoped real actions;
spending real (simulated) money never does.

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
treasury context into what `venture_partner` and its whole team (including
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
UI until the founder happens to check. `server/email.js` now sends two more,
narrower emails the instant the thing they're about actually happens:

- **A new venture proposal** (`sendVentureProposedEmail`) — fires from
  `handleProposeVenture` in `server/actionHandlers.js`, so it fires the same
  way whether the proposal came from an interactive Venture Studio
  conversation or the autonomous daily cycle's opportunity-review phase.
- **A tranche request** (`sendTrancheRequestEmail`) — fires from
  `handleRequestTranche`, which matters most exactly when nobody's
  watching: greenlighting a venture or approving a tranche triggers a
  company briefing conversation (see the `/api/ventures/:id/greenlight` and
  `/api/ventures/:id/tranche/approve` routes in `index.js`), and the CFO
  can ask for the *next* tranche as part of that same briefing, seconds
  after the founder clicked approve and moved on.

Both share the same opt-in gate as the daily report (`SMTP_HOST` +
`REPORT_EMAIL_TO`) and the same failure isolation: a `notify()` wrapper in
`actionHandlers.js` logs a failed send but never lets it break the action
itself — the venture or tranche request is already real either way, so a
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
$0.08 · 18,342 in / 4,021 out tokens" next to the treasury line — and both
guard for older reports saved before this existed, so a report from before
this feature just omits the line instead of printing `undefined`.

## A behavioral eval, not just data-layer tests

`server/test/` checks the data layer (ledger math, venture state
transitions) — none of it checks whether an agent's actual *judgment* is
any good, so a prompt change could quietly make the CFO worse at refusing
a bad tranche ask and nothing would catch it. `server/eval/` is a starter
behavioral eval: 10 scenarios (`scenarios.js`) run against the real org
chart and real action handlers via `server/eval/runner.mjs`, each
targeting one judgment call — does the CFO request a tranche when a
milestone is actually done, and correctly refuse when it isn't; does the
Validation Critic flag a lifestyle idea as too small without also
flagging a genuinely large one; does the Venture Partner notice a pitch
resembles something already killed (exercising the `pastLessons` context
from earlier in this doc); does the CEO kill a venture on a clear reason
but not on vague doubt alone.

Most grades read real end state (did `pendingTranche` actually get set,
did the ledger balance actually move) rather than parsing the reply text,
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
anything, but it can't move money, greenlight a venture, or touch the
ledger. `server/weeklyReflections.js` stores the result the same way
`dailyReports.js` stores daily ones, keyed by `weekEnding` so re-running
mid-week overwrites rather than duplicates.

The reflection then feeds back into the same context every ideation
session already reads: `buildWeeklyReflectionContext()` in
`server/finance/context.js` surfaces the latest reflection (or says
plainly that none has run yet), and `buildStudioContext()` now joins it
alongside the treasury and past-lessons context. The `venture_partner`
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

Everything above — revenue, expenses, tranches, kills, even the weekly
reflection — happens entirely inside this app's own data files. Nothing
touched a real, external system, so the worst-case blast radius of any
mistake was always "the numbers in `server/data/` are wrong." Real code
deployment is the first capability that doesn't have that property: the
Engineering Lead can now make an actual, permanent, publicly-visible commit
to a real GitHub repo. Getting that guardrail right mattered more than
getting it done fast.

The model isn't a per-deploy approval gate like a tranche request — that
would just be a slower version of what already exists, not a new
capability. Instead, the founder grants a bounded **scope** once per
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
other treasury/venture action still haven't.

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
working SMTP transport for founder notifications (the daily report,
tranche/proposal alerts). `sendCustomerEmail(to, subject, body)` is the
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
treasury/venture action (`log_revenue`, `log_expense`,
`report_milestone_progress`, `request_tranche`, `kill_venture`) is still
not wired into either autonomous cycle, because those specifically depend
on the founder having personally reported a real-world outcome; nobody
reports anything to an unattended run, so there's nothing genuine for them
to log.

The reasoning for singling out these two: unlike a tranche request or a
logged expense, `deploy_code` and `send_customer_email` don't need the
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
