# Skills

Procedures an agent loads only when the work calls for them.

## Why

An agent's know-how used to live in its system prompt, sent on every call
whether relevant or not. Teaching the Security Reviewer a proper methodology
meant every one of its turns carried that methodology — including the ones
answering a yes-or-no question. Twenty-one agents deep, that stops the roster
being able to grow.

A skill puts the one-line description in the prompt and the body behind a
tool call. The description costs a few dozen tokens; the body costs thousands
and is only paid for when it is actually used.

## What's in the library

Fourteen, in two groups.

**Written from failures that happened here.** Most of these are a procedure
for a mistake this company already made, fluently and confidently, at the
time:

| Skill | Why it exists |
|---|---|
| `diagnosing-a-blocker` | Three confident wrong root causes, all the same shape — an absent observation promoted to a cause |
| `sizing-work-for-a-turn` | Seven files attempted in one turn, against a token budget that could not hold them |
| `reporting-status` | Progress overstated to the founder, who then planned around it |
| `writing-tests-that-assert` | Tests that passed without testing anything |
| `writing-for-the-founder` | Reports written for engineers and read on a phone |
| `shipping-code` | A deploy reported as done that had not run any check |
| `security-review` | A finding needs to be actionable, not a list of concerns |
| `customer-outreach` | An email to a real person cannot be recalled |
| `building-a-python-api` | Every venture reinventing the same layout |

**Written for work about to happen.** The other half of what a library is
for — the first venture is an API in a health-adjacent space that has to
authenticate callers, price itself, and find someone to sell to:

| Skill | For |
|---|---|
| `api-authentication` | Keys done properly, without a week on OAuth |
| `writing-an-api-contract` | The one part of a product you cannot iterate on freely |
| `handling-regulated-claims` | Anything touching health, money or legal advice |
| `finding-first-customers` | The first ten, who come from nowhere a later channel reaches |
| `pricing-a-product` | The fastest revenue lever, usually left at its default |

## Adding one

Drop a markdown file in `library/`. That's the whole job — no roster edit, no
wiring. `load_skill` appears automatically for any agent with at least one
skill available.

```markdown
---
name: negotiating-a-contract
description: How to hold a price and what to concede instead — the terms worth trading away.
agents: [sales_commercial_manager, coo]
---

# Negotiating a contract

...
```

- **`description` is required.** Without it an agent has no way to know when
  to reach for the skill, so it would only ever be dead weight in the menu —
  a skill without one is skipped, with a warning.
- **`agents` is optional.** Omit it and every agent is offered the skill.
  Listing agents keeps each one's menu short; it is not a secrecy mechanism.
- **Write it as a procedure**, not an essay. The agent is reading it to decide
  what to do next.

Set `SKILLS_DIR` to point somewhere else — a venture carrying its own library,
or a test fixture.

## What a skill is not

**Not code.** A skill is knowledge. A skill that could execute something would
be a second action surface outside the scopes that govern the first, and every
guardrail in `finance/ventures.js` would have a hole beside it.

**Not nested.** One level, no skills loading skills. The depth would buy very
little and makes the cost of a turn hard to reason about.

## Provenance

The pattern is from the Claude Code ecosystem, where
[Everything Claude Code](https://github.com/affaan-m/everything-claude-code) —
the repo that won Anthropic's hackathon — packages 181 of them. Four of this
company's specialist agents were adapted from that repo already; this is the
mechanism that makes borrowing the rest cheap.
