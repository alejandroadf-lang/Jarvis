"""
Selling the planning engine to other companies: the developer page, a free
key without talking to anyone, and the owner's controls for paid keys.

The API itself (/v2/plan) was built and priced before anything here existed,
and nobody could buy it: a company had no page to find, no way to try it, and
the only way to issue a key was to type it into a Railway variable and
redeploy, which also wiped every usage count. This is the missing half.

- GET  /developers              what it does, the plans, a quickstart, a form for a free key
- POST /developers/keys         a free key for an email address, once per address
- GET  /admin/api-keys          the owner's list: plan, owner, usage this month
- POST /admin/api-keys          issue a key on any plan (after someone pays)
- POST /admin/api-keys/{key_id} move a key to another plan, or switch it off

Money is taken outside this service, by a Stripe payment link the owner makes
(CIRCADIAN_API_CHECKOUT_URL); when it is paid, the owner moves the key to
Starter with the admin endpoint. Automating that step is worth doing at the
tenth customer, not the first.

The admin endpoints answer only to CIRCADIAN_ADMIN_TOKEN, compared in
constant time, and refuse to work at all while it is unset or short: an admin
surface with a guessable password is worse than none.
"""

from __future__ import annotations

import hmac
import html
import os
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from src import analytics, auth, store
from src.telemetry import calls_this_month

router = APIRouter()

PAGE = Path(__file__).resolve().parent / "developers.html"
EMAILS = "api_emails"                 # email -> key hash, one free key per address
EMAIL_RE = re.compile(r"^[^@\s<>\"']+@[^@\s<>\"']+\.[^@\s<>\"']+$")
ADMIN_TOKEN_MIN = 24

# Free keys per address per day. A key is harmless on its own (100 plans a
# month), but an endpoint that hands them out unmetered is a way to get
# unlimited free plans by asking many times.
_SIGNUPS = auth.RateLimiter(max_requests=3, window_seconds=24 * 3600)
# And across everyone. The per-address limit trusts X-Forwarded-For, which a
# caller can write themselves; this one they cannot get round. Fifty real
# developers in a day would be a good problem, and the page then says to write.
_SIGNUPS_ALL = auth.RateLimiter(max_requests=50, window_seconds=24 * 3600)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


# --- the page --------------------------------------------------------------------------

def _contact() -> str:
    email = os.environ.get("CIRCADIAN_CONTACT_EMAIL", "").strip()
    return email if EMAIL_RE.match(email) else ""


def _checkout_url() -> str:
    url = os.environ.get("CIRCADIAN_API_CHECKOUT_URL", "").strip()
    return url if url.startswith("https://") else ""


def _plans_rows() -> str:
    rows = []
    for name, p in auth.PLANS.items():
        rows.append(f"<tr><th scope=\"row\">{p['label']}</th><td>{p['price']}</td>"
                    f"<td>{p['monthly_plans']:,}</td><td>{p['per_minute']}</td></tr>")
    return "\n".join(rows)


def _upgrade_html() -> str:
    contact, checkout = _contact(), _checkout_url()
    parts = []
    if checkout:
        parts.append(f'<a class="button" href="{html.escape(checkout)}">Subscribe to Starter</a> '
                     "then reply to the receipt with your key's first 12 characters, and it is upgraded the same day.")
    if contact:
        parts.append(f'For Scale, or anything else: <a href="mailto:{html.escape(contact)}">{html.escape(contact)}</a>.')
    if not parts:
        parts.append("Paid plans open soon.")
    return " ".join(parts)


@router.get("/developers", include_in_schema=False)
def developers_page():
    page = (PAGE.read_text(encoding="utf-8")
            .replace("{{PLANS}}", _plans_rows())
            .replace("{{UPGRADE}}", _upgrade_html())
            .replace("{{FREE_QUOTA}}", f"{auth.PLANS['free']['monthly_plans']:,}"))
    return HTMLResponse(page, headers={"Cache-Control": "no-cache"})


# --- a free key --------------------------------------------------------------------------

class FreeKeyRequest(BaseModel):
    email: str = Field(..., max_length=200, description="Where to reach you about the key")
    company: str = Field("", max_length=120, description="Who the key is for")


@router.post("/developers/keys")
def free_key(req: FreeKeyRequest, request: Request):
    email = req.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail={"code": "invalid_email", "message": "That does not look like an email address."})
    _SIGNUPS.check("ip:" + _client_ip(request))
    _SIGNUPS_ALL.check("all")
    if store.get(EMAILS, email):
        contact = _contact()
        raise HTTPException(status_code=409, detail={
            "code": "key_exists",
            "message": "A free key was already issued for this address, and keys are shown only once."
                       + (f" Write to {contact} to have it replaced." if contact else ""),
        })
    key, row = auth.issue_key("free", name=req.company.strip(), email=email)
    store.put(EMAILS, email, auth._hash_key(key))
    analytics.track("api_key_issued", request.headers, {"plan": "free"})
    free = auth.PLANS["free"]
    return {
        "api_key": key,
        "key_id": row["key_id"],
        "plan": "free",
        "monthly_plans": free["monthly_plans"],
        "note": "Keep the key somewhere safe: it is not shown again. Send it as 'Authorization: Bearer <key>'.",
    }


# --- the owner's controls -----------------------------------------------------------------

def require_admin(authorization: Optional[str] = Header(None)) -> None:
    token = os.environ.get("CIRCADIAN_ADMIN_TOKEN", "").strip()
    if len(token) < ADMIN_TOKEN_MIN:
        raise HTTPException(status_code=503, detail={
            "code": "admin_not_configured",
            "message": f"Set CIRCADIAN_ADMIN_TOKEN (at least {ADMIN_TOKEN_MIN} random characters) to manage API keys.",
        })
    given = auth._parse_bearer(authorization) or ""
    if not hmac.compare_digest(given.encode(), token.encode()):
        raise HTTPException(status_code=401, detail="Invalid admin token")


class IssueRequest(BaseModel):
    plan: str = "starter"
    name: str = Field("", max_length=120)
    email: str = Field("", max_length=200)


class UpdateRequest(BaseModel):
    plan: Optional[str] = None
    active: Optional[bool] = None


def _with_usage(row: dict) -> dict:
    found = auth.find_key(row["key_id"])
    used = calls_this_month(found[0]) if found else 0
    quota = auth.PLANS.get(row.get("plan"), auth.PLANS["free"])["monthly_plans"]
    return {**row, "used_this_month": used, "monthly_plans": quota}


@router.get("/admin/api-keys", include_in_schema=False, dependencies=[Depends(require_admin)])
def admin_list():
    return {"keys": [_with_usage(r) for r in auth.list_keys()], "plans": auth.PLANS}


@router.post("/admin/api-keys", include_in_schema=False, dependencies=[Depends(require_admin)])
def admin_issue(req: IssueRequest):
    key, row = auth.issue_key(req.plan, name=req.name, email=req.email)
    return {"api_key": key, **row}


@router.post("/admin/api-keys/{key_id}", include_in_schema=False, dependencies=[Depends(require_admin)])
def admin_update(key_id: str, req: UpdateRequest):
    row = auth.update_key(key_id, plan=req.plan, active=req.active)
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "no_such_key", "message": f"No key starts with {key_id!r}."})
    return _with_usage(row)
