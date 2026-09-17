---
name: exposing-an-api-to-agents
description: How to make a product callable by other people's AI agents over MCP — what to expose, what not to, and why this is a distribution decision rather than an integration one.
agents: [cto, engineering_lead, solutions_architect, product_manager, sales_commercial_manager]
---

# Exposing an API to agents

A growing share of buyers meet an API for the first time through their own
assistant trying to use it. If that attempt fails, the evaluation is over and
nobody files a ticket about it. An MCP server is how a product shows up in that
moment: expose the capability once, and every MCP-speaking client — Claude,
ChatGPT, Cursor, an in-house agent — can call it.

Treat this as distribution, not integration. It is closer to being listed in a
marketplace than to adding a webhook.

## Do it when, and not before

- The API is **deployed and answering**. An MCP server in front of nothing
  advertises a product that does not exist.
- Authentication works. An agent will send the key on the first call; if that
  path is untested it will fail in front of a buyer.
- There is a price. An agent that can call the product for free is a product
  being given away at machine speed.

## What to expose

**One tool per job the customer has**, not one per HTTP route. `plan_shift` is
a job. `POST /v1/shift-plans` is a route. The name, the description and the
argument names are the whole interface an agent gets — it cannot read your
docs, guess your conventions or ask a colleague.

Keep the surface small. Tool selection degrades once an agent is choosing
between dozens of similar-sounding options, so five clear tools beat twenty
precise ones. If two tools need the same sentence to tell them apart, they are
one tool with an argument.

Write the description for someone who has never seen the product and will not
read further: what it does, when to reach for it, and what it returns. State
units and formats in the schema — `iso_date`, `zones_crossed`, not `d` and `n`.

**Never expose**: anything that spends money without an explicit confirmation
step, anything that returns another customer's data, anything destructive, or
an admin path. The blast radius of a tool is every agent that ever calls it.

## Errors are part of the interface

An agent recovers from a good error and gives up on a bad one, exactly as a
person does. `{"error": "invalid input"}` ends the evaluation. `"zones_crossed
must be between 1 and 12; got 26"` gets a corrected retry. Say what was wrong
and what would be right. This is the same rule this company applies to its own
refusals, for the same reason.

## Charging for it

An MCP call is a billable call. Meter it exactly like an HTTP call — same key,
same rate limit, same usage report to the company. If the two paths count
differently, the numbers stop meaning anything and the first billing dispute
is unanswerable.

## When it is live

Tell the founder the endpoint so they can record it with
`MCP <ventureId> <https://...>`. It then appears in the context Sales reads, so
"can my team's assistant call this?" has an answer in the reply rather than a
follow-up.

## The test that matters

Point a real MCP client at it and complete one real task without touching the
code. Not a unit test of the handler — the handler was never the risky part.
The risk is that the tool names and descriptions do not survive contact with an
agent that has not read your mind, and there is exactly one way to find that
out.
