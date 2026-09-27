"""
Tests for src/checkin.py: the morning check-in.

Pinned because each part fails quietly: a forged webhook must not make the
server push anything, a real one must send exactly one message per night with
last night and today's times in it, and the sweep must cover a morning the
webhook missed without asking WHOOP every minute.
"""

import base64
import hashlib
import hmac
import json
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

os.environ["CIRCADIAN_SCHEDULER"] = "off"
from src import checkin, push, store, whoop  # noqa: E402
from src.itinerary import plan_trip  # noqa: E402
from src.test_whoop import DEVICE, FakeWhoop, sleep_record  # noqa: E402

UTC = timezone.utc
TRIP = {"departure": "2026-10-10T19:00", "departure_tz": "Europe/London",
        "arrival": "2026-10-11T15:00", "arrival_tz": "Asia/Tokyo", "preflight_days": 0}
SUB = {"endpoint": "https://push.example.com/x", "keys": {"p256dh": "a", "auth": "b"}}


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCADIAN_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("WHOOP_CLIENT_ID", "cid")
    monkeypatch.setenv("WHOOP_CLIENT_SECRET", "csecret")
    fake = FakeWhoop()
    monkeypatch.setattr(whoop, "_http", fake)
    whoop.exchange_code(DEVICE, "code123", "https://app.example/whoop/callback", now=1_000_000.0)
    plan = plan_trip(datetime(2026, 10, 10, 19), "Europe/London", datetime(2026, 10, 11, 15), "Asia/Tokyo", preflight_days=0)
    push.subscribe(DEVICE, SUB, plan, trip=TRIP)
    sent = []
    nights = [e for e in plan.events if e.type == "sleep" and e.where == "destination"]
    return SimpleNamespace(fake=fake, plan=plan, nights=nights, sent=sent,
                           send=lambda sub, payload: sent.append((sub, payload)))


def signed(body: bytes, ts_ms: int, secret: str = "csecret") -> dict:
    mac = hmac.new(secret.encode(), str(ts_ms).encode() + body, hashlib.sha256).digest()
    return {"x-whoop-signature": base64.b64encode(mac).decode(), "x-whoop-signature-timestamp": str(ts_ms)}


def scored_night(w, i, late_bed=90, late_wake=50, recovery=52):
    n = w.nights[i]
    w.fake.sleeps.append(dict(sleep_record(i, n.start + timedelta(minutes=late_bed), n.end + timedelta(minutes=late_wake)),
                              user_id=10129))
    w.fake.recoveries.append({"sleep_id": f"s{i}", "score_state": "SCORED", "score": {"recovery_score": recovery},
                              "created_at": (n.end + timedelta(minutes=5)).isoformat(), "user_id": 10129})


def test_the_signature_check_refuses_forged_and_stale_deliveries(world):
    body = b'{"type":"recovery.updated","user_id":10129}'
    now = 1_800_000_000.0
    h = signed(body, int(now * 1000))
    assert checkin.verify_signature(h["x-whoop-signature-timestamp"], body, h["x-whoop-signature"], now=now)
    bad = signed(body, int(now * 1000), secret="other")
    assert not checkin.verify_signature(bad["x-whoop-signature-timestamp"], body, bad["x-whoop-signature"], now=now)
    old = signed(body, int((now - 600) * 1000))
    assert not checkin.verify_signature(old["x-whoop-signature-timestamp"], body, old["x-whoop-signature"], now=now)
    assert not checkin.verify_signature("soon", body, h["x-whoop-signature"], now=now)
    assert not checkin.verify_signature(h["x-whoop-signature-timestamp"], body + b" ", h["x-whoop-signature"], now=now)


def test_a_webhook_sends_one_check_in_per_night_with_last_night_and_today_in_it(world):
    w = world
    scored_night(w, 0)
    now = w.nights[0].end + timedelta(hours=2)
    # WHOOP's member id is only known once a record has been seen.
    assert checkin.handle_webhook(b'{"type":"recovery.updated","user_id":10129}', now=now, send=w.send) == "ignored: member not connected here"
    whoop.progress(DEVICE, w.plan, now=now)
    out = checkin.handle_webhook(b'{"type":"recovery.updated","user_id":10129}', now=now, send=w.send)
    assert out.startswith("sent for 2026-10-11")
    assert len(w.sent) == 1
    sub, payload = w.sent[0]
    assert sub == SUB and payload["kind"] == "checkin"
    assert payload["title"] == "Morning check-in: night 1 there"
    body = payload["body"]
    # Planned 23:00-07:00 Tokyo; slept 90 and 50 min late; today's moments in the order of the day, moved 35 min.
    assert body == ("Slept 00:30–07:50, 70 min later than planned. Recovery 52%. "
                    "Today: dim light 09:35–12:35 · bright light 12:35–15:35 · last coffee 17:35 · bed 23:35. "
                    "Times moved 35 min later to match your clock.")
    # The same night again, from a second delivery, is not sent twice.
    assert checkin.handle_webhook(b'{"type":"sleep.updated","user_id":10129}', now=now, send=w.send) == "skipped: already sent"
    assert checkin.handle_webhook(b'{"type":"workout.updated","user_id":10129}', now=now, send=w.send) == "ignored: workout.updated"
    assert checkin.handle_webhook(b"not json", now=now, send=w.send) == "ignored: not JSON"
    assert len(w.sent) == 1


def test_without_reminders_there_is_nowhere_to_send_it(world):
    w = world
    scored_night(w, 0)
    push.unsubscribe(DEVICE)
    assert checkin.run(DEVICE, now=w.nights[0].end + timedelta(hours=2), send=w.send) == "skipped: reminders are off"
    assert w.sent == []


def test_the_sweep_covers_a_morning_the_webhook_missed_and_does_not_hammer_whoop(world):
    w = world
    # Too early: WHOOP has nothing yet. One ask, then not again for 20 minutes.
    now = w.nights[0].end + timedelta(minutes=90)
    assert checkin.sweep(now=now, send=w.send) == 0
    asks = len([c for c in w.fake.calls if "/activity/sleep" in c[1]])
    assert asks == 1
    assert checkin.sweep(now=now + timedelta(minutes=5), send=w.send) == 0
    assert len([c for c in w.fake.calls if "/activity/sleep" in c[1]]) == asks
    # The night arrives; the next try sends it, once.
    scored_night(w, 0, late_bed=10, late_wake=5, recovery=70)
    assert checkin.sweep(now=now + timedelta(minutes=25), send=w.send) == 1
    assert checkin.sweep(now=now + timedelta(minutes=50), send=w.send) == 0
    assert w.sent[0][1]["body"].startswith("Slept 23:10–07:05, on the plan. Recovery 70%.")
    # Five hours after the wake the morning is over: nothing is sent late.
    push.subscribe(DEVICE, SUB, w.plan, trip=TRIP)  # a re-subscribe keeps the check-in record
    assert store.read(push.COLLECTION, {})[DEVICE]["checkins"]
    assert checkin.sweep(now=w.nights[0].end + timedelta(hours=5), send=w.send) == 0
