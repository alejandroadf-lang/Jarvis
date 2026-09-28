"""
Per-API-key call counts for CircadianAPI, by month.

Answers two questions: is anyone calling this API, and how many plans has
each customer used this month. The second is what a plan's quota is checked
against and what a customer is billed by, so the count lives in the database
(store.py, collection "api_usage", one row per key and month) and survives a
redeploy. It lived in memory until a paying customer was a possibility; a
redeploy then reset everyone's month to zero.

Keyed by key_hash (the same sha256 hash auth.py already computes and
stores) -- never the raw key, so telemetry cannot become a second place
a live key could leak from.
"""

from __future__ import annotations

import time
from typing import Optional

from src import store

USAGE = "api_usage"


def month_of(now: Optional[float] = None) -> str:
    return time.strftime("%Y-%m", time.gmtime(now))


def record_call(key_hash: str, now: Optional[float] = None) -> None:
    """
    One served plan for this key, this month.

    Call exactly once per successfully-served request, after auth and
    rate limiting have both passed -- this counts real served calls,
    not every inbound attempt (a failed-auth request tells you nothing
    about a caller you'd bill or support).
    """
    store.update_record(USAGE, f"{key_hash}:{month_of(now)}", lambda n: (n or 0) + 1)


def calls_this_month(key_hash: str, now: Optional[float] = None) -> int:
    return store.get(USAGE, f"{key_hash}:{month_of(now)}", 0)


def get_call_count(key_hash: str) -> int:
    """Calls served for this key this month. 0 if never seen."""
    return calls_this_month(key_hash)


def total_calls(now: Optional[float] = None) -> int:
    """Sum of served calls across all keys this month -- the aggregate liveness signal."""
    month = month_of(now)
    return sum(n for k, n in store.items(USAGE) if k.endswith(":" + month))
