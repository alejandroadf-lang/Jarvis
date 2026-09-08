# The Company: a virtual IT-company executive team

"Executive Team" mode turns Jarvis from a single assistant into a small
company of Claude agents, organized as a real IT-company org chart. Ask it
anything — from "draft a Q4 marketing plan" to "what should our pricing
model be" — and the CEO agent figures out who on the team should actually
answer it, consults them, and gives you back one synthesized answer.

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
│   └── Solutions Architect
├── CFO (finance)
│   └── Finance & Accounting Manager
├── CMO (marketing)
│   └── Marketing Manager
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

This is deliberately close to how a real early-stage IT company is
structured — a lean C-suite, with one specialist owning each of the
functions a company actually needs to sell, build, deliver, and support a
product: marketing, engineering/product, commercial (solutions +
sales), customer support, implementation, and finance/accounting, plus
people operations to keep the team itself running.

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
