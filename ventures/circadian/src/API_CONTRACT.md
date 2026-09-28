# CircadianAPI — API Contract

All request/response bodies are JSON. `/health` is open, no auth.
`/v1/shift-plan` and `/v2/plan` require an API key; each call counts
against the key's plan. The public page for developers, with the plans and
a form for a free key, is `/developers`. The schema is `/openapi.json`.

## Authentication

`Authorization: Bearer ca_live_<token>`

A key comes from the developer page (a free key, once per email address),
from the owner (`/admin/api-keys`, after a paid plan is paid), or from the
`CIRCADIAN_API_KEYS` variable (Starter). Keys are stored by hash only and
survive a redeploy.

## Plans and limits

| Plan | Price | Plans a month | Requests a minute |
|---|---|---|---|
| Free | $0 | 100 | 10 |
| Starter | $29 a month | 5,000 | 60 |
| Scale | by arrangement | 100,000 | 300 |

A plan is one successful request to `/v2/plan` or `/v1/shift-plan`,
however many flights it covers. The month is the calendar month in UTC.
Every plan response carries `X-Plan`, `X-Quota-Limit` and
`X-Quota-Remaining`. `GET /v1/usage` answers even past the quota:

```json
{ "call_count": 37, "period": "2026-10", "plan": "free", "monthly_plans": 100, "remaining": 63 }
```

## Errors

Every refusal has one shape, whatever the status:

```json
{ "error": { "code": "quota_exceeded", "message": "This key has used the 100 plans..." } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | A field is missing, malformed or impossible; the message names it |
| 401 | `unauthorized` | Missing or malformed header, or an unknown or switched-off key |
| 429 | `rate_limited` | Over the plan's requests a minute; `Retry-After` says when to retry |
| 429 | `quota_exceeded` | The month's plans are used; resets on the 1st (UTC) |
| 500 | `internal_error` | A bug on our side |

## POST /v1/shift-plan

### Request

| field | type | required | notes |
|---|---|---|---|
| `direction` | string | yes | `"eastward"` (phase advance) or `"westward"` (phase delay). **Never inferred by the API — see "Direction at 12 zones" below.** |
| `time_zones_shifted` | integer | yes | Absolute (unsigned) number of time zones crossed. `>= 0`. |
| `current_sleep_start_hour` | float | no, default `23.0` | Origin-local clock hour, `[0, 24)`. |
| `current_sleep_end_hour` | float | no, default `7.0` | Origin-local clock hour, `[0, 24)`. |

### Response `200`

```json
{
  "direction": "eastward",
  "time_zones_shifted": 5,
  "total_days": 5,
  "rate_hours_per_day": 1.0,
  "days": [
    {
      "day": 1,
      "cumulative_shift_hours": -1.0,
      "sleep_start_hour": 22.0,
      "sleep_end_hour": 6.0,
      "light_seek_start_hour": 6.0,
      "light_seek_end_hour": 8.0,
      "light_avoid_start_hour": 20.0,
      "light_avoid_end_hour": 22.0,
      "melatonin_hour": 21.5
    }
  ],
  "disclaimer": "This schedule is generated from published circadian-rhythm research for general informational purposes only. It is not medical advice, diagnosis, or treatment, and has not been reviewed by a clinician. Consult a qualified healthcare provider before changing sleep, light, or medication routines, especially if you have a sleep disorder, are pregnant, or take other medication."
}
```

`disclaimer` is present on **every** successful response — this is a
non-medical, informational tool, not medical advice, diagnosis, or
treatment. Do not strip this field client-side; it must reach the end
user, not just live in documentation.

### Error `400`

```json
{ "error": { "code": "invalid_request", "message": "..." } }
```

Returned for an unknown `direction` value or `time_zones_shifted < 0`.

## Field semantics you must not confuse

### `time_zones_shifted` vs `cumulative_shift_hours`

- `time_zones_shifted` (request field) is **always absolute/unsigned** —
  it is a count of zones crossed, e.g. `5`, never `-5`.
- `cumulative_shift_hours` (response field, per day) is **signed**:
  - **negative** for `eastward` (phase advance — the clock moves earlier)
  - **positive** for `westward` (phase delay — the clock moves later)

These are not the same kind of number and must not be treated as
interchangeable. A client that assumes `cumulative_shift_hours` is always
positive, or that its sign encodes direction redundantly with the
`direction` field, will misread the schedule.

### `time_zones_shifted = 0` — valid no-op, not an error

A request with `time_zones_shifted: 0` is valid and returns `200`, not a
`400`. It represents "no shift needed" (e.g. same time zone). Shape:

```json
{
  "direction": "eastward",
  "time_zones_shifted": 0,
  "total_days": 0,
  "rate_hours_per_day": 1.0,
  "days": [],
  "disclaimer": "..."
}
```

`total_days` is `0` and `days` is an empty list — there is nothing to
schedule. `direction` still echoes back whatever the caller sent (it is
still a required field on the request even when it has no effect on the
output), and `rate_hours_per_day` still reflects the rate for that
direction. Do not treat this response as an error condition.

### Direction at 12 zones — never inferred, always required

The API **never infers `direction` from `time_zones_shifted`, at any
value, including exactly 12.** Twelve zones is the halfway point around
the globe, where "shortest way around" is genuinely ambiguous — going
12 zones eastward and 12 zones westward land you in the same wall-clock
offset, but they are computed at different rates (`1.0h/day` eastward vs
`1.5h/day` westward) and produce different schedules and a different
`total_days`.

**This is a hard requirement, not a note:** the caller must always pass
an explicit `direction`. The request schema makes `direction` a required
field with no default, at every value of `time_zones_shifted` — this is
enforced the same way at 12 as at any other value. Do not add
zone-count-based direction inference to this endpoint; if that behavior
is ever wanted, it must be a new, explicitly-named parameter, not a
change to how `direction` is interpreted.

## GET /health

No auth. Returns `{"status": "ok"}`. Used for liveness checks only —
does not indicate whether API keys or rate limiting are configured.

## Rates used by the engine

| direction | rate | source |
|---|---|---|
| eastward (advance) | 1.0 h/day | published circadian literature (e.g. Eastman & Burgess 2009; Sack et al. 2007 AASM practice parameters) |
| westward (delay) | 1.5 h/day | same |

`total_days = ceil(time_zones_shifted / rate)`, except `time_zones_shifted
== 0` which gives `total_days = 0` (see above).

## POST /v2/plan (and the consumer app)

A plan from a real trip rather than a zone count. Same key and rate limit as
v1. The consumer app on this host calls the identical engine at
`POST /app/plan`, open and limited to 20 requests a minute per IP address,
and `GET /app/plan.ics` with the same fields as query parameters returns the
plan as a calendar file with reminders.

### Request

| field | type | required | notes |
|---|---|---|---|
| `departure` | datetime | yes | Wall-clock time at the origin, e.g. `2026-10-10T23:55`. For stopovers, the first departure. |
| `departure_tz` | string | yes | IANA zone of the origin, e.g. `Asia/Bangkok`. |
| `arrival` | datetime | yes | Wall-clock time at the final destination. |
| `arrival_tz` | string | yes | IANA zone of the destination. |
| `sleep_start`, `sleep_end` | `HH:MM` | no | Usual bedtime and wake time at home. |
| `chronotype` | string | no | `early`, `intermediate` (default) or `late`; sets sleep times only when they are not given. |
| `preflight_days` | int 0-3 | no, default `2` | Days to start shifting before departure. |
| `return_departure` | datetime | no | When the traveller leaves the destination. Under 72 hours there means stay on home time. |
| `melatonin`, `caffeine` | bool | no, default `true` | Include melatonin timing (advancing only, never a dose) and caffeine windows. |
| `strategy` | string | no, default `auto` | `auto` picks the faster way round, which past about nine zones east is often delaying; `advance` or `delay` forces it. |
| `legs` | list | no | For connections: every flight in order, each with `departure`, `departure_tz`, `arrival`, `arrival_tz`. Replaces the four single-flight fields. Stopovers appear as `stopover` events on their own clock; sleep is advised on board, or at a stopover of 4 hours or more, only where it covers a night at the destination. |
| `journeys` | list | no | Several journeys in order, each `{legs: [...]}`, separated by stays: a round trip, an open jaw (back from a different city) or a multi-city trip. Each journey's plan starts from the body clock the previous one predicts at that departure, pre-flight shifting applies to the first only, and each journey's events stop before the next departure. Replaces `legs` and `return_departure`. `POST /v2/plan` and `/app/plan` return the journeys merged into one plan; `POST /app/itinerary` (same fields) returns `{journeys: [plan, ...]}`, one per journey. |

### Response `200`

`mode` is `adapt`, `stay_on_home_time` or `no_shift`. With `strategy`,
`shift_hours`, `preflight_days`, `days_to_adapt_after_arrival`,
`adapted_by`, a one-paragraph `summary`, the `disclaimer`, and `events` in
time order. Each event has `type` (`sleep`, `light_seek`, `light_avoid`,
`melatonin`, `caffeine_ok`, `nap`, `flight`, `stopover`), `where` (`home`,
`flight`, `stopover`, `destination`), `start`/`end` in UTC, `start_local`/`end_local` on the clock
of where the traveller is, `local_tz`, and a `note` to show the traveller.

Sleep before departure follows the shifting body clock; from arrival, sleep
is on local time and light does the shifting. Light windows never overlap
planned sleep.

## Consumer app endpoints

Open, 20 requests a minute per IP, keyed by a device id the phone generates
(a UUID). Not for API customers.

- `GET /app/push/key`: the web-push public key.
- `POST /app/push/subscribe` `{device, subscription, trip}`: plan the trip and
  schedule its reminders for this phone. `POST /app/push/unsubscribe`
  `{device}` deletes them. `GET /app/push/status?device=`.
- `GET /whoop/connect?device=`: to WHOOP's sign-in. `GET /whoop/callback`:
  WHOOP's return; redirects to `/?whoop=connected|failed|cancelled`.
- `GET /app/whoop/status?device=`, `POST /app/whoop/disconnect` `{device}`.
- `POST /app/whoop/progress` `{device, trip}`: each passed planned night with
  `planned_bed`, `planned_wake`, and when WHOOP recorded it, `actual_bed`,
  `actual_wake`, `bed_minutes_late`, `wake_minutes_late`, `on_track` (both
  within 60 minutes), `sleep_performance`, `recovery`; plus `summary`,
  `advice` and `latest_recovery`. `409` with `whoop_not_connected` when there
  is no connection.
- `GET /app/plan.ics?t=`: `t` is the whole trip as base64url JSON, for trips
  with connections.

## Pricing

See *Plans and limits* above; the same table is on `/developers`, filled
from the same numbers the server enforces (`PLANS` in `auth.py`). Money is
taken by a Stripe payment link; the key is moved to the paid plan when it
is paid.

## Non-medical disclaimer

This is general informational tooling based on published circadian-rhythm
research. It is **not** medical advice, diagnosis, or treatment, and has
not been reviewed by a clinician. It is returned verbatim in the
`disclaimer` field of every successful `/v1/shift-plan` response — see
above — precisely so it reaches the end user, not just a reader of this
document.
