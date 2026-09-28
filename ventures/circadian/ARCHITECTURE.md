# Circadian architecture

What runs, where the data lives, what each part costs as travellers grow, and
what to change at each size. Written when the storage moved from JSON files to
SQLite, with the measurements that moved it.

The rule behind every choice here: build for the next order of magnitude, and
write down what the one after that needs, rather than build it now. Circadian
is one founder's product on one Railway service. Nothing below adds a service
to run, back up or pay for until the numbers say so.

## The system

```
 phone (PWA, src/web)                      Railway service (one container)
 ─────────────────────                     ──────────────────────────────────────────────
 index.html + app.js                        Jarvis (Node, server/)
 service worker: app shell offline   ──►    └─ /circadian/*  proxied to ─┐
 localStorage: trip, plan, device id                                    │
                                            Circadian (FastAPI, one uvicorn process)
                                            ├─ HTTP routes (src/app.py)
                                            ├─ planner (itinerary.py, shift_logic.py, advice.py)
                                            ├─ push.py      reminders + the minute scheduler
                                            ├─ checkin.py   morning check-in: webhook + sweep
                                            ├─ whoop.py     OAuth, tokens, sleep/recovery reads
                                            ├─ flights.py   flight number → times (AeroDataBox)
                                            ├─ analytics.py PostHog, server side, off by default
                                            └─ store.py ──► circadian.sqlite3 on the volume
                                                              (CIRCADIAN_DATA_DIR)
 outbound:  WHOOP API · web push services (Apple, Google, Mozilla) · AeroDataBox · PostHog
 inbound:   WHOOP webhook (POST /whoop/webhook, HMAC-signed)
```

Jarvis starts Circadian as a child process and forwards `/circadian/*` to it
(`server/circadian.js`). One process means one scheduler, which is what keeps
a reminder from being sent twice.

## Components

| Module | Owns | State |
|---|---|---|
| `itinerary.py`, `shift_logic.py`, `advice.py` | The plan: sleep, light, caffeine, melatonin, naps, around every leg | None. Pure functions of the trip. |
| `push.py` | Subscriptions, the reminder list per device, the minute tick | `push` records |
| `checkin.py` | One morning message per night, from the webhook or the sweep | Fields on the `push` record |
| `whoop.py` | Tokens, refresh, the two-week baseline, progress against the plan | `whoop` and `whoop_users` records, a baseline cache in memory |
| `flights.py` | Flight lookup, its cache and the daily spend ceiling | In memory |
| `auth.py` | API keys and rate limits for `/v1` and `/v2`, per-IP limit for `/app` | In memory |
| `store.py` | Records, transactions, the server's own secrets | `circadian.sqlite3` |

The planner has no state and no I/O. That is what lets the check-in rebuild a
plan from a stored trip, and what makes it the part that scales by adding
processes when the time comes.

## Data flow

**Making a plan.** The page posts the trip to `/app/plan`. The planner
returns it, and the page keeps trip and plan in localStorage, so the next
open draws the saved plan at once and refreshes it in the background. Nothing
is stored on the server.

**Turning reminders on.** The page posts its push subscription and the trip
to `/app/push/subscribe`. The server plans the trip and stores one `push`
record: the subscription, the dated reminders, the trip, and the planned
wakes. Turning reminders off deletes the record.

**The minute tick** (one thread, `push.start_scheduler`):

1. `push.dispatch` sends every reminder that is due and marks it sent. One
   more than 30 minutes stale is skipped. A subscription the push service
   calls gone is deleted, unless the phone re-subscribed meanwhile.
2. `checkin.sweep` finds devices whose planned wake was one to four hours
   ago, reads the stored wakes, and runs the check-in only for those. It asks
   WHOOP at most every 20 minutes per device.

**The morning check-in.** WHOOP posts a signed webhook when it scores a
night. The server finds the device through the `whoop_users` index, drops
that device's cached baseline, rebuilds its plan, compares the night with
it, and pushes one message. The sweep covers mornings the webhook missed.
Each night is recorded as sent, so the two never both send.

**WHOOP.** The OAuth state is HMAC-signed with the server's own secret.
Tokens refresh under a per-device lock, because WHOOP issues a new refresh
token each time and refuses the old one.

## API design

Three audiences, three prefixes, one engine.

| Prefix | Caller | Auth | Limit |
|---|---|---|---|
| `/v1`, `/v2` | Developers | API key (`auth.py`), never stored raw | Per key |
| `/app/*` | The web app on a phone | None: an anonymous device id | 60 a minute per IP |
| `/whoop/*` | WHOOP: the OAuth redirect and the webhook | Signed state; HMAC-signed body, 5-minute window | None |

Conventions every route keeps:

- Errors are `{"error": {"code", "message"}}`. The message says what to do,
  and a route that needs configuration names the variable to set.
- `/v1` is frozen. New behaviour is a new version, so nothing built against
  an old one breaks.
- The device id is a random UUID made by the phone. It is checked for shape
  on every route that takes one, and it is the only identity the server has.
- A status route describes the whole capability, for example "configured and
  connected", not half of it.

The request and response models are in `src/app.py`. The developer contract
is in `src/API_CONTRACT.md`.

## Database schema

One SQLite file, `circadian.sqlite3`, in `CIRCADIAN_DATA_DIR`:

```sql
CREATE TABLE records (
  collection TEXT NOT NULL,   -- 'push' | 'whoop' | 'whoop_users' | 'secrets'
  key        TEXT NOT NULL,   -- device id, WHOOP user id, or secret name
  value      TEXT NOT NULL,   -- the record, as JSON
  PRIMARY KEY (collection, key)
) WITHOUT ROWID;
-- journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000
```

| Collection | Key | Record |
|---|---|---|
| `push` | device id | `subscription`, `reminders` [{at, title, body, kind, sent}], `trip`, `wakes` [{start, end, tz}], `checkins` {night: sent at}, `checkin_attempt` |
| `whoop` | device id | `access_token`, `refresh_token`, `expires_at`, `user_id` |
| `whoop_users` | WHOOP user id | device id, for the webhook |
| `secrets` | `hmac`, `vapid_private_pem` | Made on first use. Losing them signs every traveller out of reminders. |

Why a key-value table rather than columns: every read here is "this device's
record", and the records' shapes change with the product. A column earns its
place when something must be queried across records. The first one will be
the next reminder's time; see the scale triggers below.

**Migration.** On first use of a collection in a directory that still has
`<name>.json`, the file is imported in one transaction and renamed to
`<name>.json.imported`, which is kept as the backup. If that transaction
rolls back, the file stays and the next use imports it again.

**Consistency.** Every write is a transaction. `store.transaction()` groups
several, for example deleting a WHOOP connection and its index entry, so a
crash leaves both or neither. Writes are serialised by one lock in the
process; SQLite's `busy_timeout` covers a second process.

**Backups.** The volume is the database, so a Railway volume backup covers it. To
copy it while the app runs, use `sqlite3 circadian.sqlite3 ".backup copy.sqlite3"`,
not `cp`, which can catch a write half done.

## Caching

| What | Where | Lifetime | Dropped when |
|---|---|---|---|
| App shell | Service worker | Until a new version | Network first, so a deploy reaches people on the next open |
| Trip and plan | localStorage | Until replaced | The traveller plans again |
| WHOOP status, reminder status | Page memory | One page view | A connect, disconnect or switch changes them |
| Two weeks of WHOOP sleep and recovery | Server memory, per device | 10 minutes | Webhook, new tokens, disconnect |
| Flight lookups | Server memory, per flight and date | 6 hours | Restart |
| Flight lookup spend | Server memory | One UTC day | At a daily ceiling of 20 (`AERODATABOX_LOOKUPS_PER_DAY`) |

What is deliberately not cached: plans. They are cheap to compute (about
three milliseconds) and depend on the trip alone, so a cache would only add a way
to serve a stale one. Caches live in process memory because there is one
process. A second process is the moment they move; see below.

## Measured

A synthetic load of N travellers, each with reminders on, 40 reminders
pending and WHOOP connected. Measured in this container.

Before, with one JSON file per collection:

| Travellers | Reminders file | WHOOP status | Dispatch pass | Check-in sweep |
|---|---|---|---|---|
| 500 | 4.6 MB | 0.7 ms | 32 ms | 1.6 s |
| 2,000 | 18.5 MB | 2.8 ms | 141 ms | 8.4 s |
| 5,000 | 46.2 MB | 6.9 ms | 372 ms | 43.5 s |

The sweep grew with the square of the travellers. It re-read the whole WHOOP
file for each device and rebuilt every plan every minute. Past about 6,000
travellers the minute tick ran longer than a minute, and reminders were late.

After, with SQLite records and stored wakes:

| Travellers | Database | WHOOP status | One write | Dispatch pass | Sweep, first | Sweep, then |
|---|---|---|---|---|---|---|
| 500 | 6.6 MB | 0.04 ms | 0.2 ms | 39 ms | 1.5 s | 38 ms |
| 2,000 | 26.3 MB | 0.04 ms | 0.2 ms | 145 ms | 4.9 s | 156 ms |
| 5,000 | 65.9 MB | 0.04 ms | 0.2 ms | 410 ms | 10.9 s | 425 ms |

"First" is the one sweep after the deploy that fills in the wakes for
subscriptions made before they were stored. Every sweep after that is linear
in travellers and does not build plans.

## Scale triggers

What to change, and the sign that says it is time. None of these is built
yet, on purpose.

1. **About 30,000 travellers with reminders on.** The minute tick reads every
   `push` record twice and nears 5 seconds. Add a `next_at` column with an
   index to `records`, written with each record. Dispatch and the sweep then
   select only the rows that are due.
2. **The single process is the bottleneck,** meaning plan requests queue
   behind each other. Run more uvicorn workers for HTTP, and move the minute
   tick into its own process so it still runs once. The in-memory caches and
   rate limits move to a shared store at the same time, for example Redis.
   The API keys in `auth.py` move into the database at the same time too;
   today a restart forgets them.
3. **More than one machine.** SQLite on one volume stops being enough.
   Move `records` to Postgres with the same table and a JSONB value. `store.py`
   is the only module that changes, because nothing else touches SQL.
4. **WHOOP's rate limit.** WHOOP limits requests per app; the current limit
   is in its developer dashboard. Each check-in reads sleep and recovery, so
   mornings that cluster in one time zone arrive together. When WHOOP starts
   answering 429, queue the check-ins and pace them.

Signals to watch before any of these: the minute tick's duration, and the
database size on the volume. Both are cheap to log when the first one
matters.
