"""
WHOOP: did the traveller actually sleep when the plan said to?

A plan says "bed at 23:00 Tokyo time". Without a wearable nobody knows whether
that happened, and a plan nobody checks against reality cannot tell a
traveller why day three still feels awful. WHOOP measures sleep onset and wake
to the minute, scores sleep, and gives a morning recovery score, so each
planned night can be put next to the real one.

The WHOOP Developer Platform, API v2. OAuth 2.0 authorization-code flow with
the `offline` scope for a refresh token; sleep from /v2/activity/sleep and
recovery from /v2/recovery, both paged with `nextToken`. WHOOP's own docs are
at developer.whoop.com; the paths and field names here were checked against an
open-source v2 client, since those docs were not reachable from where this was
written.

Privacy, deliberately narrow:
- The app has no accounts. A random device id, made by the phone and kept in
  its local storage, is the only link between the phone and the WHOOP
  connection. It is treated as a secret and never logged.
- Only the tokens are stored. Sleep and recovery are fetched when the
  traveller opens their progress, compared, and not kept.
- Disconnecting revokes access at WHOOP and deletes the tokens here.

The OAuth `state` is the device id signed with this server's own key and a
timestamp, so a callback can only attach a WHOOP account to the device that
asked, and only within ten minutes.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests

from src import store
from src.itinerary import TripPlan, hours_off_local

UTC = timezone.utc
AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
API = "https://api.prod.whoop.com/developer/v2"
REVOKE_URL = f"{API}/user/access"
SCOPES = "read:sleep read:recovery offline"
COLLECTION = "whoop"
STATE_MAX_AGE = 600
ON_TRACK_MINUTES = 60
LOW_RECOVERY = 34          # WHOOP's red band
BASELINE_DAYS = 14         # nights that stand for "usual" before a trip
# Correcting the plan from a real night. Sleep timing is one of the things
# that sets the clock, light is the other and it was (we assume) taken as
# planned, so only half of a late night is counted as a late clock. Under 20
# minutes is noise; over 3 hours the plan itself is wrong, not the clock.
ADJUST_FRACTION = 0.5
ADJUST_MIN_MINUTES = 20
ADJUST_MAX_MINUTES = 180
RECOVERY_SLACK = 10        # points below the pre-trip median still counts as recovered
DEVICE_RE = re.compile(r"^[0-9a-fA-F-]{32,40}$")


class NotConnected(Exception):
    """No usable WHOOP connection for this device."""


class ConnectFailed(ValueError):
    """
    Connecting did not work, with why in a word the page turns into advice:
    keys (WHOOP rejected the client id or secret), redirect (the callback URL
    is not the one registered), expired (the sign-in code was used or too
    old), network (WHOOP could not be reached), whoop (anything else).
    A bare "did not work" left the owner with nothing to fix.
    """

    def __init__(self, reason: str, detail: str, status: int = 0):
        super().__init__(detail)
        self.reason = reason
        self.status = status


# Sent on every request to WHOOP, which sits behind Cloudflare. Python's
# default ("Python-urllib/3.x") is on bot filters' lists, and so is the
# crawler convention of a "(...; +https://...)" suffix: with that suffix the
# token exchange came back 403 from the live server. Plain name and version.
USER_AGENT = "Circadian/1.0"


# --- configuration ---------------------------------------------------------------------

def is_configured() -> bool:
    return bool(os.environ.get("WHOOP_CLIENT_ID", "").strip() and os.environ.get("WHOOP_CLIENT_SECRET", "").strip())


def describe() -> str:
    if is_configured():
        return "CircadianAPI: WHOOP is configured; travellers can connect it from the app."
    return ("CircadianAPI: WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET are not set, so the app's "
            "'Connect WHOOP' button explains that WHOOP is not available yet.")


def check_device(device: str) -> str:
    if not isinstance(device, str) or not DEVICE_RE.match(device):
        raise ValueError("missing or malformed device id")
    return device


# --- state ------------------------------------------------------------------------------

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_state(device: str, now: Optional[float] = None) -> str:
    payload = f"{check_device(device)}.{int(now if now is not None else time.time())}"
    mac = hmac.new(store.server_secret(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return _b64(f"{payload}.{mac}".encode())


def verify_state(state: str, now: Optional[float] = None) -> str:
    now = now if now is not None else time.time()
    try:
        device, issued, mac = _unb64(state).decode().rsplit(".", 2)
        issued_at = int(issued)
    except (ValueError, UnicodeDecodeError) as err:
        raise ValueError("the WHOOP sign-in link is not valid") from err
    expected = hmac.new(store.server_secret(), f"{device}.{issued}".encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(mac, expected):
        raise ValueError("the WHOOP sign-in link is not valid")
    if now - issued_at > STATE_MAX_AGE:
        raise ValueError("the WHOOP sign-in link expired; start again from the app")
    return check_device(device)


def authorize_url(device: str, redirect_uri: str) -> str:
    return AUTHORIZE_URL + "?" + urllib.parse.urlencode({
        "client_id": os.environ["WHOOP_CLIENT_ID"].strip(),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPES,
        "state": sign_state(device),
    })


# --- HTTP -------------------------------------------------------------------------------

def _http(method: str, url: str, headers: Optional[dict] = None, form: Optional[dict] = None) -> Tuple[int, Optional[dict]]:
    """
    (status, json body or None). Replaced in tests.

    Through requests (already installed: pywebpush depends on it) rather than
    urllib. Cloudflare in front of WHOOP answered the live token exchange with
    "Sorry, you have been blocked" (cf-ray a419c319baaa991c-SJC) even after
    the User-Agent was fixed; urllib's connection looks unlike any common
    client (no ALPN, bare headers), which bot scoring weighs, while requests
    is what WHOOP's own examples and most integrations use.
    """
    h = {"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})}
    try:
        res = requests.request(method, url, headers=h, data=form, timeout=15)
    except requests.RequestException:  # DNS, refused, timeout: 0 means WHOOP was not reached
        return 0, None
    try:
        body = res.json() if res.content else None
    except ValueError:
        body = None
    if res.status_code >= 400 and res.status_code != 401 and not (isinstance(body, dict) and body.get("error")):
        # Not WHOOP's OAuth server talking (it answers with an "error" field)
        # but something in front of it: a firewall page, an empty 403, a
        # gateway's {"message": ...}. Its server, ray id and words say which,
        # where a bare "HTTP 403" did not. Such error pages never echo the
        # request's form, so nothing secret is printed.
        page = res.content[:6000].decode("utf-8", "replace")
        page = _re_script.sub(" ", page)
        text = " ".join(re.sub(r"<[^>]+>", " ", page).split())[:400] or "(empty body)"
        print(f"CircadianAPI: {method} {url.split('?')[0]} answered HTTP {res.status_code} "
              f"(server={res.headers.get('server', '?')}, cf-ray={res.headers.get('cf-ray', '-')}, "
              f"x-amzn-requestid={res.headers.get('x-amzn-requestid', '-')}): {text}")
    return res.status_code, body


# Scripts and styles say nothing about why a firewall page refused.
_re_script = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)


def reachability() -> str:
    """
    One token request with a code WHOOP cannot know, made at startup. WHOOP's
    OAuth server answers it with a JSON error (invalid_grant); anything else
    answering is whatever stands between this server and WHOOP, and the same
    check from Jarvis's Node process (server/circadian.js) says whether it is
    this client or this server's address that is refused. Cloudflare blocked
    the live token exchange three times with no rule named; this tells the
    two causes apart without a traveller having to sign in each time.
    """
    if not is_configured():
        return "CircadianAPI: WHOOP reachability not checked (not configured)."
    status, body = _http("POST", TOKEN_URL, form={
        "grant_type": "authorization_code",
        "code": "reachability-check",
        "redirect_uri": "https://example.invalid/whoop/callback",
        "client_id": os.environ["WHOOP_CLIENT_ID"].strip(),
        "client_secret": os.environ["WHOOP_CLIENT_SECRET"].strip(),
    })
    if isinstance(body, dict) and body.get("error"):
        return f"CircadianAPI: WHOOP's OAuth server is reachable from Python (it answered HTTP {status} {body['error']} to a check)."
    if status == 0:
        return "CircadianAPI: WHOOP could not be reached from Python (network error); connecting WHOOP will fail until it can."
    return (f"CircadianAPI: WHOOP is NOT reachable from Python: something in front of it answered HTTP {status} "
            f"(details above). Connecting WHOOP fails until that block is lifted.")


# --- tokens -----------------------------------------------------------------------------

def _save_tokens(device: str, body: dict, now: float) -> None:
    def change(all_):
        old = all_.get(device, {})
        all_[device] = {
            "access_token": body["access_token"],
            "refresh_token": body.get("refresh_token") or old.get("refresh_token"),
            "expires_at": now + int(body.get("expires_in", 3600)) - 60,
        }
        return all_
    store.update(COLLECTION, {}, change)


def _forget(device: str) -> None:
    def change(all_):
        all_.pop(device, None)
        return all_
    store.update(COLLECTION, {}, change)


def exchange_code(device: str, code: str, redirect_uri: str, now: Optional[float] = None) -> None:
    status, body = _http("POST", TOKEN_URL, form={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": os.environ["WHOOP_CLIENT_ID"].strip(),
        "client_secret": os.environ["WHOOP_CLIENT_SECRET"].strip(),
    })
    if status != 200 or not body or "access_token" not in body:
        raise _why_refused(status, body)
    _save_tokens(device, body, now if now is not None else time.time())


def _why_refused(status: int, body) -> ConnectFailed:
    """WHOOP's token error, sorted into what the owner or traveller can do about it."""
    error = str((body or {}).get("error", "")) if isinstance(body, dict) else ""
    about = str((body or {}).get("error_description", "")) if isinstance(body, dict) else ""
    detail = f"WHOOP did not accept the sign-in (HTTP {status}{', ' + error if error else ''}{': ' + about[:200] if about else ''})"
    # Logged so the reason is in Railway's logs; nothing here is a secret.
    print(f"CircadianAPI: {detail}")
    if status == 0:
        return ConnectFailed("network", detail)
    if status == 401 or error in ("invalid_client", "unauthorized_client"):
        return ConnectFailed("keys", detail)
    if "redirect" in about.lower():
        return ConnectFailed("redirect", detail)
    if error == "invalid_grant":
        return ConnectFailed("expired", detail)
    return ConnectFailed("whoop", detail, status)


def _refresh(device: str, now: float) -> str:
    tok = store.read(COLLECTION, {}).get(device)
    if not tok or not tok.get("refresh_token"):
        _forget(device)
        raise NotConnected()
    status, body = _http("POST", TOKEN_URL, form={
        "grant_type": "refresh_token",
        "refresh_token": tok["refresh_token"],
        "client_id": os.environ["WHOOP_CLIENT_ID"].strip(),
        "client_secret": os.environ["WHOOP_CLIENT_SECRET"].strip(),
        "scope": "offline",
    })
    if status in (400, 401) or not body or "access_token" not in body:
        # The traveller revoked access at WHOOP, or the refresh token expired.
        _forget(device)
        raise NotConnected()
    _save_tokens(device, body, now)
    return body["access_token"]


def _token(device: str, now: float) -> str:
    tok = store.read(COLLECTION, {}).get(device)
    if not tok:
        raise NotConnected()
    if now >= tok["expires_at"]:
        return _refresh(device, now)
    return tok["access_token"]


def _get(device: str, path: str, params: dict, now: float) -> dict:
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    token = _token(device, now)
    status, body = _http("GET", url, headers={"Authorization": f"Bearer {token}"})
    if status == 401:
        token = _refresh(device, now)
        status, body = _http("GET", url, headers={"Authorization": f"Bearer {token}"})
    if status == 429:
        raise ValueError("WHOOP is rate-limiting requests; try again in a minute")
    if status != 200 or body is None:
        raise ValueError(f"WHOOP returned HTTP {status}")
    return body


def _collection(device: str, path: str, start: datetime, end: datetime, now: float) -> List[dict]:
    params = {"start": _iso(start), "end": _iso(end), "limit": 25}
    records: List[dict] = []
    for _ in range(10):
        body = _get(device, path, params, now)
        records += body.get("records") or []
        nxt = body.get("next_token")
        if not nxt:
            break
        params = dict(params, nextToken=nxt)
    return records


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _offset(tzd: Optional[str]) -> timezone:
    """WHOOP's timezone_offset ("+07:00", "-05:00", "Z") as a tzinfo."""
    if not tzd or tzd == "Z":
        return UTC
    sign = -1 if tzd.startswith("-") else 1
    h, m = tzd.lstrip("+-").split(":")
    return timezone(sign * timedelta(hours=int(h), minutes=int(m)))


def _clock_minutes(ts: str, tzd: Optional[str]) -> int:
    local = _parse(ts).astimezone(_offset(tzd))
    return local.hour * 60 + local.minute


def _clock_median(minutes: List[int]) -> int:
    """Median of clock times that may straddle midnight: 23:30 and 00:30 give 00:00, not 12:00."""
    shifted = sorted((m - 720) % 1440 for m in minutes)   # measured from noon
    mid = int(median(shifted))
    return int(round(((mid + 720) % 1440) / 5.0) * 5) % 1440


def _hm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _remember_user_id(device: str, records: List[dict]) -> None:
    """
    WHOOP's webhooks name the member by user_id, not by our device id, so the
    id is kept from the first record seen. The profile scope would give it
    directly but asks the traveller for their name and email, which nothing
    here needs.
    """
    uid = next((r.get("user_id") for r in records if r.get("user_id")), None)
    if not uid:
        return

    def change(all_):
        entry = all_.get(device)
        if entry is not None and entry.get("user_id") != uid:
            entry["user_id"] = uid
        return all_

    store.update(COLLECTION, {}, change)


def device_for_user(user_id) -> Optional[str]:
    return next((d for d, e in store.read(COLLECTION, {}).items() if e.get("user_id") == user_id), None)


# --- what the app calls -------------------------------------------------------------------

def status(device: str) -> dict:
    return {"configured": is_configured(), "connected": bool(store.read(COLLECTION, {}).get(check_device(device)))}


def disconnect(device: str, now: Optional[float] = None) -> None:
    check_device(device)
    try:
        token = _token(device, now if now is not None else time.time())
        _http("DELETE", REVOKE_URL, headers={"Authorization": f"Bearer {token}"})
    except (NotConnected, ValueError, OSError):
        pass
    _forget(device)


def baseline(device: str, now: Optional[datetime] = None) -> dict:
    """
    The traveller's usual bedtime, wake time and recovery, from their last
    two weeks on WHOOP. The form's 23:00-07:00 is a guess; a plan for a
    person whose real nights run 00:40-08:20 is 100 minutes off from its
    first line. Clock times are taken on the zone each night was slept in.
    """
    check_device(device)
    if not store.read(COLLECTION, {}).get(device):
        raise NotConnected()
    now = now or datetime.now(UTC)
    t = now.timestamp()
    start = now - timedelta(days=BASELINE_DAYS)
    sleeps = [x for x in _collection(device, "/activity/sleep", start, now, t)
              if not x.get("nap") and x.get("start") and x.get("end")]
    recoveries = [r for r in _collection(device, "/recovery", start, now, t)
                  if r.get("score_state") == "SCORED" and (r.get("score") or {}).get("recovery_score") is not None]
    _remember_user_id(device, sleeps + recoveries)
    out = {"days": BASELINE_DAYS, "nights": len(sleeps), "bed": None, "wake": None, "recovery": None,
           "recovery_week": None, "asleep_hours": None, "debt_hours": None, "week": []}
    if recoveries:
        out["recovery"] = int(round(median(r["score"]["recovery_score"] for r in recoveries)))
    if len(sleeps) >= 3:
        out["bed"] = _hm(_clock_median([_clock_minutes(x["start"], x.get("timezone_offset")) for x in sleeps]))
        out["wake"] = _hm(_clock_median([_clock_minutes(x["end"], x.get("timezone_offset")) for x in sleeps]))
    # The week before a trip, night by night: how long asleep, and the
    # morning's recovery. WHOOP's own sleep-debt figure comes with the latest
    # night; it is what "bank some sleep before you fly" is measured against.
    week_start = now - timedelta(days=7)
    by_day: Dict[str, dict] = {}
    for x in sorted(sleeps, key=lambda x: x["end"]):
        day = _parse(x["end"]).astimezone(_offset(x.get("timezone_offset"))).date().isoformat()
        stages = (x.get("score") or {}).get("stage_summary") or {}
        if stages.get("total_in_bed_time_milli") is not None:
            asleep = (stages["total_in_bed_time_milli"] - stages.get("total_awake_time_milli", 0)
                      - stages.get("total_no_data_time_milli", 0)) / 3.6e6
            by_day.setdefault(day, {})["asleep_hours"] = round(asleep, 1)
        need = (x.get("score") or {}).get("sleep_needed") or {}
        if need.get("need_from_sleep_debt_milli") is not None:
            out["debt_hours"] = round(need["need_from_sleep_debt_milli"] / 3.6e6, 1)   # the latest night's
    for r in sorted(recoveries, key=lambda r: r.get("created_at") or ""):
        if r.get("created_at"):
            by_day.setdefault(_parse(r["created_at"]).date().isoformat(), {})["recovery"] = int(round(r["score"]["recovery_score"]))
    week = [{"date": d, **v} for d, v in sorted(by_day.items()) if d >= week_start.date().isoformat()]
    out["week"] = week
    hours = [w["asleep_hours"] for w in week if "asleep_hours" in w]
    recs = [w["recovery"] for w in week if "recovery" in w]
    if hours:
        out["asleep_hours"] = round(sum(hours) / len(hours), 1)
    if recs:
        out["recovery_week"] = int(round(median(recs)))
    return out


SHORT_SLEEP_HOURS = 6.5
DEBT_WORTH_ACTING_ON = 1.0     # hours
RECOVERY_DIP = 8               # points below the two-week median


def pretrip_advice(b: dict, days_until: int) -> List[str]:
    """
    What WHOOP's last week says to do before flying. Sleep debt is the one
    thing a traveller can fix in advance: jet lag symptoms are worse on a
    debt, and sleep extended in the nights before a stressor holds
    performance up through it (Rupp et al. 2009). Recovery trending down is
    a reason to ease training, not to change the plan.
    """
    out: List[str] = []
    if b.get("nights", 0) < 3:
        return ["Not enough nights on WHOOP yet to judge how rested you are. Wear it the nights before you fly."]
    debt, hours = b.get("debt_hours"), b.get("asleep_hours")
    week, usual = b.get("recovery_week"), b.get("recovery")
    if debt is not None and debt >= DEBT_WORTH_ACTING_ON and days_until >= 1:
        out.append(f"You are carrying about {debt:g} h of sleep debt. Add 30-45 minutes a night until you fly: jet lag "
                   f"lands harder on a debt, and sleep banked beforehand holds you up through the first days.")
    if hours is not None and hours < SHORT_SLEEP_HOURS:
        out.append(f"You have averaged {hours:g} h asleep this week. Protect a full night on the two nights before "
                   f"the flight above anything else in this plan.")
    if week is not None and usual is not None and week <= usual - RECOVERY_DIP:
        out.append(f"Recovery is trending down: {week}% this week against your usual {usual}%. Go easy on training "
                   f"in the last two days and arrive with something in reserve.")
    if not out:
        rested = f"recovery {week}% against your usual {usual}%" if week is not None and usual is not None else "recovery steady"
        sleep = f", {hours:g} h asleep a night" if hours is not None else ""
        out.append(f"You are going in rested: {rested}{sleep}. Keep your usual bedtime until the plan starts.")
    return out


def progress(device: str, plan: TripPlan, now: Optional[datetime] = None) -> dict:
    """
    Each planned night next to the real one, what to do about the gap, how far
    the plan should move to match last night, and whether the traveller is
    back on local time yet.
    """
    check_device(device)
    if not store.read(COLLECTION, {}).get(device):
        raise NotConnected()
    now = now or datetime.now(UTC)
    t = now.timestamp()
    planned = [e for e in plan.events if e.type == "sleep" and e.where in ("home", "destination") and e.end <= now]
    if not planned:
        return {"nights": [], "summary": "No planned nights have passed yet. Check back after your first night on the plan.",
                "advice": [], "latest_recovery": None, "adjustment": _no_adjustment(), "adaptation": None}

    start = min(e.start for e in planned) - timedelta(hours=12)
    end = min(now, max(e.end for e in planned) + timedelta(hours=12))
    sleeps = [s for s in _collection(device, "/activity/sleep", start, end, t)
              if not s.get("nap") and s.get("start") and s.get("end")]
    # Recoveries from two weeks before the first night too: the pre-trip
    # median is what "recovered" is measured against after arrival.
    recoveries = _collection(device, "/recovery", start - timedelta(days=BASELINE_DAYS), end + timedelta(hours=12), t)
    _remember_user_id(device, sleeps + recoveries)
    recovery_by_sleep: Dict[str, dict] = {}
    before_trip: List[dict] = []
    for r in recoveries:
        score = r.get("score") or {}
        if r.get("score_state") != "SCORED" or score.get("recovery_score") is None:
            continue
        if r.get("sleep_id"):
            recovery_by_sleep[str(r["sleep_id"])] = score
        created = r.get("created_at")
        if created and _parse(created) < start:
            before_trip.append(score)
    # The traveller's own two weeks before the trip: what "usual" means for them.
    baseline = _baseline_of(before_trip)
    baseline_recovery = baseline.get("recovery")

    nights = []
    onsets = []
    for e in planned:
        tz = ZoneInfo(e.tz or (plan.home_tz if e.where == "home" else plan.destination_tz))
        best, best_overlap = None, timedelta(0)
        for s in sleeps:
            s0, s1 = _parse(s["start"]), _parse(s["end"])
            overlap = min(s1, e.end + timedelta(hours=6)) - max(s0, e.start - timedelta(hours=6))
            if overlap > best_overlap:
                best, best_overlap = s, overlap
        row = {
            "night_of": e.start.astimezone(tz).date().isoformat(),
            "where": e.where,
            "planned_bed": e.start.astimezone(tz).strftime("%H:%M"),
            "planned_wake": e.end.astimezone(tz).strftime("%H:%M"),
            "local_tz": tz.key,
        }
        if best is None:
            row.update(tracked=False)
        else:
            a0, a1 = _parse(best["start"]), _parse(best["end"])
            onset = round((a0 - e.start).total_seconds() / 60)
            wake = round((a1 - e.end).total_seconds() / 60)
            score = best.get("score") or {}
            rec = recovery_by_sleep.get(str(best.get("id")))
            # Where the body clock was that night, against the local clock: the
            # plan's expectation, and it corrected by the same rule as the
            # day's plan (half the night's lateness). What the graph plots.
            mid = e.start + (e.end - e.start) / 2
            planned_hours = hours_off_local(plan, mid)
            row.update(
                tracked=True,
                actual_bed=a0.astimezone(tz).strftime("%H:%M"),
                actual_wake=a1.astimezone(tz).strftime("%H:%M"),
                bed_minutes_late=onset,
                wake_minutes_late=wake,
                clock_at=mid.astimezone(UTC).isoformat().replace("+00:00", "Z"),
                clock_planned=planned_hours,
                clock_measured=round(planned_hours + ADJUST_FRACTION * ((onset + wake) / 2) / 60, 2),
                on_track=abs(onset) <= ON_TRACK_MINUTES and abs(wake) <= ON_TRACK_MINUTES,
                sleep_performance=score.get("sleep_performance_percentage") if best.get("score_state") == "SCORED" else None,
                recovery=int(round(rec["recovery_score"])) if rec else None,
                whoop=_night_details(best, rec),
            )
            onsets.append(onset)
        nights.append(row)

    tracked = [n for n in nights if n["tracked"]]
    on_track = [n for n in tracked if n["on_track"]]
    latest_recovery = next((n["recovery"] for n in reversed(tracked) if n.get("recovery") is not None), None)

    advice = []
    if onsets:
        typical = median(onsets)
        if typical > ON_TRACK_MINUTES:
            advice.append("You are going to bed later than planned. Dim the lights and put screens away in the hour "
                          "before bedtime" + (", and get the morning light the plan gives you." if plan.strategy == "advance" else "."))
        elif typical < -ON_TRACK_MINUTES:
            advice.append("You are going to bed earlier than planned. Stay up to the planned bedtime"
                          + (" and get the evening light the plan gives you." if plan.strategy == "delay" else "."))
    if latest_recovery is not None and latest_recovery < LOW_RECOVERY:
        advice.append("Your recovery is low today. Keep effort light, and use the nap window if the plan has one.")

    if not tracked:
        summary = "WHOOP has no sleep recorded for your planned nights yet."
    else:
        summary = f"{len(on_track)} of {len(tracked)} night{'s' if len(tracked) != 1 else ''} within an hour of the plan."

    still_to_come = any(e.start > now for e in plan.events if e.type not in ("flight", "stopover"))
    latest_is_last = bool(tracked) and nights[-1]["tracked"]
    adjustment = _adjustment(nights[-1]) if still_to_come and latest_is_last else _no_adjustment()

    last = nights[-1] if latest_is_last else None
    return {"nights": nights, "summary": summary, "advice": advice, "latest_recovery": latest_recovery,
            "adjustment": adjustment, "adaptation": _adaptation(plan, nights, baseline_recovery),
            "baseline": baseline,
            "insight": _insight(last, baseline) if last else None,
            "tonight": _tonight(plan, now, last, adjustment["minutes"])}


def _baseline_of(scores: List[dict]) -> dict:
    """Medians of the recovery scores WHOOP gave before the trip."""
    out: dict = {}
    for key, field, digits in (("recovery", "recovery_score", 0), ("hrv", "hrv_rmssd_milli", 0),
                               ("rhr", "resting_heart_rate", 0), ("skin_temp", "skin_temp_celsius", 1)):
        values = [x[field] for x in scores if x.get(field) is not None]
        if values:
            out[key] = round(median(values), digits) if digits else int(round(median(values)))
    return out


def _night_details(sleep: dict, rec: Optional[dict]) -> dict:
    """
    Everything WHOOP measured about one night that a traveller can act on:
    how long asleep against the need, the debt, REM and deep sleep, and the
    morning's HRV, resting heart rate, SpO2 and skin temperature.
    """
    out: dict = {}
    sc = sleep.get("score") or {}
    st = sc.get("stage_summary") or {}
    need = sc.get("sleep_needed") or {}
    if st.get("total_in_bed_time_milli") is not None:
        out["asleep_hours"] = round((st["total_in_bed_time_milli"] - st.get("total_awake_time_milli", 0)
                                     - st.get("total_no_data_time_milli", 0)) / 3.6e6, 1)
        out["rem_hours"] = round(st.get("total_rem_sleep_time_milli", 0) / 3.6e6, 1)
        out["deep_hours"] = round(st.get("total_slow_wave_sleep_time_milli", 0) / 3.6e6, 1)
        if st.get("disturbance_count") is not None:
            out["disturbances"] = st["disturbance_count"]
    if need.get("baseline_milli") is not None:
        out["need_hours"] = round(need["baseline_milli"] / 3.6e6, 1)
        out["debt_hours"] = round(need.get("need_from_sleep_debt_milli", 0) / 3.6e6, 1)
        out["need_total_hours"] = round(sum(v for v in need.values() if isinstance(v, (int, float))) / 3.6e6, 1)
    for src, key in (("sleep_consistency_percentage", "consistency"), ("sleep_efficiency_percentage", "efficiency")):
        if sc.get(src) is not None:
            out[key] = int(round(sc[src]))
    if sc.get("respiratory_rate") is not None:
        out["resp_rate"] = round(sc["respiratory_rate"], 1)
    if rec:
        for src, key, digits in (("hrv_rmssd_milli", "hrv", 0), ("resting_heart_rate", "rhr", 0),
                                 ("spo2_percentage", "spo2", 1), ("skin_temp_celsius", "skin_temp", 1)):
            if rec.get(src) is not None:
                out[key] = round(rec[src], digits) if digits else int(round(rec[src]))
    return out


MAX_DEBT_REPAY_HOURS = 1.0  # extra sleep asked for in one night, at most
HRV_LOW_FRACTION = 0.85    # HRV this far under the usual reads as a body under strain
RHR_HIGH_BPM = 5
FEVERISH_BPM = 8
FEVERISH_TEMP = 0.5


def _insight(night: dict, baseline: dict) -> str:
    """
    Two sentences at most: what this morning's WHOOP numbers say about how
    the body is taking the shift, and what that changes today. Recovery is
    read in WHOOP's own bands (green from 67, red under 34); HRV and resting
    heart rate against the traveller's own two-week medians, since the
    absolute numbers mean nothing across people.
    """
    w = night.get("whoop") or {}
    rec = night.get("recovery")
    if rec is None and not w:
        return ""
    signals = []
    if w.get("hrv") is not None and baseline.get("hrv") and w["hrv"] < HRV_LOW_FRACTION * baseline["hrv"]:
        signals.append(f"HRV {w['hrv']} ms against your usual {baseline['hrv']}")
    if w.get("rhr") is not None and baseline.get("rhr") and w["rhr"] >= baseline["rhr"] + RHR_HIGH_BPM:
        signals.append(f"resting heart rate {w['rhr']} against your usual {baseline['rhr']}")
    short = (w.get("asleep_hours") is not None and w.get("need_total_hours") is not None
             and w["asleep_hours"] < w["need_total_hours"] - 1)
    parts = []
    band = None if rec is None else ("green" if rec >= 67 else "red" if rec < LOW_RECOVERY else "yellow")
    head = f"Recovery {rec}%" if rec is not None else "This morning"
    if signals:
        head += ", " + " and ".join(signals)
    if band == "green" and not signals:
        parts.append(f"{head}: your body is taking the shift well. Keep to the plan.")
    elif band == "red":
        parts.append(f"{head}: your body is struggling with the shift. Take the nap, skip training, and get the light "
                     f"window; those three move the clock without costing you.")
    else:
        parts.append(f"{head}: your body is still working through the shift. Today the light window and the nap matter "
                     f"more than usual; keep training easy.")
    if short:
        parts.append(f"You slept {w['asleep_hours']:g} h of the {w['need_total_hours']:g} h WHOOP says you needed.")
    feverish = ((w.get("skin_temp") is not None and baseline.get("skin_temp") and w["skin_temp"] >= baseline["skin_temp"] + FEVERISH_TEMP)
                or (w.get("rhr") is not None and baseline.get("rhr") and w["rhr"] >= baseline["rhr"] + FEVERISH_BPM))
    if feverish:
        parts.append("A raised temperature or heart rate can also be a cold coming on; if you feel off, that is not the jet lag.")
    return " ".join(parts)


def _tonight(plan: TripPlan, now: datetime, night: Optional[dict], shift_minutes: int) -> Optional[dict]:
    """
    Tonight's sleep, sized by WHOOP's need rather than the usual duration:
    the plan's wake time stays (it anchors the morning light), so a bigger
    need means lights out earlier. The need is WHOOP's baseline plus what is
    left of the debt after last night.
    """
    nxt = next((e for e in plan.events if e.type == "sleep" and e.where in ("home", "destination") and e.start > now), None)
    if nxt is None:
        return None
    delta = timedelta(minutes=shift_minutes)
    bed, wake = nxt.start + delta, nxt.end + delta
    tz = ZoneInfo(nxt.tz or (plan.home_tz if nxt.where == "home" else plan.destination_tz))
    planned_hours = round((wake - bed).total_seconds() / 3600, 1)
    out = {"bed": bed.astimezone(tz).strftime("%H:%M"), "wake": wake.astimezone(tz).strftime("%H:%M"),
           "planned_hours": planned_hours, "local_tz": tz.key, "need_hours": None, "bed_by": None, "note": None}
    w = (night or {}).get("whoop") or {}
    if w.get("need_hours") is None:
        out["note"] = f"Bed {out['bed']}, up {out['wake']} ({planned_hours:g} h)."
        return out
    # Debt is paid back a little a night, as WHOOP itself advises: asking for
    # three hours extra tonight is not advice anyone can take.
    debt_left = round(max(0.0, w.get("debt_hours", 0) + w["need_hours"] - w.get("asleep_hours", w["need_hours"])), 1)
    extra = min(debt_left, MAX_DEBT_REPAY_HOURS)
    need = round(w["need_hours"] + extra, 1)
    out["need_hours"] = need
    out["debt_left_hours"] = debt_left
    if need > planned_hours + 0.25:
        bed_by = wake - timedelta(hours=need)
        out["bed_by"] = bed_by.astimezone(tz).strftime("%H:%M")
        out["note"] = (f"Lights out by {out['bed_by']} to be up at {out['wake']}: the {w['need_hours']:g} h WHOOP says you need"
                       + (f", plus {extra:g} h toward {debt_left:g} h of sleep debt" if extra >= 0.25 else "") + ".")
    else:
        out["note"] = f"Bed {out['bed']}, up {out['wake']} ({planned_hours:g} h, which covers WHOOP's need of {need:g} h)."
    return out


def _no_adjustment() -> dict:
    return {"minutes": 0, "night_of": None, "note": None}


def _adjustment(last: dict) -> dict:
    """How far the rest of the plan moves to match last night. See ADJUST_*."""
    mid = (last["bed_minutes_late"] + last["wake_minutes_late"]) / 2
    minutes = int(round(mid * ADJUST_FRACTION / 5.0) * 5)
    minutes = max(-ADJUST_MAX_MINUTES, min(ADJUST_MAX_MINUTES, minutes))
    if abs(minutes) < ADJUST_MIN_MINUTES:
        return {"minutes": 0, "night_of": last["night_of"],
                "note": "Last night was close enough to the plan: today's times stand."}
    later = minutes > 0
    slept = abs(int(round(mid)))
    return {
        "minutes": minutes,
        "night_of": last["night_of"],
        "note": (f"Last night you slept about {slept} min {'later' if later else 'earlier'} than planned, so your body clock "
                 f"is running about {abs(minutes)} min {'later' if later else 'earlier'} than the plan assumes. "
                 f"Today's times are moved {abs(minutes)} min {'later' if later else 'earlier'} to match."),
    }


def _adaptation(plan: TripPlan, nights: List[dict], baseline_recovery: Optional[int]) -> Optional[dict]:
    """
    Whether the traveller is back on local time, measured the way the plan
    predicts it: sleeping within an hour of the local schedule two nights
    running, with recovery not below their pre-trip usual. The plan's own
    prediction sits next to it, which is the number that tells a traveller,
    and us, whether the plan was right.
    """
    if plan.mode != "adapt":
        return None
    dest = [n for n in nights if n["where"] == "destination"]
    if not dest:
        return None

    def recovered(n):
        return n["tracked"] and n["on_track"] and (
            n.get("recovery") is None or baseline_recovery is None or n["recovery"] >= baseline_recovery - RECOVERY_SLACK)

    adapted_after = next((i + 1 for i in range(len(dest) - 1) if recovered(dest[i]) and recovered(dest[i + 1])), None)
    tracked = len([n for n in dest if n["tracked"]])
    predicted = plan.days_to_adapt_after_arrival
    if adapted_after is not None:
        verdict = (f"Back on local time after {adapted_after} night{'s' if adapted_after != 1 else ''}; "
                   f"the plan expected {predicted}.")
    elif tracked:
        verdict = (f"Not yet on local time after {tracked} night{'s' if tracked != 1 else ''} there; "
                   f"the plan expects {predicted}.")
    else:
        verdict = None
    return {"nights_at_destination": tracked, "adapted_after_nights": adapted_after,
            "predicted_nights": predicted, "baseline_recovery": baseline_recovery, "verdict": verdict}
