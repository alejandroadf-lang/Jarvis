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
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from src import store
from src.itinerary import TripPlan

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
    """(status, json body or None). Replaced in tests."""
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")
    if form is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw) if raw else None
        except ValueError:
            # Not WHOOP's API talking but something in front of it (a firewall
            # page): its first words and ray id say which rule, and a bare
            # "HTTP 403" did not. Such pages never echo the request's form.
            text = " ".join(raw[:4000].decode("utf-8", "replace").split())
            text = re.sub(r"<[^>]+>", " ", text)
            text = " ".join(text.split())[:300]
            print(f"CircadianAPI: {method} {url.split('?')[0]} answered HTTP {err.code} "
                  f"(server={err.headers.get('server', '?')}, cf-ray={err.headers.get('cf-ray', '-')}): {text}")
            return err.code, None
    except OSError:  # DNS, refused, timeout: status 0 means WHOOP was not reached
        return 0, None


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


def progress(device: str, plan: TripPlan, now: Optional[datetime] = None) -> dict:
    """Each planned night next to the real one, and what to do about the gap."""
    check_device(device)
    if not store.read(COLLECTION, {}).get(device):
        raise NotConnected()
    now = now or datetime.now(UTC)
    t = now.timestamp()
    planned = [e for e in plan.events if e.type == "sleep" and e.where in ("home", "destination") and e.end <= now]
    if not planned:
        return {"nights": [], "summary": "No planned nights have passed yet. Check back after your first night on the plan.",
                "advice": [], "latest_recovery": None}

    start = min(e.start for e in planned) - timedelta(hours=12)
    end = min(now, max(e.end for e in planned) + timedelta(hours=12))
    sleeps = [s for s in _collection(device, "/activity/sleep", start, end, t)
              if not s.get("nap") and s.get("start") and s.get("end")]
    recoveries = _collection(device, "/recovery", start, end + timedelta(hours=12), t)
    recovery_by_sleep: Dict[str, int] = {}
    for r in recoveries:
        score = (r.get("score") or {}).get("recovery_score")
        if r.get("score_state") == "SCORED" and r.get("sleep_id") and score is not None:
            recovery_by_sleep[str(r["sleep_id"])] = int(round(score))

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
            row.update(
                tracked=True,
                actual_bed=a0.astimezone(tz).strftime("%H:%M"),
                actual_wake=a1.astimezone(tz).strftime("%H:%M"),
                bed_minutes_late=onset,
                wake_minutes_late=wake,
                on_track=abs(onset) <= ON_TRACK_MINUTES and abs(wake) <= ON_TRACK_MINUTES,
                sleep_performance=score.get("sleep_performance_percentage") if best.get("score_state") == "SCORED" else None,
                recovery=recovery_by_sleep.get(str(best.get("id"))),
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
    return {"nights": nights, "summary": summary, "advice": advice, "latest_recovery": latest_recovery}
