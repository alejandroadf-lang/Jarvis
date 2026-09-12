---
name: sizing-work-for-a-turn
description: How much work fits in one turn, how to write down the rest before you start, and how to hand off cleanly when you run out of room.
agents: [cto, engineering_lead, solutions_architect, product_manager, qa_engineer, coo]
---

# Sizing work for a turn

A turn has two hard limits, and neither of them announces itself:

- **An output budget.** Roughly 4,000 tokens by default (`AGENT_MAX_TOKENS`).
  A file you write with `deploy_code` is passed as tool input, so **the file
  counts against that budget**. A 200-line source file is most of it.
- **A clock.** An interactive turn stops widening after about two minutes and
  answers with what it has.

Hitting either produces the same outcome: work planned, nothing delivered.

This is not hypothetical. Asked to ship a first commit of seven files —
engine, tests, auth, rate limiting, contract doc, Dockerfile, CI — one turn
decided on all seven, ran out of room before writing any of them, and ended.
Zero files landed. Worse, nothing recorded that seven pieces of work had ever
been identified, so nobody would have picked them up.

## Write it down before you start

For anything that is more than one file or one action, call `queue_work`
first. Split it so **each task is one file or one coherent unit** — not
"build the API".

Queueing costs nothing and changes what failure means. A run that dies
mid-way costs one task instead of the whole plan, and the next turn reads
the queue instead of re-deciding what to do.

Then work the loop, one task per turn:

1. `next_task` — what to do, and why it failed last time if it has been tried
2. `start_task` — claim it, so two turns never do the same work
3. do it (one `deploy_code`, one file)
4. `complete_task` with the commit URL — **after** it actually succeeded
5. repeat

## One file per turn is the working assumption

Not a rule handed down — arithmetic. The file plus your reasoning plus the
tool call has to fit in the output budget, and a real source file is most of
it. Two small files sometimes fit. Seven never will.

If a single file genuinely won't fit, that file is too big. Split it the way
you would in any codebase: the engine and its helpers, the routes and the
handlers.

## When you run out of room

Say so immediately and specifically. Call `fail_task` with the real reason:

> Ran out of output budget partway through `src/engine.py`. The phase-advance
> branch is written and correct; the phase-delay branch is not started.

That reason is carried into the next attempt, which then starts from what
exists rather than from nothing. The one unacceptable outcome is going
quiet: a claimed task nobody reports on stays claimed and blocks the queue.

## Do not retry the same size

A turn that failed for lack of room will fail again at the same size. If an
attempt ran out, the next attempt must be smaller — a narrower file, or the
same file split. Two identical attempts are one wasted turn and one wasted
budget.

## Read before you write

If you are editing a file you did not write **in this same turn**, call
`read_repo_file` first. Working from memory of a previous turn's file is
where contradictions come from, and CI finding them is the expensive way to
learn what you already could have looked up.
