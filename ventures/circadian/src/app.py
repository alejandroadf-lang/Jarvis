"""
FastAPI application exposing the circadian phase-shift scheduling engine.

Thin HTTP layer only: parse the request, call plan_shift(), return the
result. All scheduling logic lives in shift_logic.py, which imports no
framework and is tested independently (see test_shift_logic.py).

API-key authentication and rate limiting are enforced on /v1/shift-plan
via auth_and_rate_limit (see auth.py). /health remains open, no auth.
Every response, success or error, is JSON. Every successful
shift-plan response includes the `disclaimer` field from ShiftPlan --
this is a non-medical informational tool, not medical advice, and that
has to be visible in the payload itself, not just in the docs.

Every successful /v1/shift-plan call is recorded per-key in
telemetry.py, keyed by the same key_hash auth.py already uses -- this
is the only source of truth on whether the API is actually being used.
"""

import os
import re
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src import analytics, push, store, whoop
from src.auth import RateLimiter, auth_and_rate_limit
from src.ics import plan_to_ics
from src.itinerary import plan_to_dict, plan_trip
from src.shift_logic import plan_shift
from src.telemetry import get_call_count, record_call

WEB_DIR = Path(__file__).parent / "web"

app = FastAPI(
    title="CircadianAPI",
    version="1.0.0",
    description=(
        "Generates a day-by-day light/melatonin/sleep-window schedule to "
        "help resynchronize a traveler's circadian clock after crossing "
        "time zones. This is general informational tooling based on "
        "published circadian-rhythm research -- it is not medical advice, "
        "diagnosis, or treatment. See the `disclaimer` field returned on "
        "every /v1/shift-plan response."
    ),
)


class ShiftPlanRequest(BaseModel):
    direction: str = Field(..., description="'eastward' (phase advance) or 'westward' (phase delay)")
    time_zones_shifted: int = Field(..., ge=0, description="Absolute number of time zones crossed")
    current_sleep_start_hour: float = Field(
        23.0, ge=0, lt=24, description="Normal sleep-start hour, origin-local clock, 0-24"
    )
    current_sleep_end_hour: float = Field(
        7.0, ge=0, lt=24, description="Normal wake hour, origin-local clock, 0-24"
    )


class DayPlanResponse(BaseModel):
    day: int
    cumulative_shift_hours: float
    sleep_start_hour: float
    sleep_end_hour: float
    light_seek_start_hour: float
    light_seek_end_hour: float
    light_avoid_start_hour: float
    light_avoid_end_hour: float
    melatonin_hour: float


class ShiftPlanResponse(BaseModel):
    direction: str
    time_zones_shifted: int
    total_days: int
    rate_hours_per_day: float
    days: List[DayPlanResponse]
    disclaimer: str


class UsageResponse(BaseModel):
    call_count: int


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


@app.exception_handler(Exception)
def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    # Counted so a bug on a traveller's trip shows up somewhere other than a
    # log nobody reads. Starlette still re-raises it, so the traceback stays
    # in the deploy log as before.
    analytics.track("$exception", request.headers, analytics.exception_properties(exc, request.url.path))
    return JSONResponse(status_code=500, content={"error": {
        "code": "internal_error", "message": "Something went wrong making this plan. Try again in a minute."}})


@app.exception_handler(ValueError)
def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": {"code": "invalid_request", "message": str(exc)}},
    )


@app.post(
    "/v1/shift-plan",
    response_model=ShiftPlanResponse,
    responses={400: {"model": ErrorResponse}},
)
def create_shift_plan(
    req: ShiftPlanRequest, _auth=Depends(auth_and_rate_limit)
) -> ShiftPlanResponse:
    plan = plan_shift(
        direction=req.direction,
        time_zones_shifted=req.time_zones_shifted,
        current_sleep_start_hour=req.current_sleep_start_hour,
        current_sleep_end_hour=req.current_sleep_end_hour,
    )
    data = asdict(plan)
    data["direction"] = plan.direction.value if hasattr(plan.direction, "value") else plan.direction
    record_call(_auth.key_hash)
    return ShiftPlanResponse(**data)


@app.get("/v1/usage", response_model=UsageResponse)
def get_usage(_auth=Depends(auth_and_rate_limit)) -> UsageResponse:
    """
    Returns the calling key's own served-call count. Requires the same
    auth as /v1/shift-plan. Does not expose other keys' counts or any
    cross-account data.
    """
    return UsageResponse(call_count=get_call_count(_auth.key_hash))


@app.get("/health")
def health():
    return {"status": "ok"}


# --- v2: plans from a real trip ---------------------------------------------------------
#
# The same engine serves two callers. /v2/plan is the developer API, keyed and
# counted like v1. /app/plan is the consumer app on this same host: a traveller
# on a phone has no API key, so it is open and limited per IP address instead.
# v1 is untouched, so nothing already built against it changes.


class Leg(BaseModel):
    departure: datetime
    departure_tz: str
    arrival: datetime
    arrival_tz: str


class TripRequest(BaseModel):
    departure: Optional[datetime] = Field(None, description="Wall-clock departure time at the origin, e.g. 2026-10-10T23:55")
    departure_tz: Optional[str] = Field(None, description="IANA time zone of the origin, e.g. Asia/Bangkok")
    arrival: Optional[datetime] = Field(None, description="Wall-clock arrival time at the final destination")
    arrival_tz: Optional[str] = Field(None, description="IANA time zone of the destination, e.g. Europe/Paris")
    legs: Optional[List[Leg]] = Field(None, description="For connections: every flight in order; replaces the four fields above")
    sleep_start: Optional[str] = Field(None, description="Usual bedtime at home, HH:MM")
    sleep_end: Optional[str] = Field(None, description="Usual wake time at home, HH:MM")
    chronotype: str = Field("intermediate", description="early | intermediate | late; used when sleep times are missing")
    preflight_days: int = Field(2, ge=0, le=3, description="Days to start shifting before departure")
    return_departure: Optional[datetime] = Field(None, description="When you leave the destination, local time")
    melatonin: bool = True
    caffeine: bool = True
    strategy: str = Field("auto", description="auto | advance | delay")


def _plan(req: TripRequest):
    return plan_trip(
        departure=req.departure, departure_tz=req.departure_tz,
        arrival=req.arrival, arrival_tz=req.arrival_tz,
        sleep_start=req.sleep_start, sleep_end=req.sleep_end,
        chronotype=req.chronotype, preflight_days=req.preflight_days,
        return_departure=req.return_departure,
        melatonin=req.melatonin, caffeine=req.caffeine, strategy=req.strategy,
        legs=[leg.model_dump() for leg in req.legs] if req.legs else None,
    )


@app.post("/v2/plan", responses={400: {"model": ErrorResponse}})
def create_trip_plan(req: TripRequest, _auth=Depends(auth_and_rate_limit)):
    plan = plan_to_dict(_plan(req))
    record_call(_auth.key_hash)
    return plan


# Generous for one person planning a trip, useless for reselling the engine.
_APP_LIMITER = RateLimiter(max_requests=20, window_seconds=60)


def _client_ip(request: Request) -> str:
    # Railway's proxy puts the caller first in X-Forwarded-For.
    forwarded = request.headers.get("x-forwarded-for", "")
    return (forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown"))


def app_rate_limit(request: Request) -> None:
    _APP_LIMITER.check("ip:" + _client_ip(request))


@app.post("/app/plan", responses={400: {"model": ErrorResponse}})
def app_plan(req: TripRequest, request: Request, _limit=Depends(app_rate_limit)):
    plan = plan_to_dict(_plan(req))
    # The page re-plans the saved (or example) trip on every open; only the
    # button is someone planning a trip.
    submitted = request.headers.get("x-circadian-intent", "") == "submit"
    analytics.track("plan_made" if submitted else "app_opened", request.headers,
                    analytics.plan_properties(req, plan))
    return plan


@app.get("/app/plan.ics")
def app_plan_ics(request: Request, t: Optional[str] = None, _limit=Depends(app_rate_limit)):
    """
    GET with the trip in the query string, so a plain link opens the phone's
    calendar import. iOS Safari will not hand a script-made file to Calendar;
    it does follow a link to a text/calendar response.

    A trip with connections does not fit in flat query parameters, so the
    app sends it whole as `t`: base64url JSON. Flat parameters still work for
    a single flight.
    """
    import base64
    import json as _json

    try:
        if t:
            raw = _json.loads(base64.urlsafe_b64decode(t + "=" * (-len(t) % 4)))
        else:
            raw = dict(request.query_params)
        req = TripRequest.model_validate(raw)
    except Exception as err:  # malformed link: say so rather than 500
        raise ValueError(f"the calendar link is not valid: {err}") from err
    body = plan_to_ics(_plan(req))
    analytics.track("calendar_added", request.headers, {"flights": len(req.legs) if req.legs else 1})
    return Response(
        content=body,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="jet-lag-plan.ics"'},
    )


# --- reminders and WHOOP -------------------------------------------------------------------
#
# Both are keyed by an anonymous device id the phone makes for itself; there
# are no accounts. See push.py and whoop.py for what is stored and why.


def _as_device(request: Request, device: str) -> dict:
    """The request's privacy signals, with the device id this route already has."""
    return {
        "x-circadian-device": device,
        "sec-gpc": request.headers.get("sec-gpc", ""),
        "dnt": request.headers.get("dnt", ""),
    }


class DeviceRequest(BaseModel):
    device: str


class PushSubscribeRequest(BaseModel):
    device: str
    subscription: dict
    trip: TripRequest


class ProgressRequest(BaseModel):
    device: str
    trip: TripRequest


@app.on_event("startup")
def _startup() -> None:
    print(store.describe_storage())
    print(analytics.describe())
    print(whoop.describe())
    push.start_scheduler()


@app.get("/app/push/key")
def push_key(_limit=Depends(app_rate_limit)):
    return {"public_key": store.vapid_keys()["public_key"]}


@app.post("/app/push/subscribe")
def push_subscribe(req: PushSubscribeRequest, request: Request, _limit=Depends(app_rate_limit)):
    whoop.check_device(req.device)
    count = push.subscribe(req.device, req.subscription, _plan(req.trip))
    analytics.track("reminders_on", _as_device(request, req.device), {"reminders": count})
    return {"subscribed": True, "reminders": count}


@app.post("/app/push/unsubscribe")
def push_unsubscribe(req: DeviceRequest, request: Request, _limit=Depends(app_rate_limit)):
    whoop.check_device(req.device)
    removed = push.unsubscribe(req.device)
    analytics.track("reminders_off", _as_device(request, req.device))
    return {"subscribed": False, "removed": removed}


@app.get("/app/push/status")
def push_status(device: str = Query(...), _limit=Depends(app_rate_limit)):
    return push.status(whoop.check_device(device))


_PREFIX_RE = re.compile(r"^(/[A-Za-z0-9_-]+)*$")


def _prefix(request: Request) -> str:
    """
    The path this app is mounted under when a proxy serves it below the root,
    e.g. "/circadian" inside Jarvis. The proxy says so in X-Forwarded-Prefix.
    Only plain path segments are accepted: anything else ("//evil.example",
    "/../x") is ignored, so the header cannot turn our redirects into an open
    redirect to another site.
    """
    prefix = request.headers.get("x-forwarded-prefix", "").strip().rstrip("/")
    return prefix if _PREFIX_RE.match(prefix) else ""


def _redirect_uri(request: Request) -> str:
    # Must match the redirect URL registered in the WHOOP developer dashboard.
    configured = os.environ.get("WHOOP_REDIRECT_URI", "").strip()
    if configured:
        return configured
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}{_prefix(request)}/whoop/callback"


@app.get("/whoop/connect")
def whoop_connect(request: Request, device: str = Query(...), _limit=Depends(app_rate_limit)):
    whoop.check_device(device)
    if not whoop.is_configured():
        return HTMLResponse(
            "<p>WHOOP is not connected to this app yet. The owner needs to add WHOOP_CLIENT_ID and "
            f"WHOOP_CLIENT_SECRET.</p><p><a href=\"{_prefix(request)}/\">Back to your plan</a></p>", status_code=503)
    return RedirectResponse(whoop.authorize_url(device, _redirect_uri(request)), status_code=302)


@app.get("/whoop/callback")
def whoop_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None,
                   error: Optional[str] = None, _limit=Depends(app_rate_limit)):
    if error or not code or not state:
        return RedirectResponse(f"{_prefix(request)}/?whoop=cancelled", status_code=302)
    try:
        device = whoop.verify_state(state)
        whoop.exchange_code(device, code, _redirect_uri(request))
    except ValueError:
        analytics.track("whoop_connect_failed", request.headers)
        return RedirectResponse(f"{_prefix(request)}/?whoop=failed", status_code=302)
    analytics.track("whoop_connected", _as_device(request, device))
    return RedirectResponse(f"{_prefix(request)}/?whoop=connected", status_code=302)


@app.get("/app/whoop/status")
def whoop_status(device: str = Query(...), _limit=Depends(app_rate_limit)):
    return whoop.status(device)


@app.post("/app/whoop/progress")
def whoop_progress(req: ProgressRequest, request: Request, _limit=Depends(app_rate_limit)):
    try:
        out = whoop.progress(req.device, _plan(req.trip))
        tracked = [n for n in out.get("nights", []) if n.get("tracked")]
        analytics.track("whoop_progress_viewed", _as_device(request, req.device), {
            "nights_tracked": len(tracked),
            "nights_on_track": len([n for n in tracked if n.get("on_track")]),
        })
        return out
    except whoop.NotConnected:
        return JSONResponse(status_code=409, content={"error": {
            "code": "whoop_not_connected", "message": "WHOOP is not connected on this phone. Tap Connect WHOOP."}})


@app.post("/app/whoop/disconnect")
def whoop_disconnect(req: DeviceRequest, _limit=Depends(app_rate_limit)):
    whoop.disconnect(req.device)
    return {"connected": False}


def _public_base(request: Request) -> str:
    """Where the app is reached from outside, with a trailing slash: the proxy's
    scheme and host plus any path prefix (see _prefix)."""
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}{_prefix(request)}/"


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def web_index(request: Request):
    """
    The page, with its link-preview URLs filled in. Reddit, WhatsApp and the
    rest only show a title and picture for absolute URLs, and the app can be
    served at the root of a host or below /circadian, so the address is taken
    from the request rather than written into the file.
    """
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8").replace("{{BASE_URL}}", _public_base(request))
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


# The consumer app itself. Mounted last so every route above wins.
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
