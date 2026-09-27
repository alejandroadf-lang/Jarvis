"""
Tests for src/analytics.py and the events the app routes send.

These pin the promises in that module's docstring, because each one fails
silently: nothing is sent without a key, a traveller who opted out is not
counted, no trip location leaves the server, opening the app is not counted
as planning a trip, and an unhandled error is reported instead of vanishing.
"""

import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ["CIRCADIAN_SCHEDULER"] = "off"
import src.app as app_module  # noqa: E402
from src import analytics  # noqa: E402

DEVICE = "0f8fad5b-d9cb-469f-a165-70867728950e"
TRIP = {"departure": "2031-10-10T19:00", "departure_tz": "Europe/London",
        "arrival": "2031-10-11T15:00", "arrival_tz": "Asia/Tokyo"}


class Sent(list):
    def events(self):
        return [b["event"] for b in self]


@pytest.fixture
def sent(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCADIAN_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test")
    monkeypatch.setattr(app_module, "_APP_LIMITER", type(app_module._APP_LIMITER)(max_requests=50, window_seconds=60))
    out = Sent()

    class InlineThread:
        # Runs the send at once so the test sees it; the real one is a daemon thread.
        def __init__(self, target, args, daemon):
            self.target, self.args = target, args

        def start(self):
            self.target(*self.args)

    monkeypatch.setattr(analytics.threading, "Thread", InlineThread)
    monkeypatch.setattr(analytics, "_send", out.append)
    return out


client = TestClient(app_module.app)


def test_nothing_is_sent_without_a_key(monkeypatch):
    monkeypatch.delenv("POSTHOG_API_KEY", raising=False)
    got = []
    assert analytics.track("plan_made", {}, send=got.append) is False
    assert got == []


def test_opening_the_app_and_making_a_plan_are_different_events(sent):
    client.post("/app/plan", json=TRIP, headers={"x-circadian-device": DEVICE})
    client.post("/app/plan", json=TRIP, headers={"x-circadian-device": DEVICE, "x-circadian-intent": "submit"})
    assert sent.events() == ["app_opened", "plan_made"]
    body = sent[1]
    assert body["api_key"] == "phc_test" and body["distinct_id"] == DEVICE
    props = body["properties"]
    assert props["strategy"] == "advance" and props["hours_shifted"] == 8.0 and props["flights"] == 1
    assert props["$process_person_profile"] is False and props["$geoip_disable"] is True


def test_no_trip_location_or_time_leaves_the_server(sent):
    client.post("/app/plan", json=TRIP, headers={"x-circadian-device": DEVICE, "x-circadian-intent": "submit"})
    text = json.dumps(sent[0])
    for leaked in ["London", "Tokyo", "Europe", "Asia", "2031-10-10", "19:00"]:
        assert leaked not in text, leaked


def test_a_traveller_who_opted_out_is_not_counted(sent):
    client.post("/app/plan", json=TRIP, headers={"x-circadian-device": DEVICE, "sec-gpc": "1"})
    client.post("/app/plan", json=TRIP, headers={"x-circadian-device": DEVICE, "dnt": "1"})
    assert sent == []


def test_a_malformed_device_id_is_not_passed_on(sent):
    client.post("/app/plan", json=TRIP, headers={"x-circadian-device": "../etc/passwd"})
    assert sent[0]["distinct_id"] == analytics.ANONYMOUS


def test_reminders_on_and_off_are_counted_against_the_device(sent):
    sub = {"endpoint": "https://push.example.com/x", "keys": {"p256dh": "a", "auth": "b"}}
    client.post("/app/push/subscribe", json={"device": DEVICE, "subscription": sub, "trip": TRIP})
    client.post("/app/push/unsubscribe", json={"device": DEVICE})
    assert sent.events() == ["reminders_on", "reminders_off"]
    assert {b["distinct_id"] for b in sent} == {DEVICE}
    assert sent[0]["properties"]["reminders"] > 0


def test_an_unhandled_error_is_reported_and_the_traveller_gets_a_plain_message(sent, monkeypatch):
    def broken(_plan):
        raise RuntimeError("boom")

    monkeypatch.setattr(app_module, "plan_to_dict", broken)
    res = TestClient(app_module.app, raise_server_exceptions=False).post("/app/plan", json=TRIP)
    assert res.status_code == 500 and "Try again" in res.json()["error"]["message"]
    assert sent.events() == ["$exception"]
    exc = sent[0]["properties"]["$exception_list"][0]
    assert exc["type"] == "RuntimeError" and exc["value"] == "boom"
    assert sent[0]["properties"]["path"] == "/app/plan"


def test_a_failing_posthog_is_swallowed(monkeypatch, capsys):
    monkeypatch.setenv("POSTHOG_API_KEY", "phc_test")
    monkeypatch.setenv("POSTHOG_HOST", "http://127.0.0.1:1")
    monkeypatch.setattr(analytics, "_warned", False)
    analytics._send(analytics.payload("plan_made", DEVICE))
    analytics._send(analytics.payload("plan_made", DEVICE))
    assert capsys.readouterr().out.count("could not send analytics") == 1
