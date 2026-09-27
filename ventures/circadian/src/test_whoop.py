"""
Tests for src/whoop.py, with WHOOP replaced by a fake that records what it
was asked and answers in the v2 shape (records + next_token).

These pin the parts that fail quietly in production: the OAuth state cannot be
forged or replayed late, an expired token is refreshed rather than surfacing as
"no data", a revoked connection is forgotten, paging is followed, and each
planned night is matched to the right real sleep.
"""

from datetime import datetime, timedelta, timezone

import pytest

from src import store, whoop
from src.itinerary import plan_trip

UTC = timezone.utc
DEVICE = "0f8fad5b-d9cb-469f-a165-70867728950e"


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCADIAN_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("WHOOP_CLIENT_ID", "cid")
    monkeypatch.setenv("WHOOP_CLIENT_SECRET", "csecret")


class FakeWhoop:
    def __init__(self):
        self.calls = []
        self.sleeps = []
        self.recoveries = []
        self.token_status = 200
        self.page_size = 25
        self.expire_access = False

    def __call__(self, method, url, headers=None, form=None):
        self.calls.append((method, url, dict(headers or {}), dict(form or {})))
        if url == whoop.TOKEN_URL:
            if self.token_status != 200:
                return self.token_status, {"error": "invalid_grant"}
            n = len([c for c in self.calls if c[1] == whoop.TOKEN_URL])
            return 200, {"access_token": f"at{n}", "refresh_token": f"rt{n}", "expires_in": 3600}
        if method == "DELETE":
            return 204, None
        if self.expire_access and headers and headers.get("Authorization") == "Bearer at1":
            return 401, None
        source = self.sleeps if "/activity/sleep" in url else self.recoveries
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(url).query)
        offset = int(q.get("nextToken", ["0"])[0])
        page = source[offset: offset + self.page_size]
        nxt = str(offset + self.page_size) if offset + self.page_size < len(source) else None
        return 200, {"records": page, "next_token": nxt}


@pytest.fixture
def fake(monkeypatch):
    f = FakeWhoop()
    monkeypatch.setattr(whoop, "_http", f)
    return f


def connect(fake, now=1_000_000.0):
    whoop.exchange_code(DEVICE, "code123", "https://app.example/whoop/callback", now=now)


def trip():
    # London to Tokyo, landing 11 Oct 2026 15:00 Tokyo. Local bedtime 23:00.
    return plan_trip(datetime(2026, 10, 10, 19, 0), "Europe/London",
                     datetime(2026, 10, 11, 15, 0), "Asia/Tokyo", preflight_days=0)


def sleep_record(i, start, end, perf=85, nap=False):
    return {"id": f"s{i}", "start": start.isoformat().replace("+00:00", "Z"),
            "end": end.isoformat().replace("+00:00", "Z"), "nap": nap,
            "score_state": "SCORED", "score": {"sleep_performance_percentage": perf}}


# --- OAuth ------------------------------------------------------------------------------------

def test_authorize_url_asks_for_sleep_recovery_and_offline():
    url = whoop.authorize_url(DEVICE, "https://app.example/whoop/callback")
    assert url.startswith(whoop.AUTHORIZE_URL + "?")
    assert "scope=read%3Asleep+read%3Arecovery+offline" in url
    assert "client_id=cid" in url and "response_type=code" in url


def test_state_round_trips_and_cannot_be_forged_or_replayed_late():
    state = whoop.sign_state(DEVICE, now=1000)
    assert whoop.verify_state(state, now=1100) == DEVICE
    with pytest.raises(ValueError, match="expired"):
        whoop.verify_state(state, now=1000 + whoop.STATE_MAX_AGE + 1)
    other = "11111111-2222-3333-4444-555555555555"
    forged = whoop._b64(f"{other}.1000.{'0' * 32}".encode())
    with pytest.raises(ValueError, match="not valid"):
        whoop.verify_state(forged, now=1100)
    with pytest.raises(ValueError):
        whoop.verify_state("garbage", now=1100)


def test_device_ids_are_checked():
    with pytest.raises(ValueError):
        whoop.status("../../etc/passwd")


def test_code_exchange_stores_tokens_but_never_returns_them(fake):
    connect(fake)
    assert whoop.status(DEVICE) == {"configured": True, "connected": True}
    saved = store.read("whoop", {})[DEVICE]
    assert saved["access_token"] == "at1" and saved["refresh_token"] == "rt1"
    form = fake.calls[0][3]
    assert form["grant_type"] == "authorization_code" and form["client_secret"] == "csecret"


def test_rejected_code_is_an_error(fake):
    fake.token_status = 400
    with pytest.raises(ValueError, match="did not accept"):
        connect(fake)
    assert not whoop.status(DEVICE)["connected"]


def test_expired_token_is_refreshed_before_use(fake):
    connect(fake, now=1_000_000)
    whoop._get(DEVICE, "/activity/sleep", {"limit": 1}, now=1_000_000 + 7200)
    refresh = [c for c in fake.calls if c[3].get("grant_type") == "refresh_token"]
    assert refresh and refresh[0][3]["refresh_token"] == "rt1"
    assert fake.calls[-1][2]["Authorization"] == "Bearer at2"


def test_a_401_triggers_one_refresh_and_retry(fake):
    connect(fake, now=1_000_000)
    fake.expire_access = True
    whoop._get(DEVICE, "/activity/sleep", {"limit": 1}, now=1_000_000)
    assert fake.calls[-1][2]["Authorization"] == "Bearer at2"


def test_revoked_access_forgets_the_connection(fake):
    connect(fake, now=1_000_000)
    fake.token_status = 400
    with pytest.raises(whoop.NotConnected):
        whoop._get(DEVICE, "/activity/sleep", {"limit": 1}, now=1_000_000 + 7200)
    assert not whoop.status(DEVICE)["connected"]


def test_disconnect_revokes_at_whoop_and_deletes_here(fake):
    connect(fake)
    whoop.disconnect(DEVICE, now=1_000_000)
    assert any(c[0] == "DELETE" and c[1] == whoop.REVOKE_URL for c in fake.calls)
    assert DEVICE not in store.read("whoop", {})


# --- progress ----------------------------------------------------------------------------------

def test_planned_nights_are_matched_to_real_sleep(fake):
    plan = trip()
    connect(fake)
    nights = [e for e in plan.events if e.type == "sleep" and e.where == "destination"]
    n0, n1 = nights[0], nights[1]
    # Night 1: to bed 30 min late, on track. Night 2: 2 h late. Plus a nap to ignore.
    fake.sleeps = [
        sleep_record(1, n0.start + timedelta(minutes=30), n0.end + timedelta(minutes=10), perf=80),
        sleep_record(2, n1.start + timedelta(hours=2), n1.end + timedelta(minutes=20), perf=70),
        sleep_record(3, n0.end + timedelta(hours=6), n0.end + timedelta(hours=6, minutes=25), nap=True),
    ]
    fake.recoveries = [{"sleep_id": "s2", "score_state": "SCORED", "score": {"recovery_score": 28}}]
    out = whoop.progress(DEVICE, plan, now=n1.end + timedelta(hours=3))

    tracked = [n for n in out["nights"] if n["tracked"]]
    assert [n["bed_minutes_late"] for n in tracked] == [30, 120]
    assert [n["on_track"] for n in tracked] == [True, False]
    assert tracked[0]["planned_bed"] == "23:00" and tracked[0]["actual_bed"] == "23:30"
    assert tracked[1]["recovery"] == 28 and out["latest_recovery"] == 28
    assert out["summary"] == "1 of 2 nights within an hour of the plan."
    assert any("recovery is low" in a for a in out["advice"])


def test_late_bedtimes_on_an_eastward_trip_get_the_morning_light_advice(fake):
    plan = trip()
    connect(fake)
    nights = [e for e in plan.events if e.type == "sleep" and e.where == "destination"][:3]
    fake.sleeps = [sleep_record(i, n.start + timedelta(minutes=90), n.end) for i, n in enumerate(nights)]
    out = whoop.progress(DEVICE, plan, now=nights[-1].end + timedelta(hours=1))
    assert any("later than planned" in a and "morning light" in a for a in out["advice"])


def test_paging_is_followed(fake):
    plan = trip()
    connect(fake)
    nights = [e for e in plan.events if e.type == "sleep" and e.where == "destination"][:3]
    fake.page_size = 1
    fake.sleeps = [sleep_record(i, n.start, n.end) for i, n in enumerate(nights)]
    out = whoop.progress(DEVICE, plan, now=nights[-1].end + timedelta(hours=1))
    assert len([n for n in out["nights"] if n["tracked"]]) == 3
    assert any("nextToken=" in c[1] for c in fake.calls)


def test_before_the_first_night_there_is_nothing_to_compare(fake):
    connect(fake)
    out = whoop.progress(DEVICE, trip(), now=datetime(2026, 10, 1, tzinfo=UTC))
    assert out["nights"] == [] and "Check back" in out["summary"]
    assert not [c for c in fake.calls if "/activity/sleep" in c[1]], "no WHOOP call when there is nothing to compare"


def test_progress_without_a_connection_says_so(fake):
    plan = trip()
    later = max(e.end for e in plan.events if e.type == "sleep") + timedelta(hours=1)
    with pytest.raises(whoop.NotConnected):
        whoop.progress(DEVICE, plan, now=later)


@pytest.mark.parametrize("status, body, reason", [
    (401, {"error": "invalid_client", "error_description": "Client authentication failed"}, "keys"),
    (400, {"error": "invalid_grant", "error_description": "The redirect_uri does not match"}, "redirect"),
    (400, {"error": "invalid_grant", "error_description": "The authorization code has expired"}, "expired"),
    (403, None, "whoop"),   # e.g. a bot filter's HTML page
    (0, None, "network"),
])
def test_a_refused_sign_in_says_which_thing_to_fix(monkeypatch, capsys, status, body, reason):
    # "Connecting WHOOP did not work" was all the owner got; each of these has a different fix.
    monkeypatch.setattr(whoop, "_http", lambda *a, **k: (status, body))
    with pytest.raises(whoop.ConnectFailed) as err:
        whoop.exchange_code(DEVICE, "code123", "https://app.example/whoop/callback")
    assert err.value.reason == reason
    logged = capsys.readouterr().out
    assert f"HTTP {status}" in logged and "csecret" not in logged and "code123" not in logged


def test_requests_to_whoop_identify_the_app(monkeypatch):
    seen = {}

    class Res:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b"{}"

    def fake_urlopen(req, timeout):
        seen.update({k.lower(): v for k, v in req.header_items()})
        return Res()

    monkeypatch.setattr(whoop.urllib.request, "urlopen", fake_urlopen)
    whoop._http("POST", whoop.TOKEN_URL, form={"a": "b"})
    assert seen["user-agent"].startswith("Circadian/") and "python-urllib" not in seen["user-agent"].lower()
