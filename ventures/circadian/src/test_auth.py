"""
Tests for src/auth.py: API-key issuance/validation and rate limiting.

These call the auth module's functions and classes directly (no HTTP
layer / TestClient needed) -- consistent with test_shift_logic.py's
pattern of testing the underlying logic, not the framework wiring.

Covered, per the api-authentication skill's checklist:
  - a request with no header -> 401
  - a request with a key that does not exist -> 401, same message shape
  - a request with a revoked key -> 401
  - a valid key, over the limit -> 429 with Retry-After
  - the store never holds a value that would work as a key if it leaked
    (only sha256 hash + prefix + last4 are persisted)
  - generate_key returns a full key that is NOT equal to what's stored
"""

import hashlib

import pytest
from fastapi import HTTPException

from src.auth import (
    ApiKeyRecord,
    RateLimiter,
    _KEY_STORE,
    _hash_key,
    generate_key,
    require_api_key,
)


def test_generate_key_returns_prefixed_key_not_stored_raw():
    full_key, key_hash = generate_key()

    assert full_key.startswith("ca_live_")
    # The hash returned must match what's actually in the store.
    assert key_hash in _KEY_STORE
    record = _KEY_STORE[key_hash]

    # The raw key itself must never appear as a stored value anywhere in
    # the record -- only its hash, prefix, and last4 are kept. If this
    # broke (e.g. someone added a `raw_key` field to ApiKeyRecord), a
    # leaked database dump would leak live keys.
    assert record.key_hash == _hash_key(full_key)
    assert record.key_hash != full_key
    stored_values = vars(record).values()
    assert full_key not in stored_values

    # last4 must actually be the last 4 chars of the real key, not the hash.
    assert record.last4 == full_key[-4:]


def test_require_api_key_missing_header_raises_401():
    with pytest.raises(HTTPException) as exc_info:
        require_api_key(authorization=None)
    assert exc_info.value.status_code == 401


def test_require_api_key_malformed_header_raises_401():
    # Missing "Bearer" scheme entirely.
    with pytest.raises(HTTPException) as exc_info:
        require_api_key(authorization="ca_live_someRawKeyWithNoScheme")
    assert exc_info.value.status_code == 401


def test_require_api_key_unknown_key_raises_401_same_shape_as_missing():
    with pytest.raises(HTTPException) as exc_info_unknown:
        require_api_key(authorization="Bearer ca_live_not_a_real_key_at_all")
    unknown_status = exc_info_unknown.value.status_code

    with pytest.raises(HTTPException) as exc_info_missing:
        require_api_key(authorization=None)
    missing_status = exc_info_missing.value.status_code

    # Same status code for "missing" and "unknown" -- an attacker should
    # not be able to distinguish "no key sent" from "key doesn't exist"
    # by status code or message detail.
    assert unknown_status == missing_status == 401


def test_require_api_key_valid_key_returns_record():
    full_key, key_hash = generate_key()
    record = require_api_key(authorization=f"Bearer {full_key}")
    assert isinstance(record, ApiKeyRecord)
    assert record.key_hash == key_hash


def test_require_api_key_revoked_key_raises_401():
    full_key, key_hash = generate_key()
    _KEY_STORE[key_hash].active = False

    with pytest.raises(HTTPException) as exc_info:
        require_api_key(authorization=f"Bearer {full_key}")
    assert exc_info.value.status_code == 401


def test_rate_limiter_allows_up_to_max_then_429_with_retry_after():
    limiter = RateLimiter(max_requests=3, window_seconds=60)
    key_hash = hashlib.sha256(b"test-key-for-rate-limit").hexdigest()

    # First call establishes the window (count=1); two more are allowed
    # (count=2, count=3) before max_requests=3 is hit.
    limiter.check(key_hash)
    limiter.check(key_hash)
    limiter.check(key_hash)

    with pytest.raises(HTTPException) as exc_info:
        limiter.check(key_hash)

    assert exc_info.value.status_code == 429
    assert "Retry-After" in exc_info.value.headers
    # Must be a positive integer number of seconds, not zero or negative.
    assert int(exc_info.value.headers["Retry-After"]) > 0


def test_rate_limiter_is_scoped_per_key_not_global():
    limiter = RateLimiter(max_requests=1, window_seconds=60)
    key_a = hashlib.sha256(b"key-a").hexdigest()
    key_b = hashlib.sha256(b"key-b").hexdigest()

    limiter.check(key_a)  # uses up key_a's single allowed request

    with pytest.raises(HTTPException):
        limiter.check(key_a)

    # key_b must be unaffected by key_a's usage -- a shared counter here
    # would mean one noisy customer rate-limits every other customer.
    limiter.check(key_b)


def test_rate_limiter_resets_after_window_elapses(monkeypatch):
    limiter = RateLimiter(max_requests=1, window_seconds=60)
    key_hash = hashlib.sha256(b"key-c").hexdigest()

    fake_now = [1000.0]
    monkeypatch.setattr("src.auth.time.time", lambda: fake_now[0])

    limiter.check(key_hash)  # count=1, window_start=1000.0
    with pytest.raises(HTTPException):
        limiter.check(key_hash)  # still within window -> 429

    fake_now[0] = 1061.0  # 61s later, past the 60s window
    limiter.check(key_hash)  # window has reset -> allowed again, no raise


# --- Keys from the environment -------------------------------------------------------
#
# Without these the deployed service had no way to hold a key across a restart
# and no way to issue one, so every request was refused.

from src.auth import load_keys_from_env, register_key, _lookup_key


def test_keys_listed_in_env_are_accepted_by_hash():
    good = "ca_live_" + "k" * 30
    other = "ca_live_" + "z" * 30
    loaded = load_keys_from_env({"CIRCADIAN_API_KEYS": f"{good}, {other}"})
    assert loaded == 2
    assert _lookup_key(good) is not None
    assert _lookup_key(other) is not None
    assert good not in _KEY_STORE, "stored by hash, never raw"


def test_malformed_env_entries_are_skipped_not_fatal():
    good = "ca_live_" + "g" * 30
    loaded = load_keys_from_env({"CIRCADIAN_API_KEYS": f"nope, ca_live_short, {good},,"})
    assert loaded == 1
    assert _lookup_key(good) is not None
    assert _lookup_key("ca_live_short") is None


def test_register_key_refuses_guessable_keys():
    with pytest.raises(ValueError):
        register_key("ca_live_abc")
    with pytest.raises(ValueError):
        register_key("sk_" + "x" * 40)


def test_no_env_means_no_keys_and_no_crash():
    assert load_keys_from_env({}) == 0
