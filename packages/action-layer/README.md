# @venture/action-layer

The gate every irreversible agent action passes through.

One rule: **if it spends money, ships code, or reaches a human being, it goes
through `perform()`.** Everything else here exists to make that call safe to
rely on.

```ts
import { createActionGate, createPostgresStore } from '@venture/action-layer';

const gate = createActionGate({
  store: createPostgresStore(pool),
  dailySpendCapUsd: 25,
});

const { result } = await gate.perform(
  {
    ventureId: 'inbox-triage',
    agentId: 'sales_manager',
    action: 'send_email',
    target: 'known@customer.com',
    rationale: 'They asked for pricing on Tuesday.',
  },
  () => sendEmail(to, subject, body)
);
```

If the request is refused, `sendEmail` never runs and `ActionDenied` is thrown
with a reason fit to show a person. Either way it's in the log.

## Why the work is a callback

Because ask-then-act has a gap. The obvious API is `if (await canSend()) {
send() }`, and the gap between the two is where recording gets forgotten — and
an audit trail with holes in it is worse than none, because it reads as
complete. Handing the work to the gate means the decision, the action and the
record are one thing.

## What it checks, in order

Cheapest and most absolute first.

| # | Check | Refuses when |
|---|-------|--------------|
| 1 | **Global halt** | The founder pulled the cord. Nothing gets past this. |
| 2 | **Scope** | No scope granted, or granted and switched off. |
| 3 | **Target allowlist** | The target isn't on the list for this venture. |
| 4 | **Cooldown** | Too soon after the last one of these. |
| 5 | **Rate caps** | Per-day or per-week quota used up. |
| 6 | **Spend cap** | This action would cross the daily ceiling. |

Three defaults are load-bearing:

- **Nothing is permitted until it's granted.** No scope means refused.
- **An empty allowlist permits nothing.** It does not mean "unrestricted" —
  that misreading is how a scope system quietly opens up, so `NULL` (no target
  rule) and `[]` (a target is required and none are approved) are kept
  distinct all the way down to the column.
- **A failed action doesn't consume quota.** A send that errored reached
  nobody, so counting it would let a flaky provider eat the day's allowance.

## The log

Append-only, and enforced by triggers rather than a comment — `UPDATE` and
`DELETE` on `action_log` raise. A record an agent could edit isn't evidence,
and answering *"what did it actually do"* is the entire point.

Denials are recorded too, and they're the valuable rows: they're how you find
out an agent has been trying the same blocked thing for a week.

Three outcomes, kept distinct: `allowed`, `denied` (the gate refused; `reason`
says why), `failed` (the gate allowed it and the work threw).

## Setup

```bash
psql "$DATABASE_URL" -f node_modules/@venture/action-layer/schema.sql
```

Then grant a scope — off until you do:

```ts
await store.putScope({
  ventureId: 'inbox-triage',
  action: 'send_email',
  enabled: true,
  allowedTargets: ['known@customer.com'],
  maxPerDay: 20,
  maxPerWeek: 50,
  cooldownMs: 30_000,
});
```

`createMemoryStore()` is the same thing without a database — for tests, and
for running before Postgres exists.

## Tests

```bash
npm test
```

26 tests, all about refusal: the permissive paths are obvious, and this
layer's whole value is in the cases where it says no and in the log being
trustworthy afterwards.

## Provenance

The policy model here is lifted from a system already running it in
production — per-venture scopes, allowlists, daily and weekly caps, a burst
cooldown, a global halt, and spend metered at the one chokepoint every paid
call goes through. What's new is that it's reusable, backed by Postgres
instead of JSON files, and enforces append-only in the database.
