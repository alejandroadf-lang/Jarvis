---
name: building-a-python-api
description: How this company builds a small production HTTP API in Python — layout, FastAPI conventions, config, errors, Docker and CI — so every venture doesn't reinvent it.
agents: [engineering_lead, solutions_architect, cto, qa_engineer]
---

# Building a Python API

Defaults for a small, real, deployable service. Deviate when there's a
reason; don't deviate by accident.

## Stack

**FastAPI + uvicorn.** The generated OpenAPI docs mean "a documented API
contract" is satisfied by the code rather than by a document that drifts
from it. **Pydantic** models for request and response — validation and the
schema come from the same definition.

**No database until something needs to persist.** A stateless service is
one fewer thing to run, back up and get wrong. Most v1 APIs that compute an
answer from their input need nothing.

## Layout

```
src/
  main.py          # app, routes, nothing else
  models.py        # Pydantic request/response models
  engine.py        # the actual logic — no framework imports
  auth.py          # key verification
  config.py        # settings from env, with defaults
tests/
  test_engine.py   # the logic, directly, no HTTP
  test_api.py      # routes, via TestClient
Dockerfile
requirements.txt   # pinned: fastapi==0.115.0, not fastapi
API_CONTRACT.md
.github/workflows/ci.yml
```

**The engine imports no framework.** That's what makes it testable without
spinning up an app, and it's the difference between a test suite that runs
in a second and one nobody waits for.

## Routes

Thin. Parse, call the engine, return. Any logic that appears in a route
handler belongs in the engine where it can be tested directly.

```python
@app.post("/v1/plan", response_model=PlanResponse)
def create_plan(req: PlanRequest, _: str = Depends(require_api_key)):
    return plan_shift(req)
```

Version from the first release (`/v1/...`). Adding a version later means
breaking everyone who integrated before you did.

## Errors

Return a shape, not a string. One consistent envelope, documented in the
contract:

```json
{ "error": { "code": "unknown_timezone", "message": "…", "field": "origin" } }
```

`422` for validation (FastAPI's default), `401` for a bad key, `429` over
the rate limit, `500` only for genuine bugs. An error message says what to
do differently — never leak a stack trace, a file path, or a key.

## Configuration

Everything environment-dependent comes from env with a sane default, read
in `config.py`. **No secret is ever a literal in source.** A key committed
to a repo is a key that has to be rotated, and public history keeps it
forever.

Beware the blank-variable trap: `int(os.environ.get("LIMIT", "") or 60)` —
an unset variable must not silently become `0`. Treat empty as absent.

## Dockerfile

Slim base, pinned deps, non-root user, and the app on `$PORT`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/
RUN useradd -m app && chown -R app /app
USER app
CMD uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-8000}
```

## CI

`.github/workflows/ci.yml` with `workflow_dispatch:` — without that trigger
`run_checks` has nothing to run. Keep the first one to install, lint, test.
A CI file that tries to do everything fails for reasons unrelated to the
code, and then gets ignored.

## Order to build in

1. `engine.py` and its tests — the part that is actually the product
2. `models.py`, then the routes
3. `auth.py` and rate limiting
4. `API_CONTRACT.md`, Dockerfile
5. CI, then `run_checks`

One file per turn (see `sizing-work-for-a-turn`), and the engine first so
that if the run stops early, what landed is the valuable half.
