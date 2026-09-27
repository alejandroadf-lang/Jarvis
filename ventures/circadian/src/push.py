"""
Reminders on the traveller's phone, by web push.

Timeshifter's plan works because it taps you on the shoulder: "light now",
"bed in half an hour". A plan you have to remember to open is followed on the
first day and forgotten by the third. Calendar alarms (ics.py) cover some of
that; push covers the rest and works on iPhones for apps added to the home
screen (iOS 16.4 and later).

How it runs. When the traveller turns reminders on, the page sends its push
subscription and the trip. The trip is planned here, turned into a short list
of dated reminders, and stored against an anonymous device id. A background
thread wakes every minute, sends what is due, and marks it sent. Subscriptions
the push service reports as gone (404/410) are deleted rather than retried for
ever.

Nothing about the traveller is stored beyond the trip times and the
subscription endpoint, and turning reminders off deletes both.
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional

from src import store
from src.itinerary import TripPlan

UTC = timezone.utc
COLLECTION = "push"
TICK_SECONDS = 60
MAX_LATE = timedelta(minutes=30)   # a reminder this stale is skipped, not sent late
BEDTIME_NOTICE = timedelta(minutes=30)

MESSAGES = {
    "light_seek": ("Bright light now", "Get outdoors or near a bright light until {end}."),
    "light_avoid": ("Avoid bright light now", "Keep lights dim and wear sunglasses outside until {end}."),
    "melatonin": ("Melatonin time", "If you use it, now is the time. Bed in 30 minutes."),
    "nap": ("Nap window", "If you need it, nap now. 30 minutes at most: set an alarm."),
    "caffeine_ok": ("Last coffee", "That's the last caffeine for today."),
    "sleep": ("Bedtime in 30 minutes", "Start winding down: dim lights, screens away."),
}


def reminders_from_plan(plan: TripPlan, now: Optional[datetime] = None) -> List[dict]:
    """The future moments worth a tap on the shoulder, oldest first."""
    now = now or datetime.now(UTC)
    out = []
    for e in plan.events:
        if e.type not in MESSAGES:
            continue
        if e.type == "sleep" and e.where not in ("home", "destination"):
            continue
        if e.type == "caffeine_ok":
            at = e.end
        elif e.type == "sleep":
            at = e.start - BEDTIME_NOTICE
        else:
            at = e.start
        if at is None or at <= now:
            continue
        title, body = MESSAGES[e.type]
        end_local = ""
        if e.end is not None:
            from zoneinfo import ZoneInfo
            tz = ZoneInfo(e.tz or (plan.home_tz if e.where == "home" else plan.destination_tz))
            end_local = e.end.astimezone(tz).strftime("%H:%M")
        # The plan's own note, first sentence: it names the city, the times and
        # whether to go outside or use a lamp. The fixed text is the fallback.
        specific = (e.note or "").split(". ")[0].rstrip(".")
        if e.type == "melatonin" and e.note:
            # Whole note: the prescription warning is the second sentence.
            specific = e.note.rstrip(".")
        out.append({
            "at": at.astimezone(UTC).isoformat(),
            "title": title,
            "body": (specific + ".") if specific else body.format(end=end_local),
            "kind": e.type,
            "sent": False,
        })
    out.sort(key=lambda r: r["at"])
    return out


def subscribe(device: str, subscription: dict, plan: TripPlan) -> int:
    if not isinstance(subscription, dict) or not str(subscription.get("endpoint", "")).startswith("https://"):
        raise ValueError("a push subscription needs an https endpoint")
    keys = subscription.get("keys") or {}
    if not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("a push subscription needs its p256dh and auth keys")
    reminders = reminders_from_plan(plan)

    def change(all_):
        all_[device] = {"subscription": subscription, "reminders": reminders}
        return all_

    store.update(COLLECTION, {}, change)
    return len(reminders)


def unsubscribe(device: str) -> bool:
    removed = {"hit": False}

    def change(all_):
        removed["hit"] = all_.pop(device, None) is not None
        return all_

    store.update(COLLECTION, {}, change)
    return removed["hit"]


def status(device: str) -> dict:
    entry = store.read(COLLECTION, {}).get(device)
    if not entry:
        return {"subscribed": False, "pending": 0}
    pending = [r for r in entry["reminders"] if not r["sent"]]
    return {"subscribed": True, "pending": len(pending), "next": pending[0]["at"] if pending else None}


class Gone(Exception):
    """The push service says this subscription no longer exists."""


def send_webpush(subscription: dict, payload: dict) -> None:
    from pywebpush import WebPushException, webpush
    from py_vapid import Vapid02

    keys = store.vapid_keys()
    try:
        webpush(
            subscription_info=subscription,
            data=json.dumps(payload),
            vapid_private_key=Vapid02.from_pem(keys["private_pem"].encode()),
            vapid_claims={"sub": os.environ.get("VAPID_SUBJECT", "").strip() or "mailto:hello@example.com"},
            ttl=3600,
            timeout=10,
        )
    except WebPushException as err:
        code = getattr(getattr(err, "response", None), "status_code", None)
        if code in (404, 410):
            raise Gone() from err
        raise


def dispatch(now: Optional[datetime] = None, send: Callable[[dict, dict], None] = None) -> Dict[str, int]:
    """One pass: send what is due, skip what is stale, drop what is gone."""
    now = now or datetime.now(UTC)
    send = send or send_webpush
    counts = {"sent": 0, "skipped": 0, "gone": 0, "failed": 0}
    snapshot = store.read(COLLECTION, {})
    outcomes = {}
    for device, entry in snapshot.items():
        for i, r in enumerate(entry["reminders"]):
            if r["sent"]:
                continue
            at = datetime.fromisoformat(r["at"])
            if at > now:
                break
            if now - at > MAX_LATE:
                outcomes.setdefault(device, {})[i] = "skipped"
                counts["skipped"] += 1
                continue
            try:
                send(entry["subscription"], {"title": r["title"], "body": r["body"], "kind": r["kind"]})
                outcomes.setdefault(device, {})[i] = "sent"
                counts["sent"] += 1
            except Gone:
                outcomes[device] = "gone"
                counts["gone"] += 1
                break
            except Exception as err:  # a flaky push service must not stop the loop
                print(f"CircadianAPI: push failed ({type(err).__name__}); will retry next minute.")
                counts["failed"] += 1
                break

    if outcomes:
        def change(all_):
            for device, result in outcomes.items():
                if device not in all_:
                    continue
                if result == "gone":
                    all_.pop(device)
                    continue
                for i in result:
                    if i < len(all_[device]["reminders"]):
                        all_[device]["reminders"][i]["sent"] = True
            return all_

        store.update(COLLECTION, {}, change)
    return counts


_started = False


def start_scheduler() -> None:
    """The minute loop, once per process. Off when CIRCADIAN_SCHEDULER=off (tests)."""
    global _started
    if _started or os.environ.get("CIRCADIAN_SCHEDULER", "").lower() == "off":
        return
    _started = True

    def loop():
        while True:
            try:
                dispatch()
            except Exception as err:
                print(f"CircadianAPI: reminder pass failed: {err}")
            time.sleep(TICK_SECONDS)

    threading.Thread(target=loop, name="circadian-reminders", daemon=True).start()
