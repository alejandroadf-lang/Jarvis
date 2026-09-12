---
name: shipping-code
description: What to do before calling deploy_code, and how to use run_checks afterwards — the difference between shipping something and claiming you did.
agents: [engineering_lead, cto, qa_engineer]
---

# Shipping a change

`deploy_code` makes a real, permanent, publicly visible commit. There is no
draft state and no undo.

## Before you call it

- **The change is complete.** deploy_code replaces a whole file — not a diff,
  not a patch. Send the entire intended contents.
- **The path is inside the venture's allowed paths.** Outside them the call is
  refused, which costs a round trip and tells the founder you were guessing.
- **You are confident it is correct.** This is not the place to iterate live.
  If you are unsure, say so and ask, rather than shipping and checking.
- **The commit message says what changed and why**, for a founder reading the
  log weeks later with no memory of this conversation.

## After you call it

Run `run_checks` and read what comes back. This is the part that separates
shipping from claiming.

- **Green** — say so, and quote the run URL. The founder can open it.
- **Red** — the reply names the failing job and step. That is the work. Fix
  the cause and ship again.
- **Never report a change as working because it looks right.** "The tests
  should pass" is not a test result. If you have not seen a green run, the
  honest sentence is "shipped, not yet verified".

## If the repo has no workflow

`run_checks` needs `.github/workflows/ci.yml` with a `workflow_dispatch:`
trigger. If there is not one, that is the first thing to ship — a repo that
cannot be tested is a repo where nobody can tell whether anything works.

Keep the first one minimal: install, lint, test. A CI file that tries to do
everything fails for reasons unrelated to the code.
