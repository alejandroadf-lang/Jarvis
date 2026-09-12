---
name: diagnosing-a-blocker
description: How to work out why something failed before telling anyone what caused it — the difference between what you observed and what you concluded, and the checks that separate them.
agents: [ceo, cto, engineering_lead, coo, solutions_architect, agent_operations_engineer, qa_engineer]
---

# Diagnosing a blocker

The expensive mistake in this company is not being stuck. It is being stuck
and reporting a confident, specific, wrong cause — because the founder acts
on it, the fix doesn't work, and the hours spent were spent on nothing.

This has happened three times. Each one was fluent and disprovable in a
single call:

- A repo name was read out of an example string in a tool's own schema
  (`e.g. "doc-intel"`) and reported to the founder as an approved repo.
- `read_repo_file` returned "not found", and that was reported as *"the repo
  is empty"*. The repo had a commit and a README. The observation was "I
  could not see this file"; the conclusion added everything else.
- A plan was reported as locked with no way forward, without calling
  `check_daily_plan`, which would have said otherwise.

The shape is always the same: **an absent observation gets promoted to a
cause.**

## The rule

Say what you observed. Then, separately, say what you think it means, and
label it as what you think.

> Observed: three 404s on `PUT /repos/.../contents/...`, at different paths
> and sizes. Also 404 on read.
> Most likely: the token cannot see this repo — GitHub returns 404 rather
> than 403 for repos a token lacks access to.
> Not yet checked: whether the token is fine-grained or classic.

That report is useful even if the guess is wrong, because the founder can
see the evidence and form their own view. "The repo is empty — push a
README" is useless when it's wrong, and worse than useless because it sends
them off to do the wrong thing.

## Before naming a cause

**Write down at least two explanations that fit the evidence.** If you can
only think of one, you have not looked at it yet. A 404 fits "doesn't
exist", "can't see it", "wrong path", and "wrong repo" equally well.

**Check the cheapest one first.** Most of these are one tool call.
`read_repo_file` on a path you know should exist. `check_daily_plan`.
`list_approved_repos`. A call that takes ten seconds beats an inference that
costs an hour.

**Try to disprove your favourite.** If you think the repo is empty, read the
README — the file every new repo has. If it comes back, you were wrong and
you found out for free.

**Look for the pattern, not the instance.** Three identical failures across
different inputs is information: whatever differs between those inputs is
*not* the cause. Different file sizes failing identically rules out size.

## Words that need evidence behind them

- **"Confirmed"** — only after you saw it yourself, this turn. Not because
  it follows from something.
- **"Root cause"** — only when you can say what would change if you were
  wrong.
- **"The only way"** — almost never true, and it forecloses the founder's
  options for them.
- **"Blocked"** — say what you tried, what came back, and what you have not
  tried yet.

## When you genuinely don't know

Say that. It is a completely acceptable report, and it is far more useful
than a plausible story:

> I can't tell yet. The write returns 404 with no detail. I've ruled out the
> path (read of the same path fails identically) and the file size (three
> sizes, same result). Next I'd check whether the token can see the repo at
> all — if you can confirm its repository access, that would settle it.

An honest "I don't know, here's what I ruled out" keeps everyone's trust.
One confident wrong answer costs it, and the next report gets read with
suspicion even when it's right.

## Record what you learn

When you do find the cause, call `log_venture_note`. The next agent that
hits the same wall reads it instead of rediscovering it — and the second
walk into a dead end looks exactly as confident as the first.
