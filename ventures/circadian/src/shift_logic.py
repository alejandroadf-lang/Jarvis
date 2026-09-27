"""
Circadian phase-shift scheduling engine.

Computes a day-by-day light/melatonin/sleep-window schedule to help a
traveler resynchronize their circadian clock after crossing time zones.

This module imports no web framework and has no I/O — it is pure logic,
testable directly. Not medical advice; see ShiftPlan.disclaimer, which is
also what the API layer must echo back in every response payload.
"""

from dataclasses import dataclass, field
from enum import Enum
import math


class Direction(str, Enum):
    EASTWARD = "eastward"   # phase advance (e.g. flying LHR -> DXB)
    WESTWARD = "westward"   # phase delay (e.g. flying LHR -> JFK)


# Published circadian literature (e.g. Eastman & Burgess 2009; Sack et al.
# 2007, AASM practice parameters) puts sustainable phase-advance around
# 1.0h/day and phase-delay around 1.5h/day for most people using light and
# melatonin timing. These are the rates this engine schedules against.
EASTWARD_RATE_HOURS_PER_DAY = 1.0
WESTWARD_RATE_HOURS_PER_DAY = 1.5

LIGHT_WINDOW_HOURS = 2.0
AVOID_LIGHT_WINDOW_HOURS = 2.0
MELATONIN_OFFSET_HOURS = 0.5

DISCLAIMER = (
    "This schedule is generated from published circadian-rhythm research "
    "for general informational purposes only. It is not medical advice, "
    "diagnosis, or treatment, and has not been reviewed by a clinician. "
    "Consult a qualified healthcare provider before changing sleep, light, "
    "or medication routines, especially if you have a sleep disorder, are "
    "pregnant, or take other medication."
)


@dataclass
class DayPlan:
    day: int
    cumulative_shift_hours: float
    sleep_start_hour: float
    sleep_end_hour: float
    light_seek_start_hour: float
    light_seek_end_hour: float
    light_avoid_start_hour: float
    light_avoid_end_hour: float
    melatonin_hour: float


@dataclass
class ShiftPlan:
    direction: Direction
    time_zones_shifted: int
    total_days: int
    rate_hours_per_day: float
    days: list = field(default_factory=list)
    disclaimer: str = DISCLAIMER


def _normalize_hour(hour: float) -> float:
    """Wrap a clock hour into [0, 24)."""
    return hour % 24.0


def plan_shift(
    direction: str,
    time_zones_shifted: int,
    current_sleep_start_hour: float = 23.0,
    current_sleep_end_hour: float = 7.0,
) -> ShiftPlan:
    """
    Build a day-by-day circadian realignment schedule.

    direction: "eastward" (phase advance) or "westward" (phase delay).
    time_zones_shifted: absolute number of time zones crossed (>= 0).
    current_sleep_start_hour / current_sleep_end_hour: the traveler's
        normal sleep window, in origin-local clock hours (0-24).
    """
    if direction not in (Direction.EASTWARD.value, Direction.WESTWARD.value):
        raise ValueError(f"unknown direction: {direction}")
    if time_zones_shifted < 0:
        raise ValueError("time_zones_shifted must be >= 0")

    dir_enum = Direction(direction)
    rate = (
        EASTWARD_RATE_HOURS_PER_DAY
        if dir_enum == Direction.EASTWARD
        else WESTWARD_RATE_HOURS_PER_DAY
    )

    total_days = 0 if time_zones_shifted == 0 else math.ceil(time_zones_shifted / rate)

    days = []
    for d in range(1, total_days + 1):
        shift_so_far = min(d * rate, time_zones_shifted)
        cumulative_delta = (
            -shift_so_far if dir_enum == Direction.EASTWARD else shift_so_far
        )

        sleep_start = _normalize_hour(current_sleep_start_hour + cumulative_delta)
        sleep_end = _normalize_hour(current_sleep_end_hour + cumulative_delta)

        if dir_enum == Direction.EASTWARD:
            # Advance: seek light soon after the new wake time; avoid
            # light in the hours right before the new sleep start.
            light_seek_start = sleep_end
            light_seek_end = _normalize_hour(sleep_end + LIGHT_WINDOW_HOURS)
            light_avoid_start = _normalize_hour(sleep_start - AVOID_LIGHT_WINDOW_HOURS)
            light_avoid_end = sleep_start
            melatonin_hour = _normalize_hour(sleep_start - MELATONIN_OFFSET_HOURS)
        else:
            # Delay: seek light in the hours before the new sleep start
            # (late evening); avoid light right after the new wake time.
            light_seek_start = _normalize_hour(sleep_start - LIGHT_WINDOW_HOURS)
            light_seek_end = sleep_start
            light_avoid_start = sleep_end
            light_avoid_end = _normalize_hour(sleep_end + AVOID_LIGHT_WINDOW_HOURS)
            melatonin_hour = _normalize_hour(sleep_end + MELATONIN_OFFSET_HOURS)

        days.append(
            DayPlan(
                day=d,
                cumulative_shift_hours=cumulative_delta,
                sleep_start_hour=sleep_start,
                sleep_end_hour=sleep_end,
                light_seek_start_hour=light_seek_start,
                light_seek_end_hour=light_seek_end,
                light_avoid_start_hour=light_avoid_start,
                light_avoid_end_hour=light_avoid_end,
                melatonin_hour=melatonin_hour,
            )
        )

    return ShiftPlan(
        direction=dir_enum,
        time_zones_shifted=time_zones_shifted,
        total_days=total_days,
        rate_hours_per_day=rate,
        days=days,
    )
