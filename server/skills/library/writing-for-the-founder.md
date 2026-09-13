---
name: writing-for-the-founder
description: How to write a message the founder can act on from a phone — what goes in the first two lines, what belongs underneath, and the vocabulary that makes a true report unreadable.
agents: [ceo, cto, cfo, cmo, coo, engineering_lead, product_manager, finance_manager, sales_commercial_manager, implementation_manager, customer_support_manager, data_analyst]
---

# Writing for the founder

Everything this company sends goes to one person, usually on a phone,
usually between other things. They can follow anything you write — this is
not about simplifying. It is about order.

Here is a real message this company sent:

> `next_task` handed engineering the auth task (`bcwfkd`), not the engine
> task (`ox40vj`) — even after you said the abandoned-claim fix would
> surface it. I don't want to name a cause here.

Every word true. Nothing in it says what happened, what it cost, or what to
do. What it actually meant:

> The engine is already built and committed — that's why the queue moved on
> to auth. Nothing is broken. Carrying on with auth now.

Same facts. One is a decision; the other is a transcript.

## The first two lines

1. **What changed**, in the world, not in the tooling. A commit landed. An
   email went out. Nothing moved.
2. **What you need**, if anything. A decision, an approval, a credential. If
   you need nothing, say so — *"nothing needed, carrying on"* is a complete
   and welcome message.

Everything else goes underneath, for if they want it.

## Vocabulary that makes a true report unreadable

Keep these out of an opening line:

- **Tool names** — `next_task`, `deploy_code`, `read_repo_file`
- **Internal ids** — `task_1789...`, agent ids, plan ids
- **Our status words** — QUEUED, stalled, "the plan gate", "the scope model"

Use them only when they *are* the subject, or when the founder has to copy
one: a venture id to paste, a commit URL to open. Those earn their place.

## Rewrites

> **Not:** "deploy_code returned 404 on the contents endpoint across three
> path lengths."
> **But:** "We can't write to the repo. Reads fail the same way, which
> usually means permissions rather than a missing file. One check would
> settle it: can the token read the README?"

> **Not:** "Milestone 0 remains in progress pending verification."
> **But:** "Not shipped yet. The engine is committed; tests, auth and CI are
> still to go. Nothing needed from you."

> **Not:** "Monetization strategy exhibits dual-channel logic."
> **But:** "Two ways to charge: per call for small users, a flat licence for
> big ones. I'd start with per call — it needs no sales conversation."

## Say the number

A commit URL beats "shipped successfully". "$1.87" beats "modest". "Four of
seven files" beats "good progress". If you do not have the number, that is
worth saying plainly too — and it is shorter.

## Length

If it fits on a phone screen without scrolling, it gets read. If it does
not, the part that matters must still be in the first screen.

Nobody has ever complained that a status update was too clear.
