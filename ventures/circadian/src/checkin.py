"""
The morning check-in: one push notification when WHOOP has scored the night.

A plan you read once is followed on day one and forgotten by day three. What
keeps a traveller on it is being told, each morning, how last night went
against the plan and what today's few moments are:

    Slept 01:40-08:30, 70 min later than planned. Recovery 52%.
    Today: bright light 09:15-12:15 · last coffee 15:35 · bed 00:45
    (moved 35 min later to match your clock).

Two triggers, one message per night:

- WHOOP's webhook (POST /whoop/webhook), sent when a sleep or recovery is
  scored, usually within the hour after waking. It names the member by
  WHOOP user id; whoop.py remembers that id against the device.
- A sweep on the reminder scheduler's minute tick, for when the webhook is
  not registered or was missed: from one to four hours after each planned
  wake, tried every 20 minutes until WHOOP has the night.

Needs reminders to be on: the push subscription is the only way to reach the
phone, and the trip is stored with it (push.py) so the plan can be rebuilt
here without the page.

Webhook authenticity: WHOOP signs each delivery with the app's client secret,
HMAC-SHA256 over the timestamp header followed by the raw body, base64. A
delivery that fails that, or is more than five minutes old, is refused: a
forged one could otherwise make the server call WHOOP and push to a phone.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from src import push, store, whoop

UTC = timezone.utc
SIGNATURE_MAX_AGE = 300            # seconds
EVENTS = ("recovery.updated", "sleep.updated")
SWEEP_AFTER = timedelta(hours=1)   # a planned wake this long ago is worth asking WHOOP about
SWEEP_UNTIL = timedelta(hours=4)   # and after this long, the morning is over
RETRY_EVERY = timedelta(minutes=20)


# --- webhook ----------------------------------------------------------------------------

def verify_signature(timestamp: str, body: bytes, signature: str, now: Optional[float] = None) -> bool:
    secret = os.environ.get("WHOOP_CLIENT_SECRET", "").strip()
    if not secret or not timestamp or not signature:
        return False
    try:
        sent_ms = int(timestamp)
    except ValueError:
        return False
    if abs((now if now is not None else time.time()) - sent_ms / 1000) > SIGNATURE_MAX_AGE:
        return False
    mac = hmac.new(secret.encode(), timestamp.encode() + body, hashlib.sha256).digest()
    return hmac.compare_digest(base64.b64encode(mac).decode(), signature.strip())


def handle_webhook(body: bytes, now: Optional[datetime] = None, send=None) -> str:
    """One verified delivery. Returns what was done, for the log."""
    try:
        payload = json.loads(body)
    except ValueError:
        return "ignored: not JSON"
    kind = payload.get("type")
    if kind not in EVENTS:
        return f"ignored: {kind}"
    device = whoop.device_for_user(payload.get("user_id"))
    if not device:
        return "ignored: member not connected here"
    whoop.invalidate(device)   # a night or recovery was just scored: the cached two weeks are out of date
    return run(device, now=now, send=send)


# --- the check-in -----------------------------------------------------------------------

def run(device: str, now: Optional[datetime] = None, send=None) -> str:
    """Send this device its check-in for the latest planned night, once."""
    now = now or datetime.now(UTC)
    entry = store.read(push.COLLECTION, {}).get(device)
    if not entry or not entry.get("trip"):
        return "skipped: reminders are off"
    plan = _plan_from(entry["trip"])
    try:
        progress = whoop.progress(device, plan, now=now)
    except whoop.NotConnected:
        return "skipped: WHOOP not connected"
    nights = progress["nights"]
    if not nights or not nights[-1]["tracked"]:
        _note_attempt(device, now)
        return "waiting: WHOOP has not scored the night yet"
    night = nights[-1]
    if night["night_of"] in (entry.get("checkins") or {}):
        return "skipped: already sent"
    payload = message(plan, progress, now)
    if not push.send_to(device, payload, send=send):
        return "skipped: reminders gone"

    def change(all_):
        e = all_.get(device)
        if e is not None:
            e.setdefault("checkins", {})[night["night_of"]] = now.isoformat()
        return all_

    store.update(push.COLLECTION, {}, change)
    return f"sent for {night['night_of']}"


def message(plan, progress: dict, now: datetime) -> dict:
    night = progress["nights"][-1]
    late = round((night["bed_minutes_late"] + night["wake_minutes_late"]) / 2)
    parts = [f"Slept {night['actual_bed']}–{night['actual_wake']}"]
    if abs(late) < 15:
        parts[0] += ", on the plan."
    else:
        parts[0] += f", {abs(late)} min {'later' if late > 0 else 'earlier'} than planned."
    if night.get("recovery") is not None:
        parts.append(f"Recovery {night['recovery']}%.")
    today = _today(plan, now, progress["adjustment"]["minutes"], ZoneInfo(night["local_tz"]))
    if today:
        parts.append("Today: " + " · ".join(today) + ".")
    minutes = progress["adjustment"]["minutes"]
    if minutes:
        parts.append(f"Times moved {abs(minutes)} min {'later' if minutes > 0 else 'earlier'} to match your clock.")
    adaptation = progress.get("adaptation") or {}
    if adaptation.get("adapted_after_nights"):
        parts.append("You are back on local time.")
    where = "at home" if night["where"] == "home" else "there"
    n = len([x for x in progress["nights"] if x["where"] == night["where"]])
    return {"title": f"Morning check-in: night {n} {where}", "body": " ".join(parts), "kind": "checkin"}


def _today(plan, now: datetime, shift_minutes: int, tz: ZoneInfo) -> list:
    """The few moments still ahead today, moved by the correction, on the local clock."""
    day = now.astimezone(tz).date()
    delta = timedelta(minutes=shift_minutes)
    picked = {}
    for e in plan.events:
        if e.type not in ("light_seek", "light_avoid", "caffeine_ok", "sleep", "nap"):
            continue
        if e.type == "sleep" and e.where not in ("home", "destination"):
            continue
        start = e.start + delta
        end = (e.end + delta) if e.end else None
        at = end if e.type == "caffeine_ok" else start
        ahead = at is not None and at > now
        today = ahead and at.astimezone(tz).date() == day
        tonight = ahead and e.type == "sleep" and at - now < timedelta(hours=30)  # bed may fall after midnight
        if not (today or tonight) or e.type in picked:
            continue
        hm = lambda t: t.astimezone(tz).strftime("%H:%M")  # noqa: E731
        picked[e.type] = (at, {
            "light_seek": f"bright light {hm(start)}–{hm(end)}" if end else f"bright light {hm(start)}",
            "light_avoid": f"dim light {hm(start)}–{hm(end)}" if end else f"dim light {hm(start)}",
            "caffeine_ok": f"last coffee {hm(end)}",
            "nap": f"nap {hm(start)}",
            "sleep": f"bed {hm(start)}",
        }[e.type])
    return [text for _, text in sorted(picked.values(), key=lambda x: x[0])]  # in the order of the day


# --- the fallback sweep -----------------------------------------------------------------

def sweep(now: Optional[datetime] = None, send=None) -> int:
    """Check-ins the webhook did not deliver, for planned wakes 1-4 h ago. Returns how many were sent."""
    now = now or datetime.now(UTC)
    sent = 0
    for device, entry in store.read(push.COLLECTION, {}).items():
        if not entry.get("trip") or not whoop.status(device)["connected"]:
            continue
        last = entry.get("checkin_attempt")
        if last and now - datetime.fromisoformat(last) < RETRY_EVERY:
            continue
        plan = _plan_from(entry["trip"])
        due = [e for e in plan.events if e.type == "sleep" and e.where in ("home", "destination")
               and SWEEP_AFTER <= now - e.end <= SWEEP_UNTIL]
        if not due:
            continue
        night_of = due[-1].start.astimezone(ZoneInfo(due[-1].tz or (plan.home_tz if due[-1].where == "home" else plan.destination_tz))).date().isoformat()
        if night_of in (entry.get("checkins") or {}):
            continue
        try:
            if run(device, now=now, send=send).startswith("sent"):
                sent += 1
        except Exception as err:  # one device's trouble must not stop the others
            print(f"CircadianAPI: morning check-in failed ({type(err).__name__}: {err}); will retry.")
            _note_attempt(device, now)
    return sent


def _note_attempt(device: str, now: datetime) -> None:
    def change(all_):
        if device in all_:
            all_[device]["checkin_attempt"] = now.isoformat()
        return all_
    store.update(push.COLLECTION, {}, change)


def _plan_from(trip: dict):
    # app.py owns the request model and the itinerary assembly; importing it
    # here at module load would be circular, since app.py imports this.
    from src.app import TripRequest, _plan
    return _plan(TripRequest(**trip))


def start() -> None:
    """Run the sweep on the reminder scheduler's tick."""
    push.on_tick(lambda now: sweep(now))


def in_background(fn, *args) -> None:
    threading.Thread(target=fn, args=args, daemon=True).start()
