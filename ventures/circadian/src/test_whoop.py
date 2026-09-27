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


class FakeResponse:
    def __init__(self, status, content=b"", headers=None):
        self.status_code, self.content, self.headers = status, content, headers or {}

    def json(self):
        import json
        return json.loads(self.content)


def test_requests_to_whoop_identify_the_app(monkeypatch):
    seen = {}

    def fake_request(method, url, headers, data, timeout):
        seen.update({k.lower(): v for k, v in headers.items()})
        return FakeResponse(200, b"{}")

    monkeypatch.setattr(whoop.requests, "request", fake_request)
    assert whoop._http("POST", whoop.TOKEN_URL, form={"a": "b"}) == (200, {})
    ua = seen["user-agent"]
    # Neither Python's default nor the crawler-style "(...; +https://...)" suffix
    # that the live token exchange was refused with.
    assert ua.startswith("Circadian/") and "python" not in ua.lower() and "+http" not in ua


def test_a_firewall_page_is_logged_with_its_ray_id(monkeypatch, capsys):
    # What the live server got: Cloudflare's block page, ray id and all.
    page = (b"<html><head><title>Attention Required! | Cloudflare</title><style>body{margin:0}</style>"
            b"<script>if (!navigator.cookieEnabled) {}</script></head>"
            b"<body>Sorry, you have been blocked. You are unable to access api.prod.whoop.com</body></html>")
    monkeypatch.setattr(whoop.requests, "request", lambda *a, **k: FakeResponse(
        403, page, {"server": "cloudflare", "cf-ray": "a419c319baaa991c-SJC"}))
    assert whoop._http("POST", whoop.TOKEN_URL, form={"client_secret": "csecret"}) == (403, None)
    logged = capsys.readouterr().out
    assert "HTTP 403" in logged and "cloudflare" in logged and "a419c319baaa991c-SJC" in logged
    assert "you have been blocked" in logged and "unable to access" in logged
    assert "<html>" not in logged and "cookieEnabled" not in logged and "csecret" not in logged


@pytest.mark.parametrize("raw", [b"", b'{"message":"Forbidden"}'])
def test_an_empty_or_gateway_403_is_logged_too(monkeypatch, capsys, raw):
    monkeypatch.setattr(whoop.requests, "request", lambda *a, **k: FakeResponse(403, raw, {"server": "awselb/2.0"}))
    whoop._http("POST", whoop.TOKEN_URL, form={"client_secret": "csecret"})
    logged = capsys.readouterr().out
    assert "HTTP 403" in logged and "awselb/2.0" in logged and "csecret" not in logged
    assert ("(empty body)" if not raw else "Forbidden") in logged


def test_whoop_unreachable_is_status_zero(monkeypatch):
    def down(*a, **k):
        raise whoop.requests.ConnectionError("no route")
    monkeypatch.setattr(whoop.requests, "request", down)
    assert whoop._http("GET", whoop.API + "/recovery") == (0, None)


def test_the_startup_check_tells_whoop_apart_from_whatever_is_in_front_of_it(monkeypatch):
    monkeypatch.setattr(whoop.requests, "request", lambda *a, **k: FakeResponse(400, b'{"error":"invalid_grant"}'))
    assert "reachable from Python" in whoop.reachability() and "invalid_grant" in whoop.reachability()
    monkeypatch.setattr(whoop.requests, "request", lambda *a, **k: FakeResponse(403, b"<html>blocked</html>", {"server": "cloudflare"}))
    assert "NOT reachable from Python" in whoop.reachability()
    monkeypatch.delenv("WHOOP_CLIENT_ID")
    assert "not checked" in whoop.reachability()


# --- baseline, correction, adaptation ------------------------------------------------------

def test_baseline_takes_the_usual_night_across_midnight_and_remembers_the_member(fake):
    connect(fake)
    now = datetime(2026, 10, 1, 12, tzinfo=UTC)
    # Bangkok nights (+07:00): to bed around midnight, some before and some after it.
    beds = ["23:30", "00:20", "00:40", "23:50", "00:10", "01:00", "23:40"]
    fake.sleeps = []
    for i, bed in enumerate(beds):
        h, m = map(int, bed.split(":"))
        start = datetime(2026, 9, 20 + i, h, m, tzinfo=timezone(timedelta(hours=7)))
        if h < 12:
            start += timedelta(days=1)
        rec = sleep_record(i, start.astimezone(UTC), (start + timedelta(hours=7, minutes=30)).astimezone(UTC))
        rec.update(timezone_offset="+07:00", user_id=10129)
        fake.sleeps.append(rec)
    fake.sleeps.append(dict(sleep_record(99, now - timedelta(hours=5), now - timedelta(hours=4, minutes=30), nap=True), user_id=10129))
    fake.recoveries = [{"score_state": "SCORED", "score": {"recovery_score": s}, "user_id": 10129} for s in (61, 70, 55, 66, 48)]
    out = whoop.baseline(DEVICE, now=now)
    assert out == {"days": 14, "nights": 7, "bed": "00:10", "wake": "07:40", "recovery": 61}
    assert whoop.device_for_user(10129) == DEVICE and whoop.device_for_user(1) is None
    # Two weeks of nights, not the whole history.
    assert all(f"start={whoop._iso(now - timedelta(days=14))}" in c[1].replace("%3A", ":") for c in fake.calls if "start=" in c[1])


def test_baseline_with_too_few_nights_gives_no_times(fake):
    connect(fake)
    now = datetime(2026, 10, 1, 12, tzinfo=UTC)
    fake.sleeps = [sleep_record(1, now - timedelta(hours=30), now - timedelta(hours=22))]
    out = whoop.baseline(DEVICE, now=now)
    assert out["nights"] == 1 and out["bed"] is None and out["wake"] is None


def test_a_late_night_moves_the_rest_of_the_plan_by_half_the_lateness(fake):
    plan = trip()
    connect(fake)
    n0 = [e for e in plan.events if e.type == "sleep" and e.where == "destination"][0]
    fake.sleeps = [sleep_record(1, n0.start + timedelta(minutes=100), n0.end + timedelta(minutes=60))]
    out = whoop.progress(DEVICE, plan, now=n0.end + timedelta(hours=2))
    adj = out["adjustment"]
    assert adj["minutes"] == 40 and adj["night_of"] == out["nights"][-1]["night_of"]   # (100+60)/2 = 80, half, to 5 min
    assert "80 min later than planned" in adj["note"] and "moved 40 min later" in adj["note"]


def test_a_night_close_to_the_plan_and_a_finished_plan_move_nothing(fake):
    plan = trip()
    connect(fake)
    nights = [e for e in plan.events if e.type == "sleep" and e.where == "destination"]
    fake.sleeps = [sleep_record(1, nights[0].start + timedelta(minutes=20), nights[0].end + timedelta(minutes=10))]
    out = whoop.progress(DEVICE, plan, now=nights[0].end + timedelta(hours=2))
    assert out["adjustment"]["minutes"] == 0 and "close enough" in out["adjustment"]["note"]
    # After the last event there is nothing left to move, however late the night was.
    fake.sleeps = [sleep_record(i, n.start + timedelta(hours=2), n.end + timedelta(hours=2)) for i, n in enumerate(nights)]
    after = max(e.end or e.start for e in plan.events) + timedelta(days=1)
    assert whoop.progress(DEVICE, plan, now=after)["adjustment"]["minutes"] == 0


def test_adaptation_is_two_good_nights_running_with_recovery_back_to_usual(fake):
    plan = trip()
    connect(fake)
    nights = [e for e in plan.events if e.type == "sleep" and e.where == "destination"]
    assert len(nights) >= 4
    first = nights[0].start
    # Before the trip: usual recovery around 60. Nights: 1 late, 2 on track but drained, 3 and 4 on track and recovered.
    fake.recoveries = [{"score_state": "SCORED", "score": {"recovery_score": r}, "sleep_id": None,
                        "created_at": (first - timedelta(days=d)).isoformat()} for d, r in ((3, 58), (5, 62), (8, 60))]
    plan_nights = [(120, 30, 40), (10, 10, 30), (15, 20, 64), (5, 0, 71)]
    for i, (late_bed, late_wake, rec) in enumerate(plan_nights):
        n = nights[i]
        fake.sleeps.append(sleep_record(i, n.start + timedelta(minutes=late_bed), n.end + timedelta(minutes=late_wake)))
        fake.recoveries.append({"sleep_id": f"s{i}", "score_state": "SCORED", "score": {"recovery_score": rec},
                                "created_at": (n.end + timedelta(minutes=5)).isoformat()})
    out = whoop.progress(DEVICE, plan, now=nights[3].end + timedelta(hours=2))
    a = out["adaptation"]
    assert a["baseline_recovery"] == 60 and a["nights_at_destination"] == 4
    assert a["adapted_after_nights"] == 3 and a["predicted_nights"] == plan.days_to_adapt_after_arrival
    assert a["verdict"].startswith("Back on local time after 3 nights; the plan expected")

    # Two nights in: on track once, not yet.
    out = whoop.progress(DEVICE, plan, now=nights[1].end + timedelta(hours=2))
    assert out["adaptation"]["adapted_after_nights"] is None
    assert out["adaptation"]["verdict"].startswith("Not yet on local time after 2 nights there")
