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


def _device(plan) -> str:
    return getattr(plan, "light_device", "none") or "none"


def _indoor_light(plan, start: str, end: str) -> str:
    """The traveller's own light source when daylight isn't available."""
    if _device(plan) == "glasses":
        return f"put your light glasses on, {start} to {end}"
    if _device(plan) == "box":
        return f"sit at your light box, {start} to {end}"
    return f"sit close to the brightest lamp you have, {start} to {end}"


def _light_seek(plan, e, zone: str, n: int = 1) -> str:
    start, end, here = _hm(e.start, zone), _hm(e.end, zone), city(zone)
    why = (f"Light now pulls your body clock {_way(plan)}, towards {city(plan.destination_tz)} time."
           if n == 1 else _progress(plan, e, zone))
    if e.where == "flight":
        if _device(plan) == "glasses":
            return f"On the plane: light glasses on until {end} {here} time, and the reading light on. {why}"
        return (f"On the plane until {end} {here} time: window shade up if it's light out, reading light on, "
                f"phone or tablet bright and close to your face. {why}")
    if e.where == "stopover":
        extra = " or wear your light glasses" if _device(plan) == "glasses" else ""
        return f"At the {here} stopover until {end}: sit by the big windows{extra} or walk the terminal. {why}"
    spans = daylight_spans(e.start, e.end, zone)
    aim = "Aim for at least 30 minutes of it."
    if _device(plan) == "glasses":
        aim += " Stuck indoors? Your light glasses do the job."
    if spans is None:
        return f"Bright light {start} to {end}: outdoors if it's light out, otherwise a bright lamp close up. {aim} {why}"
    if all(day for _, _, day in spans):
        return (f"Get outside in {here} between {start} and {end}: {OUTDOORS[(n - 1) % len(OUTDOORS)]}. "
                f"{aim} {why}")
    if not any(day for _, _, day in spans):
        return f"It's dark in {here} until after {end}, so bring the light to you: {_indoor_light(plan, start, end)}. {why}"
    first_day = next(s for s, _, day in spans if day)
    last_day = max(t for _, t, day in spans if day)
    source = {"glasses": "Light glasses", "box": "Light box"}.get(_device(plan), "Bright lamp")
    if spans[0][2] is False:
        return (f"{source} from {start}, then outside once the sun is up at "
                f"{_hm(first_day, zone)}, until {end}. {aim} {why}")
    return (f"Get outside until sunset at {_hm(last_day, zone)}, then {source.lower()} until {end}. "
            f"{aim} {why}")


def _light_avoid(plan, e, zone: str, n: int = 1, explain_sunglasses: bool = True) -> str:
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
        # Which sunglasses matters: all visible light reaches the clock, so the
        # darkest wrap-around pair beats a tinted fashion pair, and blue-blocking
        # lenses let through too much in daylight. Said once, then short.
        which = (" The darkest pair you have, wrap-around if possible; blue-blocking glasses aren't dark enough in daylight."
                 if explain_sunglasses else "")
        return (f"Sunglasses on outside and stay in the shade from {start} to {end}; "
                f"indoors, sit away from the windows.{which} {why}")
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
    return (f"If you use melatonin: take it at {_hm(e.start, zone)}, 30 minutes before bed. Choose a low-dose, "
            f"fast-release tablet, not slow-release: the timing is what moves your clock, and slow-release keeps "
            f"working into the morning. Check with a doctor first; it needs a prescription in some countries.")


def _nap(plan, e, zone: str) -> str:
    return (f"If you're flagging: one nap, {_hm(e.start, zone)} to {_hm(e.end, zone)}, no longer. Set an alarm; "
            f"a longer or later nap takes from tonight's sleep.")


def describe(plan) -> None:
    """Rewrite each event's note from the plan. Safe to run more than once."""
    sleeps = sorted((e for e in plan.events if e.type == "sleep"), key=lambda e: e.start)
    home_nights = [e for e in sleeps if e.where == "home"]
    dest_nights = [e for e in sleeps if e.where == "destination"]
    seen: Dict[str, int] = {}
    sunglasses_explained = False
    for e in sorted(plan.events, key=lambda e: e.start):
        zone = _zone_of(plan, e)
        n = seen[e.type] = seen.get(e.type, 0) + 1
        if e.type == "light_seek":
            e.note = _light_seek(plan, e, zone, n)
        elif e.type == "light_avoid":
            # Which sunglasses is said on the first note that asks for them,
            # which is often not the first light-avoid event (that one tends
            # to be on the plane).
            e.note = _light_avoid(plan, e, zone, n, explain_sunglasses=not sunglasses_explained)
            sunglasses_explained = sunglasses_explained or e.note.startswith("Sunglasses")
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


# --- the plan in brief ----------------------------------------------------------------------
#
# The events are the schedule; this is what a traveller should take from it if
# they read nothing else: how hard this shift is, what to do before and on the
# flight, the one light window that matters most, when exercise helps, and what
# undoes the work. Every line comes from this plan's own events.
#
# Exercise timing follows the human phase-response curve for exercise
# (Youngstedt et al., J Physiol 2019): exercise at 07:00 or between 13:00 and
# 16:00 advances the clock; exercise between 19:00 and 22:00 delays it.

def _day(at: datetime, zone: str) -> str:
    local = at.astimezone(ZoneInfo(zone))
    return f"{local.strftime('%a')} {local.day} {local.strftime('%b')}"


def briefing(plan) -> List[Dict[str, str]]:
    there, home = city(plan.destination_tz), city(plan.home_tz)
    if plan.mode == "no_shift":
        return [{"title": "No jet lag to fix", "text": f"{home} and {there} are within an hour. Keep your usual schedule."}]

    events = sorted(plan.events, key=lambda e: e.start)
    items: List[Dict[str, str]] = []

    if plan.mode == "stay_on_home_time":
        night = next((e for e in events if e.type == "sleep" and e.where == "destination"), None)
        text = f"You're not in {there} long enough to adapt, so stay on {home} time."
        if night:
            text += (f" That means bed at {_hm(night.start, plan.destination_tz)} {there} time: "
                     f"book a room with blackout curtains, and plan meetings for when it's daytime in {home}.")
        items.append({"title": "Stay on home time", "text": text})
    else:
        east = plan.strategy == "advance"
        hard = ("the harder direction: your body clock has to move earlier" if east
                else "the easier direction: your body clock only has to stay up later")
        by = plan.adapted_by.strftime("%a %-d %b") if plan.adapted_by else ""
        items.append({"title": f"{plan.shift_hours:g} hours {'earlier' if east else 'later'}",
                      "text": f"This is {hard}. Expect about {plan.days_to_adapt_after_arrival} days; "
                              f"you should feel on {there} time by {by}."})

        home_nights = [e for e in events if e.type == "sleep" and e.where == "home"]
        if home_nights:
            beds = ", then ".join(_hm(e.start, plan.home_tz) for e in home_nights)
            items.append({"title": "Before you fly",
                          "text": f"From {_day(home_nights[0].start, plan.home_tz)}: bed at {beds}. "
                                  f"Get light as soon as you're up; it does half the work."})

    flight = next((e for e in events if e.type == "flight"), None)
    if flight:
        plane_sleep = [e for e in events if e.type == "sleep" and e.where in ("flight", "stopover")]
        if plane_sleep:
            s = plane_sleep[0]
            zone = s.tz or plan.destination_tz
            text = f"Sleep {_hm(s.start, zone)} to {_hm(s.end, zone)} {city(zone)} time, and eat on {there} time from boarding: skip any meal served in that window."
        elif plan.mode == "adapt":
            text = f"Stay awake on this flight: it's daytime in {there}. Eat on {there} time from boarding."
        else:
            text = "Sleep when it's night at home, whatever the cabin lights are doing."
        items.append({"title": "On the plane", "text": text + " Water, not alcohol: alcohol makes plane sleep shorter and worse."})

    if plan.mode == "adapt" and flight:
        landing = max(e.end for e in events if e.type == "flight")
        bed = next((e for e in events if e.type == "sleep" and e.where == "destination"), None)
        nap = next((e for e in events if e.type == "nap"), None)
        coffee = next((e for e in events if e.type == "caffeine_ok" and e.start >= landing - timedelta(hours=12)), None)
        if bed:
            z = plan.destination_tz
            parts = [f"You land at {_hm(landing, z)}. Stay up until {_hm(bed.start, z)}, however tired you are"]
            if nap:
                parts.append(f"one nap at most, {_hm(nap.start, z)} to {_hm(nap.end, z)}, with an alarm")
            if coffee and coffee.end > landing:
                parts.append(f"coffee is fine until {_hm(coffee.end, z)}")
            items.append({"title": "Arrival day", "text": "; ".join(parts) + "."})

    if plan.mode == "adapt":
        seek = next((e for e in events if e.type == "light_seek" and e.where == "destination"), None)
        if seek:
            avoid = next((e for e in events if e.type == "light_avoid" and e.where == "destination"
                          and e.start.astimezone(ZoneInfo(plan.destination_tz)).date()
                          == seek.start.astimezone(ZoneInfo(plan.destination_tz)).date()), None)
            text = f"{_day(seek.start, plan.destination_tz)}: bright light {_hm(seek.start, plan.destination_tz)} to {_hm(seek.end, plan.destination_tz)}"
            if avoid:
                text += f", and sunglasses {_hm(avoid.start, plan.destination_tz)} to {_hm(avoid.end, plan.destination_tz)}"
            text += ". Get this one right and the rest of the week is easier."
            items.append({"title": "Your most important light", "text": text})

        east = plan.strategy == "advance"
        items.append({"title": "Exercise",
                      "text": ("A workout at 07:00 or between 13:00 and 16:00 local time helps move your clock earlier. "
                               "Avoid exercising between 19:00 and 22:00 for the first days: it pushes the wrong way.")
                      if east else
                              ("A workout between 19:00 and 22:00 local time helps move your clock later. "
                               "Skip early-morning workouts for the first days.")})
        items.append({"title": "What undoes it",
                      "text": "A nap longer than 30 minutes or after 15:00, a drink to help you sleep (it breaks up the second half of the night), "
                              "and screens in bed. Keep your bedtime the same every night, even after a bad one."})
    return items


# --- supplements ------------------------------------------------------------------------------
#
# Graded by the evidence for this use, not by how often they are sold for it.
# Only melatonin has good evidence for jet lag itself (Cochrane review,
# Herxheimer & Petrie 2002: effective for flights across five or more time
# zones, especially eastward; 0.5 to 5 mg similarly effective). Caffeine helps
# alertness and is already timed in the plan. Vitamin C taken regularly
# slightly shortens colds and helps more under physical stress (Cochrane,
# Hemilä & Chalker 2013), but starting it once ill does not help. Zinc lozenges
# started within a day of symptoms may shorten a cold, on low-certainty
# evidence. Nothing here is a prescription: every entry carries its own caution.

GENERAL_CAUTION = ("Not medical advice. Check with a doctor or pharmacist first if you take other medicines, "
                   "are pregnant or breastfeeding, or have a health condition.")


def supplements(plans) -> Dict[str, object]:
    if not plans:
        return {"items": [], "caution": GENERAL_CAUTION}
    first, last = plans[0], plans[-1]
    flights = sorted((e for p in plans for e in p.events if e.type == "flight"), key=lambda e: e.start)
    depart = flights[0].start if flights else None
    home = first.home_tz
    items: List[Dict[str, str]] = []

    advancing = [p for p in plans if p.mode == "adapt" and p.strategy == "advance"]
    mel = [e for p in advancing for e in p.events if e.type == "melatonin"]
    if mel:
        zone = lambda e: e.tz or (first.home_tz if e.where == "home" else next(p for p in plans if e in p.events).destination_tz)
        first_mel = min(mel, key=lambda e: e.start)
        last_mel = max(mel, key=lambda e: e.start)
        items.append({
            "name": "Melatonin", "evidence": "Good evidence",
            "when": f"30 minutes before bed, from {_day(first_mel.start, zone(first_mel))} to {_day(last_mel.start, zone(last_mel))}; "
                    f"each night's time is in your plan.",
            "why": "The best-studied aid for jet lag after flying east across five or more time zones. "
                   "Use a fast-release tablet at a low dose: studies used 0.5 to 5 mg, and more is not better. "
                   "Slow-release versions keep working into the morning and blur the signal.",
            "caution": "Prescription-only in some countries, including the UK. Avoid with blood thinners, sleeping pills, epilepsy, "
                       "pregnancy or breastfeeding, and don't drive for a few hours after.",
        })
    elif any(p.mode == "adapt" and p.strategy == "delay" for p in plans):
        items.append({
            "name": "Melatonin", "evidence": "Not for this trip",
            "when": "Skip it.",
            "why": "You're shifting later, and for that direction the evidence is weak; a morning dose would also make you drowsy.",
            "caution": "",
        })

    items.append({
        "name": "Caffeine", "evidence": "Good evidence for alertness",
        "when": "Already timed in your plan: coffee or tea each morning, none in the 6 hours before bed.",
        "why": "Keeps you alert through the first days without stealing the sleep that resets your clock.",
        "caution": "",
    })

    if depart is not None:
        start = depart - timedelta(days=7)
        end = max(e.end or e.start for p in plans for e in p.events)
        items.append({
            "name": "Vitamin C", "evidence": "Some evidence",
            "when": f"Daily from {_day(start, home)} (a week before you fly) until {_day(end, last.destination_tz)}.",
            "why": "Taken regularly, it slightly shortens colds, and helps more when you're run down, as long flights and short "
                   "nights make you. Starting once you're already ill doesn't help. Studies used 200 mg to 1 g a day.",
            "caution": "High doses can upset your stomach. Avoid large doses if you've had kidney stones.",
        })
        items.append({
            "name": "Zinc lozenges", "evidence": "Weak or mixed",
            "when": "Only if you catch a cold: start within 24 hours of the first symptoms, for a few days at most.",
            "why": "May shorten a cold by a day or two, but the evidence is low-certainty.",
            "caution": "Can cause nausea or a bad taste. Never use zinc nasal sprays: they have caused lasting loss of smell.",
        })

    items.append({
        "name": "Vitamin D, B12, magnesium, 'jet lag' blends", "evidence": "No evidence for jet lag",
        "when": "Skip them for this trip.",
        "why": "None has good evidence of helping jet lag. Take them only if a doctor has told you you're low.",
        "caution": "",
    })
    return {"items": items, "caution": GENERAL_CAUTION}
