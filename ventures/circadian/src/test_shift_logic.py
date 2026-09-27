"""
Tests for src/shift_logic.py.

These assert concrete, hand-derived numeric outcomes (not "it ran without
throwing"), computed from the engine's own documented arithmetic:

  total_days = ceil(time_zones_shifted / rate)
  shift_so_far(day d) = min(d * rate, time_zones_shifted)   # capped at the
      total zones requested, so the final day doesn't overshoot
  cumulative_delta = -shift_so_far for eastward, +shift_so_far for westward
  sleep_hour(day d) = (base_hour + cumulative_delta) % 24

rates: eastward (phase advance) = 1.0 h/day, westward (phase delay) = 1.5 h/day.

Light/melatonin windows are derived from the day's sleep_start/sleep_end
using the module's own constants:
  LIGHT_WINDOW_HOURS = 2.0
  AVOID_LIGHT_WINDOW_HOURS = 2.0
  MELATONIN_OFFSET_HOURS = 0.5

Eastward (advance): seek light right after wake, avoid light right before
the new sleep start, melatonin just before sleep start.
  light_seek  = [sleep_end, sleep_end + 2.0)
  light_avoid = [sleep_start - 2.0, sleep_start)
  melatonin_hour = sleep_start - 0.5

Westward (delay): seek light in the hours before the new sleep start,
avoid light right after the new wake time, melatonin just after wake.
  light_seek  = [sleep_start - 2.0, sleep_start)
  light_avoid = [sleep_end, sleep_end + 2.0)
  melatonin_hour = sleep_end + 0.5
"""

import math

import pytest

from src.shift_logic import Direction, plan_shift


BASE_SLEEP_START = 23.0
BASE_SLEEP_END = 7.0


def test_eastward_five_zones_total_days_and_final_day_hours():
    # 5 zones at 1.0 h/day -> ceil(5/1.0) = 5 days.
    plan = plan_shift(
        direction="eastward",
        time_zones_shifted=5,
        current_sleep_start_hour=BASE_SLEEP_START,
        current_sleep_end_hour=BASE_SLEEP_END,
    )

    assert plan.direction == Direction.EASTWARD
    assert plan.total_days == 5
    assert len(plan.days) == 5

    final_day = plan.days[-1]
    assert final_day.day == 5

    # Day 5: shift_so_far = min(5*1.0, 5) = 5.0; eastward -> delta = -5.0.
    # A sign flip (e.g. treating eastward as positive) or a rounding bug
    # (e.g. using round() instead of the true 23-5=18 / 7-5=2) would break
    # these hardcoded values.
    assert final_day.cumulative_shift_hours == -5.0
    assert final_day.sleep_start_hour == 18.0
    assert final_day.sleep_end_hour == 2.0

    # Sanity-check an intermediate day too, so a bug that only shows up
    # mid-schedule (e.g. an off-by-one in the day loop) is also caught.
    day1 = plan.days[0]
    assert day1.cumulative_shift_hours == -1.0
    assert day1.sleep_start_hour == 22.0
    assert day1.sleep_end_hour == 6.0


def test_westward_five_zones_total_days_and_final_day_hours():
    # 5 zones at 1.5 h/day -> ceil(5/1.5) = ceil(3.333..) = 4 days.
    plan = plan_shift(
        direction="westward",
        time_zones_shifted=5,
        current_sleep_start_hour=BASE_SLEEP_START,
        current_sleep_end_hour=BASE_SLEEP_END,
    )

    assert plan.direction == Direction.WESTWARD
    assert plan.total_days == math.ceil(5 / 1.5)
    assert plan.total_days == 4
    assert len(plan.days) == 4

    final_day = plan.days[-1]
    assert final_day.day == 4

    # Day 4: naive shift_so_far = 4*1.5 = 6.0, but the engine caps at the
    # 5 zones actually requested, so shift_so_far = min(6.0, 5) = 5.0.
    # westward -> delta = +5.0. If the cap were missing, sleep_start would
    # wrongly come out to (23+6)%24=5.0 instead of (23+5)%24=4.0 — this
    # assertion catches that regression.
    assert final_day.cumulative_shift_hours == 5.0
    assert final_day.sleep_start_hour == 4.0
    assert final_day.sleep_end_hour == 12.0

    # Intermediate day, uncapped: day 3 -> shift_so_far = min(4.5, 5) = 4.5.
    day3 = plan.days[2]
    assert day3.cumulative_shift_hours == 4.5
    assert day3.sleep_start_hour == 3.5
    assert day3.sleep_end_hour == 11.5


def test_disclaimer_present_and_non_empty_on_returned_plan():
    plan = plan_shift(direction="eastward", time_zones_shifted=5)
    assert isinstance(plan.disclaimer, str)
    assert len(plan.disclaimer.strip()) > 0
    assert "not medical advice" in plan.disclaimer.lower()

    # Also present on a westward plan, and on a zero-shift plan — the
    # disclaimer must not depend on direction or on there being any travel.
    plan_west = plan_shift(direction="westward", time_zones_shifted=5)
    assert plan_west.disclaimer == plan.disclaimer

    plan_zero = plan_shift(direction="eastward", time_zones_shifted=0)
    assert plan_zero.total_days == 0
    assert plan_zero.days == []
    assert len(plan_zero.disclaimer.strip()) > 0


def test_eastward_five_zones_final_day_light_and_melatonin_tuple():
    # Final day (day 5): sleep_start=18.0, sleep_end=2.0 (from the test
    # above). Eastward light/melatonin derivation:
    #   light_seek  = [sleep_end, sleep_end+2.0)       = [2.0, 4.0)
    #   light_avoid = [sleep_start-2.0, sleep_start)   = [16.0, 18.0)
    #   melatonin_hour = sleep_start - 0.5             = 17.5
    plan = plan_shift(
        direction="eastward",
        time_zones_shifted=5,
        current_sleep_start_hour=BASE_SLEEP_START,
        current_sleep_end_hour=BASE_SLEEP_END,
    )
    final_day = plan.days[-1]
    assert final_day.day == 5

    actual_tuple = (
        final_day.light_seek_start_hour,
        final_day.light_seek_end_hour,
        final_day.light_avoid_start_hour,
        final_day.light_avoid_end_hour,
        final_day.melatonin_hour,
    )
    expected_tuple = (2.0, 4.0, 16.0, 18.0, 17.5)
    assert actual_tuple == expected_tuple


def test_westward_five_zones_final_day_light_and_melatonin_tuple():
    # Final day (day 4): sleep_start=4.0, sleep_end=12.0 (from the test
    # above). Westward light/melatonin derivation:
    #   light_seek  = [sleep_start-2.0, sleep_start)   = [2.0, 4.0)
    #   light_avoid = [sleep_end, sleep_end+2.0)       = [12.0, 14.0)
    #   melatonin_hour = sleep_end + 0.5               = 12.5
    plan = plan_shift(
        direction="westward",
        time_zones_shifted=5,
        current_sleep_start_hour=BASE_SLEEP_START,
        current_sleep_end_hour=BASE_SLEEP_END,
    )
    final_day = plan.days[-1]
    assert final_day.day == 4

    actual_tuple = (
        final_day.light_seek_start_hour,
        final_day.light_seek_end_hour,
        final_day.light_avoid_start_hour,
        final_day.light_avoid_end_hour,
        final_day.melatonin_hour,
    )
    expected_tuple = (2.0, 4.0, 12.0, 14.0, 12.5)
    assert actual_tuple == expected_tuple


def test_unknown_direction_raises_value_error():
    with pytest.raises(ValueError):
        plan_shift(direction="northward", time_zones_shifted=3)


def test_negative_zone_count_raises_value_error():
    with pytest.raises(ValueError):
        plan_shift(direction="eastward", time_zones_shifted=-1)
