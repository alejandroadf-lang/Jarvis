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

**This cycle cannot move money or kill a venture on its own.** The
leadership sync isn't given the treasury/venture action handlers at
all — it's explicitly told this is an internal status meeting, not a
real founder-reported event, and even a stray tool call would resolve as
an unknown tool rather than a silent no-op. The only side effect the
whole cycle can cause is the Studio logging a new *proposal*, which
spends nothing and still needs the founder's greenlight
(`POST /api/ventures/:id/greenlight`) before any budget is allocated —
the same human-in-the-loop guarantee every other capital-moving action in
this app already has. Autonomy here means the *information gathering and
recommending* runs itself; spending real (simulated) money never does.

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
