# Working in this repo

## Ponytail: the decision ladder

Adapted from [Ponytail](https://github.com/dietrichgebert/ponytail) — a ruleset for AI
coding agents. It is not a dependency and nothing imports it; it lives here because
this is where an agent reads before it writes.

Before writing code, stop at the first rung that holds:

1. **Does this need to exist?** → no: skip it (YAGNI)
2. **Already in this codebase?** → reuse it, don't rewrite
3. **Stdlib does it?** → use it
4. **Native platform feature?** → use it
5. **Installed dependency?** → use it
6. **One line?** → one line
7. **Only then:** the minimum that works

The ladder runs *after* understanding the problem, not instead of it: read the code the
change touches and trace the real flow before picking a rung.

**Lazy, not negligent.** Trust-boundary validation, data-loss handling, security and
accessibility are never on the chopping block. Write only what the task needs, and never
cut validation, error handling, security or accessibility.

## What the ladder does and does not mean here

This codebase has two habits that are not "extra code", and the ladder must not be read
as an argument against either.

**Comments carry the rationale.** Modules here explain *why* a decision was made, and
usually what went wrong before it. `server/language.js` records that Whisper returns
`"spanish"` rather than `"es"`; `server/realtime/twilioBridge.js` records that a bare
`return` on an unhandled upgrade leaks the socket. Deleting that is not writing less
code — it is deleting the reason the code is shaped the way it is, and it is how the same
bug gets reintroduced. Rung 1 asks whether a *feature* needs to exist, never whether an
explanation does.

**Tests pin behaviour, not implementation.** A test that fails only against the old code
is the deliverable, not overhead. Several bugs here — the leaked upgrade socket, the
unauthenticated `/api/calls/*` endpoints — were found by writing the test, not by reading
the diff.

Where the ladder genuinely bites in this repo: new abstractions, new dependencies, new
config surfaces, and new endpoints that duplicate an existing one. Rung 2 in particular —
`api/chat.js` already carried the access token on every request, and going around it with
raw `fetch` is what made two new endpoints return 401.

## Other conventions

- **Tests:** `npm test` from the repo root. Everything must pass before a push.
- **Client:** `npm run build --prefix client` after changing anything under `client/`.
- **Secrets** live in Railway variables and never in the repo, a commit message, or chat.
- **Env vars** get an entry in `server/.env.example` with a sentence on what breaks
  without them.
- **Failure modes** are named in the message: a refusal says which variable to set, and a
  status check describes the whole capability rather than half of it.
