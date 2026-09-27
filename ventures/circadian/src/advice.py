"""
The words on each event: what to do, when, and why, for this trip.

The first version gave every event of a type the same sentence: "Get bright
light: outdoors if you can, otherwise a bright lamp", every morning, in every
city. A traveller reads that once and stops reading. What makes advice
followable is what only this trip knows, so each note is built from it:

- the times, on the clock of wherever the traveller is ("until 09:30");
- the city ("Go outside in Tokyo");
- where the body clock is at that moment ("your body is still 6 h behind
  Tokyo: 23:00 here feels like 17:00"), from the plan's own phase;
- whether it is light or dark there. A light window at 05:00 in October
  Tokyo is before sunrise, and "go outside" is wrong advice then; a lamp is
  right. Sunrise is worked out from the zone's city coordinates, which tzdata
  already ships (zone.tab), with the NOAA solar-position approximation. Good
  to a few minutes, which is all a light window needs.

describe() rewrites the notes from the structured events, so it can run
again after an itinerary clips a plan without doubling anything up. Flight
and stopover notes are left as plan_trip wrote them.
"""

from __future__ import annotations

import importlib.resources
import math
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

UTC = timezone.utc
SAMPLE = timedelta(minutes=10)
HORIZON = -0.833   # degrees: the sun's upper edge on the horizon, with refraction


# --- where the sun is ---------------------------------------------------------------------

def _dms(text: str, degree_digits: int) -> float:
    sign = -1.0 if text[0] == "-" else 1.0
    digits = text[1:]
    deg = int(digits[:degree_digits])
    minutes = int(digits[degree_digits:degree_digits + 2])
    seconds = int(digits[degree_digits + 2:degree_digits + 4] or 0)
    return sign * (deg + minutes / 60 + seconds / 3600)


@lru_cache(maxsize=1)
def _coordinates() -> Dict[str, Tuple[float, float]]:
    """{zone: (lat, lon)} from tzdata's zone tables; empty if they are missing."""
    out: Dict[str, Tuple[float, float]] = {}
    for table in ("zone1970.tab", "zone.tab"):
        try:
            text = importlib.resources.files("tzdata").joinpath("zoneinfo", table).read_text()
        except (ModuleNotFoundError, FileNotFoundError, OSError):
            continue
        for line in text.splitlines():
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 3 or parts[2] in out:
                continue
            coord = parts[1]
            split = max(coord.rfind("+"), coord.rfind("-"))
            lat, lon = coord[:split], coord[split:]
            out[parts[2]] = (_dms(lat, 2), _dms(lon, 3))
    return out


def coordinates(zone: str) -> Optional[Tuple[float, float]]:
    return _coordinates().get(zone)


def solar_elevation(at: datetime, lat: float, lon: float) -> float:
    """Degrees above the horizon (NOAA's general solar position approximation)."""
    t = at.astimezone(UTC)
    hour = t.hour + t.minute / 60 + t.second / 3600
    g = 2 * math.pi / 365 * (t.timetuple().tm_yday - 1 + (hour - 12) / 24)
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                       - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g) - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    solar_minutes = hour * 60 + eqtime + 4 * lon
    ha = math.radians(solar_minutes / 4 - 180)
    phi = math.radians(lat)
    cos_zenith = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(ha)
    return 90 - math.degrees(math.acos(max(-1.0, min(1.0, cos_zenith))))


def daylight_spans(a: datetime, b: datetime, zone: str) -> Optional[List[Tuple[datetime, datetime, bool]]]:
    """[(start, end, is_day)] covering a..b, or None when the city is unknown."""
    where = coordinates(zone)
    if where is None or b <= a:
        return None
    spans: List[Tuple[datetime, datetime, bool]] = []
    t = a
    while t < b:
        nxt = min(t + SAMPLE, b)
        day = solar_elevation(t + (nxt - t) / 2, *where) > HORIZON
        if spans and spans[-1][2] == day:
            spans[-1] = (spans[-1][0], nxt, day)
        else:
            spans.append((t, nxt, day))
        t = nxt
    return spans


# --- wording ------------------------------------------------------------------------------

def city(zone: str) -> str:
    return zone.split("/")[-1].replace("_", " ")


def _hm(at: datetime, zone: str) -> str:
    return at.astimezone(ZoneInfo(zone)).strftime("%H:%M")


def _hours(h: float) -> str:
    h = round(h * 2) / 2
    return f"{h:g} h"


def _wrap(h: float) -> float:
    h = ((h + 12) % 24) - 12
    return 12.0 if h == -12 else h


def _zone_of(plan, e) -> str:
    if e.tz:
        return e.tz
    return plan.home_tz if e.where == "home" else plan.destination_tz


def _body_offset(plan, at: datetime) -> float:
    moved = 0.0
    for cbt, s in plan.phase:
        if cbt <= at:
            moved = s
    return plan.body_offset_hours + moved


def _gap(plan, at: datetime, zone: str) -> float:
    """Hours the local clock is ahead of the body clock (negative: behind)."""
    local = at.astimezone(ZoneInfo(zone)).utcoffset().total_seconds() / 3600
    return _wrap(local - _body_offset(plan, at))


def _body_time(plan, at: datetime) -> str:
    return at.astimezone(timezone(timedelta(hours=_body_offset(plan, at)))).strftime("%H:%M")


def _way(plan) -> str:
    return "earlier" if plan.strategy == "advance" else "later"


# Rotated by day, so a week of mornings doesn't read as one sentence on repeat.
OUTDOORS = [
    "a walk, breakfast outdoors, a coffee on a terrace",
    "walk to wherever you're going instead of taking a taxi",
    "a run or a walk in a park",
    "eat by a window, then a walk outside",
    "sit outside with a book or your emails",
]


def _progress(plan, e, zone: str) -> str:
    """How far the body clock still has to go, as of this window."""
    gap = _gap(plan, e.start, zone)
    target = city(plan.destination_tz)
    if abs(gap) < 0.75:
        return f"Your body is on {target} time now; this keeps it there."
    return (f"Your body is {_hours(abs(gap))} {'behind' if gap > 0 else 'ahead of'} {target} now; "
            f"this window is what closes the gap.")


def _light_seek(plan, e, zone: str, n: int = 1) -> str:
    start, end, here = _hm(e.start, zone), _hm(e.end, zone), city(zone)
    why = (f"Light now pulls your body clock {_way(plan)}, towards {city(plan.destination_tz)} time."
           if n == 1 else _progress(plan, e, zone))
    if e.where == "flight":
        return (f"On the plane until {end} {here} time: window shade up if it's light out, reading light on, "
                f"phone or tablet bright and close to your face. {why}")
    if e.where == "stopover":
        return f"At the {here} stopover until {end}: sit by the big windows or walk the terminal. {why}"
    spans = daylight_spans(e.start, e.end, zone)
    aim = "Aim for at least 30 minutes of it."
    if spans is None:
        return f"Bright light {start} to {end}: outdoors if it's light out, otherwise a bright lamp close up. {aim} {why}"
    if all(day for _, _, day in spans):
        return (f"Get outside in {here} between {start} and {end}: {OUTDOORS[(n - 1) % len(OUTDOORS)]}. "
                f"{aim} {why}")
    if not any(day for _, _, day in spans):
        return (f"It's dark in {here} until after {end}, so bring the light to you: a light box, or sit close "
                f"to the brightest lamp you have, {start} to {end}. {why}")
    first_day = next(s for s, _, day in spans if day)
    last_day = max(t for _, t, day in spans if day)
    if spans[0][2] is False:
        return (f"Bright lamp or light box from {start}, then outside once the sun is up at "
                f"{_hm(first_day, zone)}, until {end}. {aim} {why}")
    return (f"Get outside until sunset at {_hm(last_day, zone)}, then bright indoor light until {end}. "
            f"{aim} {why}")


def _light_avoid(plan, e, zone: str, n: int = 1) -> str:
    start, end, here = _hm(e.start, zone), _hm(e.end, zone), city(zone)
    why = ("Light now would pull your body clock the wrong way." if n == 1
           else "Same reason as before: light now pulls the wrong way.")
    if e.where == "flight":
        return (f"On the plane until {end} {here} time: eye mask on, shade down, screens dimmed, "
                f"even if the cabin lights come on. {why}")
    if e.where == "stopover":
        return f"At the {here} stopover until {end}: sunglasses on, find a dim corner, skip the bright shops. {why}"
    spans = daylight_spans(e.start, e.end, zone)
    if spans is not None and any(day for _, _, day in spans):
        return (f"Sunglasses on outside and stay in the shade from {start} to {end}; "
                f"indoors, sit away from the windows. {why}")
    return (f"Keep the lights low from {start} to {end}: lamps instead of ceiling lights, "
            f"night mode on your phone. {why}")


def _sleep(plan, e, zone: str, index: int, count: int) -> str:
    start, end, here = _hm(e.start, zone), _hm(e.end, zone), city(zone)
    if e.where == "flight":
        return (f"Sleep on the plane {start} to {end} {here} time: it's night where you're going. "
                f"Eye mask and earplugs; skip the alcohol, and the meal if it lands in this window.")
    if e.where == "stopover":
        return (f"Sleep at the {here} stopover, {start} to {end}: a lounge, a sleep pod or the transit hotel. "
                f"It's night where you're going.")
    if plan.mode == "stay_on_home_time":
        return (f"Bed at {start} {here} time, which is {_body_time(plan, e.start)} on your home clock. "
                f"The trip is too short to adapt, so keep to home time: blackout curtains or an eye mask if it's light out.")
    if e.where == "home":
        usual = getattr(plan, "usual_bedtime", None)
        local = e.start.astimezone(ZoneInfo(zone))
        moved = ""
        if usual is not None:
            diff = _wrap((local.hour + local.minute / 60) - usual)
            if abs(diff) >= 0.25:
                moved = f", {_hours(abs(diff))} {'earlier' if diff < 0 else 'later'} than usual"
        step = f"Night {index} of {count} before you fly" if count > 1 else "The night before you fly"
        return (f"{step}: bed at {start}{moved}, up at {end}. "
                f"This starts moving your body clock towards {city(plan.destination_tz)} time.")
    gap = _gap(plan, e.start, zone)
    head = f"Night {index} in {here}: bed at {start}, up at {end}."
    if abs(gap) < 0.75:
        return f"{head} Your body clock has caught up with {here} time: a normal night."
    feel = f"your body is still {_hours(abs(gap))} {'behind' if gap > 0 else 'ahead of'} {here}, so {start} here feels like {_body_time(plan, e.start)}"
    if index == 1:
        tip = ("Expect to lie awake at first: keep the room dark and stay in bed rather than reaching for your phone."
               if gap > 0 else
               "Expect to wake early: keep the room dark and stay in bed until the alarm.")
    elif index == count:
        tip = "The last night of the adjustment: tomorrow you should wake feeling local."
    else:
        tip = "It gets easier each night; keep the same bedtime even if last night was rough."
    return f"{head} Tonight {feel}. {tip}"


def _caffeine(plan, e, zone: str, next_bed: Optional[datetime]) -> str:
    end = _hm(e.end, zone)
    if next_bed is None:
        return f"Coffee or tea is fine until {end}; none after that."
    return (f"Coffee or tea is fine until {end}. After that it would still be working at "
            f"bedtime ({_hm(next_bed, zone)}).")


def _melatonin(plan, e, zone: str, n: int = 1) -> str:
    if n > 1:
        # Shorter, but the warning stays: a reminder or a calendar entry may be
        # the only one of these a traveller ever reads.
        return (f"Melatonin at {_hm(e.start, zone)} if you're using it, 30 minutes before bed. "
                f"Prescription-only in some countries; check with a doctor.")
    return (f"If you use melatonin: take it at {_hm(e.start, zone)}, 30 minutes before bed. The timing "
            f"is what moves your clock, not the dose. Check with a doctor first; it needs a prescription "
            f"in some countries.")


def _nap(plan, e, zone: str) -> str:
    return (f"If you're flagging: one nap, {_hm(e.start, zone)} to {_hm(e.end, zone)}, no longer. Set an alarm; "
            f"a longer or later nap takes from tonight's sleep.")


def describe(plan) -> None:
    """Rewrite each event's note from the plan. Safe to run more than once."""
    sleeps = sorted((e for e in plan.events if e.type == "sleep"), key=lambda e: e.start)
    home_nights = [e for e in sleeps if e.where == "home"]
    dest_nights = [e for e in sleeps if e.where == "destination"]
    seen: Dict[str, int] = {}
    for e in sorted(plan.events, key=lambda e: e.start):
        zone = _zone_of(plan, e)
        n = seen[e.type] = seen.get(e.type, 0) + 1
        if e.type == "light_seek":
            e.note = _light_seek(plan, e, zone, n)
        elif e.type == "light_avoid":
            e.note = _light_avoid(plan, e, zone, n)
        elif e.type == "sleep":
            group = home_nights if e.where == "home" else dest_nights
            index = group.index(e) + 1 if e in group else 1
            e.note = _sleep(plan, e, zone, index, len(group))
        elif e.type == "caffeine_ok":
            nxt = next((s.start for s in sleeps if s.start >= e.end), None)
            e.note = _caffeine(plan, e, zone, nxt)
        elif e.type == "melatonin":
            e.note = _melatonin(plan, e, zone, n)
        elif e.type == "nap":
            e.note = _nap(plan, e, zone)
