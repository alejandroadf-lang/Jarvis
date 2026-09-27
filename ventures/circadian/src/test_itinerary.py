"""
Tests for src/itinerary.py, the trip-based planner behind the app and /v2.

Real routes and real zones, so daylight saving is exercised rather than
assumed away. Each test pins a behaviour a traveller would notice if it were
wrong: the direction, the number of days, light advice they could not follow,
melatonin where it does not belong.
"""

from datetime import datetime, timedelta, timezone

import pytest

from src.itinerary import (
    ADVANCE_RATE,
    DELAY_RATE,
    choose_strategy,
    plan_to_dict,
    plan_trip,
)

UTC = timezone.utc


def bkk_to_cdg(**kw):
    # Overnight westward: Bangkok UTC+7 to Paris UTC+2 (summer time) = 5 h later.
    return plan_trip(datetime(2026, 10, 10, 23, 55), "Asia/Bangkok",
                     datetime(2026, 10, 11, 7, 0), "Europe/Paris", **kw)


def lhr_to_hnd(**kw):
    # Eastward: London UTC+1 (summer time) to Tokyo UTC+9 = 8 h earlier.
    return plan_trip(datetime(2026, 10, 10, 19, 0), "Europe/London",
                     datetime(2026, 10, 11, 15, 0), "Asia/Tokyo", **kw)


def sleeps(plan, where=None):
    return [e for e in plan.events if e.type == "sleep" and (where is None or e.where == where)]


# --- direction and length -----------------------------------------------------------------

def test_westward_trip_delays_and_counts_days_after_preflight():
    p = bkk_to_cdg()
    assert p.time_difference_hours == -5
    assert p.strategy == "delay" and p.shift_hours == 5
    assert p.preflight_days == 2
    # 5 h, 2 of them at home at 1 h/day, 3 left at 1.5 h/day = 2 days.
    assert p.days_to_adapt_after_arrival == 2


def test_eastward_trip_advances():
    p = lhr_to_hnd()
    assert p.time_difference_hours == 8
    assert p.strategy == "advance" and p.shift_hours == 8
    assert p.days_to_adapt_after_arrival == 6        # (8 - 2) / 1.0


def test_no_preflight_means_more_days_there():
    assert lhr_to_hnd(preflight_days=0).days_to_adapt_after_arrival == 8


def test_far_east_goes_the_long_way_when_it_is_faster():
    # 11 h east: advancing takes 11 days, delaying 13 h takes ceil(13/1.5) = 9.
    strat, need, rate = choose_strategy(11, 0)
    assert (strat, need, rate) == ("delay", 13, DELAY_RATE)
    # 8 h east: advancing (8) beats delaying 16 h (11).
    assert choose_strategy(8, 0)[0] == "advance"
    # A tie goes the short way round: 10 east with 2 pre-flight days is 8 either way.
    assert choose_strategy(10, 2) == ("advance", 10, ADVANCE_RATE)


def test_strategy_can_be_forced():
    assert lhr_to_hnd(strategy="delay").strategy == "delay"
    with pytest.raises(ValueError):
        lhr_to_hnd(strategy="sideways")


def test_time_difference_uses_the_offsets_in_force_at_arrival():
    # London leaves summer time on 25 Oct 2026; Tokyo has none. A day later
    # the difference is 9 h, not 8.
    p = plan_trip(datetime(2026, 10, 26, 19, 0), "Europe/London",
                  datetime(2026, 10, 27, 15, 0), "Asia/Tokyo")
    assert p.time_difference_hours == 9


# --- the three modes ------------------------------------------------------------------------

def test_same_zone_is_no_shift():
    p = plan_trip(datetime(2026, 10, 10, 9, 0), "Europe/Paris",
                  datetime(2026, 10, 10, 11, 0), "Europe/Berlin")
    assert p.mode == "no_shift"
    assert [e.type for e in p.events] == ["flight"]


def test_short_trip_stays_on_home_time():
    p = lhr_to_hnd(return_departure=datetime(2026, 10, 13, 10, 0))
    assert p.mode == "stay_on_home_time"
    assert p.strategy is None
    home_nights = sleeps(p, "destination")
    assert home_nights, "still tells them when to sleep"
    # Their home-time night, in Tokyo: 23:00 London is 07:00 Tokyo.
    assert home_nights[0].start.astimezone(timezone(timedelta(hours=9))).hour in (7, 16)


def test_long_trip_adapts():
    assert lhr_to_hnd(return_departure=datetime(2026, 10, 20, 10, 0)).mode == "adapt"


# --- advice a traveller can follow ------------------------------------------------------------

def test_no_light_window_overlaps_a_planned_sleep():
    for p in (bkk_to_cdg(), lhr_to_hnd(), lhr_to_hnd(preflight_days=0)):
        nights = [(e.start, e.end) for e in sleeps(p)]
        for e in p.events:
            if e.type in ("light_seek", "light_avoid"):
                for a, b in nights:
                    assert e.end <= a or e.start >= b, f"{e.type} {e.start}-{e.end} overlaps sleep {a}-{b}"


def test_westward_still_gets_light_advice_in_the_evening():
    # The raw delay window (before CBTmin) sits inside sleep; the fallback
    # moves it to the evening before, so the traveller is told something.
    seeks = [e for e in bkk_to_cdg().events if e.type == "light_seek" and e.where == "destination"]
    assert seeks
    paris = timezone(timedelta(hours=2))
    assert all(18 <= e.start.astimezone(paris).hour <= 23 for e in seeks)


def test_eastward_avoids_morning_light_on_arrival():
    first_day = [e for e in lhr_to_hnd().events if e.where == "destination" and e.type.startswith("light")]
    first_day.sort(key=lambda e: e.start)
    assert first_day[0].type == "light_avoid", "classic trap: morning light on day one pushes the clock the wrong way"


def test_destination_sleep_is_on_local_time():
    tokyo = timezone(timedelta(hours=9))
    for e in sleeps(lhr_to_hnd(), "destination"):
        assert e.start.astimezone(tokyo).hour == 23


def test_preflight_sleep_moves_the_right_way():
    london = timezone(timedelta(hours=1))
    pre = sleeps(lhr_to_hnd(), "home")
    assert [e.start.astimezone(london).hour for e in pre] == [22, 21]
    bangkok = timezone(timedelta(hours=7))
    pre = sleeps(bkk_to_cdg(), "home")
    assert [e.start.astimezone(bangkok).hour for e in pre] == [0, 1]


def test_sleep_on_the_plane_only_inside_the_flight():
    p = bkk_to_cdg()
    flight = next(e for e in p.events if e.type == "flight")
    on_board = sleeps(p, "flight")
    assert on_board
    for e in on_board:
        assert flight.start <= e.start and e.end <= flight.end


def test_melatonin_only_when_advancing_and_never_on_the_plane():
    assert not [e for e in bkk_to_cdg().events if e.type == "melatonin"]
    mel = [e for e in lhr_to_hnd().events if e.type == "melatonin"]
    assert mel and all(e.where != "flight" for e in mel)
    assert all("rescription" in e.note for e in mel)
    assert not [e for e in lhr_to_hnd(melatonin=False).events if e.type == "melatonin"]


def test_caffeine_stops_six_hours_before_bed():
    p = lhr_to_hnd()
    nights = sorted(e.start for e in sleeps(p))
    for c in [e for e in p.events if e.type == "caffeine_ok"]:
        nxt = min(n for n in nights if n > c.start)
        assert nxt - c.end == timedelta(hours=6)
    assert not [e for e in lhr_to_hnd(caffeine=False).events if e.type == "caffeine_ok"]


def test_arrival_nap_is_short_and_early_afternoon():
    nap = [e for e in bkk_to_cdg().events if e.type == "nap"]
    assert len(nap) == 1
    assert nap[0].end - nap[0].start == timedelta(minutes=30)
    assert nap[0].start.astimezone(timezone(timedelta(hours=2))).hour == 13
    # Landing at 15:00 leaves no early-afternoon slot.
    assert not [e for e in lhr_to_hnd().events if e.type == "nap"]


def test_chronotype_sets_sleep_only_when_times_are_missing():
    late = lhr_to_hnd(chronotype="late")
    tokyo = timezone(timedelta(hours=9))
    first = sleeps(late, "destination")[0].start.astimezone(tokyo)
    assert (first.hour, first.minute) == (0, 30)
    given = lhr_to_hnd(chronotype="late", sleep_start="23:00", sleep_end="07:00")
    assert sleeps(given, "destination")[0].start.astimezone(tokyo).hour == 23


# --- input that must be refused ---------------------------------------------------------------

@pytest.mark.parametrize("kw, message", [
    (dict(arrival=datetime(2026, 10, 10, 1, 0)), "after departure"),
    (dict(arrival_tz="Mars/Olympus"), "unknown time zone"),
    (dict(preflight_days=5), "preflight_days"),
    (dict(chronotype="owl"), "chronotype"),
    (dict(sleep_start="23:00", sleep_end="01:00"), "between 4 and 12"),
    (dict(arrival=datetime(2026, 10, 13, 7, 0)), "check the landing date"),
])
def test_bad_input_is_a_clear_error(kw, message):
    args = dict(departure=datetime(2026, 10, 10, 23, 55), departure_tz="Asia/Bangkok",
                arrival=datetime(2026, 10, 11, 7, 0), arrival_tz="Europe/Paris")
    args.update(kw)
    with pytest.raises(ValueError, match=message):
        plan_trip(**args)


# --- output ------------------------------------------------------------------------------------

def test_json_carries_utc_and_local_times_and_the_disclaimer():
    d = plan_to_dict(lhr_to_hnd())
    assert d["disclaimer"] and "not medical advice" in d["disclaimer"]
    home = next(e for e in d["events"] if e["where"] == "home")
    assert home["local_tz"] == "Europe/London" and home["start"].endswith("Z")
    there = next(e for e in d["events"] if e["where"] == "destination")
    assert there["local_tz"] == "Asia/Tokyo"
    starts = [e["start"] for e in d["events"]]
    assert starts == sorted(starts), "events come in time order"
    assert d["adapted_by"] == "2026-10-17"


# --- connections ------------------------------------------------------------------------------

def bkk_via_dxb_to_lhr(layover_hours=3):
    # Bangkok UTC+7 -> Dubai UTC+4 -> London UTC+1 (summer time): 6 h later overall.
    from datetime import datetime as dt
    land_dxb = dt(2026, 10, 11, 5, 0)
    leave_dxb = land_dxb + timedelta(hours=layover_hours)
    return plan_trip(legs=[
        {"departure": dt(2026, 10, 11, 1, 30), "departure_tz": "Asia/Bangkok",
         "arrival": land_dxb, "arrival_tz": "Asia/Dubai"},
        {"departure": leave_dxb, "departure_tz": "Asia/Dubai",
         "arrival": leave_dxb + timedelta(hours=4, minutes=30), "arrival_tz": "Europe/London"},
    ])


def test_connection_is_planned_from_first_departure_to_final_arrival():
    p = bkk_via_dxb_to_lhr()
    assert p.home_tz == "Asia/Bangkok" and p.destination_tz == "Europe/London"
    assert p.time_difference_hours == -6 and p.strategy == "delay"
    flights = [e for e in p.events if e.type == "flight"]
    assert len(flights) == 2 and "Flight 1 of 2" in flights[0].note
    stop = [e for e in p.events if e.type == "stopover"]
    assert len(stop) == 1 and stop[0].tz == "Asia/Dubai"


def test_stopover_events_show_on_the_stopover_clock():
    d = plan_to_dict(bkk_via_dxb_to_lhr())
    stop = next(e for e in d["events"] if e["type"] == "stopover")
    assert stop["local_tz"] == "Asia/Dubai"
    assert stop["start_local"].endswith("05:00"), "landing in Dubai at 05:00 Dubai time"


def test_no_plane_sleep_is_advised_during_a_short_stopover():
    p = bkk_via_dxb_to_lhr(layover_hours=3)
    stop = next(e for e in p.events if e.type == "stopover")
    for e in sleeps(p):
        assert e.end <= stop.start or e.start >= stop.end


def test_a_long_stopover_can_hold_sleep():
    # Landing in Dubai at 05:00 is 02:00 in London, mid-night at the
    # destination: a 14-hour stopover holds the rest of that night.
    p = bkk_via_dxb_to_lhr(layover_hours=14)
    at_stop = [e for e in sleeps(p) if e.where == "stopover"]
    assert len(at_stop) == 1 and at_stop[0].tz == "Asia/Dubai"
    stop = next(e for e in p.events if e.type == "stopover")
    assert stop.start <= at_stop[0].start and at_stop[0].end <= stop.end


def test_legs_must_be_in_order():
    from datetime import datetime as dt
    with pytest.raises(ValueError, match="leaves .* before you land there .* check the times at stop 1"):
        plan_trip(legs=[
            {"departure": dt(2026, 10, 11, 1, 30), "departure_tz": "Asia/Bangkok",
             "arrival": dt(2026, 10, 11, 5, 0), "arrival_tz": "Asia/Dubai"},
            {"departure": dt(2026, 10, 11, 4, 0), "departure_tz": "Asia/Dubai",
             "arrival": dt(2026, 10, 11, 9, 0), "arrival_tz": "Europe/London"},
        ])
    with pytest.raises(ValueError, match="at least one flight|give departure"):
        plan_trip(legs=[])


# --- itineraries: open jaw and multi-city ---------------------------------------------------
#
# The claim under test: the second journey starts from where the body clock
# will be, not from the local clock of the city being left. Each case here
# would read the same as a naive "plan each flight on its own" for one number
# and differs on the one that matters.

from src.itinerary import body_offset_at, merge_plans, plan_itinerary  # noqa: E402


def leg(dep, dep_tz, arr, arr_tz):
    return {"departure": dep, "departure_tz": dep_tz, "arrival": arr, "arrival_tz": arr_tz}


def test_a_body_clock_already_on_destination_time_needs_no_shift():
    # London to Tokyo, but the body is still on Tokyo time (UTC+9): nothing to do.
    plan = plan_trip(datetime(2026, 10, 10, 19, 0), "Europe/London", datetime(2026, 10, 11, 15, 0), "Asia/Tokyo",
                     body_offset_hours=9.0)
    assert plan.mode == "no_shift"
    assert plan.local_time_difference_hours == 8.0 and plan.time_difference_hours == 0.0


def test_open_jaw_return_starts_from_the_adapted_body_not_the_departure_city():
    # Bangkok -> London, ten days there (fully adapted to London, UTC+1), then
    # home from Paris (UTC+2). The body is on London time, so the shift back to
    # Bangkok is 6 h, not the 5 h a Paris-to-Bangkok flight would suggest.
    plans = plan_itinerary([
        [leg("2026-10-04T19:00", "Asia/Bangkok", "2026-10-05T15:00", "Europe/London")],
        [leg("2026-10-15T12:00", "Europe/Paris", "2026-10-16T06:00", "Asia/Bangkok")],
    ])
    assert [p.home_tz for p in plans] == ["Asia/Bangkok", "Europe/Paris"]
    assert plans[1].local_time_difference_hours == 5.0
    assert plans[1].time_difference_hours == 6.0
    assert plans[1].body_offset_hours == 1.0
    assert plans[1].preflight_days == 0, "a stay is the previous journey's adaptation time, not pre-flight time"


def test_multi_city_with_a_short_stop_keeps_the_body_where_it_was():
    # Bangkok -> London for 40 hours -> New York. Under 72 h in London means
    # stay on Bangkok time there, so the flight on starts from Bangkok's clock.
    plans = plan_itinerary([
        [leg("2026-10-04T19:00", "Asia/Bangkok", "2026-10-05T15:00", "Europe/London")],
        [leg("2026-10-07T08:00", "Europe/London", "2026-10-07T11:00", "America/New_York")],
    ])
    assert plans[0].mode == "stay_on_home_time"
    assert plans[1].body_offset_hours == 7.0
    assert plans[1].local_time_difference_hours == -5.0
    assert plans[1].time_difference_hours == -11.0
    assert plans[1].strategy == "delay"


def test_multi_city_with_a_longer_stop_starts_from_the_partly_shifted_body():
    # London -> Tokyo (8 h earlier, 1 h/day), four nights there, then Sydney.
    # Four of the eight hours are done, so the body is on UTC+5 when it flies
    # on: six hours from Sydney, not the two hours Tokyo is from Sydney.
    plans = plan_itinerary([
        [leg("2026-10-04T19:00", "Europe/London", "2026-10-05T15:00", "Asia/Tokyo")],
        [leg("2026-10-09T10:00", "Asia/Tokyo", "2026-10-09T21:00", "Australia/Sydney")],
    ], preflight_days=0)
    first, second = plans
    assert first.mode == "adapt" and first.strategy == "advance"
    departure = datetime(2026, 10, 9, 1, 0, tzinfo=UTC)
    assert body_offset_at(first, departure) == pytest.approx(5.0)
    assert second.body_offset_hours == pytest.approx(5.0)
    assert second.local_time_difference_hours == 2.0
    assert second.time_difference_hours == pytest.approx(6.0)
    assert "fly on before your body clock has fully caught up" in first.summary


def test_a_journeys_events_stop_before_the_next_departure():
    plans = plan_itinerary([
        [leg("2026-10-04T19:00", "Asia/Bangkok", "2026-10-05T15:00", "Europe/London")],
        [leg("2026-10-07T08:00", "Europe/London", "2026-10-08T06:00", "Asia/Bangkok")],
    ])
    cut = datetime(2026, 10, 7, 7, 0, tzinfo=UTC) - timedelta(hours=3)
    assert plans[0].events, "the first journey still has a plan"
    assert all(e.start < cut and (e.end is None or e.end <= cut) for e in plans[0].events)
    assert any(e.type == "flight" for e in plans[1].events)


def test_journeys_out_of_order_are_refused():
    with pytest.raises(ValueError, match=r"^Flight 2 leaves .* before flight 1 lands .*check the landing date of flight 1"):
        plan_itinerary([
            [leg("2026-10-04T19:00", "Asia/Bangkok", "2026-10-05T15:00", "Europe/London")],
            [leg("2026-10-05T12:00", "Europe/London", "2026-10-06T06:00", "Asia/Bangkok")],
        ])
    with pytest.raises(ValueError, match="at least one journey"):
        plan_itinerary([])


def test_merged_plan_keeps_every_event_on_its_own_clock():
    plans = plan_itinerary([
        [leg("2026-10-04T19:00", "Asia/Bangkok", "2026-10-05T15:00", "Europe/London")],
        [leg("2026-10-15T12:00", "Europe/Paris", "2026-10-16T06:00", "Asia/Bangkok")],
    ])
    merged = merge_plans(plans)
    assert len(merged.events) == sum(len(p.events) for p in plans)
    assert all(e.tz for e in merged.events), "every event says which clock it is on"
    clocks = {e.tz for e in merged.events}
    assert {"Europe/London", "Asia/Bangkok"} <= clocks, "each journey's events keep their own destination clock"
    assert merged.events == sorted(merged.events, key=lambda e: (e.start, e.type))
    assert merge_plans(plans[:1]) is plans[0]


# --- the advice: specific to the trip, not one sentence per event type ----------------------

from zoneinfo import ZoneInfo  # noqa: E402

from src import advice  # noqa: E402


def notes(plan, kind, where=None):
    return [e.note for e in plan.events if e.type == kind and (where is None or e.where == where)]


def test_sunrise_is_worked_out_for_the_city():
    # Tokyo in mid October: sunrise about 05:40. Dark at 04:30 local, light by 06:30.
    tokyo = advice.coordinates("Asia/Tokyo")
    assert tokyo and 35 < tokyo[0] < 36 and 139 < tokyo[1] < 140
    assert advice.solar_elevation(datetime(2026, 10, 12, 19, 30, tzinfo=UTC), *tokyo) < advice.HORIZON
    assert advice.solar_elevation(datetime(2026, 10, 12, 21, 30, tzinfo=UTC), *tokyo) > advice.HORIZON
    assert advice.coordinates("Nowhere/Atlantis") is None


def test_a_light_window_before_sunrise_says_use_a_lamp_not_go_outside():
    notes_ = notes(lhr_to_hnd(preflight_days=2), "light_seek", "home")
    assert notes_ and all("dark in London" in n and "lamp" in n for n in notes_)
    assert not any("Get outside" in n for n in notes_)


def test_daylight_windows_name_the_city_and_the_times():
    plan = lhr_to_hnd(preflight_days=2)
    seek = [e for e in plan.events if e.type == "light_seek" and e.where == "destination"]
    first = seek[0]
    start = first.start.astimezone(ZoneInfo("Asia/Tokyo")).strftime("%H:%M")
    assert "Tokyo" in first.note and start in first.note
    assert len({e.note for e in seek}) == len(seek), "no two mornings read the same"


def test_each_night_says_where_the_body_clock_is():
    plan = lhr_to_hnd(preflight_days=2)
    nights = notes(plan, "sleep", "destination")
    assert "Night 1 in Tokyo" in nights[0]
    assert "behind Tokyo" in nights[0] and "feels like" in nights[0]
    assert "lie awake" in nights[0]
    assert "wake feeling local" in nights[-1]


def test_pre_flight_nights_say_how_far_from_usual():
    homes = notes(lhr_to_hnd(preflight_days=2), "sleep", "home")
    assert "1 h earlier than usual" in homes[0] and "2 h earlier than usual" in homes[1]


def test_melatonin_explains_once_then_stays_short():
    mel = notes(lhr_to_hnd(preflight_days=2), "melatonin")
    assert all("rescription" in m for m in mel), "the warning is on every one"
    assert all(len(m) < len(mel[0]) for m in mel[1:])


def test_the_summary_names_the_city_and_the_day_to_feel_local():
    plan = lhr_to_hnd(preflight_days=2)
    assert "Tokyo time" in plan.summary
    assert plan.adapted_by.strftime("%a") in plan.summary


def test_describe_can_run_twice_without_doubling_up():
    plan = lhr_to_hnd(preflight_days=2)
    before = [e.note for e in plan.events]
    advice.describe(plan)
    assert [e.note for e in plan.events] == before


# --- the plan in brief, and supplements -----------------------------------------------------

from src.itinerary import plan_itinerary as _plan_itinerary  # noqa: E402


def _round_trip():
    leg_ = lambda a, b, d, r: [{"departure": d, "departure_tz": a, "arrival": r, "arrival_tz": b}]
    return _plan_itinerary([leg_("Europe/London", "Asia/Tokyo", "2026-10-10T19:00", "2026-10-11T15:00"),
                            leg_("Asia/Tokyo", "Europe/London", "2026-10-24T11:00", "2026-10-24T15:30")])


def test_the_brief_is_built_from_this_trip():
    out, back = _round_trip()
    brief = {b["title"]: b["text"] for b in advice.briefing(out)}
    assert "8 hours earlier" in brief and "harder direction" in brief["8 hours earlier"]
    assert "Tokyo time by" in brief["8 hours earlier"]
    assert "22:00, then 21:00" in brief["Before you fly"]
    assert "Tokyo time" in brief["On the plane"] and "alcohol" in brief["On the plane"]
    first_light = next(e for e in out.events if e.type == "light_seek" and e.where == "destination")
    assert first_light.start.astimezone(ZoneInfo("Asia/Tokyo")).strftime("%H:%M") in brief["Your most important light"]


def test_exercise_timing_follows_the_direction():
    out, back = _round_trip()
    east = {b["title"]: b["text"] for b in advice.briefing(out)}["Exercise"]
    west = {b["title"]: b["text"] for b in advice.briefing(back)}["Exercise"]
    assert "earlier" in east and "Avoid exercising between 19:00 and 22:00" in east
    assert "between 19:00 and 22:00 local time helps move your clock later" in west


def test_the_brief_is_in_the_json():
    from src.itinerary import plan_to_dict
    assert plan_to_dict(lhr_to_hnd())["briefing"][0]["title"].endswith("earlier")


def test_supplements_are_graded_dated_and_cautioned():
    plans = _round_trip()
    out = advice.supplements(plans)
    items = {s["name"]: s for s in out["items"]}
    assert items["Melatonin"]["evidence"] == "Good evidence"
    assert "Thu 8 Oct" in items["Melatonin"]["when"] and "0.5 to 5 mg" in items["Melatonin"]["why"]
    assert "Prescription" in items["Melatonin"]["caution"]
    assert "Sat 3 Oct" in items["Vitamin C"]["when"], "a week before the first flight"
    assert "nasal" in items["Zinc lozenges"]["caution"]
    assert any(s["evidence"] == "No evidence for jet lag" for s in out["items"]), "says what not to take"
    assert "Not medical advice" in out["caution"]


def test_melatonin_is_not_suggested_for_a_westward_trip():
    west = [bkk_to_cdg()]
    mel = next(s for s in advice.supplements(west)["items"] if s["name"] == "Melatonin")
    assert mel["evidence"] == "Not for this trip"


# --- benchmark gaps: light devices, sunglasses, melatonin type, arrival day ------------------

def test_light_glasses_change_the_advice_where_daylight_is_not_available():
    plain = notes(lhr_to_hnd(preflight_days=2), "light_seek", "home")
    glasses = notes(lhr_to_hnd(preflight_days=2, light_device="glasses"), "light_seek", "home")
    assert all("lamp" in n for n in plain)
    assert all("light glasses" in n for n in glasses)
    box = notes(lhr_to_hnd(preflight_days=2, light_device="box"), "light_seek", "home")
    assert all("light box" in n for n in box)


def test_an_unknown_light_device_is_refused():
    with pytest.raises(ValueError, match="light_device"):
        lhr_to_hnd(light_device="laser")


def test_the_first_sunglasses_note_says_which_kind():
    avoid = notes(lhr_to_hnd(preflight_days=2), "light_avoid", "destination")
    daylight = [n for n in avoid if n.startswith("Sunglasses")]
    assert daylight and "wrap-around" in daylight[0] and "blue-blocking" in daylight[0]


def test_melatonin_advice_says_fast_release():
    mel = notes(lhr_to_hnd(preflight_days=2), "melatonin")
    assert "fast-release" in mel[0] and "rescription" in mel[0]


def test_the_brief_covers_arrival_day():
    brief = {b["title"]: b["text"] for b in advice.briefing(lhr_to_hnd(preflight_days=2))}
    assert brief["Arrival day"].startswith("You land at 15:00. Stay up until 23:00")


# --- when the brain is clearest -------------------------------------------------------------

def windows(plan, kind):
    return [e for e in plan.events if e.type == kind]


def test_flying_east_the_fog_is_the_local_morning_and_the_clear_hours_come_later():
    plan = lhr_to_hnd(preflight_days=0)
    tokyo = ZoneInfo("Asia/Tokyo")
    fog = windows(plan, "fog")[0]
    assert fog.start.astimezone(tokyo).hour < 12, "the body's night falls in the Tokyo morning"
    assert "middle of its night" in fog.note and "driving" in fog.note
    focus = [e for e in windows(plan, "focus") if e.start.astimezone(tokyo).date() == fog.start.astimezone(tokyo).date()][0]
    assert focus.start.astimezone(tokyo).hour >= 12, "the clear hours come after the fog"
    assert "your body" in focus.note.lower()


def test_flying_west_the_fog_moves_to_the_evening():
    fog = windows(bkk_to_cdg(), "fog")[0]
    assert fog.start.astimezone(ZoneInfo("Europe/Paris")).hour >= 18


def test_clear_hours_end_an_hour_before_bed():
    plan = lhr_to_hnd(preflight_days=0)
    beds = [e.start for e in plan.events if e.type == "sleep" and e.where == "destination"]
    for f in windows(plan, "focus"):
        nxt = min(b for b in beds if b >= f.end)
        assert nxt - f.end >= timedelta(hours=1)


def test_no_windows_once_the_body_has_caught_up():
    plan = lhr_to_hnd(preflight_days=0)
    last = max(windows(plan, "focus") + windows(plan, "fog"), key=lambda e: e.start)
    assert last.start.date() <= plan.adapted_by


def test_a_short_trip_on_home_time_still_gets_its_clear_hours():
    short = plan_trip(datetime(2026, 10, 10, 9, 0), "Europe/London", datetime(2026, 10, 10, 12, 0),
                      "America/New_York", return_departure=datetime(2026, 10, 12, 18, 0))
    assert short.mode == "stay_on_home_time" and windows(short, "focus")


def test_the_brief_says_when_to_book_meetings():
    brief = {b["title"]: b["text"] for b in advice.briefing(lhr_to_hnd(preflight_days=0))}
    assert "sharpest" in brief["Best time for work"] and "foggiest" in brief["Best time for work"]


def test_the_calendar_names_the_new_windows():
    from src.ics import plan_to_ics
    text = plan_to_ics(lhr_to_hnd())
    assert "SUMMARY:Clearest thinking: demanding work" in text and "SUMMARY:Low focus: routine tasks only" in text


def test_a_mistyped_landing_date_says_which_flight_and_what_to_check():
    # Bangkok to London typed as landing on the 9th instead of the 7th: the
    # message has to point at the date, not tell a direct flight to "plan each leg".
    with pytest.raises(ValueError) as err:
        plan_trip(datetime(2031, 10, 6, 19), "Asia/Bangkok", datetime(2031, 10, 9, 15), "Europe/London")
    msg = str(err.value)
    assert "This flight comes out at 3 days 2 hours" in msg
    assert "Mon 6 Oct 19:00 to Thu 9 Oct 15:00" in msg and "check the landing date" in msg
    # "Lands" is easily read as the end of a short work trip: say how to enter that.
    assert "choose Return" in msg and "under 3 days there, the plan keeps you on home time" in msg
    # The same trip with the right date plans.
    plan_trip(datetime(2031, 10, 6, 19), "Asia/Bangkok", datetime(2031, 10, 7, 15), "Europe/London")


def test_a_long_journey_of_short_flights_points_at_the_dates():
    legs = [
        {"departure": "2031-10-06T19:00", "departure_tz": "Asia/Bangkok", "arrival": "2031-10-06T23:00", "arrival_tz": "Asia/Dubai"},
        {"departure": "2031-10-09T08:00", "departure_tz": "Asia/Dubai", "arrival": "2031-10-09T12:00", "arrival_tz": "Europe/London"},
    ]
    with pytest.raises(ValueError, match="Check the dates of each flight.*Multi-city"):
        plan_trip(legs=legs)
    legs[1]["arrival"] = "2031-10-10T12:00"
    with pytest.raises(ValueError, match="^Flight 2 comes out at 1 day 7 hours"):
        plan_trip(legs=legs)


def test_a_flight_back_before_the_flight_out_lands_names_both_times():
    # The screenshot: the flight out's landing had slipped to the 10th, after
    # the flight back on the 9th. Say both times and which date to check.
    with pytest.raises(ValueError) as err:
        plan_itinerary([
            [leg("2026-10-06T19:00", "Asia/Bangkok", "2026-10-10T01:25", "Europe/London")],
            [leg("2026-10-09T15:00", "Europe/London", "2026-10-10T09:25", "Asia/Bangkok")],
        ])
    assert str(err.value).startswith(
        "Flight 2 leaves Fri 9 Oct 15:00, before flight 1 lands (Sat 10 Oct 01:25, local times)")


def test_the_clock_series_starts_on_home_time_and_comes_back_to_zero():
    from src.itinerary import clock_series, hours_off_local, plan_to_dict
    plan = plan_trip(datetime(2026, 10, 6, 19, 0), "Asia/Bangkok", datetime(2026, 10, 7, 1, 25), "Europe/London",
                     preflight_days=2)
    pts = clock_series(plan)
    assert pts and pts == plan_to_dict(plan)["clock"]
    # Before flying the body is on Bangkok time, so 0 h off local; landing puts it 6 h ahead of London.
    assert pts[0]["hours"] == 0 and pts[0]["local_tz"] == "Asia/Bangkok"
    landed = next(p for p in pts if p["local_tz"] == "Europe/London")
    assert 3.5 <= landed["hours"] <= 6.0     # two preflight days at 1 h/day have already moved it from 6
    assert abs(pts[-1]["hours"]) < 0.01, "the line ends on local time"
    # Monotonic: every step brings it closer to zero, never further.
    london = [p["hours"] for p in pts if p["local_tz"] == "Europe/London"]
    assert all(b <= a + 1e-9 for a, b in zip(london, london[1:]))
    # Sleep on the plane is not "in London": the line stays on Bangkok's clock
    # (at or below zero, the body moving later) until the wheels touch down.
    assert all(p["hours"] <= 0 for p in pts if p["local_tz"] == "Asia/Bangkok")
    landing = next(e.end for e in plan.events if e.type == "flight")
    assert landed["at"] == landing.isoformat().replace("+00:00", "Z")
    # And the point function agrees with the series.
    assert hours_off_local(plan, datetime(2026, 10, 12, 12, tzinfo=timezone.utc)) == pts[-1]["hours"]


def test_a_merged_itinerary_keeps_one_body_clock_line():
    from src.itinerary import clock_series
    out = plan_itinerary([
        [leg("2026-10-06T19:00", "Asia/Bangkok", "2026-10-07T01:25", "Europe/London")],
        [leg("2026-10-16T15:00", "Europe/London", "2026-10-17T09:25", "Asia/Bangkok")],
    ])
    merged = merge_plans(out)
    pts = clock_series(merged)
    # Adapted in London by the flight back, then 6 h behind Bangkok on landing, then back to zero.
    before_back = [p for p in pts if p["local_tz"] == "Europe/London"][-1]
    assert abs(before_back["hours"]) < 0.01
    back = [p for p in pts if p["local_tz"] == "Asia/Bangkok" and p["at"] > "2026-10-16"]
    assert back[0]["hours"] <= -5 and abs(back[-1]["hours"]) < 0.01
