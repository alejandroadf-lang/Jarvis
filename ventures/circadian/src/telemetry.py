"""
Per-API-key call telemetry for CircadianAPI.

Exists to answer one question: is anyone actually calling this API.
Before this, the product had zero usage instrumentation -- pricing and
listings existed on paper with no way to confirm a single real call
ever happened.

v1 storage is in-memory, same tradeoff as auth.py's key store and rate
limiter: counts reset on process restart and are not shared across
instances. That is fine for answering "nonzero calls happened" on a
single instance; replace with a persistent/shared store (Redis, a DB
table) before running multiple instances or needing history that
survives a restart.

Keyed by key_hash (the same sha256 hash auth.py already computes and
stores) -- never the raw key, so telemetry cannot become a second place
a live key could leak from.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict


@dataclass
class KeyUsage:
    call_count: int = 0


_USAGE: Dict[str, KeyUsage] = {}


def record_call(key_hash: str) -> None:
    """
    Increment the call counter for this key hash.

    Call exactly once per successfully-served request, after auth and
    rate limiting have both passed -- this counts real served calls,
    not every inbound attempt (a failed-auth request tells you nothing
    about a caller you'd bill or support).
    """
    usage = _USAGE.setdefault(key_hash, KeyUsage())
    usage.call_count += 1


def get_call_count(key_hash: str) -> int:
    """Calls served for this specific key hash. 0 if never seen."""
    usage = _USAGE.get(key_hash)
    return usage.call_count if usage else 0


def total_calls() -> int:
    """Sum of served calls across all keys -- the aggregate liveness signal."""
    return sum(u.call_count for u in _USAGE.values())


def active_key_count() -> int:
    """How many distinct keys have made at least one served call."""
    return sum(1 for u in _USAGE.values() if u.call_count > 0)
