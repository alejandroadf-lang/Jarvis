"""
HTTP tests for the v2 planner and the consumer app routes.

The engine is tested in test_itinerary.py; these pin the wiring a phone
depends on: the app route needs no key, the developer route does, the
calendar link returns something a calendar will import, and the app page
itself is served.
"""

import os
from pathlib import Path

from fastapi.testclient import TestClient

KEY = "ca_live_" + "t" * 32
os.environ["CIRCADIAN_API_KEYS"] = KEY

os.environ["CIRCADIAN_SCHEDULER"] = "off"
from src.app import app  # noqa: E402
from src.auth import load_keys_from_env  # noqa: E402

load_keys_from_env({"CIRCADIAN_API_KEYS": KEY})
client = TestClient(app)

TRIP = {
    "departure": "2026-10-10T19:00", "departure_tz": "Europe/London",
    "arrival": "2026-10-11T15:00", "arrival_tz": "Asia/Tokyo",
    "sleep_start": "23:00", "sleep_end": "07:00",
}


def test_app_plan_needs_no_key():
    r = client.post("/app/plan", json=TRIP)
    assert r.status_code == 200
    body = r.json()
    assert body["strategy"] == "advance" and body["events"] and body["disclaimer"]


def test_v2_plan_needs_a_key():
    assert client.post("/v2/plan", json=TRIP).status_code == 401
    r = client.post("/v2/plan", json=TRIP, headers={"authorization": f"Bearer {KEY}"})
    assert r.status_code == 200 and r.json()["shift_hours"] == 8


def test_bad_trip_is_a_400_with_a_reason():
    bad = dict(TRIP, arrival_tz="Mars/Olympus")
    r = client.post("/app/plan", json=bad)
    assert r.status_code == 400
    assert "unknown time zone" in r.json()["error"]["message"]


def test_calendar_link_returns_an_importable_calendar():
    r = client.get("/app/plan.ics", params=TRIP)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/calendar")
    text = r.text
    assert text.startswith("BEGIN:VCALENDAR\r\n") and text.endswith("END:VCALENDAR\r\n")
    assert "SUMMARY:Get bright light" in text and "BEGIN:VALARM" in text
    assert all(len(line.encode()) <= 75 for line in text.split("\r\n")), "folded to 75 octets"


def test_app_page_is_served_and_health_still_answers():
    assert client.get("/health").json() == {"status": "ok"}
    page = client.get("/")
    assert page.status_code == 200 and "<title>" in page.text


def test_v1_is_unchanged():
    r = client.post("/v1/shift-plan", json={"direction": "eastward", "time_zones_shifted": 3},
                    headers={"authorization": f"Bearer {KEY}"})
    assert r.status_code == 200 and r.json()["total_days"] == 3


# --- reminders and WHOOP over HTTP ------------------------------------------------------

import pytest  # noqa: E402

import src.app as app_module  # noqa: E402

DEVICE = "0f8fad5b-d9cb-469f-a165-70867728950e"
FUTURE = dict(TRIP, departure="2031-10-10T19:00", arrival="2031-10-11T15:00")


@pytest.fixture(autouse=True)
def data(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCADIAN_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("WHOOP_CLIENT_ID", raising=False)
    monkeypatch.delenv("WHOOP_CLIENT_SECRET", raising=False)
    # Every test client shares one address, so each test gets a fresh per-IP window;
    # otherwise adding tests would push later ones over the limit into a 429.
    monkeypatch.setattr(app_module, "_APP_LIMITER", type(app_module._APP_LIMITER)(max_requests=20, window_seconds=60))


def test_push_key_subscribe_status_unsubscribe():
    key = client.get("/app/push/key").json()["public_key"]
    assert len(key) == 87
    sub = {"endpoint": "https://push.example.com/x", "keys": {"p256dh": "a", "auth": "b"}}
    r = client.post("/app/push/subscribe", json={"device": DEVICE, "subscription": sub, "trip": FUTURE})
    assert r.status_code == 200 and r.json()["reminders"] > 0
    assert client.get("/app/push/status", params={"device": DEVICE}).json()["subscribed"]
    assert client.post("/app/push/unsubscribe", json={"device": DEVICE}).json()["removed"] is True


def test_bad_device_ids_are_refused():
    assert client.get("/app/push/status", params={"device": "nope"}).status_code == 400


def test_trip_with_legs_over_http():
    legs = {"legs": [
        {"departure": "2031-10-11T01:30", "departure_tz": "Asia/Bangkok", "arrival": "2031-10-11T05:00", "arrival_tz": "Asia/Dubai"},
        {"departure": "2031-10-11T08:00", "departure_tz": "Asia/Dubai", "arrival": "2031-10-11T12:30", "arrival_tz": "Europe/London"},
    ]}
    body = client.post("/app/plan", json=legs).json()
    assert body["home_tz"] == "Asia/Bangkok" and body["destination_tz"] == "Europe/London"
    assert [e["type"] for e in body["events"]].count("flight") == 2


def test_whoop_connect_explains_when_not_configured():
    r = client.get("/whoop/connect", params={"device": DEVICE}, follow_redirects=False)
    assert r.status_code == 503 and "WHOOP_CLIENT_ID" in r.text


def test_whoop_connect_redirects_with_a_signed_state_when_configured(monkeypatch):
    monkeypatch.setenv("WHOOP_CLIENT_ID", "cid")
    monkeypatch.setenv("WHOOP_CLIENT_SECRET", "cs")
    r = client.get("/whoop/connect", params={"device": DEVICE}, follow_redirects=False,
                   headers={"x-forwarded-proto": "https", "x-forwarded-host": "circadian.example"})
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://api.prod.whoop.com/oauth/oauth2/auth?")
    assert "redirect_uri=https%3A%2F%2Fcircadian.example%2Fwhoop%2Fcallback" in loc


def test_whoop_callback_with_a_forged_state_does_not_connect():
    r = client.get("/whoop/callback", params={"code": "c", "state": "forged-state-xx"}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?whoop=failed&why=link"
    assert client.get("/app/whoop/status", params={"device": DEVICE}).json()["connected"] is False


def test_under_a_path_prefix_the_callback_and_redirects_keep_it(monkeypatch):
    # Served by Jarvis at /circadian: WHOOP must call back to /circadian/whoop/callback
    # and the traveller must land back on /circadian/, not on Jarvis's own page.
    monkeypatch.setenv("WHOOP_CLIENT_ID", "cid")
    monkeypatch.setenv("WHOOP_CLIENT_SECRET", "cs")
    proxied = {"x-forwarded-proto": "https", "x-forwarded-host": "jarvis.example",
               "x-forwarded-prefix": "/circadian"}
    r = client.get("/whoop/connect", params={"device": DEVICE}, follow_redirects=False, headers=proxied)
    assert "redirect_uri=https%3A%2F%2Fjarvis.example%2Fcircadian%2Fwhoop%2Fcallback" in r.headers["location"]
    r = client.get("/whoop/callback", params={"error": "access_denied"}, follow_redirects=False, headers=proxied)
    assert r.headers["location"] == "/circadian/?whoop=cancelled"


def test_a_hostile_prefix_is_ignored_rather_than_redirecting_off_site():
    for bad in ["//evil.example", "/../x", "https://evil.example", "/a b"]:
        r = client.get("/whoop/callback", params={"error": "access_denied"}, follow_redirects=False,
                       headers={"x-forwarded-prefix": bad})
        assert r.headers["location"] == "/?whoop=cancelled", bad


def test_the_web_app_uses_only_relative_urls_so_it_works_under_a_prefix():
    web = Path(__file__).parent / "web"
    for name in ["index.html", "app.js", "manifest.webmanifest"]:
        text = (web / name).read_text()
        for needle in ['"/app', '`/app', '"/whoop', '`/whoop', '"/icon', '"/sw.js', '"/manifest', '"/app.js', '"start_url": "/"']:
            assert needle not in text, f"{name} has an absolute URL {needle}"


def test_link_previews_carry_the_absolute_address_the_app_is_reached_at():
    # A bare URL in a Reddit or WhatsApp post gets no title or picture; the
    # preview tags need absolute URLs, and the app may sit under /circadian.
    r = client.get("/", headers={"x-forwarded-proto": "https", "x-forwarded-host": "jarvis.example",
                                 "x-forwarded-prefix": "/circadian"})
    assert r.status_code == 200
    assert '<meta property="og:image" content="https://jarvis.example/circadian/card.png">' in r.text
    assert '<meta property="og:url" content="https://jarvis.example/circadian/">' in r.text
    assert "{{BASE_URL}}" not in r.text
    assert client.get("/card.png").headers["content-type"] == "image/png"


OPEN_JAW = {"journeys": [
    {"legs": [{"departure": "2031-10-04T19:00", "departure_tz": "Asia/Bangkok", "arrival": "2031-10-05T15:00", "arrival_tz": "Europe/London"}]},
    {"legs": [{"departure": "2031-10-15T12:00", "departure_tz": "Europe/Paris", "arrival": "2031-10-16T06:00", "arrival_tz": "Asia/Bangkok"}]},
]}


def test_an_itinerary_comes_back_as_one_plan_per_journey():
    body = client.post("/app/itinerary", json=OPEN_JAW).json()
    assert [p["home_tz"] for p in body["journeys"]] == ["Asia/Bangkok", "Europe/Paris"]
    assert body["journeys"][1]["time_difference_hours"] == 6.0
    assert body["journeys"][1]["local_time_difference_hours"] == 5.0
    # The same trip as one plan, for reminders, WHOOP and the calendar.
    merged = client.post("/app/plan", json=OPEN_JAW).json()
    assert [e["type"] for e in merged["events"]].count("flight") == 2
    assert merged["home_tz"] == "Asia/Bangkok" and merged["destination_tz"] == "Asia/Bangkok"


def test_the_calendar_covers_the_whole_itinerary():
    import base64
    import json as _json
    t = base64.urlsafe_b64encode(_json.dumps(OPEN_JAW).encode()).decode().rstrip("=")
    r = client.get("/app/plan.ics", params={"t": t})
    assert r.status_code == 200 and r.text.count("SUMMARY:Flight") == 2


def test_journeys_out_of_order_are_a_400_not_a_500():
    bad = {"journeys": [OPEN_JAW["journeys"][1], OPEN_JAW["journeys"][0]]}
    r = client.post("/app/itinerary", json=bad)
    assert r.status_code == 400 and "before flight 1 lands" in r.json()["error"]["message"]


def test_whoop_progress_without_connection_is_a_clear_409():
    r = client.post("/app/whoop/progress", json={"device": DEVICE, "trip": dict(TRIP)})
    assert r.status_code == 409 and r.json()["error"]["code"] == "whoop_not_connected"


def test_calendar_link_carries_a_whole_trip_with_connections():
    import base64, json
    legs = {"legs": [
        {"departure": "2031-10-11T01:30", "departure_tz": "Asia/Bangkok", "arrival": "2031-10-11T05:00", "arrival_tz": "Asia/Dubai"},
        {"departure": "2031-10-11T08:00", "departure_tz": "Asia/Dubai", "arrival": "2031-10-11T12:30", "arrival_tz": "Europe/London"},
    ]}
    tparam = base64.urlsafe_b64encode(json.dumps(legs).encode()).decode().rstrip("=")
    r = client.get("/app/plan.ics", params={"t": tparam})
    assert r.status_code == 200 and r.text.count("SUMMARY:Flight") == 2
    assert client.get("/app/plan.ics", params={"t": "not-base64-json"}).status_code == 400


def test_a_landing_time_is_estimated_from_the_distance():
    # Out 6 Oct, back 9 Oct: the page turns that into a return trip and needs
    # both flights' landing times. Bangkok-London is about 13 hours.
    r = client.get("/app/estimate", params={"departure": "2026-10-06T19:00",
                                             "departure_tz": "Asia/Bangkok", "arrival_tz": "Europe/London"})
    assert r.status_code == 200
    body = r.json()
    assert 11 * 60 <= body["minutes"] <= 14 * 60
    assert body["arrival"].startswith("2026-10-07T0")  # the next morning in London

    # A zone with no known location is refused with what to do instead.
    r = client.get("/app/estimate", params={"departure": "2026-10-06T19:00",
                                             "departure_tz": "UTC", "arrival_tz": "Europe/London"})
    assert r.status_code == 400 and "landing time from your ticket" in r.json()["error"]["message"]


def test_the_privacy_page_is_served_and_its_contact_is_the_owners_choice(monkeypatch):
    # WHOOP requires a Privacy Policy URL; this is it.
    monkeypatch.delenv("CIRCADIAN_CONTACT_EMAIL", raising=False)
    r = client.get("/privacy")
    assert r.status_code == 200 and "Circadian privacy" in r.text
    assert "{{" not in r.text and "mailto:" not in r.text

    monkeypatch.setenv("CIRCADIAN_CONTACT_EMAIL", "owner@example.com")
    assert 'href="mailto:owner@example.com"' in client.get("/privacy").text

    # Anything that isn't a plain address is not written into the page.
    monkeypatch.setenv("CIRCADIAN_CONTACT_EMAIL", '"><script>x</script>@a.b')
    text = client.get("/privacy").text
    assert "<script>" not in text and "mailto:" not in text


def test_whoop_stopping_the_sign_in_is_not_reported_as_the_traveller_saying_no(monkeypatch):
    # An invalid scope used to come back as "WHOOP was not connected", reason dropped.
    r = client.get("/whoop/callback", params={"error": "invalid_scope", "error_description": "offline"},
                   follow_redirects=False)
    assert r.headers["location"] == "/?whoop=failed&why=refused&error=invalid_scope"
    r = client.get("/whoop/callback", params={"error": "access_denied"}, follow_redirects=False)
    assert r.headers["location"] == "/?whoop=cancelled"
    # Whatever WHOOP sends, only a plain word goes back into the page's address.
    r = client.get("/whoop/callback", params={"error": "<b>x</b>&y=1"}, follow_redirects=False)
    assert r.headers["location"] == "/?whoop=failed&why=refused&error=bxby"


def test_a_refused_token_exchange_carries_whoops_status_to_the_page(monkeypatch):
    # The live failure: approved at WHOOP, then HTTP 403 swapping the code.
    from src import whoop as whoop_module

    def refuse(*a, **k):
        raise whoop_module.ConnectFailed("whoop", "WHOOP did not accept the sign-in (HTTP 403)", 403)

    monkeypatch.setattr(whoop_module, "verify_state", lambda state: DEVICE)
    monkeypatch.setattr(whoop_module, "exchange_code", refuse)
    r = client.get("/whoop/callback", params={"code": "c", "state": "s"}, follow_redirects=False)
    assert r.headers["location"] == "/?whoop=failed&why=whoop&status=403"


def test_whoop_baseline_without_a_connection_is_a_clear_409():
    r = client.get("/app/whoop/baseline", params={"device": DEVICE})
    assert r.status_code == 409 and r.json()["error"]["code"] == "whoop_not_connected"
