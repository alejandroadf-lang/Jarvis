"""
Trip-based jet-lag planning: the engine behind the consumer app and /v2.

shift_logic.py (v1) answers "N zones, which way" with a schedule on the home
clock, starting after arrival. That is not something a traveller can follow:
they know their flight, not a zone count; they live on local time once they
land; and the best-supported approach starts shifting before departure. This
module takes the flight and returns dated events on the clock of wherever the
traveller is at the time.

The model, in one paragraph. The body clock is tracked by its core-body-
temperature minimum (CBTmin), taken as two hours before habitual wake. Light
after CBTmin advances the clock and light before it delays it, so light-seek
and light-avoid windows are placed on either side of each day's CBTmin (the
phase-response curve, e.g. Khalsa et al. 2003). The clock moves at most
1.0 h/day earlier or 1.5 h/day later after arrival (Eastman & Burgess 2009),
and 1.0 h/day before departure by moving sleep earlier or later at home
(Burgess et al. 2003, three pre-flight days). Sleep before departure follows
the shifting body clock; from arrival, sleep is on the local clock, because
that is the day the traveller actually has to live, and light does the
shifting. Light windows that fall inside planned sleep are trimmed away: a
window you would sleep through is not advice.

Everything is computed in UTC and rendered per event in the traveller's
current zone (home before departure, destination from boarding on, since that
is when to change your watch). Daylight-saving is handled by zoneinfo; the time
difference is the one in force at the moment of arrival.

Itineraries. A round trip, an open jaw (back from a different city) or a
multi-city trip is a list of journeys separated by stays, and plan_itinerary
chains them: each journey starts from the body clock the previous one predicts
at that departure, not from the local clock of the city being left. After two
days in London on the way from Bangkok to New York the body is still hours
east of London, and a plan that assumed it was local would be wrong by that
much. The body clock is a fixed UTC offset here (it has no daylight-saving of
its own), which is why plan_trip takes body_offset_hours.

Not medical advice. Melatonin is given as timing only, never a dose, and only
for advancing: morning melatonin for delays is sedating and the evidence for
it is weaker. It is prescription-only in parts of Europe and the UK.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import List, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from src import advice
from src.shift_logic import DISCLAIMER

UTC = timezone.utc

ADVANCE_RATE = 1.0          # h/day after arrival, clock earlier (eastward)
DELAY_RATE = 1.5            # h/day after arrival, clock later (westward)
PREFLIGHT_RATE = 1.0        # h/day at home before departure, either way
MAX_PREFLIGHT_DAYS = 3
CBT_BEFORE_WAKE = 2.0       # CBTmin ~2h before habitual wake
LIGHT_WINDOW = 3.0          # hours either side of CBTmin
MIN_WINDOW_MINUTES = 30     # shorter trimmed windows are dropped
CAFFEINE_CUTOFF = 6.0       # no caffeine within this many hours of bedtime
NAP_MINUTES = 30
SHORT_TRIP_HOURS = 72       # at the destination for less: stay on home time
MAX_FLIGHT_HOURS = 48       # first departure to final arrival, stopovers included
# The longest scheduled nonstop (Singapore-New York) is under 19 hours. A
# single flight over 30 is a landing date typed a day or more late; the margin
# leaves room for a long delay without refusing a real flight.
MAX_LEG_HOURS = 30
LAYOVER_SLEEP_HOURS = 4     # a stopover this long can hold real sleep
READY_BEFORE_DEPARTURE = timedelta(hours=3)

# What the traveller has for light when daylight isn't available or practical.
LIGHT_DEVICES = ("none", "glasses", "box")

# Used only when the traveller gives no sleep times.
CHRONOTYPE_SLEEP = {
    "early": (22.0, 6.0),
    "intermediate": (23.0, 7.0),
    "late": (0.5, 8.5),
}


@dataclass
class Event:
    type: str                 # sleep | light_seek | light_avoid | melatonin | caffeine_ok | nap | flight | stopover | focus | fog
    start: datetime           # UTC
    end: Optional[datetime]   # UTC, None for point events
    where: str                # home | flight | stopover | destination
    note: str = ""
    tz: Optional[str] = None  # the clock to show it on, when not simply home or destination


@dataclass
class TripPlan:
    mode: str                         # adapt | stay_on_home_time | no_shift
    home_tz: str
    destination_tz: str
    time_difference_hours: float      # destination minus the body clock, at arrival
    strategy: Optional[str]           # advance | delay
    shift_hours: float
    preflight_days: int
    days_to_adapt_after_arrival: int
    adapted_by: Optional[date]        # destination date the body clock is expected to be local
    events: List[Event] = field(default_factory=list)
    summary: str = ""
    disclaimer: str = DISCLAIMER
    # Destination minus the departure city's clock. Equal to
    # time_difference_hours unless the body was already part-way when leaving.
    local_time_difference_hours: float = 0.0
    # The body clock's UTC offset at departure, and where it is expected to be
    # after each CBTmin (UTC moment, signed hours moved). What the next journey
    # in an itinerary starts from.
    body_offset_hours: float = 0.0
    phase: List[Tuple[datetime, float]] = field(default_factory=list)
    usual_bedtime: Optional[float] = None   # hours, home clock; for "1 h earlier than usual"
    usual_wake: Optional[float] = None      # hours, home clock; anchors the body's alert and foggy hours
    light_device: str = "none"              # none | glasses | box: shapes the light advice


# --- small helpers ---------------------------------------------------------------------

def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(str(name).strip())
    except (ZoneInfoNotFoundError, ValueError) as err:
        raise ValueError(f"unknown time zone: {name}") from err


def parse_hour(value) -> float:
    """'23:30' or 23.5 -> 23.5, in [0, 24)."""
    if isinstance(value, (int, float)):
        hour = float(value)
    else:
        text = str(value).strip()
        try:
            hh, mm = (text.split(":") + ["0"])[:2]
            hour = int(hh) + int(mm) / 60.0
        except ValueError as err:
            raise ValueError(f"not a clock time: {value}") from err
    if not 0 <= hour < 24:
        raise ValueError(f"clock time out of range: {value}")
    return hour


def local(dt_naive: datetime, tz: ZoneInfo) -> datetime:
    """A wall-clock time in tz, as UTC."""
    if dt_naive.tzinfo is not None:
        return dt_naive.astimezone(UTC)
    return dt_naive.replace(tzinfo=tz).astimezone(UTC)


def night_start(d: date, sleep_start: float, tz: ZoneInfo) -> datetime:
    """
    The bedtime of 'the night of date d', in UTC. A bedtime after midnight
    (a late type's 00:30) belongs to the evening before, so it is placed on
    d + 1. Wall-clock arithmetic, then UTC, so DST nights are right.
    """
    hour = sleep_start if sleep_start >= 12 else sleep_start + 24
    wall = datetime.combine(d, time(0, 0)) + timedelta(hours=hour)
    return wall.replace(tzinfo=tz).astimezone(UTC)


def _offset_hours(tz: ZoneInfo, at: datetime) -> float:
    return at.astimezone(tz).utcoffset().total_seconds() / 3600.0


def _subtract(window: Tuple[datetime, datetime], blocks: List[Tuple[datetime, datetime]]):
    """Parts of window not covered by any block, dropping slivers."""
    pieces = [window]
    for b0, b1 in blocks:
        nxt = []
        for p0, p1 in pieces:
            if b1 <= p0 or b0 >= p1:
                nxt.append((p0, p1))
                continue
            if b0 > p0:
                nxt.append((p0, b0))
            if b1 < p1:
                nxt.append((b1, p1))
        pieces = nxt
    return [(a, b) for a, b in pieces if (b - a) >= timedelta(minutes=MIN_WINDOW_MINUTES)]


# --- the plan --------------------------------------------------------------------------

def choose_strategy(difference: float, preflight_days: int, requested: str = "auto") -> Tuple[str, float, float]:
    """
    (strategy, hours to shift, post-arrival rate).

    Past about nine zones east, going the long way round (delaying) is often
    quicker, because the clock delays half again as fast as it advances. So
    'auto' compares the days each way, after pre-flight days, and takes the
    fewer; a tie goes to the shorter way round.
    """
    advance_need = difference % 24
    delay_need = (24 - advance_need) % 24
    pre = min(preflight_days, MAX_PREFLIGHT_DAYS) * PREFLIGHT_RATE

    def days(need, rate):
        return math.ceil(max(0.0, need - pre) / rate - 1e-9)

    if requested == "advance":
        return "advance", advance_need, ADVANCE_RATE
    if requested == "delay":
        return "delay", delay_need, DELAY_RATE
    if requested != "auto":
        raise ValueError(f"unknown strategy: {requested}")
    da, dd = days(advance_need, ADVANCE_RATE), days(delay_need, DELAY_RATE)
    if da < dd or (da == dd and advance_need <= 12):
        return "advance", advance_need, ADVANCE_RATE
    return "delay", delay_need, DELAY_RATE


def _duration(td: timedelta) -> str:
    hours = round(td.total_seconds() / 3600)
    days, hours = divmod(hours, 24)
    parts = [f"{days} day{'s' if days != 1 else ''}"] if days else []
    if hours or not parts:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    return " ".join(parts)


def _when(t: datetime) -> str:
    return f"{t.strftime('%a')} {t.day} {t.strftime('%b')} {t.strftime('%H:%M')}"


def _check_lengths(flights) -> None:
    """
    The times are what the traveller typed, and a landing date one or two days
    off is the usual slip on a phone's date picker. The message says which
    flight, how long it came out as, and what to check, because "not
    supported; plan each leg" left someone with a direct flight nowhere to go.
    """
    for i, (d, a, dz, az) in enumerate(flights, start=1):
        if a - d > timedelta(hours=MAX_LEG_HOURS):
            which = f"Flight {i}" if len(flights) > 1 else "This flight"
            raise ValueError(
                f"{which} comes out at {_duration(a - d)} ({_when(d.astimezone(dz))} to "
                f"{_when(a.astimezone(az))}, local times). "
                "The longest flights are about 19 hours: check the landing date on your ticket. "
                "For a stay of a few days, choose Return and add the flight home: under "
                f"{SHORT_TRIP_HOURS // 24} days there, the plan keeps you on home time."
            )
    dep, arr = flights[0][0], flights[-1][1]
    if arr - dep > timedelta(hours=MAX_FLIGHT_HOURS):
        raise ValueError(
            f"This journey comes out at {_duration(arr - dep)} from first take-off to last landing "
            f"({_when(dep.astimezone(flights[0][2]))} to {_when(arr.astimezone(flights[-1][3]))}, local times). Check the dates of each flight; "
            f"if a stop really lasts days, add it as a separate trip with Multi-city."
        )


# A long-haul jet averages about 800 km/h gate to gate once climb, descent and
# routing are counted, plus taxiing at both ends. Good to within an hour or so
# on long flights, which is what an estimate is for: the ticket's times replace it.
BLOCK_SPEED_KMH = 800
TAXI_MINUTES = 30


def estimate_landing(departure: datetime, departure_tz: str, arrival_tz: str) -> Tuple[datetime, int]:
    """
    (local landing time, minutes in the air) for a direct flight, from the
    distance between the two time zones' reference cities. Used when a
    traveller gave the day they fly out and the day they fly back, but not the
    times on the ticket.
    """
    dz, az = zone(departure_tz), zone(arrival_tz)
    a, b = advice.coordinates(dz.key), advice.coordinates(az.key)
    if not a or not b:
        raise ValueError(f"no location is known for {departure_tz if not a else arrival_tz}; add the landing time from your ticket")
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    km = 2 * 6371 * math.asin(math.sqrt(
        math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2))
    minutes = int(round((km / BLOCK_SPEED_KMH * 60 + TAXI_MINUTES) / 5) * 5)
    landing = (local(departure, dz) + timedelta(minutes=minutes)).astimezone(az)
    return landing.replace(tzinfo=None), minutes


def _parse_legs(legs) -> List[Tuple[datetime, datetime, ZoneInfo, ZoneInfo]]:
    """[(dep_utc, arr_utc, dep_zone, arr_zone)], validated as one journey."""
    parsed = []
    for i, leg in enumerate(legs, start=1):
        get = leg.get if isinstance(leg, dict) else (lambda k, _l=leg: getattr(_l, k))
        dz, az = zone(get("departure_tz")), zone(get("arrival_tz"))
        d0, a0 = get("departure"), get("arrival")
        if isinstance(d0, str):
            d0 = datetime.fromisoformat(d0)
        if isinstance(a0, str):
            a0 = datetime.fromisoformat(a0)
        d, a = local(d0, dz), local(a0, az)
        if a <= d:
            raise ValueError(f"flight {i}: arrival must be after departure")
        if parsed and d < parsed[-1][1]:
            raise ValueError(
                f"The flight on from stop {i - 1} leaves {_when(d.astimezone(dz))}, before you land there "
                f"({_when(parsed[-1][1].astimezone(dz))}, local times): check the times at stop {i - 1}.")
        parsed.append((d, a, dz, az))
    if not parsed:
        raise ValueError("a trip needs at least one flight")
    return parsed


def plan_trip(
    departure: Optional[datetime] = None,
    departure_tz: Optional[str] = None,
    arrival: Optional[datetime] = None,
    arrival_tz: Optional[str] = None,
    sleep_start=None,
    sleep_end=None,
    chronotype: str = "intermediate",
    preflight_days: int = 2,
    return_departure: Optional[datetime] = None,
    melatonin: bool = True,
    caffeine: bool = True,
    strategy: str = "auto",
    legs=None,
    body_offset_hours: Optional[float] = None,
    light_device: str = "none",
) -> TripPlan:
    """
    departure / arrival: wall-clock times at the origin and the final
    destination (naive datetimes, or aware ones). return_departure, if given,
    is the wall-clock time the traveller leaves the destination again.

    legs: for connections, a list of flights, each with departure,
    departure_tz, arrival and arrival_tz; it replaces the four single-flight
    arguments. Stopovers get their own clock, and sleep is only advised on
    board or at a stopover long enough to hold it.

    body_offset_hours: the UTC offset the body clock is on at departure, when
    that is not the departure city's own (see plan_itinerary). Sleep and light
    before the flight follow the body; the shift is measured from it.
    """
    if legs:
        flights = _parse_legs(legs)
    else:
        if None in (departure, departure_tz, arrival, arrival_tz):
            raise ValueError("give departure, departure_tz, arrival and arrival_tz, or legs")
        d_zone, a_zone = zone(departure_tz), zone(arrival_tz)
        flights = [(local(departure, d_zone), local(arrival, a_zone), d_zone, a_zone)]
        if flights[0][1] <= flights[0][0]:
            raise ValueError("arrival must be after departure")
    home, dest = flights[0][2], flights[-1][3]
    dep, arr = flights[0][0], flights[-1][1]
    # The clock the body is on. A fixed-offset zone stands in for it: pre-flight
    # nights and the body's CBTmin are computed on it, and rendered in the
    # departure city's real zone, which is what the traveller reads.
    body_offset = _offset_hours(home, dep) if body_offset_hours is None else float(body_offset_hours)
    body = timezone(timedelta(hours=body_offset))
    stopovers = [(flights[i][1], flights[i + 1][0], flights[i][3]) for i in range(len(flights) - 1)]
    _check_lengths(flights)
    if not 0 <= int(preflight_days) <= MAX_PREFLIGHT_DAYS:
        raise ValueError(f"preflight_days must be 0 to {MAX_PREFLIGHT_DAYS}")
    preflight_days = int(preflight_days)
    if chronotype not in CHRONOTYPE_SLEEP:
        raise ValueError(f"unknown chronotype: {chronotype}")
    if light_device not in LIGHT_DEVICES:
        raise ValueError(f"light_device must be one of {', '.join(LIGHT_DEVICES)}")

    default_start, default_end = CHRONOTYPE_SLEEP[chronotype]
    ss = parse_hour(sleep_start) if sleep_start is not None else default_start
    se = parse_hour(sleep_end) if sleep_end is not None else default_end
    sleep_len = (se - ss) % 24
    if not 4 <= sleep_len <= 12:
        raise ValueError("usual sleep must be between 4 and 12 hours")
    sleep_td = timedelta(hours=sleep_len)

    def wrap(hours: float) -> float:
        hours = ((hours + 12) % 24) - 12   # into [-12, 12)
        return 12.0 if hours == -12 else hours

    difference = wrap(_offset_hours(dest, arr) - body_offset)
    local_difference = wrap(_offset_hours(dest, arr) - _offset_hours(home, arr))

    events: List[Event] = []
    for i, (d, a, _dz, _az) in enumerate(flights):
        parts = [f"Flight {i + 1} of {len(flights)}."] if len(flights) > 1 else []
        if i == 0:
            parts.append("Change your watch to your destination's time when you board.")
        events.append(Event("flight", d, a, "flight", " ".join(parts), tz=dest.key))
    for s0, s1, sz in stopovers:
        events.append(Event("stopover", s0, s1, "stopover",
                            f"Stopover in {sz.key.split('/')[-1].replace('_', ' ')}. Follow the plan's light advice here too.",
                            tz=sz.key))
    base = dict(home_tz=home.key, destination_tz=dest.key, time_difference_hours=difference,
                local_time_difference_hours=local_difference, body_offset_hours=body_offset,
                usual_bedtime=ss, usual_wake=se, light_device=light_device)

    # --- no shift -----------------------------------------------------------------------
    if abs(difference) < 1:
        return TripPlan(mode="no_shift", strategy=None, shift_hours=0.0, preflight_days=0,
                        days_to_adapt_after_arrival=0, adapted_by=arr.astimezone(dest).date(),
                        events=events, summary="Less than an hour of time difference: keep your usual schedule.",
                        **base)

    # --- short trip: stay on home time ----------------------------------------------------
    if return_departure is not None:
        ret = local(return_departure, dest)
        if ret <= arr:
            raise ValueError("return_departure must be after arrival")
        if ret - arr < timedelta(hours=SHORT_TRIP_HOURS):
            d = arr.astimezone(body).date() - timedelta(days=1)
            while True:
                s0 = night_start(d, ss, body)
                if s0 >= ret:
                    break
                s1 = s0 + sleep_td
                if s1 > arr + timedelta(hours=1):
                    start = max(s0, arr + timedelta(hours=1))
                    if s1 - start >= timedelta(hours=1):
                        events.append(Event("sleep", start, s1, "destination",
                                            "Your home-time night. Keep to it: the trip is too short to adapt."))
                d += timedelta(days=1)
            events.sort(key=lambda e: e.start)
            plan = TripPlan(mode="stay_on_home_time", strategy=None, shift_hours=0.0, preflight_days=0,
                            days_to_adapt_after_arrival=0, adapted_by=None, events=events,
                            summary=(f"You are in {advice.city(dest.key)} under {SHORT_TRIP_HOURS} hours: "
                                     f"stay on {advice.city(home.key)} time. Sleep and get daylight on your home "
                                     "clock, and don't try to adapt."),
                            **base)
            _add_alertness(plan)
            return plan

    # --- adapt ----------------------------------------------------------------------------
    strat, need, rate = choose_strategy(difference, preflight_days, strategy)
    sign = 1 if strat == "advance" else -1   # +1: the body clock moves earlier
    pre_days = min(preflight_days, math.ceil(need / PREFLIGHT_RATE - 1e-9))
    pre_shift = min(need, pre_days * PREFLIGHT_RATE)
    post_days = math.ceil(max(0.0, need - pre_shift) / rate - 1e-9)

    sleeps: List[Tuple[datetime, datetime]] = []

    # Pre-flight nights, at home, on the shifting body clock.
    dep_home_date = dep.astimezone(body).date()
    first_home_night = dep_home_date - timedelta(days=pre_days)
    for i in range(pre_days):
        shift = min(need, (i + 1) * PREFLIGHT_RATE)
        s0 = night_start(first_home_night + timedelta(days=i), ss, body) - sign * timedelta(hours=shift)
        s1 = s0 + sleep_td
        if s1 > dep - READY_BEFORE_DEPARTURE:
            continue
        sleeps.append((s0, s1))
        events.append(Event("sleep", s0, s1, "home",
                            f"Bedtime {'earlier' if sign > 0 else 'later'} by {shift:g} h than usual."))

    # Sleep on the plane, or at a long stopover, where it covers a destination night.
    arr_dest_date = arr.astimezone(dest).date()
    places = [(d, a, "flight", None, "Sleep on the plane: it is night where you are going.") for d, a, _, _ in flights]
    places += [(s0, s1, "stopover", sz.key, "Sleep here if you can (a lounge or airport hotel): it is night where you are going.")
               for s0, s1, sz in stopovers if s1 - s0 >= timedelta(hours=LAYOVER_SLEEP_HOURS)]
    for p0, p1, where, tzname, note in places:
        for back in range(4):
            d = arr_dest_date - timedelta(days=back)
            n0 = night_start(d, ss, dest)
            n1 = n0 + sleep_td
            f0, f1 = max(n0, p0), min(n1, p1)
            if f1 - f0 >= timedelta(hours=1):
                sleeps.append((f0, f1))
                events.append(Event("sleep", f0, f1, where, note, tz=tzname))

    # Destination nights, on local time, until the body clock has caught up.
    nights = max(1, post_days)
    d = arr_dest_date - timedelta(days=1)
    first = True
    added = 0
    while added < nights:
        s0 = night_start(d, ss, dest)
        s1 = s0 + sleep_td
        d += timedelta(days=1)
        if s1 <= arr + timedelta(hours=1):
            continue
        start = max(s0, arr + timedelta(hours=1))
        if s1 - start < timedelta(hours=2):
            continue
        sleeps.append((start, s1))
        note = "Local bedtime. " + ("First night: expect to wake early or late; stay in bed and keep it dark."
                                    if first else "Keep to local time.")
        events.append(Event("sleep", start, s1, "destination", note))
        first = False
        added += 1
    sleeps.sort()

    # Body clock: CBTmin per day, continuous from the first pre-flight night.
    def home_cbt(d0: date) -> datetime:
        return night_start(d0, ss, body) + sleep_td - timedelta(hours=CBT_BEFORE_WAKE)

    k0 = first_home_night if pre_days else dep_home_date
    shifts = []
    k = 0
    while True:
        dk = k0 + timedelta(days=k)
        if k < pre_days:
            s = min(need, (k + 1) * PREFLIGHT_RATE)
        else:
            s = pre_shift
        cbt = home_cbt(dk) - sign * timedelta(hours=s)
        if cbt >= arr:
            break
        shifts.append((cbt, s))
        k += 1
        if k > 10:
            break
    post = 0
    while True:
        dk = k0 + timedelta(days=k)
        s = min(need, pre_shift + (post + 1) * rate)
        cbt = home_cbt(dk) - sign * timedelta(hours=s)
        shifts.append((cbt, s))
        k += 1
        post += 1
        if s >= need - 1e-9 or post > 20:
            break

    notes = {
        ("light_seek", False): "Get bright light: outdoors if you can, otherwise a bright lamp or screen close up.",
        ("light_seek", True): "Get light on the plane: window shade open, reading light on, or a bright screen close up.",
        ("light_avoid", False): "Avoid bright light: dim lights, sunglasses outside, no screens close up.",
        ("light_avoid", True): "Avoid light on the plane: shade down, eye mask, screens dimmed.",
    }

    def where_at(t: datetime):
        if t < dep:
            return "home", None
        if t >= arr:
            return "destination", None
        for s0, s1, sz in stopovers:
            if s0 <= t < s1:
                return "stopover", sz.key
        return "flight", None

    def add_light(kind: str, a: datetime, b: datetime):
        w, tzname = where_at(a)
        events.append(Event(kind, a, b, w, notes[(kind, w == "flight")], tz=tzname))

    for cbt, _ in shifts:
        before = (cbt - timedelta(hours=LIGHT_WINDOW), cbt)
        after = (cbt, cbt + timedelta(hours=LIGHT_WINDOW))
        seek, avoid = (after, before) if sign > 0 else (before, after)
        seek_pieces = _subtract(seek, sleeps)
        if not seek_pieces:
            # The window falls wholly inside a planned sleep, which is common
            # when delaying: CBTmin sits in the small hours. The same side of
            # the curve is still reachable awake, just further from CBTmin:
            # the evening before that sleep when delaying, the morning after
            # it when advancing. Weaker, but light you can actually get.
            host = next(((a, b) for a, b in sleeps if a <= cbt <= b), None)
            if host is not None:
                h0, h1 = host
                fallback = (h0 - timedelta(hours=LIGHT_WINDOW), h0) if sign < 0 else (h1, h1 + timedelta(hours=LIGHT_WINDOW))
                seek_pieces = _subtract(fallback, sleeps)
        for a, b in seek_pieces:
            add_light("light_seek", a, b)
        for a, b in _subtract(avoid, sleeps):
            add_light("light_avoid", a, b)

    # Melatonin: timing only, advancing only, on real nights (not the plane).
    if melatonin and sign > 0:
        for e in [e for e in events if e.type == "sleep" and e.where in ("home", "destination")]:
            events.append(Event("melatonin", e.start - timedelta(minutes=30), None, e.where,
                                "Optional: a low dose of melatonin 30 minutes before bed. Check with a doctor first; "
                                "it needs a prescription in some countries."))

    # Caffeine: from waking until six hours before the next bedtime.
    if caffeine:
        nights_only = [(a, b) for (a, b) in sleeps]
        for (a0, a1), (b0, _) in zip(nights_only, nights_only[1:]):
            c0, c1 = a1, b0 - timedelta(hours=CAFFEINE_CUTOFF)
            if c1 - c0 >= timedelta(hours=1) and not (c0 < arr and c1 > dep):
                where = "home" if c0 < dep else "destination"
                events.append(Event("caffeine_ok", c0, c1, where, "Coffee or tea is fine now; none after this."))

    # Arrival-day nap: short, early afternoon, well before bedtime.
    arr_local = arr.astimezone(dest)
    nap_open = local(datetime.combine(arr_local.date(), time(13, 0)), dest)
    nap_close = local(datetime.combine(arr_local.date(), time(15, 0)), dest)
    nap_start = max(nap_open, arr + timedelta(hours=1))
    next_bed = next((a for a, _ in sleeps if a > nap_start), None)
    if nap_start + timedelta(minutes=NAP_MINUTES) <= nap_close and (
        next_bed is None or next_bed - nap_start >= timedelta(hours=CAFFEINE_CUTOFF)
    ) and not any(a <= nap_start < b for a, b in sleeps):
        events.append(Event("nap", nap_start, nap_start + timedelta(minutes=NAP_MINUTES), "destination",
                            f"If you need it: one nap, {NAP_MINUTES} minutes at most. Set an alarm."))

    events.sort(key=lambda e: (e.start, e.type))
    adapted_by = (arr.astimezone(dest).date() + timedelta(days=post_days)) if post_days else arr.astimezone(dest).date()
    way = "earlier" if sign > 0 else "later"
    long_way = (strat == "advance" and difference < 0) or (strat == "delay" and difference > 0)
    there = advice.city(dest.key)
    by = f"{adapted_by.strftime('%a')} {adapted_by.day} {adapted_by.strftime('%b')}"
    summary = (
        f"Your body clock needs to move {need:g} hours {way} to reach {there} time"
        + (" (the long way round: it is faster for this trip)" if long_way else "")
        + (f". Start {pre_days} day{'s' if pre_days != 1 else ''} before you fly" if pre_days else "")
        + f", and expect to feel on {there} time by {by}, about {post_days} day{'s' if post_days != 1 else ''} after landing."
        + (" The first days matter most: the morning light windows below do most of the work." if sign > 0 else
           " The first days matter most: the evening light windows below do most of the work.")
    )
    plan = TripPlan(mode="adapt", strategy=strat, shift_hours=need, preflight_days=pre_days,
                    days_to_adapt_after_arrival=post_days, adapted_by=adapted_by, events=events,
                    summary=summary, phase=[(cbt, sign * s) for cbt, s in shifts], **base)
    _add_alertness(plan)
    return plan


def _add_alertness(plan: TripPlan) -> None:
    """Add the clearest and foggiest hours of each day there, then word every event."""
    for kind, a, b in advice.alertness_windows(plan):
        plan.events.append(Event(kind, a, b, "destination"))
    plan.events.sort(key=lambda e: (e.start, e.type))
    advice.describe(plan)


def body_offset_at(plan: TripPlan, at: datetime) -> float:
    """The body clock's UTC offset, in hours, at a moment during or after this plan."""
    moved = 0.0
    for cbt, s in plan.phase:
        if cbt <= at:
            moved = s
    return plan.body_offset_hours + moved


# --- itineraries ------------------------------------------------------------------------

def plan_itinerary(
    journeys,
    sleep_start=None,
    sleep_end=None,
    chronotype: str = "intermediate",
    preflight_days: int = 2,
    melatonin: bool = True,
    caffeine: bool = True,
    strategy: str = "auto",
    light_device: str = "none",
) -> List[TripPlan]:
    """
    Several journeys in order, each a list of flights (connections included),
    separated by stays: a round trip, an open jaw, or a multi-city trip.

    Chained: each journey starts from the body clock the previous plan predicts
    at that departure. Pre-flight shifting applies to the first journey only,
    because a stay is the previous journey's adaptation time and cannot be
    both. Each journey's events stop three hours before the next departure, so
    no night gets two plans. A stay under SHORT_TRIP_HOURS is handled by the
    previous journey's short-trip rule: the body stays where it was, and the
    next plan starts from there.
    """
    if not journeys:
        raise ValueError("an itinerary needs at least one journey")
    parsed = [_parse_legs(j) for j in journeys]
    for i in range(1, len(parsed)):
        if parsed[i][0][0] < parsed[i - 1][-1][1]:
            prev_land, prev_zone = parsed[i - 1][-1][1], parsed[i - 1][-1][3]
            raise ValueError(
                f"Flight {i + 1} leaves {_when(parsed[i][0][0].astimezone(parsed[i][0][2]))}, before flight {i} "
                f"lands ({_when(prev_land.astimezone(prev_zone))}, local times): check the landing date of flight {i}.")

    plans: List[TripPlan] = []
    body_offset: Optional[float] = None
    for i, legs in enumerate(journeys):
        nxt = parsed[i + 1][0][0] if i + 1 < len(parsed) else None
        plan = plan_trip(
            legs=legs, sleep_start=sleep_start, sleep_end=sleep_end, chronotype=chronotype,
            preflight_days=preflight_days if i == 0 else 0, return_departure=nxt,
            melatonin=melatonin, caffeine=caffeine, strategy=strategy, body_offset_hours=body_offset,
            light_device=light_device,
        )
        if nxt is not None:
            cut = nxt - READY_BEFORE_DEPARTURE
            kept = []
            for e in plan.events:
                if e.start >= cut:
                    continue
                if e.end is not None and e.end > cut:
                    if cut - e.start < timedelta(minutes=MIN_WINDOW_MINUTES):
                        continue
                    e.end = cut
                kept.append(e)
            plan.events = kept
            advice.describe(plan)
            # Where the body will be on leaving, expressed near the next
            # departure city's offset so the next difference comes out short way round.
            leaving = body_offset_at(plan, nxt)
            next_local = _offset_hours(parsed[i + 1][0][2], nxt)
            body_offset = next_local + (((leaving - next_local + 12) % 24) - 12)
            if plan.mode == "adapt" and plan.adapted_by and nxt.astimezone(zone(plan.destination_tz)).date() < plan.adapted_by:
                plan.summary += (" You fly on before your body clock has fully caught up; the next plan"
                                 " starts from where it will actually be.")
        plans.append(plan)
    return plans


def merge_plans(plans: List[TripPlan]) -> TripPlan:
    """
    One plan holding every journey's events, each on its own clock, for the
    parts of the app that read events only: reminders, the calendar file and
    WHOOP progress. The per-journey plans are what the page shows.
    """
    if len(plans) == 1:
        return plans[0]
    events: List[Event] = []
    for p in plans:
        for e in p.events:
            tz = e.tz or (p.home_tz if e.where == "home" else p.destination_tz)
            events.append(Event(e.type, e.start, e.end, e.where, e.note, tz=tz))
    events.sort(key=lambda e: (e.start, e.type))
    first, last = plans[0], plans[-1]
    adapting = [p for p in plans if p.mode == "adapt"]
    # Each journey's phase is relative to its own starting body clock; on the
    # first journey's scale they read as one trajectory, so body_offset_at
    # and the clock graph work on the merged plan too.
    phase = []
    for p in plans:
        base_shift = p.body_offset_hours - first.body_offset_hours
        phase += [(cbt, base_shift + s) for cbt, s in p.phase]
        if not p.phase and p is not first:
            phase.append((min(e.start for e in p.events), base_shift))
    return TripPlan(
        mode="adapt" if adapting else first.mode,
        home_tz=first.home_tz, destination_tz=last.destination_tz,
        time_difference_hours=first.time_difference_hours,
        strategy=adapting[-1].strategy if adapting else None,
        shift_hours=sum(p.shift_hours for p in plans),
        preflight_days=first.preflight_days,
        days_to_adapt_after_arrival=last.days_to_adapt_after_arrival,
        adapted_by=last.adapted_by, events=events,
        summary=" ".join(p.summary for p in plans),
        local_time_difference_hours=first.local_time_difference_hours,
        body_offset_hours=first.body_offset_hours,
        phase=phase,
    )


# --- output ----------------------------------------------------------------------------

def local_zone_at(plan: TripPlan, at: datetime) -> ZoneInfo:
    """Where the traveller is at a moment: the clock of the last thing on the ground before it."""
    zone = ZoneInfo(plan.home_tz)
    for e in plan.events:
        if e.start > at:
            break
        # Anything in the air (the flight itself, sleep on it) says nothing
        # about where the traveller is; a stopover does, and carries its zone.
        if e.type == "flight" or e.where == "flight":
            continue
        zone = ZoneInfo(e.tz or (plan.home_tz if e.where == "home" else plan.destination_tz))
    return zone


def hours_off_local(plan: TripPlan, at: datetime) -> float:
    """Body clock minus the local clock, in hours: 0 is adapted, +6 is a body six hours ahead."""
    zone = local_zone_at(plan, at)
    local_offset = (at.astimezone(zone).utcoffset() or timedelta(0)).total_seconds() / 3600
    return round(body_offset_at(plan, at) - local_offset, 2)


def clock_series(plan: TripPlan) -> List[dict]:
    """
    The body clock against the local clock over the whole trip, as points to
    draw: at the plan's start, at each landing (the local clock jumps, the
    body's does not), at each expected step of the body clock, and at the
    end. This is the picture of jet lag itself: a line that has to come back
    to zero, and what a night measured by WHOOP is plotted against.
    """
    if not plan.events:
        return []
    moments = {min(e.start for e in plan.events), max(e.end or e.start for e in plan.events)}
    # A point just before and one at each change, so the line steps rather
    # than slopes: where the local clock changes (landing, a stopover), and
    # where the body clock is expected to move.
    zone = plan.home_tz
    for e in plan.events:
        if e.type == "flight" or e.where == "flight":
            continue
        here = e.tz or (plan.home_tz if e.where == "home" else plan.destination_tz)
        if here != zone:
            moments.add(e.start - timedelta(seconds=1))
            moments.add(e.start)
            zone = here
    for cbt, _ in plan.phase:
        moments.add(cbt - timedelta(seconds=1))
        moments.add(cbt)
    out = []
    for at in sorted(moments):
        out.append({"at": at.astimezone(UTC).isoformat().replace("+00:00", "Z"),
                    "hours": hours_off_local(plan, at), "local_tz": local_zone_at(plan, at).key})
    return out


def plan_to_dict(plan: TripPlan) -> dict:
    """JSON-ready: every event with UTC times and the wall clock where the traveller is."""
    home, dest = ZoneInfo(plan.home_tz), ZoneInfo(plan.destination_tz)

    def zone_of(e: Event) -> ZoneInfo:
        if e.tz:
            return ZoneInfo(e.tz)
        return home if e.where == "home" else dest

    def render(dt: Optional[datetime], tz: ZoneInfo):
        if dt is None:
            return None, None
        return dt.astimezone(UTC).isoformat().replace("+00:00", "Z"), dt.astimezone(tz).strftime("%Y-%m-%dT%H:%M")

    out = []
    for e in plan.events:
        tz = zone_of(e)
        s_utc, s_local = render(e.start, tz)
        e_utc, e_local = render(e.end, tz)
        out.append({
            "type": e.type, "where": e.where, "note": e.note,
            "start": s_utc, "end": e_utc,
            "start_local": s_local, "end_local": e_local,
            "local_tz": tz.key,
        })
    return {
        "mode": plan.mode,
        "home_tz": plan.home_tz,
        "destination_tz": plan.destination_tz,
        "time_difference_hours": plan.time_difference_hours,
        "local_time_difference_hours": plan.local_time_difference_hours,
        "strategy": plan.strategy,
        "shift_hours": plan.shift_hours,
        "preflight_days": plan.preflight_days,
        "days_to_adapt_after_arrival": plan.days_to_adapt_after_arrival,
        "adapted_by": plan.adapted_by.isoformat() if plan.adapted_by else None,
        "summary": plan.summary,
        "briefing": advice.briefing(plan),
        "events": out,
        "clock": clock_series(plan),
        "disclaimer": plan.disclaimer,
    }
