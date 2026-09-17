---
name: when-the-service-is-down
description: What to do when something that was working stops — the order of checks, how to tell "nothing is listening" from "the code is broken", and why undoing comes before understanding.
agents: [cto, engineering_lead, agent_operations_engineer, coo, solutions_architect]
---

# When the service is down

An outage is the one situation where the usual instinct — understand it, then
fix it — is backwards. Understanding takes an unknown amount of time. The
service is down for all of it.

## Undo first

If something was working and now is not, and a change landed in between, put
the change back. `revert_commit` exists for this. You do not need to know
*why* it broke to know that it broke, and the version that was working is
sitting right there in the history.

Two things this buys you: the service comes back, and you now have a fact
worth more than any amount of reasoning — reverting fixed it, so the cause is
in that commit. If reverting does *not* fix it, that is also worth knowing
immediately, because it means you have been looking in the wrong place.

Only skip the revert when the change cannot be the cause: nothing shipped, or
what shipped cannot touch what broke. Say which of those it is, out loud,
rather than skipping silently.

## Read the failure precisely

The single most expensive habit in this company is treating an absent
observation as a cause (see `diagnosing-a-blocker`). Outages are where it
costs the most, because the wrong diagnosis sends someone into DNS for two
hours over a missing environment variable.

`check_service` gives you an answer. Read exactly what it says:

| What you see | What it means | Where to look |
|---|---|---|
| No response at all, connection refused | Nothing is listening | Deployment, process crashed at boot, wrong port |
| Timeout | Something is listening and stuck | A blocking call, a dependency that is itself down |
| 502 / 503 | A proxy is up, the app behind it is not | The app crashed after boot, or never finished starting |
| 500 | The app is running and the code threw | The code path the request took |
| 404 on a path that existed | Routing, not the app | A changed route, a changed base path, a bad deploy |
| 401 / 403 | It is working, and rejecting you | Credentials, not availability |

A 500 and a connection refused are completely different problems in
completely different places. Collapsing them into "the service is down" is
how an afternoon disappears.

## Then, in order

1. **When did it last work?** A timestamp bounds the search. Everything that
   happened before it is innocent.
2. **What changed in that window?** Commits, config, a founder-set env var, a
   dependency that updates itself. Config changes are the ones nobody thinks
   of, because they leave no commit.
3. **Does it fail the same way every time?** Consistent means logic.
   Intermittent means state, capacity, or a race — and a fix that "seems to
   work" on an intermittent failure has proven nothing.
4. **Run the checks.** `run_checks` on the current code. Green with a live
   500 means the failure is in something the tests do not cover, which is
   itself the finding.

## What to tell the founder, and when

Immediately, before you know the cause, in one message:

> The API has been returning 500 since roughly 14:20. I have reverted the
> 15:41 commit; it is back up. Looking into what in that commit caused it.

Three facts: what is broken, what you did, what you are doing. Not a
hypothesis. A hypothesis in the first message will be quoted back at you for
the rest of the day, and half the time it is wrong.

Then say when it is actually fixed, and separately say what caused it. Those
are two different messages because they become true at two different times,
and merging them means the founder learns the service is up an hour later
than they could have.

## After

Write down what happened with `log_venture_note`, in one or two sentences, in
the form: *this broke because that, which we now know because of this.* The
note is the only thing standing between this outage and the identical one
next month, when nobody involved remembers it.
