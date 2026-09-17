---
name: reviewing-a-diff
description: How to review a change someone else wrote — what to look for first, what a review comment should say, and when the right verdict is "this is fine" rather than a list of improvements.
agents: [cto, engineering_lead, qa_engineer, security_reviewer, solutions_architect]
---

# Reviewing a diff

This company can now open a pull request, which means work arrives needing a
review rather than a rewrite. A review is not a second author's pass. It is a
short, honest answer to one question: *would shipping this be a mistake?*

The failure mode to avoid is the review that finds eleven small things and
misses the one real one. It reads as thorough and is worse than useless,
because everyone leaves believing the change was examined.

## Read in this order

Order matters because attention runs out, and the expensive problems are at
the top.

1. **What is this supposed to do?** From the description, not the code. If you
   can't state it in one sentence after reading the description, that is the
   first review comment, and you cannot review the rest yet.
2. **Does it do that?** Follow the main path through the change end to end
   before looking at any individual line.
3. **What happens when it goes wrong?** The error path, the empty case, the
   second call, the concurrent call. Most real bugs live here, and most
   reviews never look.
4. **What else touches this?** A changed function signature, a changed data
   shape, a changed file format. The diff shows you what changed; it does not
   show you what depended on it.
5. **Now read the lines.** Naming, style, duplication. Last, deliberately.

## The three findings that actually matter

Everything else is a preference. Say so when it is one.

- **It is wrong.** There is an input for which this produces the wrong answer
  or crashes. Name the input.
- **It is unsafe.** It widens what an agent or a caller can reach, weakens a
  check, or logs something it shouldn't. Name what got wider.
- **It will break something else.** Something outside the diff depends on what
  this changed. Name the something.

If you have none of these, the review is "this looks right", and saying that
plainly is a real contribution. A reviewer who never approves anything cleanly
teaches everyone that approval is about persistence rather than quality.

## Writing the comment

A useful review comment has three parts and is usually two sentences:

> **Where.** `src/auth.py:41` —
> **What goes wrong.** if `token` is empty this returns `True` rather than
> raising, so an unauthenticated request reads as authenticated.
> **What you'd do.** Check for empty before the comparison.

What to cut: "consider", "you might want to", "nit:" attached to something
that is actually a bug, and any sentence about the author rather than the
code. What to keep: the concrete input that breaks it. A finding without a
failing case is a hunch, and should be labelled one — "I'm not sure, but
what happens if X is empty?" is a perfectly good review comment and an
honest one.

## Severity, out loud

State it, because the author cannot read your mind and will otherwise treat
every comment as equally binding:

- **Blocking** — do not merge until this changes.
- **Worth fixing** — should change, doesn't have to be in this change.
- **Preference** — take it or leave it, no follow-up needed.

A review of eight preferences and one blocking issue, with nothing labelled,
is a review that hid the blocking issue.

## When you are reviewing your own work

Reading your own diff before pushing catches most of what CI would. The trick
is to change the question. Don't re-read asking "is this right" — you already
believe it is, that's why you wrote it. Read it asking:

> What would make this fail, and what would a reviewer ask me that I can't
> answer yet?

Then answer it, or say it in the description under "what I'm least sure
about". Naming your own doubt is not weakness; it is where the review should
go first, and you are the only person who knows where it is.
