---
name: writing-tests-that-assert
description: How to write a test that would actually fail if the code were wrong — and how to spot the ones that pass against a broken implementation.
agents: [engineering_lead, qa_engineer, cto, solutions_architect]
---

# Writing tests that assert

A test that cannot fail is worse than no test, because it buys confidence
nobody paid for. The plan item *"tests for eastward and westward cases"* is
exactly the phrasing that produces two tests which call the function, check
it returned something, and would pass against an implementation that always
returns zero.

## The check that matters

Before you finish a test, ask: **what would I have to break for this to
fail?** If the answer is "delete the function" or "make it throw", the test
is measuring that the code exists. It is not measuring that it is right.

Then break it, for real: change a sign, swap a branch, return a constant. If
the test still passes, it was never testing that behaviour. Change it back
and write a better assertion.

## Assert on values

```python
# Measures nothing.
result = plan_shift(origin="LHR", destination="JFK")
assert result is not None
assert "direction" in result

# Measures the behaviour.
result = plan_shift(origin="LHR", destination="JFK")   # westward, 5 zones
assert result.direction == "delay"
assert result.days_to_adjust == 4       # 5 zones at ~1.5 h/day, rounded up
```

The second one fails if the direction logic inverts, if the rate is wrong,
or if the rounding goes the wrong way. That is the point.

## One behaviour per test, named after it

`test_westward_travel_delays_the_phase` tells you what broke from the
failure line alone. `test_plan_shift` tells you to go and read the test.

## Test the cases that are actually hard

For anything with direction, sign, or a boundary, the interesting inputs are
where behaviour changes:

- **Both directions** — eastward advances, westward delays. A single-
  direction test passes against code that ignores direction entirely.
- **The boundary** — zero zones, and the antipodal case where east and west
  are the same distance. Which way does it go, and is that deliberate?
- **The wrap** — crossing the date line. An implementation that subtracts
  offsets naively gets 19 zones instead of 5.
- **The rejected input** — what happens with a timezone that doesn't exist?
  A test that asserts the error is a test.

## Do not write the test to match the code

If you write the implementation first and then the assertions, you will
encode whatever it currently does, bug included. Work out the expected value
from the spec — the protocol, the arithmetic, the contract — and write that
number down. If the code disagrees, one of you is wrong, and finding out
which is the entire value of the exercise.

## Fixtures are part of the test

If a test needs three setup calls and a sleep to reach the state it
measures, it will be skipped or deleted within a month. Build the state
directly rather than through the slow path, and say in a comment why you did
— a future reader will otherwise "fix" it back.

## Then actually run them

`run_checks` and read the result. A test suite you have written but never
executed is a claim, not a check. See the `shipping-code` skill.
