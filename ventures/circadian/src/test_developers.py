"""
Selling the API (developers.py, auth.py plans, telemetry.py monthly usage).

Pinned because each of these fails quietly for a customer: a key that stops
working after a redeploy, a quota that resets when the server restarts or
never resets at all, a free key handed out without limit, an admin surface
that answers without a real password, and errors in three different shapes.
"""

import pytest
from fastapi.testclient import TestClient

from src import auth, developers, store, telemetry
from src.app import app

client = TestClient(app)
TRIP = {"departure": "2026-10-20T00:30", "departure_tz": "Asia/Bangkok",
        "arrival": "2026-10-20T07:15", "arrival_tz": "Europe/London"}
ADMIN = "a" * 32


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCADIAN_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("CIRCADIAN_ADMIN_TOKEN", raising=False)
    developers._SIGNUPS._state.clear()
    developers._SIGNUPS_ALL._state.clear()
    for limiter in auth._PLAN_LIMITERS.values():
        limiter._state.clear()
    yield tmp_path


def free_key(email="ada@acme.example"):
    res = client.post("/developers/keys", json={"email": email, "company": "Acme"})
    assert res.status_code == 200, res.text
    return res.json()


def bearer(key):
    return {"Authorization": f"Bearer {key}"}


def test_a_free_key_is_issued_once_per_address_and_plans_straight_away():
    out = free_key()
    assert out["api_key"].startswith("ca_live_") and out["plan"] == "free" and out["monthly_plans"] == 100
    res = client.post("/v2/plan", json=TRIP, headers=bearer(out["api_key"]))
    assert res.status_code == 200 and res.json()["mode"] == "adapt"
    assert res.headers["X-Plan"] == "free" and res.headers["X-Quota-Limit"] == "100"
    assert res.headers["X-Quota-Remaining"] == "99"
    again = client.post("/developers/keys", json={"email": "ADA@acme.example"})
    assert again.status_code == 409 and again.json()["error"]["code"] == "key_exists"
    bad = client.post("/developers/keys", json={"email": "not an email"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_email"


def test_free_keys_are_limited_per_address_per_day():
    for i in range(3):
        free_key(f"dev{i}@acme.example")
    res = client.post("/developers/keys", json={"email": "dev9@acme.example"})
    assert res.status_code == 429 and "Retry-After" in res.headers


def test_free_keys_stop_at_a_daily_total_whatever_address_they_claim(monkeypatch):
    monkeypatch.setattr(developers, "_SIGNUPS_ALL", developers.auth.RateLimiter(max_requests=2, window_seconds=86400))
    for i in range(2):
        assert client.post("/developers/keys", json={"email": f"x{i}@a.example"}, headers={"x-forwarded-for": f"10.0.0.{i}"}).status_code == 200
    res = client.post("/developers/keys", json={"email": "x9@a.example"}, headers={"x-forwarded-for": "10.0.0.9"})
    assert res.status_code == 429


def test_a_key_and_its_month_survive_a_restart():
    key = free_key()["api_key"]
    client.post("/v2/plan", json=TRIP, headers=bearer(key))
    store._connections.clear()          # what a redeploy does to everything held in memory
    assert client.get("/v1/usage", headers=bearer(key)).json()["call_count"] == 1
    assert client.post("/v2/plan", json=TRIP, headers=bearer(key)).status_code == 200


def test_the_month_s_quota_is_enforced_and_usage_still_answers_past_it():
    key = free_key()["api_key"]
    key_hash = auth._hash_key(key)
    store.put(telemetry.USAGE, f"{key_hash}:{telemetry.month_of()}", 100)
    res = client.post("/v2/plan", json=TRIP, headers=bearer(key))
    assert res.status_code == 429 and res.json()["error"]["code"] == "quota_exceeded"
    assert res.headers["X-Quota-Remaining"] == "0"
    usage = client.get("/v1/usage", headers=bearer(key)).json()
    assert usage == {"call_count": 100, "period": telemetry.month_of(), "plan": "free", "monthly_plans": 100, "remaining": 0}


def test_a_new_month_starts_from_zero():
    telemetry.record_call("h1", now=1790000000)          # 2026-09
    telemetry.record_call("h1", now=1790000000)
    assert telemetry.calls_this_month("h1", now=1790000000) == 2
    assert telemetry.calls_this_month("h1", now=1790000000 + 40 * 86400) == 0


def test_the_admin_endpoints_need_a_real_token():
    res = client.get("/admin/api-keys")
    assert res.status_code == 503 and "CIRCADIAN_ADMIN_TOKEN" in res.json()["error"]["message"]


def test_a_short_admin_token_is_refused_as_not_configured(monkeypatch):
    monkeypatch.setenv("CIRCADIAN_ADMIN_TOKEN", "password")
    assert client.get("/admin/api-keys", headers=bearer("password")).status_code == 503


def test_the_owner_issues_upgrades_and_revokes_keys(monkeypatch):
    monkeypatch.setenv("CIRCADIAN_ADMIN_TOKEN", ADMIN)
    assert client.get("/admin/api-keys", headers=bearer("b" * 32)).status_code == 401
    free = free_key()
    client.post("/v2/plan", json=TRIP, headers=bearer(free["api_key"]))
    listed = client.get("/admin/api-keys", headers=bearer(ADMIN)).json()["keys"]
    assert [(k["key_id"], k["plan"], k["used_this_month"], k["email"]) for k in listed] == \
        [(free["key_id"], "free", 1, "ada@acme.example")]
    assert "api_key" not in listed[0], "the list never shows a key"

    up = client.post(f"/admin/api-keys/{free['key_id']}", json={"plan": "starter"}, headers=bearer(ADMIN)).json()
    assert up["plan"] == "starter" and up["monthly_plans"] == 5000
    assert client.post("/v2/plan", json=TRIP, headers=bearer(free["api_key"])).headers["X-Plan"] == "starter"

    issued = client.post("/admin/api-keys", json={"plan": "scale", "name": "Big Travel"}, headers=bearer(ADMIN)).json()
    assert issued["plan"] == "scale" and issued["api_key"].startswith("ca_live_")

    client.post(f"/admin/api-keys/{free['key_id']}", json={"active": False}, headers=bearer(ADMIN))
    gone = client.post("/v2/plan", json=TRIP, headers=bearer(free["api_key"]))
    assert gone.status_code == 401 and gone.json()["error"]["code"] == "unauthorized"
    assert client.post("/admin/api-keys/000000000000", json={"plan": "free"}, headers=bearer(ADMIN)).status_code == 404
    bad = client.post("/admin/api-keys", json={"plan": "gold"}, headers=bearer(ADMIN))
    assert bad.status_code == 400 and "unknown plan" in bad.json()["error"]["message"]


def test_every_refusal_has_the_same_shape():
    missing = client.post("/v2/plan", json=TRIP)
    assert missing.status_code == 401 and missing.json() == {"error": {"code": "unauthorized", "message": "Missing or malformed Authorization header"}}
    key = free_key()["api_key"]
    malformed = client.post("/v2/plan", json={**TRIP, "departure": "tomorrow"}, headers=bearer(key))
    assert malformed.status_code == 400 and malformed.json()["error"]["message"].startswith("departure:")
    for _ in range(10):
        client.post("/v2/plan", json=TRIP, headers=bearer(key))
    limited = client.post("/v2/plan", json=TRIP, headers=bearer(key))
    assert limited.status_code == 429 and limited.json()["error"]["code"] == "rate_limited" and "Retry-After" in limited.headers


def test_keys_from_the_variable_still_work_on_starter():
    raw = "ca_live_" + "k" * 32
    auth.register_key(raw)
    res = client.post("/v2/plan", json=TRIP, headers=bearer(raw))
    assert res.status_code == 200 and res.headers["X-Plan"] == "starter"


def test_the_developer_page_states_the_plans_and_loads_nothing_from_elsewhere(monkeypatch):
    monkeypatch.setenv("CIRCADIAN_API_CHECKOUT_URL", "https://buy.stripe.com/test_123")
    page = client.get("/developers").text
    assert "$29 a month" in page and "5,000" in page and "https://buy.stripe.com/test_123" in page
    assert "src=\"http" not in page and "href=\"http" not in page.replace('href="https://buy.stripe.com/test_123"', "")
    assert client.get("/docs").status_code == 404, "FastAPI's docs page loads scripts from a CDN"
    assert client.get("/openapi.json").status_code == 200
