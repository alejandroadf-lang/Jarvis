---
name: writing-an-api-contract
description: Designing the surface of an API before building it — resource shapes, units in field names, one error shape, and which changes you can make later without breaking a customer.
agents: [solutions_architect, product_manager, engineering_lead, cto, qa_engineer]
---

# Writing an API contract

The contract is the only part of a product you cannot iterate on freely.
Internals can be rewritten at will; a field name a customer's code reads is
permanent in practice, because changing it breaks someone who is not in the
room. So the hour spent on the shape before any code exists is the cheapest
hour in the project.

This is design, not documentation. If FastAPI and Pydantic are generating the
OpenAPI spec (see `building-a-python-api`), the document writes itself — what
it cannot do is tell you the shape was wrong.

## Start from the call, not the data

Write the request and the response you wish existed, as literal JSON, before
writing a model. Then ask what the caller does with each field. A field
nobody acts on is a field to remove: every one you ship is one you support
forever, and "we might need it later" is how an API accumulates fields whose
meaning nobody can reconstruct.

Name the endpoint after the thing the caller gets, not the computation you
run. `POST /v1/schedules` beats `POST /v1/calculate` — the caller is asking
for a schedule, and the fact that you calculate it is your business.

## Put the unit in the field name

`duration_minutes`, not `duration`. `price_usd_cents`, not `price`.
`starts_at` for a timestamp, and it is ISO 8601 with an offset, always.

This reads as pedantry until the first support thread that is entirely about
whether a number was seconds or milliseconds. A caller guessing a unit wrong
produces plausible output that is wrong by a factor of sixty, which no test
catches and no error reports. The name is the only place that ambiguity can
be removed for free.

Money in integer minor units. A float for a price will eventually produce a
total that is off by a cent and an invoice you cannot explain.

## One error shape, everywhere

Pick it once and use it on every failure path:

```json
{ "error": { "code": "invalid_timezone", "message": "..." } }
```

`code` is a stable machine-readable string the caller can branch on — it is
part of the contract, so treat renaming one as a breaking change. `message`
is for a human reading a log and may be reworded freely. Validation errors add
`field`.

Two things go wrong when this is left to each handler. Callers end up parsing
prose, so a reworded message breaks their code. And a handler somewhere
returns a 200 with an error inside it, which is the worst outcome available —
every HTTP client in the world treats 200 as success, so the failure is
invisible until someone reads the data.

Status codes carry meaning: 400 the caller's fault, 401/403 authentication and
entitlement, 404 no such thing, 422 well-formed but semantically impossible,
429 too fast, 5xx yours. Never a 200 with `"error"` in it. Never a 500 for
something the caller did — that is your monitoring going off for their typo.

## Version from the first release

`/v1/` in the path from the first commit, even though there is no v2 and may
never be. Retrofitting a version prefix later means every existing caller is
on an unversioned path you now have to support indefinitely.

Then keep v1 honest. These are **safe** to add after launch:

- a new optional request field with a default that preserves today's behaviour
- a new field in a response
- a new endpoint
- a new enum value in a field *you* write, if the contract said to expect
  unknown values

These are **breaking**, whatever the changelog calls them:

- renaming or removing a field
- changing a type, including integer to string
- making an optional field required
- tightening validation that used to pass
- changing a default
- changing the meaning of a value while keeping its name — the worst kind,
  because nothing errors and everything is quietly wrong

When you need a breaking change, add the new shape alongside the old one and
leave the old one working. Two code paths for a while is cheaper than one
broken customer.

## Pagination and lists

Any list endpoint is paginated from the start, even when the data set is
tiny, because the first customer with ten thousand rows is not a reason to
change the contract. Return `{ "data": [...], "next_cursor": null }` — a
cursor rather than an offset, so inserts do not shift rows between pages.

An envelope on lists and a bare object on single resources is fine and
conventional. Be consistent about which is which.

## Be explicit about what you do not promise

Write down the things a caller should not infer: that ordering is stable
unless you say so, that ids are opaque and should not be parsed, that an
unknown field in a response should be ignored rather than rejected. Each is a
sentence in the docs that buys you a freedom later.

## The check before you build

Hand the JSON to someone who has not seen the design and ask them to describe
what each field means and what they would send. Every question they ask is a
name or a doc line that is doing less work than you thought. Fix it now: it
costs an edit before launch and a migration after.
