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

import html
import os
import re
import threading
from dataclasses import asdict
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src import advice, analytics, checkin, flights, push, store, whoop
from src.auth import RateLimiter, auth_and_rate_limit
from src.ics import plan_to_ics
from src.itinerary import estimate_landing, merge_plans, plan_itinerary, plan_to_dict, plan_trip
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


class Journey(BaseModel):
    legs: List[Leg] = Field(..., min_length=1, description="The flights of this journey in order, connections included")


class TripRequest(BaseModel):
    departure: Optional[datetime] = Field(None, description="Wall-clock departure time at the origin, e.g. 2026-10-10T23:55")
    departure_tz: Optional[str] = Field(None, description="IANA time zone of the origin, e.g. Asia/Bangkok")
    arrival: Optional[datetime] = Field(None, description="Wall-clock arrival time at the final destination")
    arrival_tz: Optional[str] = Field(None, description="IANA time zone of the destination, e.g. Europe/Paris")
    legs: Optional[List[Leg]] = Field(None, description="For connections: every flight in order; replaces the four fields above")
    journeys: Optional[List[Journey]] = Field(None, description=(
        "Several journeys in order, separated by stays: a round trip, an open jaw (back from another city) or a "
        "multi-city trip. Each starts from the body clock the previous one predicts. Replaces legs and return_departure."))
    sleep_start: Optional[str] = Field(None, description="Usual bedtime at home, HH:MM")
    sleep_end: Optional[str] = Field(None, description="Usual wake time at home, HH:MM")
    chronotype: str = Field("intermediate", description="early | intermediate | late; used when sleep times are missing")
    preflight_days: int = Field(2, ge=0, le=3, description="Days to start shifting before departure")
    return_departure: Optional[datetime] = Field(None, description="When you leave the destination, local time")
    melatonin: bool = True
    caffeine: bool = True
    strategy: str = Field("auto", description="auto | advance | delay")
    light_device: str = Field("none", description="none | glasses | box: light glasses or a light box, for when daylight isn't practical")


def _plans(req: TripRequest):
    """One plan per journey. A single flight or connection is an itinerary of one."""
    if req.journeys:
        return plan_itinerary(
            [[leg.model_dump() for leg in j.legs] for j in req.journeys],
            sleep_start=req.sleep_start, sleep_end=req.sleep_end, chronotype=req.chronotype,
            preflight_days=req.preflight_days, melatonin=req.melatonin, caffeine=req.caffeine, strategy=req.strategy,
            light_device=req.light_device,
        )
    return [plan_trip(
        departure=req.departure, departure_tz=req.departure_tz,
        arrival=req.arrival, arrival_tz=req.arrival_tz,
        sleep_start=req.sleep_start, sleep_end=req.sleep_end,
        chronotype=req.chronotype, preflight_days=req.preflight_days,
        return_departure=req.return_departure,
        melatonin=req.melatonin, caffeine=req.caffeine, strategy=req.strategy, light_device=req.light_device,
        legs=[leg.model_dump() for leg in req.legs] if req.legs else None,
    )]


def _plan(req: TripRequest):
    """The whole trip as one plan, for what reads events only: reminders, the calendar, WHOOP."""
    return merge_plans(_plans(req))


@app.post("/v2/plan", responses={400: {"model": ErrorResponse}})
def create_trip_plan(req: TripRequest, _auth=Depends(auth_and_rate_limit)):
    plan = plan_to_dict(_plan(req))
    record_call(_auth.key_hash)
    return plan


# Generous for one person using the app, useless for reselling the engine. A
# page load makes eight or nine calls (plan, WHOOP status, baseline, progress,
# reminders), and the Today screen redraws once when WHOOP moves the plan; at
# 20 a minute a second open within the minute was refused.
_APP_LIMITER = RateLimiter(max_requests=60, window_seconds=60)


def _client_ip(request: Request) -> str:
    # Railway's proxy puts the caller first in X-Forwarded-For.
    forwarded = request.headers.get("x-forwarded-for", "")
    return (forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown"))


def app_rate_limit(request: Request) -> None:
    _APP_LIMITER.check("ip:" + _client_ip(request))


def _count_plan(req: TripRequest, request: Request, first: dict) -> None:
    # The page re-plans the saved (or example) trip on every open; only the
    # button is someone planning a trip.
    submitted = request.headers.get("x-circadian-intent", "") == "submit"
    analytics.track("plan_made" if submitted else "app_opened", request.headers,
                    analytics.plan_properties(req, first))


@app.post("/app/plan", responses={400: {"model": ErrorResponse}})
def app_plan(req: TripRequest, request: Request, _limit=Depends(app_rate_limit)):
    plan = plan_to_dict(_plan(req))
    _count_plan(req, request, plan)
    return plan


@app.post("/app/itinerary", responses={400: {"model": ErrorResponse}})
def app_itinerary(req: TripRequest, request: Request, _limit=Depends(app_rate_limit)):
    """The same trip as one plan per journey, which is how the page shows it."""
    raw = _plans(req)
    plans = [plan_to_dict(p) for p in raw]
    _count_plan(req, request, plans[0])
    return {"journeys": plans, "supplements": advice.supplements(raw)}


@app.get("/app/estimate", responses={400: {"model": ErrorResponse}})
def app_estimate(departure: datetime, departure_tz: str, arrival_tz: str, _limit=Depends(app_rate_limit)):
    """When a direct flight lands, estimated from the distance; the page marks it as an estimate."""
    landing, minutes = estimate_landing(departure, departure_tz, arrival_tz)
    return {"arrival": landing.strftime("%Y-%m-%dT%H:%M"), "minutes": minutes}


@app.get("/app/flight/status")
def flight_status(_limit=Depends(app_rate_limit)):
    """Whether flight numbers can be looked up here; the page hides the field when not."""
    return {"configured": flights.is_configured()}


@app.get("/app/flight", responses={400: {"model": ErrorResponse}})
def flight_lookup(number: str = Query(..., max_length=12), on: date = Query(..., alias="date"), _limit=Depends(app_rate_limit)):
    """
    A flight's legs leaving on the ticket's date, with each airport's time
    zone and the local times, from AeroDataBox (see flights.py). Refusals
    carry the words the page shows: a wrong number, no such flight that day,
    the day's lookups used up, or the service not switched on.
    """
    try:
        return flights.lookup(number, on)
    except flights.LookupFailed as err:
        code = {400: "bad_flight_number", 404: "flight_not_found", 429: "lookups_used_up", 503: "lookup_not_configured"}.get(err.status, "lookup_failed")
        return JSONResponse(status_code=err.status, content={"error": {"code": code, "message": str(err)}})


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
    # In the background: a slow WHOOP must not hold up serving the page.
    threading.Thread(target=lambda: print(whoop.reachability()), daemon=True).start()
    checkin.start()
    push.start_scheduler()


@app.get("/app/push/key")
def push_key(_limit=Depends(app_rate_limit)):
    return {"public_key": store.vapid_keys()["public_key"]}


@app.post("/app/push/subscribe")
def push_subscribe(req: PushSubscribeRequest, request: Request, _limit=Depends(app_rate_limit)):
    whoop.check_device(req.device)
    count = push.subscribe(req.device, req.subscription, _plan(req.trip), trip=req.trip.model_dump(mode="json", exclude_none=True))
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
    # Each step is logged so a sign-in that never comes back is visible too.
    print(f"CircadianAPI: WHOOP sign-in started; WHOOP will return to {_redirect_uri(request)}")
    return RedirectResponse(whoop.authorize_url(device, _redirect_uri(request)), status_code=302)


@app.get("/whoop/callback")
def whoop_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None,
                   error: Optional[str] = None, _limit=Depends(app_rate_limit)):
    if error or not code or not state:
        # Only "access_denied" is the traveller saying no. Anything else (an
        # invalid scope, a client WHOOP doesn't know) is a setup problem that
        # used to read as "not connected" with the reason thrown away.
        detail = request.query_params.get("error_description", "")[:200]
        print(f"CircadianAPI: WHOOP sign-in returned without a code: error={error!r} {detail}")
        if error in (None, "access_denied"):
            return RedirectResponse(f"{_prefix(request)}/?whoop=cancelled", status_code=302)
        code_word = re.sub(r"[^a-z_]", "", error.lower())[:40] or "unknown"
        analytics.track("whoop_connect_failed", request.headers, {"reason": code_word})
        return RedirectResponse(f"{_prefix(request)}/?whoop=failed&why=refused&error={code_word}", status_code=302)
    try:
        device = whoop.verify_state(state)
        whoop.exchange_code(device, code, _redirect_uri(request))
    except ValueError as err:
        # verify_state's refusals are a sign-in that took too long or was
        # tampered with: starting again is the fix either way.
        why = getattr(err, "reason", "link")
        print(f"CircadianAPI: connecting WHOOP failed ({why}): {err}")
        analytics.track("whoop_connect_failed", request.headers, {"reason": why})
        status = f"&status={int(err.status)}" if getattr(err, "status", 0) else ""
        return RedirectResponse(f"{_prefix(request)}/?whoop=failed&why={why}{status}", status_code=302)
    print("CircadianAPI: WHOOP connected.")
    analytics.track("whoop_connected", _as_device(request, device))
    return RedirectResponse(f"{_prefix(request)}/?whoop=connected", status_code=302)


@app.post("/whoop/webhook", include_in_schema=False)
async def whoop_webhook(request: Request):
    """
    WHOOP's notice that a sleep or recovery was scored: the morning check-in's
    trigger (checkin.py). Registered in the WHOOP developer dashboard as
    <public base>/whoop/webhook. Answered at once; the work runs behind.
    Not rate-limited by IP like the app routes: WHOOP's addresses are shared.
    """
    body = await request.body()
    if not checkin.verify_signature(request.headers.get("x-whoop-signature-timestamp", ""), body,
                                    request.headers.get("x-whoop-signature", "")):
        print("CircadianAPI: a WHOOP webhook delivery failed its signature check and was ignored.")
        return JSONResponse(status_code=401, content={"error": {"code": "bad_signature", "message": "signature check failed"}})

    def work():
        print(f"CircadianAPI: morning check-in from WHOOP webhook: {checkin.handle_webhook(body)}")

    checkin.in_background(work)
    return {"received": True}


@app.get("/app/whoop/status")
def whoop_status(device: str = Query(...), _limit=Depends(app_rate_limit)):
    return whoop.status(device)


_NOT_CONNECTED = {"error": {"code": "whoop_not_connected", "message": "WHOOP is not connected on this phone. Tap Connect WHOOP."}}


@app.get("/app/whoop/baseline")
def whoop_baseline(device: str = Query(...), days_until: Optional[int] = Query(None, ge=-1, le=365),
                   _limit=Depends(app_rate_limit)):
    """
    The traveller's usual nights from WHOOP, to start the plan from their real
    clock; with days_until (to the plan's start), what the last week says to
    do before flying.
    """
    try:
        out = whoop.baseline(device)
    except whoop.NotConnected:
        return JSONResponse(status_code=409, content=_NOT_CONNECTED)
    if days_until is not None:
        out["advice"] = whoop.pretrip_advice(out, days_until)
    return out


@app.post("/app/whoop/progress")
def whoop_progress(req: ProgressRequest, request: Request, _limit=Depends(app_rate_limit)):
    try:
        out = whoop.progress(req.device, _plan(req.trip))
        tracked = [n for n in out.get("nights", []) if n.get("tracked")]
        adaptation = out.get("adaptation") or {}
        analytics.track("whoop_progress_viewed", _as_device(request, req.device), {
            "nights_tracked": len(tracked),
            "nights_on_track": len([n for n in tracked if n.get("on_track")]),
            "adjust_minutes": out["adjustment"]["minutes"],
            # The product question, per trip: did it work, and was the prediction right.
            "adapted_after_nights": adaptation.get("adapted_after_nights"),
            "predicted_nights": adaptation.get("predicted_nights"),
        })
        return out
    except whoop.NotConnected:
        return JSONResponse(status_code=409, content=_NOT_CONNECTED)


class FeedbackRequest(BaseModel):
    device: str
    rating: int = Field(..., ge=1, le=5, description="1 no jet lag, 2 mild, 3 moderate, 4 bad, 5 severe")
    followed: Optional[str] = Field(None, pattern="^(mostly|partly|hardly)$")
    shift_hours: Optional[float] = Field(None, ge=0, le=24)
    strategy: Optional[str] = Field(None, pattern="^(advance|delay)$")
    # From the day-by-day log on the phone, when it was used: what "followed" is measured from.
    done: Optional[int] = Field(None, ge=0, le=500)
    skipped: Optional[int] = Field(None, ge=0, le=500)


ACTIONABLE = ("light_seek", "light_avoid", "caffeine_ok", "melatonin", "nap")
MOMENT_ANSWERS = ("done", "skipped", "couldnt")


class LogRequest(BaseModel):
    """
    One tap on Today: a moment marked done, skipped or couldn't, or the
    morning's "how do you feel" 1-5. Kept on the phone; counted here so what
    people follow and how they feel can be set against what WHOOP measured.

    "Couldn't" is kept apart from "skipped": one is a plan the traveller
    chose not to follow, the other a plan the day did not allow (a meeting
    through the light window). They call for different fixes, and habit
    apps that fold them together lose people who had no choice.
    """
    device: str
    kind: str = Field(..., pattern="^(moment|feel)$")
    type: Optional[str] = Field(None, pattern="^(" + "|".join(ACTIONABLE) + ")$")
    value: str = Field(..., max_length=8)
    day: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    recovery: Optional[int] = Field(None, ge=0, le=100)
    day_number: Optional[int] = Field(None, ge=-3, le=60)


@app.post("/app/log")
def app_log(req: LogRequest, request: Request, _limit=Depends(app_rate_limit)):
    whoop.check_device(req.device)
    if req.kind == "moment":
        if req.type is None or req.value not in MOMENT_ANSWERS:
            raise ValueError("a moment log needs its type and one of " + ", ".join(MOMENT_ANSWERS))
        analytics.track("moment_logged", _as_device(request, req.device),
                        {"type": req.type, "value": req.value, "day_number": req.day_number})
    else:
        if not req.value.isdigit() or not 1 <= int(req.value) <= 5:
            raise ValueError("how you feel is 1 to 5")
        analytics.track("morning_feel", _as_device(request, req.device),
                        {"feel": int(req.value), "recovery": req.recovery, "day_number": req.day_number})
    return {"ok": True}


@app.post("/app/feedback")
def app_feedback(req: FeedbackRequest, request: Request, _limit=Depends(app_rate_limit)):
    """
    How bad the jet lag was, after the trip, and how much of the plan was
    followed. Timeshifter publishes exactly this comparison (travellers who
    followed the advice against those who didn't); it is the only evidence a
    jet lag app works, so it is collected the same way. Sent to analytics
    only, against the anonymous device id; nothing is stored here.
    """
    whoop.check_device(req.device)
    analytics.track("jet_lag_rated", _as_device(request, req.device), {
        "rating": req.rating, "followed": req.followed,
        "hours_shifted": req.shift_hours, "strategy": req.strategy,
        "moments_done": req.done, "moments_skipped": req.skipped,
    })
    return {"thanks": True}


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


PRIVACY_PAGE = Path(__file__).resolve().parent / "privacy.html"
_EMAIL_RE = re.compile(r"^[^@\s<>\"']+@[^@\s<>\"']+\.[^@\s<>\"']+$")


@app.get("/privacy", include_in_schema=False)
def privacy_page(request: Request):
    """
    The privacy policy WHOOP asks every app for, and any traveller can read.
    The contact address comes from CIRCADIAN_CONTACT_EMAIL rather than the
    file, so the owner's address is published only when they choose to.
    """
    email = os.environ.get("CIRCADIAN_CONTACT_EMAIL", "").strip()
    if _EMAIL_RE.match(email):
        contact = (f'<h2>Contact</h2><p>Questions, or a request to delete what the server holds for your device: '
                   f'<a href="mailto:{html.escape(email)}">{html.escape(email)}</a>.</p>')
    else:
        contact = ("<h2>Contact</h2><p>Reminders and WHOOP can be removed in the app at any time, which deletes "
                   "what the server holds for your device.</p>")
    page = PRIVACY_PAGE.read_text(encoding="utf-8").replace("{{CONTACT}}", contact)
    return HTMLResponse(page.replace("{{BASE_URL}}", _public_base(request)), headers={"Cache-Control": "no-cache"})


# The consumer app itself. Mounted last so every route above wins.
if WEB_DIR.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
