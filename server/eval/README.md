# Behavioral eval (starter scaffold)

Unit tests in `server/test/` check the data layer (ledger math, venture
state transitions) — nothing checks whether an agent's actual *judgment*
is any good. This is that: a small eval that runs real scenarios against
the real org chart (`server/agents/`) and real action handlers
(`server/actionHandlers.js`), and grades the real end state — did the CFO
actually mark a milestone done off nothing but a plan, did the Critic
actually flag a tiny idea — rather than eyeballing the reply text.

**This is a starter set of 10 cases, not a finished eval.** Read
`scenarios.js`, decide which cases match how you actually expect this team
to behave, cut what doesn't, and add more before treating the pass rate as
meaningful. Anthropic's own guidance for building evals like this suggests
15-100 cases reviewed by the person who owns the product — this scaffold
gets you the harness and a first 10, not the finished article.

## Running it

Requires a real `ANTHROPIC_API_KEY` (in `server/.env`, or exported in your
shell) — **this makes real, billed API calls.** It does not touch your
real `server/data/`: every run seeds a throwaway temp directory instead
(the same `JARVIS_DATA_DIR` isolation the unit tests use).

```bash
cd server
node eval/runner.mjs              # run every scenario
node eval/runner.mjs <scenario-id> # run just one, e.g. for iterating on a prompt
```

Output is plain stdout: `[PASS]`/`[FAIL]` per scenario with a one-line
reason, then a summary line with the **actual measured** cost, duration,
and token usage for that run (using the same `server/usage.js` module the
Daily Report uses) — nothing here estimates cost in advance, since a
guessed number is routinely off by several times the real one.

## What each scenario checks

See the header comment in `scenarios.js` for the exact shape. Each one
targets a specific judgment call, in pairs where it matters (a case that
should trigger an action, paired with a near-identical one that shouldn't
— so the eval can't pass just by always guessing "no"):

- **CFO milestone judgment** — records a milestone the founder reports as
  genuinely shipped, refuses to record one that's still just a plan.
- **Validation Critic ambition judgment** — flags a lifestyle/personal-use
  idea as too small, doesn't manufacture a smallness objection against a
  genuinely large one.
- **Venture Studio memory** — notices when a new pitch resembles a venture
  already tried and killed (exercises the `pastLessons` context added
  alongside this eval).
- **Studio ambition bar** — refuses to log a proposal for a banned cliche
  category (a generic resume builder).
- **CEO kill judgment** — kills a venture given a clear, concrete reason;
  does *not* kill one on vague doubt alone.
- **Finance Manager revenue judgment** — logs revenue that actually
  landed, doesn't log a hoped-for deal as if it had.

Most grades are programmatic (read the real end state — did
`ventures.json`'s milestone status actually change, did the ledger's net
actually move) rather than keyword-matching the reply, since
that's a much harder signal to game. The two Validation Critic cases are
the exception — they check for specific words in the reply, since
"correctly identifies this as too small" doesn't have a clean end-state
signal the way an action call does. Treat those two as the least reliable
in this set; a rubric read by a second model call would be the natural
upgrade if keyword-matching turns out too brittle in practice.

## Extending this

- Add a scenario: append an object to the `scenarios` array in
  `scenarios.js` following the existing shape. `setup()` seeds venture/
  ledger state via the real `finance/ventures.js` and `finance/ledger.js`
  functions; `grade()` reads it back the same way.
- This intentionally is **not** picked up by `npm test` / CI — it's named
  `runner.mjs`/`scenarios.js` (not `*.test.js`, not under `server/test/`)
  specifically so a CI run without an API key doesn't fail on it, and so
  `npm test` never triggers a billed run by accident.
