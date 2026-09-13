---
name: api-authentication
description: Putting authentication on a small API without building an identity provider — API keys done properly, what to hash, what to rate-limit, and the mistakes that leak a key into a log file.
agents: [engineering_lead, solutions_architect, cto, security_reviewer, qa_engineer]
---

# Authenticating an API

Every venture that sells an API needs this on day one, and it is the part
most likely to be either skipped or over-built. Skipped means anyone can run
up the bill. Over-built means a week spent on OAuth flows for an API with no
customers.

## Use API keys for v1. Not OAuth, not JWTs.

OAuth exists so a third party can act on a *user's* behalf without holding
their password. If your customer is a developer calling your endpoint from
their own server, there is no third party and no user to delegate for — the
whole dance buys nothing and costs a week.

JWTs are for when you need to verify a token without a round trip to the
database. With one service and one database that round trip is the thing you
were trying to avoid, and you have traded it for key rotation you cannot do,
because a signed token is valid until it expires whether you want it to be or
not.

So: an opaque random string the customer sends on every request. Reach for
something else when a specific requirement demands it, and be able to name
the requirement.

## How to do keys properly

**Generate from a cryptographic source.** `secrets.token_urlsafe(32)` in
Python. Not `random`, not a UUID, not a hash of the email address. A key a
customer can guess from their own is not a key.

**Prefix it so it is identifiable.** `ca_live_xxxx`. Two reasons, both
practical: a leaked key found in a public repo can be traced to you and
revoked, and the secret scanners that crawl GitHub can be taught the prefix.
Distinguish live from test in the prefix, not in a database column — then a
test key pasted into production fails loudly rather than working.

**Store a hash, never the key.** SHA-256 of the key, with the prefix and last
four characters in plaintext so a customer can recognise which key is which
in a list. Lookup is by hash, so the comparison is against a value your
database can lose without it mattering. The consequence to accept up front:
you can show the key exactly once, at creation. Say so in the response.

**One key per customer per environment, revocable independently.** A shared
key cannot be rotated without breaking everyone holding it, which in practice
means it is never rotated.

## Where the key travels

`Authorization: Bearer <key>`, and nowhere else.

Never a query string. A URL is logged by your web server, your proxy, your
CDN, the customer's browser history and every error tracker in between. This
is the most common way a key that was generated correctly and hashed
correctly ends up sitting in plaintext in a log file that a support engineer
can read. The same goes for anything you log yourself: log the key's *id* or
its prefix, never its value, and check the error paths too — an exception
handler that dumps the whole request is the leak the happy path does not have.

Never a custom header like `X-API-Key` without a reason. `Authorization` is
what every HTTP client, proxy and tool already knows to redact.

## Failing closed

Return **401** when the key is missing, malformed or unknown. Return **403**
when the key is valid but not entitled to this thing. Do not say which of
those it was in more detail than that — "invalid key" is the right message,
and "no account matches that key" tells an attacker they guessed a format.

The check runs *before* any work, including before parsing the body. An
unauthenticated request should cost you a hash lookup, not a model call.

And fail closed on the code path, not just the happy one: if the middleware
throws while looking up a key, the request is rejected, never admitted. Write
the test for that case specifically — it is the one that silently inverts.

## Rate limiting is part of authentication, not a later feature

A valid key with no limit on it is a valid key that can cost you your monthly
budget in an afternoon, by accident, in a customer's retry loop. Limit per
key, not per IP — the IP is shared and the key is the thing you are billing.

A fixed window counter in memory is enough to start, and enough to stop the
runaway loop that is the realistic failure. Return **429** with
`Retry-After`. Keep the limit in config, not in a literal, so raising it for
one customer is not a deploy.

## Before you say authentication is done

- A request with no header: 401.
- A request with a key that does not exist: 401, same message shape.
- A request with a revoked key: 401.
- A valid key, over the limit: 429 with `Retry-After`.
- The database holds no value that would work as a key if it leaked.
- `grep` the repo for the prefix: every match is a test fixture, not a real key.
- The key is absent from every log line, including the exception handler.

That last one is worth doing as a test rather than an inspection. Capture the
logs for a failing authenticated request and assert the key is not in them.
Inspection passes today and the next error handler someone adds does not know
the rule.
