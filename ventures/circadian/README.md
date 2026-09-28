# Circadian

The jet lag app: a plan for sleep, light, caffeine and melatonin around a
flight, with push reminders and WHOOP progress. FastAPI in `src/`, a web app
in `src/web/`.

With `AERODATABOX_API_KEY` set, the trip form looks flights up by number and
fills in the airports and times (`src/flights.py`); without it, times are
typed and a missing landing is estimated from the distance.

This copy is what runs in production. Jarvis starts it and serves it at
`/circadian/` from the same Railway service (see `server/circadian.js` and the
README's "Circadian at /circadian" section). It came from the
`alejandroadf-lang/circadian-api` repository, which can still deploy it on its
own; changes made here are not copied back there.

## Run the tests

```
pip install -r src/requirements.txt pytest httpx
CIRCADIAN_SCHEDULER=off python -m pytest -q src
```

## Run it alone

```
pip install -r src/requirements.txt
python -m uvicorn src.app:app --port 8001
```

The web app uses relative URLs only, so it works at the root of a host or
below a path. A proxy serving it below a path sends that path in
`X-Forwarded-Prefix`, which the WHOOP callback URL and the redirects include.
