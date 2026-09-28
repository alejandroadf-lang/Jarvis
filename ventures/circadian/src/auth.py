"""
API-key authentication and rate limiting for CircadianAPI.

v1 storage is in-memory (a single process). Replace _KEY_STORE and
_RATE_LIMITER state with a persistent/shared store (e.g. Redis, a DB
table) before running multiple instances or across restarts — as-is,
all issued keys and rate-limit counters are lost on process restart
and are not shared across instances.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

from fastapi import Header, HTTPException, Depends


KEY_PREFIX = "ca_live_"

# hash -> record. Never stores the raw key.
_KEY_STORE: Dict[str, "ApiKeyRecord"] = {}

# Rate limit config: fixed window.
RATE_LIMIT_MAX_REQUESTS = 60
RATE_LIMIT_WINDOW_SECONDS = 60


@dataclass
class ApiKeyRecord:
    key_hash: str
    prefix: str
    last4: str
    active: bool = True


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
    record = _KEY_STORE.get(key_hash)
    if record is None or not record.active:
        return None
    return record


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


def require_api_key(authorization: str = Header(None)) -> ApiKeyRecord:
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

# Keys from the host's secret variables, loaded once at import. See
# load_keys_from_env for why this exists.
load_keys_from_env()


def auth_and_rate_limit(record: ApiKeyRecord = Depends(require_api_key)) -> ApiKeyRecord:
    """
    Combined dependency: validates the API key (fail closed) and then
    enforces the per-key rate limit. Use as a single Depends() in
    app.py route definitions.
    """
    _RATE_LIMITER.check(record.key_hash)
    return record
