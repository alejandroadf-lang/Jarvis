"""
Flight-number lookup (flights.py and GET /app/flight). The network is replaced;
the response is shaped like AeroDataBox's flight status by number: a list of
legs, each with departure and arrival, an airport carrying its IANA timeZone,
and scheduledTime/revisedTime as {"utc": "2026-10-06 12:05Z", "local": ...}.
"""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from src import flights
from src.app import app

client = TestClient(app)


def movement(iata, city, tz, utc, revised=None, name=None):
    m = {"airport": {"iata": iata, "icao": "X" + iata, "name": name or f"{city} Airport", "shortName": name,
                     "municipalityName": city, "timeZone": tz},
         # The local string is deliberately wrong: the code must use utc + timeZone.
         "scheduledTime": {"utc": utc, "local": "1999-01-01 00:00+00:00"}}
    if revised:
        m["revisedTime"] = {"utc": revised, "local": "1999-01-01 00:00+00:00"}
    return m


def leg(number, dep, arr, **extra):
    return {"number": number, "status": "Expected", "codeshareStatus": "IsOperator", "isCargo": False,
            "airline": {"name": "Qantas"}, "aircraft": {"model": "Airbus A380"},
            "departure": dep, "arrival": arr, **extra}


# QF1: Sydney -> Singapore -> London, both legs under one number, plus noise.
SYD_SIN = leg("QF 1", movement("SYD", "Sydney", "Australia/Sydney", "2026-10-06 05:45Z"),
              movement("SIN", "Singapore", "Asia/Singapore", "2026-10-06 13:55Z"))
SIN_LHR = leg("QF 1", movement("SIN", "Singapore", "Asia/Singapore", "2026-10-06 15:20Z", revised="2026-10-06 15:50Z"),
              movement("LHR", "London", "Europe/London", "2026-10-06 04:30Z".replace("06 04", "07 04")))
CARGO = leg("QF 1", movement("SYD", "Sydney", "Australia/Sydney", "2026-10-06 01:00Z"),
            movement("MEL", "Melbourne", "Australia/Melbourne", "2026-10-06 02:30Z"), isCargo=True)
NO_ZONE = leg("QF 1", {"airport": {"iata": "ZZZ"}, "scheduledTime": {"utc": "2026-10-06 03:00Z"}},
              movement("MEL", "Melbourne", "Australia/Melbourne", "2026-10-06 04:30Z"))


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    flights._reset_for_tests()
    monkeypatch.setenv("AERODATABOX_API_KEY", ' "adb-test-key" ')
    monkeypatch.delenv("AERODATABOX_VIA", raising=False)
    calls = []

    def fake(url, headers):
        calls.append((url, headers))
        return fake.status, fake.body

    fake.status, fake.body = 200, [SIN_LHR, CARGO, SYD_SIN, NO_ZONE, SYD_SIN]
    monkeypatch.setattr(flights, "_http", fake)
    yield fake, calls
    flights._reset_for_tests()


def test_legs_come_back_in_flying_order_on_each_airports_clock(configured):
    out = flights.lookup("qf 1", date(2026, 10, 6))
    assert out["number"] == "QF1" and out["source"] == "AeroDataBox"
    legs = out["legs"]
    assert [(l["departure"]["iata"], l["arrival"]["iata"]) for l in legs] == [("SYD", "SIN"), ("SIN", "LHR")], \
        "cargo, a leg with no time zone, and the duplicate are left out"
    first, second = legs
    # 05:45Z is 16:45 in Sydney (AEDT, +11 in October); 13:55Z is 21:55 in Singapore (+8).
    assert first["departure"]["local"] == "2026-10-06T16:45" and first["departure"]["tz"] == "Australia/Sydney"
    assert first["arrival"]["local"] == "2026-10-06T21:55" and first["minutes"] == 490
    # A revised departure wins over the schedule, and says so.
    assert second["departure"]["local"] == "2026-10-06T23:50" and second["departure"]["revised"] is True
    # 04:30Z on the 7th is 05:30 in London (BST).
    assert second["arrival"]["local"] == "2026-10-07T05:30" and second["arrival"]["city"] == "London"


def test_the_request_is_the_flight_on_its_departure_date_with_the_marketplace_header(configured):
    fake, calls = configured
    flights.lookup("QF1", date(2026, 10, 6))
    url, headers = calls[0]
    assert url == ("https://prod.api.market/api/v1/aedbx/aerodatabox/flights/number/QF1/2026-10-06"
                   "?withAircraftImage=false&withLocation=false&dateLocalRole=Departure")
    assert headers == {"x-api-market-key": "adb-test-key"}, "quotes and spaces pasted with the key are dropped"


def test_a_rapidapi_key_goes_to_rapidapi(configured, monkeypatch):
    fake, calls = configured
    monkeypatch.setenv("AERODATABOX_VIA", "RapidAPI")
    flights.lookup("QF1", date(2026, 10, 6))
    url, headers = calls[0]
    assert url.startswith("https://aerodatabox.p.rapidapi.com/flights/number/QF1/2026-10-06?")
    assert headers == {"X-RapidAPI-Key": "adb-test-key", "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com"}


def test_the_same_flight_and_date_is_asked_for_once(configured):
    fake, calls = configured
    flights.lookup("QF1", date(2026, 10, 6))
    flights.lookup("qf-1", date(2026, 10, 6))
    assert len(calls) == 1
    flights.lookup("QF1", date(2026, 10, 7))
    assert len(calls) == 2


def test_lookups_stop_at_the_daily_ceiling(configured, monkeypatch):
    monkeypatch.setattr(flights, "LOOKUPS_PER_DAY", 2)
    flights.lookup("QF1", date(2026, 10, 6))
    flights.lookup("QF2", date(2026, 10, 6))
    with pytest.raises(flights.LookupFailed) as err:
        flights.lookup("QF3", date(2026, 10, 6))
    assert err.value.status == 429 and "type the times" in str(err.value).lower()
    # A cached flight is still answered.
    assert flights.lookup("QF1", date(2026, 10, 6))["number"] == "QF1"


@pytest.mark.parametrize("raw", ["", "Q", "London", "QF 12345", "12"])
def test_a_non_flight_number_is_refused_before_any_call(configured, raw):
    fake, calls = configured
    with pytest.raises(flights.LookupFailed) as err:
        flights.lookup(raw, date(2026, 10, 6))
    assert err.value.status == 400 and calls == []


@pytest.mark.parametrize("status,body,code,words", [
    (204, None, 404, "No flight QF1 leaving on Tue 6 Oct 2026"),
    (200, [], 404, "Check the number and the date"),
    (401, {"message": "Invalid API key"}, 502, "refused this server's key"),
    (429, None, 429, "monthly allowance is used up"),
    (0, None, 502, "did not answer"),
])
def test_each_failure_says_what_to_do(configured, status, body, code, words):
    fake, _ = configured
    fake.status, fake.body = status, body
    with pytest.raises(flights.LookupFailed) as err:
        flights.lookup("QF1", date(2026, 10, 6))
    assert err.value.status == code and words in str(err.value)


def test_without_a_key_the_route_names_the_variable_and_the_page_hides_the_field(monkeypatch):
    monkeypatch.delenv("AERODATABOX_API_KEY", raising=False)
    assert client.get("/app/flight/status").json() == {"configured": False}
    res = client.get("/app/flight", params={"number": "QF1", "date": "2026-10-06"})
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "lookup_not_configured"
    assert "AERODATABOX_API_KEY" in res.json()["error"]["message"]


def test_the_route_returns_the_legs_and_refusals_in_the_apps_error_shape(configured):
    assert client.get("/app/flight/status").json() == {"configured": True}
    ok = client.get("/app/flight", params={"number": "QF 1", "date": "2026-10-06"})
    assert ok.status_code == 200 and len(ok.json()["legs"]) == 2
    bad = client.get("/app/flight", params={"number": "London", "date": "2026-10-06"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_flight_number"
    assert client.get("/app/flight", params={"number": "QF1", "date": "not-a-date"}).status_code == 422


def test_the_ceiling_keeps_the_free_tier_for_the_whole_month_and_a_paid_tier_can_raise_it(configured, monkeypatch):
    # 600 free lookups a month; the old 150 a day spent them in four days.
    monkeypatch.delenv("AERODATABOX_LOOKUPS_PER_DAY", raising=False)
    assert flights.lookups_per_day() * 30 <= 600
    monkeypatch.setenv("AERODATABOX_LOOKUPS_PER_DAY", "200")
    assert flights.lookups_per_day() == 200
    for bad in ("0", "-3", "lots"):
        monkeypatch.setenv("AERODATABOX_LOOKUPS_PER_DAY", bad)
        assert flights.lookups_per_day() == flights.LOOKUPS_PER_DAY
