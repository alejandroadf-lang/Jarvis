"""
Real flight times from a flight number, through AeroDataBox.

The plan is only as good as its landing time, and until now that came from
the traveller's typing or, failing that, a guess from the distance (see
itinerary.estimate_landing). Both went wrong in practice: a landing date left
behind when the departure moved, a Bangkok-London flight estimated an hour
off. Every serious jet lag app takes the times from the flight itself. With a
flight number and the date on the ticket, this returns each leg's scheduled
departure and landing on the local clock of its own airport, and the
airport's time zone, which is what the planner needs.

Times are computed from the UTC value and the airport's IANA zone, never read
from the local string: AeroDataBox writes UTC as "2026-09-18 22:55Z", and the
zone is what the rest of the planner already works in, so the two cannot
disagree. A revised time, when AeroDataBox has one, wins over the schedule.

The key is the founder's money: the free tier is 600 units a month. So
answers are cached for six hours per flight and date, and there is a daily
ceiling across all travellers (20 unless AERODATABOX_LOOKUPS_PER_DAY says
otherwise), after which the page says to type the times
from the ticket. A lookup sends AeroDataBox the flight number and date, and
nothing about the traveller.

Two marketplaces sell the same API with different addresses and headers:
API.market (the default, and the cheaper paid tier) and RapidAPI. Which one
the key is for is AERODATABOX_VIA.
"""

from __future__ import annotations

import os
import re
import threading
import time
from datetime import date, datetime, timezone
from typing import List, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

PROVIDERS = {
    "api.market": {
        "base": "https://prod.api.market/api/v1/aedbx/aerodatabox",
        "headers": lambda key: {"x-api-market-key": key},
    },
    "rapidapi": {
        "base": "https://aerodatabox.p.rapidapi.com",
        "headers": lambda key: {"X-RapidAPI-Key": key, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com"},
    },
}
CACHE_SECONDS = 6 * 3600
# Across everyone. The free tier is 600 lookups a month, and the ceiling was
# 150 a day: a busy week spent the month's allowance in four days and every
# lookup after that failed until the month turned. 20 a day spreads the 600
# over the month. A paid tier raises it with AERODATABOX_LOOKUPS_PER_DAY.
LOOKUPS_PER_DAY = 20
NUMBER_RE = re.compile(r"^([A-Z0-9]{2}[A-Z]?)(\d{1,4}[A-Z]?)$")

_cache: dict = {}
_spent: dict = {}
_lock = threading.Lock()


class LookupFailed(Exception):
    """A lookup that could not answer. `status` is the HTTP status the page should get."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def _env(name: str) -> str:
    # Trimmed, and without surrounding quotes: a key pasted into Railway as
    # "abc" or with a trailing newline otherwise goes out malformed and fails
    # as a refused key, which reads as the wrong problem (server/env.js).
    return os.environ.get(name, "").strip().strip("'\"").strip()


def api_key() -> str:
    return _env("AERODATABOX_API_KEY")


def provider() -> str:
    via = _env("AERODATABOX_VIA").lower() or "api.market"
    return via if via in PROVIDERS else "api.market"


def is_configured() -> bool:
    return bool(api_key())


def lookups_per_day() -> int:
    try:
        n = int(_env("AERODATABOX_LOOKUPS_PER_DAY"))
    except ValueError:
        return LOOKUPS_PER_DAY
    return n if n > 0 else LOOKUPS_PER_DAY


def normalise_number(raw: str) -> str:
    """"tg 910", "TG-910" and "TG910" are the same flight. Refuses anything that is not a flight number."""
    number = re.sub(r"[\s\-]", "", str(raw or "")).upper()
    if not NUMBER_RE.match(number):
        raise LookupFailed(f'"{str(raw).strip()}" is not a flight number. It looks like TG910 or BA 12: the airline code, then the number.', 400)
    return number


def _http(url: str, headers: dict) -> Tuple[int, object]:
    """(status, parsed JSON or None). Replaced in tests."""
    try:
        res = requests.get(url, headers={"Accept": "application/json", **headers}, timeout=15)
    except requests.RequestException:
        return 0, None
    try:
        body = res.json() if res.content else None
    except ValueError:
        body = None
    return res.status_code, body


def _utc(value: Optional[str]) -> Optional[datetime]:
    """AeroDataBox's "2026-09-18 22:55Z" (or with seconds, or a T) as an aware UTC time."""
    if not value:
        return None
    text = str(value).strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _end(movement: dict) -> Optional[dict]:
    """One end of a leg on its own airport's clock, or None when it cannot be placed."""
    airport = movement.get("airport") or {}
    zone = airport.get("timeZone")
    when = _utc((movement.get("revisedTime") or {}).get("utc")) or _utc((movement.get("scheduledTime") or {}).get("utc"))
    if not zone or when is None:
        return None
    try:
        local = when.astimezone(ZoneInfo(zone))
    except ZoneInfoNotFoundError:
        return None
    return {
        "iata": airport.get("iata") or airport.get("icao") or "",
        "airport": airport.get("shortName") or airport.get("name") or "",
        "city": airport.get("municipalityName") or "",
        "tz": zone,
        "local": local.strftime("%Y-%m-%dT%H:%M"),
        "utc": when.isoformat().replace("+00:00", "Z"),
        "revised": bool((movement.get("revisedTime") or {}).get("utc")),
    }


def _legs(body) -> List[dict]:
    legs = []
    for f in body if isinstance(body, list) else []:
        if f.get("isCargo"):
            continue
        dep, arr = _end(f.get("departure") or {}), _end(f.get("arrival") or {})
        if not dep or not arr:
            continue
        legs.append({
            "number": re.sub(r"\s", "", f.get("number") or ""),
            "airline": (f.get("airline") or {}).get("name") or "",
            "aircraft": (f.get("aircraft") or {}).get("model") or "",
            "status": f.get("status") or "",
            "departure": dep,
            "arrival": arr,
            "minutes": round((_utc(arr["utc"]) - _utc(dep["utc"])).total_seconds() / 60),
        })
    # One entry per physical leg, in the order they fly.
    seen, unique = set(), []
    for leg in sorted(legs, key=lambda x: x["departure"]["utc"]):
        key = (leg["departure"]["iata"], leg["departure"]["utc"])
        if key not in seen:
            seen.add(key)
            unique.append(leg)
    return unique


def lookup(raw_number: str, on: date, now: Optional[float] = None) -> dict:
    """The legs of this flight that leave on `on` (the date on the ticket, at the departure airport)."""
    number = normalise_number(raw_number)
    if not is_configured():
        raise LookupFailed("Looking up flights is not switched on here: set AERODATABOX_API_KEY on the server. "
                           "Type the times from your ticket instead.", 503)
    now = time.time() if now is None else now
    key = (number, on.isoformat())
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
        today = time.strftime("%Y-%m-%d", time.gmtime(now))
        if today not in _spent:          # a new UTC day: yesterday's count goes
            _spent.clear()
            _spent[today] = 0
        if _spent[today] >= lookups_per_day():
            raise LookupFailed("Flight lookups are paused until tomorrow. Type the times from your ticket for now.", 429)
        _spent[today] += 1

    p = PROVIDERS[provider()]
    url = (f"{p['base']}/flights/number/{number}/{on.isoformat()}"
           "?withAircraftImage=false&withLocation=false&dateLocalRole=Departure")
    status, body = _http(url, p["headers"](api_key()))

    if status in (401, 403):
        print(f"CircadianAPI: AeroDataBox refused the key (HTTP {status}) via {provider()}; check AERODATABOX_API_KEY and AERODATABOX_VIA.")
        raise LookupFailed("The flight lookup service refused this server's key. Type the times from your ticket; "
                           "the server's logs say what to fix.", 502)
    if status == 429:
        raise LookupFailed("The flight lookup service's monthly allowance is used up. Type the times from your ticket.", 429)
    if status == 0 or status >= 500:
        raise LookupFailed("The flight lookup service did not answer. Try again in a minute, or type the times from your ticket.", 502)

    legs = _legs(body) if status == 200 else []
    if not legs:
        raise LookupFailed(f"No flight {number} leaving on {on.strftime('%a %d %b %Y').replace(' 0', ' ')} was found. "
                           "Check the number and the date on your ticket, or type the times.", 404)
    result = {"number": number, "date": on.isoformat(), "legs": legs, "source": "AeroDataBox"}
    with _lock:
        _cache[key] = (now, result)
    return result


def _reset_for_tests() -> None:
    with _lock:
        _cache.clear()
        _spent.clear()
