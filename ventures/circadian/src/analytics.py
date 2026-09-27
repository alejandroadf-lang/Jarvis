"""
Product analytics, sent to PostHog: is anyone using this, and which parts?

This is the question to answer before charging for it. Downloads and page
views don't answer it; what does is whether people make a plan for their own
trip, turn reminders on, connect WHOOP, and come back.

Sent from the server over PostHog's capture API with the standard library,
rather than with PostHog's browser script, because:

- the traveller's phone loads no third-party script and gets no cookie;
- PostHog never sees the traveller's IP address (GeoIP is switched off too);
- it needs no new dependency.

What is sent is deliberately thin. The identity is the anonymous device id
the phone already makes for reminders and WHOOP, and no person profile is
created from it. No trip times, cities or time zones leave this server: a
route plus a device id is where someone is going, and "8 hours east" is all
the product question needs. A browser that sends Global Privacy Control or Do
Not Track is not counted at all.

Off unless POSTHOG_API_KEY is set. Sending happens on a background thread,
so a slow or unreachable PostHog never slows a traveller down, and a failure
is logged once rather than on every request.
"""

from __future__ import annotations

import json
import os
import re
import threading
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Optional

DEFAULT_HOST = "https://us.i.posthog.com"
ANONYMOUS = "anonymous"
_DEVICE_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

_warned = False


def is_configured() -> bool:
    return bool(os.environ.get("POSTHOG_API_KEY", "").strip())


def describe() -> str:
    if is_configured():
        return f"CircadianAPI: usage analytics go to PostHog at {_host()}."
    return "CircadianAPI: POSTHOG_API_KEY is not set, so there are no usage analytics."


def _host() -> str:
    return (os.environ.get("POSTHOG_HOST", "").strip() or DEFAULT_HOST).rstrip("/")


def opted_out(headers) -> bool:
    """Global Privacy Control or Do Not Track: the traveller asked not to be counted."""
    return headers.get("sec-gpc", "").strip() == "1" or headers.get("dnt", "").strip() == "1"


def device_from(headers) -> str:
    """The phone's anonymous id if it sent a well-formed one, else a shared placeholder."""
    raw = headers.get("x-circadian-device", "").strip().lower()
    return raw if _DEVICE_RE.match(raw) else ANONYMOUS


def payload(event: str, distinct_id: str, properties: Optional[dict] = None,
            now: Optional[datetime] = None) -> dict:
    props = dict(properties or {})
    props.update({
        "distinct_id": distinct_id,
        # Events only: no person profile per phone.
        "$process_person_profile": False,
        # The server's address is not the traveller's; don't place them there.
        "$geoip_disable": True,
        "app": "circadian",
    })
    return {
        "api_key": os.environ.get("POSTHOG_API_KEY", "").strip(),
        "event": event,
        "distinct_id": distinct_id,
        "properties": props,
        "timestamp": (now or datetime.now(timezone.utc)).isoformat(),
    }


def _send(body: dict) -> None:
    global _warned
    req = urllib.request.Request(
        f"{_host()}/i/v0/e/",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            res.read()
    except Exception as err:  # analytics must never take anything else down
        if not _warned:
            _warned = True
            print(f"CircadianAPI: could not send analytics to PostHog ({err}). Check POSTHOG_API_KEY and POSTHOG_HOST.")


def track(event: str, headers, properties: Optional[dict] = None,
          send: Optional[Callable[[dict], None]] = None) -> bool:
    """Queue one event. Returns whether anything was sent (for tests)."""
    if not is_configured() or opted_out(headers):
        return False
    body = payload(event, device_from(headers), properties)
    if send is not None:
        send(body)
    else:
        threading.Thread(target=_send, args=(body,), daemon=True).start()
    return True


def plan_properties(req, plan: dict) -> dict:
    """What a plan says about how the product is used, with nothing about where."""
    return {
        "mode": plan.get("mode"),
        "strategy": plan.get("strategy"),
        "hours_shifted": plan.get("shift_hours"),
        "days_to_adapt": plan.get("days_to_adapt_after_arrival"),
        "preflight_days": plan.get("preflight_days"),
        "flights": len(req.legs) if req.legs else 1,
        "has_return": req.return_departure is not None,
        "melatonin": req.melatonin,
        "caffeine": req.caffeine,
    }


def exception_properties(err: BaseException, path: str) -> dict:
    """An unhandled server error, in the shape PostHog error tracking lists."""
    return {
        "$exception_list": [{
            "type": type(err).__name__,
            "value": str(err)[:500],
            "mechanism": {"handled": False, "synthetic": False},
        }],
        "path": path,
    }
