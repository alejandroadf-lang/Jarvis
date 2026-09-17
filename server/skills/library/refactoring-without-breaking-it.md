---
name: refactoring-without-breaking-it
description: How to change the shape of working code without changing what it does — what to do first, how to keep each step reversible, and when not to refactor at all.
agents: [cto, engineering_lead, qa_engineer, solutions_architect, product_manager]
---

# Refactoring without breaking it

A refactor changes how code is arranged without changing what it does. The
moment it also changes what it does, it stops being a refactor and becomes an
undisclosed feature change riding inside a diff nobody is reading closely —
which is how a working system quietly stops working.

## First: should you?

Most refactors are not worth doing, and an agent with a large context window
is unusually prone to proposing them, because the whole file is right there
and its flaws are obvious.

Do it when:

- You are about to add something and the current shape makes that add
  genuinely harder — the refactor pays for itself in the same change.
- The same bug has now happened twice in the same place.
- Something is duplicated three or more times and they have started to drift.

Do not do it when:

- The code is ugly but correct, and nothing is about to touch it.
- You just read it for the first time and it is unfamiliar. Unfamiliar and
  badly structured feel identical from the inside.
- You cannot tell whether it works today. A refactor of untested code is a
  rewrite with extra confidence.

"It would be cleaner" is not a reason on its own. Say what it unblocks.

## Before you change anything

**Know what "still works" means.** If there is no test covering the behaviour
you are about to rearrange, write one *first*, against the current code, and
watch it pass. That test is the entire safety net — without it you are not
refactoring, you are rewriting and hoping. `writing-tests-that-assert` covers
what makes such a test worth having.

**Find every caller.** `list_repo_files` and `read_repo_file` exist for this.
Changing a signature you believe has one caller and discovers a second in
production is the classic way a refactor becomes an outage.

## Do it in steps that each land

One commit per step, each one leaving the code working. `deploy_changes`
makes this practical: a step that spans four files is one commit, all of it
or none of it.

A sequence that works for almost everything:

1. Add the new thing beside the old one. Nothing calls it yet. Nothing can
   break.
2. Move callers over, a few at a time, running the checks between. Both paths
   exist and both work.
3. Delete the old thing once nothing points at it — `deploy_changes` can
   actually remove the file.

Three small commits beat one large one, and not for tidiness: when step two
breaks something, you revert step two, and steps one and three were never at
risk. A single commit that does all three can only be undone entirely.

## Keep the behaviour change out

If, mid-refactor, you notice a real bug — do not fix it in the same commit.
Finish the refactor, land it, then fix the bug in its own commit with its own
message. A diff that says "restructure the auth module" and also quietly
changes who can log in is unreviewable, and when something breaks next week
nobody can tell which half did it.

Write the bug down with `log_venture_note` the moment you see it, so
finishing the refactor first does not mean forgetting.

## Say what you did not verify

The honest end of a refactor names its own blind spot:

> Moved the three parsers into `parsers/`, updated the six imports. Tests
> cover the JSON and CSV paths; the XML path has no test and I did not add
> one, so that one is verified by reading only.

That sentence is worth more than any amount of "fully refactored and tested".
It tells the next person exactly where to look when something is wrong.
