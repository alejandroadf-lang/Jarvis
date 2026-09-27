"""
A jet-lag plan as a calendar file (RFC 5545).

This is how the plan reaches the traveller's phone without an app store:
every calendar app imports .ics, and the reminders come from the calendar,
not from us. Light and melatonin events carry an alarm ten minutes before,
because those are the ones a traveller forgets and the ones that matter.

Times are written in UTC so no calendar has to know the zones; each app shows
them on the phone's current clock, which is exactly what a traveller wants.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import List

from src.itinerary import TripPlan

UTC = timezone.utc

TITLES = {
    "sleep": "Sleep",
    "light_seek": "Get bright light",
    "light_avoid": "Avoid bright light",
    "melatonin": "Melatonin (optional)",
    "caffeine_ok": "Caffeine OK until the end of this",
    "nap": "Nap, 30 minutes at most",
    "flight": "Flight",
}
ALARMED = {"light_seek", "light_avoid", "melatonin", "nap"}


def _stamp(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _fold(line: str) -> List[str]:
    """Lines over 75 octets continue on the next line after a space."""
    out, current = [], b""
    for ch in line:
        enc = ch.encode("utf-8")
        if len(current) + len(enc) > 75:
            out.append(current.decode("utf-8"))
            current = b" " + enc
        else:
            current += enc
    out.append(current.decode("utf-8"))
    return out


def plan_to_ics(plan: TripPlan, now: datetime = None) -> str:
    now = now or datetime.now(UTC)
    seed = hashlib.sha256(f"{plan.home_tz}{plan.destination_tz}{plan.events[0].start}".encode()).hexdigest()[:16]
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Circadian//Jet lag plan//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape('Jet lag plan: ' + plan.destination_tz.split('/')[-1].replace('_', ' '))}",
    ]
    for i, e in enumerate(plan.events):
        end = e.end or e.start
        lines += [
            "BEGIN:VEVENT",
            f"UID:{seed}-{i}@circadian",
            f"DTSTAMP:{_stamp(now)}",
            f"DTSTART:{_stamp(e.start)}",
            f"DTEND:{_stamp(end)}",
            f"SUMMARY:{_escape(TITLES.get(e.type, e.type))}",
            f"DESCRIPTION:{_escape(e.note + chr(10) + chr(10) + plan.disclaimer)}",
            "TRANSP:TRANSPARENT",
        ]
        if e.type in ALARMED:
            lines += [
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                f"DESCRIPTION:{_escape(TITLES[e.type])}",
                "TRIGGER:-PT10M",
                "END:VALARM",
            ]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    folded = []
    for line in lines:
        folded += _fold(line)
    return "\r\n".join(folded) + "\r\n"
