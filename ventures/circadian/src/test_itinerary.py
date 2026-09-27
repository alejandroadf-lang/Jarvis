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
    assert all("prescription" in e.note for e in mel)
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
    (dict(arrival=datetime(2026, 10, 13, 7, 0)), "longer than"),
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
    with pytest.raises(ValueError, match="departs before flight 1 lands"):
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
    with pytest.raises(ValueError, match="journey 2 departs before journey 1 lands"):
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
