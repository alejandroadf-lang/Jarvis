"""
API-key authentication, plans and rate limiting for CircadianAPI.

Two sources of keys, both checked by hash, never stored raw:

- Keys issued by this service (a free key from the developer page, or one
  the owner issues or upgrades through the admin endpoints) live in the
  database (store.py, collection "api_keys"), so they survive a redeploy.
  Until they did, every key lived in memory and a redeploy signed every
  customer out; the only workaround was typing keys into a Railway variable.
- Keys listed in CIRCADIAN_API_KEYS, loaded at start, as before. They are on
  the Starter plan: they were handed to people paying the one price there was.

Each key has a plan (PLANS): a per-minute limit and a monthly quota. The
per-minute window is in memory (a restart forgiving one minute costs
nothing); the monthly count is in the database (telemetry.py), because it is
what a customer is billed against and what they are told is left.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

from fastapi import Header, HTTPException, Depends, Response

from src import store
from src.telemetry import calls_this_month


KEY_PREFIX = "ca_live_"

# hash -> record. Never stores the raw key.
_KEY_STORE: Dict[str, "ApiKeyRecord"] = {}

# Rate limit config: fixed window.
RATE_LIMIT_MAX_REQUESTS = 60
RATE_LIMIT_WINDOW_SECONDS = 60

KEYS = "api_keys"          # key hash -> {plan, name, email, created_at, active, last4}

# What each plan allows. Prices are stated here so the developer page and the
# contract cannot disagree with what is enforced; money is taken outside this
# service (a Stripe payment link), and a key is moved to a paid plan with the
# admin endpoint once it is paid.
PLANS = {
    "free": {"label": "Free", "monthly_plans": 100, "per_minute": 10, "price": "$0"},
    "starter": {"label": "Starter", "monthly_plans": 5000, "per_minute": 60, "price": "$29 a month"},
    "scale": {"label": "Scale", "monthly_plans": 100000, "per_minute": 300, "price": "by arrangement"},
}


@dataclass
class ApiKeyRecord:
    key_hash: str
    prefix: str
    last4: str
    active: bool = True
    plan: str = "starter"

    @property
    def key_id(self) -> str:
        """A public name for the key, for the owner's admin list: not enough to use it."""
        return self.key_hash[:12]


def _hash_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def generate_key() -> Tuple[str, str]:
    """
    Create a new API key.

    Returns (full_key, key_hash). The full_key is shown to the caller
    exactly once (e.g. at issuance time) and is never stored — only its
    sha256 hash, prefix, and last 4 characters are persisted, so the raw
    key cannot be recovered or leaked from storage or logs.
    """
    token = secrets.token_urlsafe(32)
    full_key = f"{KEY_PREFIX}{token}"
    key_hash = _hash_key(full_key)

    record = ApiKeyRecord(
        key_hash=key_hash,
        prefix=KEY_PREFIX,
        last4=full_key[-4:],
    )
    _KEY_STORE[key_hash] = record

    return full_key, key_hash


def register_key(raw_key: str) -> str:
    """
    Accept an externally issued key into the store, by hash.

    Rejects anything without the ca_live_ prefix or shorter than 24
    characters after it: a guessable key is worse than none, because it
    looks like protection.
    """
    raw_key = raw_key.strip()
    if not raw_key.startswith(KEY_PREFIX) or len(raw_key) - len(KEY_PREFIX) < 24:
        raise ValueError(
            f"An API key must start with {KEY_PREFIX} and have at least 24 characters after it."
        )
    key_hash = _hash_key(raw_key)
    _KEY_STORE[key_hash] = ApiKeyRecord(key_hash=key_hash, prefix=KEY_PREFIX, last4=raw_key[-4:])
    return key_hash


def load_keys_from_env(env: Optional[Dict[str, str]] = None) -> int:
    """
    Load the keys listed in CIRCADIAN_API_KEYS (comma-separated).

    The in-memory store is wiped by every restart and there is no issuance
    endpoint, so without this a deployed service answers 401 to everyone
    for ever. Keys kept in the host's secret variables survive restarts;
    issuing one is adding it there. Malformed entries are skipped and
    counted in the log line rather than crashing the service, so one typo
    cannot take the other keys down with it.
    """
    env = os.environ if env is None else env
    raw = env.get("CIRCADIAN_API_KEYS", "")
    loaded, skipped = 0, 0
    for entry in raw.split(","):
        if not entry.strip():
            continue
        try:
            register_key(entry)
            loaded += 1
        except ValueError:
            skipped += 1
    if loaded or skipped:
        print(f"CircadianAPI: loaded {loaded} API key(s) from CIRCADIAN_API_KEYS; skipped {skipped} malformed.")
    else:
        print("CircadianAPI: CIRCADIAN_API_KEYS is not set, so every /v1 request will be refused with 401.")
    return loaded


def _lookup_key(raw_key: str) -> Optional[ApiKeyRecord]:
    key_hash = _hash_key(raw_key)
    record = _KEY_STORE.get(key_hash) or _stored_record(key_hash)
    if record is None or not record.active:
        return None
    return record


def _stored_record(key_hash: str) -> Optional[ApiKeyRecord]:
    row = store.get(KEYS, key_hash)
    if not row:
        return None
    return ApiKeyRecord(key_hash=key_hash, prefix=KEY_PREFIX, last4=row.get("last4", ""),
                        active=bool(row.get("active", True)), plan=row.get("plan") if row.get("plan") in PLANS else "free")


def issue_key(plan: str, name: str = "", email: str = "", now: Optional[float] = None) -> Tuple[str, dict]:
    """
    A new key, kept in the database. Returns (full key, the stored record with
    its key_id). The full key exists only in this return value.
    """
    if plan not in PLANS:
        raise ValueError(f"unknown plan {plan!r}: one of {', '.join(PLANS)}")
    full_key = f"{KEY_PREFIX}{secrets.token_urlsafe(32)}"
    key_hash = _hash_key(full_key)
    row = {"plan": plan, "name": str(name or "")[:120], "email": str(email or "")[:200],
           "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "active": True, "last4": full_key[-4:]}
    store.put(KEYS, key_hash, row)
    return full_key, {"key_id": key_hash[:12], **row}


def find_key(key_id: str) -> Optional[Tuple[str, dict]]:
    """(key hash, record) for a key_id from the admin list, or None."""
    key_id = str(key_id or "")
    if len(key_id) < 12:
        return None
    for key_hash, row in store.items(KEYS):
        if key_hash.startswith(key_id):
            return key_hash, row
    return None


def update_key(key_id: str, plan: Optional[str] = None, active: Optional[bool] = None) -> Optional[dict]:
    """Move a key to another plan, or switch it off or on. None when there is no such key."""
    if plan is not None and plan not in PLANS:
        raise ValueError(f"unknown plan {plan!r}: one of {', '.join(PLANS)}")
    found = find_key(key_id)
    if not found:
        return None
    key_hash, _ = found

    def change(row):
        if row is None:
            return None
        if plan is not None:
            row["plan"] = plan
        if active is not None:
            row["active"] = bool(active)
        return row

    row = store.update_record(KEYS, key_hash, change)
    return {"key_id": key_hash[:12], **row} if row else None


def list_keys() -> list:
    return [{"key_id": h[:12], **row} for h, row in store.items(KEYS)]


def _parse_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    raw_key = parts[1].strip()
    if not raw_key:
        return None
    return raw_key


def require_api_key(authorization: Optional[str] = Header(None)) -> ApiKeyRecord:
    """
    FastAPI dependency. Fails closed: any missing header, malformed
    header, or unknown/inactive key results in 401.
    """
    raw_key = _parse_bearer(authorization)
    if raw_key is None:
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")

    record = _lookup_key(raw_key)
    if record is None:
        raise HTTPException(status_code=401, detail="Invalid API key")

    return record


@dataclass
class _WindowState:
    window_start: float
    count: int = 0


class RateLimiter:
    """
    Fixed-window rate limiter, keyed by API key hash.

    Not distributed — state lives in this process's memory only.
    Fine for a single instance; replace with a shared store (e.g.
    Redis) before scaling out to multiple instances.
    """

    def __init__(
        self,
        max_requests: int = RATE_LIMIT_MAX_REQUESTS,
        window_seconds: int = RATE_LIMIT_WINDOW_SECONDS,
    ) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._state: Dict[str, _WindowState] = {}

    def check(self, key_hash: str) -> None:
        """
        Raises HTTPException(429) with a Retry-After header if the
        caller identified by key_hash has exceeded the limit within
        the current fixed window.
        """
        now = time.time()
        self._forget_expired(now)
        state = self._state.get(key_hash)

        if state is None or (now - state.window_start) >= self.window_seconds:
            self._state[key_hash] = _WindowState(window_start=now, count=1)
            return

        if state.count >= self.max_requests:
            retry_after = int(self.window_seconds - (now - state.window_start)) + 1
            raise HTTPException(
                status_code=429,
                detail="Rate limit exceeded",
                headers={"Retry-After": str(max(retry_after, 1))},
            )

        state.count += 1

    # Windows that have closed are dropped, at most once a window, so the
    # table holds only callers seen in the last window. Keyed by IP for the
    # consumer app (app.py), the table otherwise grew by one entry per
    # address for the life of the process: a few bytes a visitor, never
    # given back, on a server that stays up for weeks.
    _swept_at: float = 0.0

    def _forget_expired(self, now: float) -> None:
        if now - self._swept_at < self.window_seconds:
            return
        self._swept_at = now
        for key, state in list(self._state.items()):
            if now - state.window_start >= self.window_seconds:
                del self._state[key]

    def tracked(self) -> int:
        """How many callers the limiter is holding state for (for tests and logs)."""
        return len(self._state)


_RATE_LIMITER = RateLimiter()
_PLAN_LIMITERS = {name: RateLimiter(max_requests=p["per_minute"], window_seconds=RATE_LIMIT_WINDOW_SECONDS)
                  for name, p in PLANS.items()}

# Keys from the host's secret variables, loaded once at import. See
# load_keys_from_env for why this exists.
load_keys_from_env()


def _limiter_for(record: ApiKeyRecord) -> RateLimiter:
    # Env keys keep the module-level limiter the tests and v1 were written against.
    return _RATE_LIMITER if record.key_hash in _KEY_STORE else _PLAN_LIMITERS[record.plan]


def api_key_rate_limited(record: ApiKeyRecord = Depends(require_api_key)) -> ApiKeyRecord:
    """A valid key within its per-minute limit. For reading usage, which a key over quota may still do."""
    _limiter_for(record).check(record.key_hash)
    return record


def auth_and_rate_limit(response: Response, record: ApiKeyRecord = Depends(api_key_rate_limited)) -> ApiKeyRecord:
    """
    Combined dependency for anything that makes a plan: a valid key, within
    its per-minute limit, with plans left this month. Every answer carries the
    plan and what is left, so a customer's code can see a quota coming.
    """
    plan = PLANS[record.plan]
    used = calls_this_month(record.key_hash)
    response.headers["X-Plan"] = record.plan
    response.headers["X-Quota-Limit"] = str(plan["monthly_plans"])
    response.headers["X-Quota-Remaining"] = str(max(0, plan["monthly_plans"] - used - 1))
    if used >= plan["monthly_plans"]:
        raise HTTPException(status_code=429, detail={
            "code": "quota_exceeded",
            "message": f"This key has used the {plan['monthly_plans']} plans its {plan['label']} plan includes this "
                       "month. It resets on the 1st (UTC); to raise it now, see the pricing on the developer page.",
        }, headers={"X-Plan": record.plan, "X-Quota-Limit": str(plan["monthly_plans"]), "X-Quota-Remaining": "0"})
    return record
