"""
Tests for src/push.py and src/store.py.

The push service is replaced by a recorder, so these pin what reaches a phone
and when: only future reminders are kept, due ones go out once, stale ones are
skipped rather than sent hours late, and a subscription the push service has
dropped is deleted instead of retried for ever.
"""

from datetime import datetime, timedelta, timezone

import pytest

from src import push, store
from src.itinerary import plan_trip

UTC = timezone.utc
SUB = {"endpoint": "https://push.example.com/abc", "keys": {"p256dh": "BPk", "auth": "xyz"}}


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCADIAN_DATA_DIR", str(tmp_path))
    yield tmp_path


def trip():
    return plan_trip(datetime(2030, 10, 10, 19, 0), "Europe/London",
                     datetime(2030, 10, 11, 15, 0), "Asia/Tokyo")


def test_reminders_are_future_only_and_in_order():
    plan = trip()
    rs = push.reminders_from_plan(plan, now=datetime(2030, 10, 9, 12, 0, tzinfo=UTC))
    assert rs and [r["at"] for r in rs] == sorted(r["at"] for r in rs)
    assert all(datetime.fromisoformat(r["at"]) > datetime(2030, 10, 9, 12, 0, tzinfo=UTC) for r in rs)
    kinds = {r["kind"] for r in rs}
    assert {"light_seek", "sleep", "melatonin"} <= kinds
    bedtime = next(r for r in rs if r["kind"] == "sleep")
    assert bedtime["title"] == "Bedtime in 30 minutes"
    # The body is the plan's own advice for that moment, not a fixed line.
    assert "Tokyo" in next(r for r in rs if r["kind"] == "sleep" and "Tokyo" in r["body"])["body"]
    assert all("rescription" in r["body"] for r in rs if r["kind"] == "melatonin")


def test_no_bedtime_reminder_for_sleep_on_the_plane():
    plan = trip()
    plane = [e for e in plan.events if e.type == "sleep" and e.where == "flight"]
    assert plane
    rs = push.reminders_from_plan(plan, now=datetime(2030, 1, 1, tzinfo=UTC))
    plane_times = {(e.start - push.BEDTIME_NOTICE).isoformat() for e in plane}
    assert not [r for r in rs if r["kind"] == "sleep" and r["at"] in plane_times]


def test_subscribe_validates_the_subscription():
    with pytest.raises(ValueError, match="https endpoint"):
        push.subscribe("d1", {"endpoint": "http://x"}, trip())
    with pytest.raises(ValueError, match="p256dh"):
        push.subscribe("d1", {"endpoint": "https://x", "keys": {}}, trip())


def test_due_reminders_go_out_once():
    plan = trip()
    push.subscribe("d1", SUB, plan)
    first = datetime.fromisoformat(store.read("push", {})["d1"]["reminders"][0]["at"])
    sent = []
    counts = push.dispatch(now=first + timedelta(minutes=1), send=lambda s, p: sent.append(p))
    assert counts["sent"] >= 1 and sent[0]["title"]
    again = push.dispatch(now=first + timedelta(minutes=2), send=lambda s, p: sent.append(p))
    assert again["sent"] == 0, "never sent twice"
    assert push.status("d1")["subscribed"]


def test_stale_reminders_are_skipped_not_sent_late():
    now = datetime(2030, 10, 11, 12, 0, tzinfo=UTC)
    store.write("push", {"d1": {"subscription": SUB, "reminders": [
        {"at": (now - timedelta(hours=2)).isoformat(), "title": "old", "body": "", "kind": "nap", "sent": False},
        {"at": (now - timedelta(minutes=5)).isoformat(), "title": "fresh", "body": "", "kind": "nap", "sent": False},
        {"at": (now + timedelta(hours=1)).isoformat(), "title": "later", "body": "", "kind": "nap", "sent": False},
    ]}})
    sent = []
    counts = push.dispatch(now=now, send=lambda s, p: sent.append(p["title"]))
    assert sent == ["fresh"], "the two-hour-old one is skipped, the future one waits"
    assert counts == {"sent": 1, "skipped": 1, "gone": 0, "failed": 0}
    assert push.status("d1")["pending"] == 1


def test_a_gone_subscription_is_deleted():
    push.subscribe("d1", SUB, trip())
    first = datetime.fromisoformat(store.read("push", {})["d1"]["reminders"][0]["at"])

    def gone(s, p):
        raise push.Gone()

    counts = push.dispatch(now=first + timedelta(minutes=1), send=gone)
    assert counts["gone"] == 1
    assert not push.status("d1")["subscribed"]


def test_a_flaky_push_service_is_retried_next_pass():
    push.subscribe("d1", SUB, trip())
    first = datetime.fromisoformat(store.read("push", {})["d1"]["reminders"][0]["at"])

    def boom(s, p):
        raise RuntimeError("503")

    assert push.dispatch(now=first + timedelta(minutes=1), send=boom)["failed"] == 1
    sent = []
    assert push.dispatch(now=first + timedelta(minutes=2), send=lambda s, p: sent.append(p))["sent"] >= 1


def test_unsubscribe_forgets_everything():
    push.subscribe("d1", SUB, trip())
    assert push.unsubscribe("d1") is True
    assert "d1" not in store.read("push", {})
    assert push.unsubscribe("d1") is False


def test_secrets_are_made_once_and_kept(data_dir):
    a = store.server_secret()
    v = store.vapid_keys()
    assert len(a) == 32 and store.server_secret() == a
    assert store.vapid_keys() == v
    assert len(v["public_key"]) == 87, "a 65-byte uncompressed P-256 point, base64url"
    assert (data_dir / store.DB_NAME).exists(), "kept in the database on the volume"
    # A fresh process sees the same keys: nothing is cached outside the database.
    store._connections.clear()
    assert store.server_secret() == a and store.vapid_keys() == v


def test_a_replan_while_reminders_go_out_keeps_the_new_list():
    plan = trip()
    push.subscribe("d1", SUB, plan)
    first = store.get("push", "d1")["reminders"][0]
    due = datetime.fromisoformat(first["at"]) + timedelta(minutes=1)
    moved = plan_trip(datetime(2030, 10, 12, 19, 0), "Europe/London", datetime(2030, 10, 13, 15, 0), "Asia/Tokyo")

    def send(sub, payload):
        push.subscribe("d1", SUB, moved)   # the traveller changes the trip at this moment

    assert push.dispatch(now=due, send=send)["sent"] >= 1
    after = store.get("push", "d1")["reminders"]
    assert after and not any(r["sent"] for r in after), \
        "the new trip's reminders are all still to come; marking by position sent the first one silently"


def test_a_gone_subscription_replaced_meanwhile_is_kept():
    push.subscribe("d1", SUB, trip())
    first = store.get("push", "d1")["reminders"][0]
    fresh = {**SUB, "endpoint": "https://push.example.com/new"}

    def send(sub, payload):
        push.subscribe("d1", fresh, trip())   # the phone re-subscribed with a new endpoint
        raise push.Gone()

    assert push.dispatch(now=datetime.fromisoformat(first["at"]), send=send)["gone"] == 1
    assert store.get("push", "d1")["subscription"]["endpoint"] == fresh["endpoint"]
    # And a gone one that was not replaced is dropped.
    assert push.dispatch(now=datetime.fromisoformat(first["at"]), send=lambda s, p: (_ for _ in ()).throw(push.Gone()))["gone"] == 1
    assert store.get("push", "d1") is None
