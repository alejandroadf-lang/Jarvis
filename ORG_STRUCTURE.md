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
