"""GET /api/aircraft/{icao24} -- the aviation twin of test_vessel_endpoint.py.

Task 23 wires up the Route card Task 22 left a place for, fed by Task 1's
flight_legs table and Task 1/refine's flight_legs.py detection job. These
tests follow test_vessel_endpoint.py's own style: call the endpoint function
directly and monkeypatch storage to a fake in-memory backing, rather than
standing up Postgres.

What they hold the line on: the 404 shape when an icao24 is entirely unknown,
the response shape when identity and legs are present, the cargo hint only
firing for a freighter-typed airframe, and -- the one a regression here would
be silent about -- that the handler never reads entity_history. A card that
quietly grew an entity_history query would still work in every manual check;
it would just cost 11 GB of table scan on every click, exactly the failure
global-constraints.md's performance rule exists to catch before it ships.
"""

import asyncio

import pytest
from fastapi import HTTPException

from backend import app as app_mod

ICAO = "a1b2c3"


def _run(coro):
    return asyncio.run(coro)


IDENTITY = {
    "icao24": ICAO, "callsign": "TST123", "type_code": "B763",
    "type_desc": "Boeing 767-300F", "operator": "Cargo Air",
}

LEG = {
    "icao24": ICAO, "departed_at": 1_700_000_000.0, "arrived_at": 1_700_010_000.0,
    "origin_code": "KJFK", "dest_code": "EGLL", "callsign": "TST123",
    "max_alt_ft": 35000, "distance_km": 5500.2, "confidence": "observed_both",
    "last_seen_at": 1_700_010_000.0,
}

OPEN_LEG = {
    "icao24": ICAO, "departed_at": 1_700_500_000.0, "arrived_at": None,
    "origin_code": "EGLL", "dest_code": None, "callsign": "TST123",
    "max_alt_ft": 12000, "distance_km": 400.0, "confidence": "observed_one",
    # backend/refine/flight_legs.py's Task 23 review fix (Important 1) --
    # this is the field that lets a reader tell "still airborne" from "we
    # stopped hearing from this eleven weeks ago" for an open leg.
    "last_seen_at": 1_700_500_300.0,
}


@pytest.fixture
def stubbed(monkeypatch):
    calls = []

    async def entity_latest_one(kind, entity_id):
        calls.append(("entity_latest_one", kind, str(entity_id)))
        if kind == "adsb" and str(entity_id) == ICAO:
            return dict(IDENTITY)
        return None

    async def flight_legs_for(icao24, limit=20):
        calls.append(("flight_legs_for", str(icao24), limit))
        return [dict(LEG)] if str(icao24) == ICAO else []

    async def open_flight_leg(icao24):
        calls.append(("open_flight_leg", str(icao24)))
        return dict(OPEN_LEG) if str(icao24) == ICAO else None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", entity_latest_one)
    monkeypatch.setattr(app_mod.storage, "flight_legs_for", flight_legs_for)
    monkeypatch.setattr(app_mod.storage, "open_flight_leg", open_flight_leg)
    return calls


def _forbid_entity_history(monkeypatch):
    """entity_history is ~11 GB and a request path must never open it (see
    global-constraints.md) -- see test_vessel_endpoint.py's own version of
    this for the full reasoning behind covering every reader, not just the
    ones this handler happens to be nowhere near today."""

    async def _forbidden(*args, **kwargs):
        raise AssertionError("a per-request handler must not read entity_history")

    for name in ("entity_history_since", "entity_track", "history_at", "position_gaps", "airfield_activity"):
        monkeypatch.setattr(app_mod.storage, name, _forbidden)


def test_unknown_icao24_is_404(monkeypatch):
    async def empty_one(kind, entity_id):
        return None

    async def empty_legs(icao24, limit=20):
        return []

    async def empty_open(icao24):
        return None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", empty_one)
    monkeypatch.setattr(app_mod.storage, "flight_legs_for", empty_legs)
    monkeypatch.setattr(app_mod.storage, "open_flight_leg", empty_open)

    with pytest.raises(HTTPException) as raised:
        _run(app_mod.aircraft_detail("ffffff"))
    assert raised.value.status_code == 404
    assert "ffffff" in raised.value.detail


def test_full_shape_carries_identity_legs_current_leg_and_cargo_hint(stubbed):
    body = _run(app_mod.aircraft_detail(ICAO))

    assert body["identity"] == IDENTITY
    assert len(body["legs"]) == 1
    assert body["legs"][0]["confidence"] == "observed_both"
    assert body["current_leg"]["origin_code"] == "EGLL"
    # last_seen_at (Task 23 review, Important 1) passes through untouched --
    # nothing in this handler recomputes it, it is exactly what storage held.
    assert body["current_leg"]["last_seen_at"] == OPEN_LEG["last_seen_at"]

    # Freighter-typed identity + an in-progress leg's origin -> a hint fires,
    # and it says nothing stronger than "suggests freight".
    assert body["cargo_hint"] is not None
    assert "aircraft class suggests freight" in body["cargo_hint"]
    assert "No cargo or commodity is asserted" in body["cargo_hint"]


def test_cargo_hint_is_absent_for_a_non_freighter_type(stubbed, monkeypatch):
    async def passenger_identity(kind, entity_id):
        if kind == "adsb" and str(entity_id) == ICAO:
            return {**IDENTITY, "type_desc": "Boeing 767-300", "type_code": "B763"}
        return None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", passenger_identity)
    body = _run(app_mod.aircraft_detail(ICAO))
    assert body["cargo_hint"] is None


def test_an_airframe_with_only_legs_and_no_live_identity_is_not_404(stubbed, monkeypatch):
    """An airframe can go dark (out of range, transponder off) and still carry
    a flight-leg history -- identity being None must not itself be a 404 as
    long as something else is known, the same rule test_vessel_endpoint.py
    holds for a hull with only a profile."""

    async def no_identity(kind, entity_id):
        return None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", no_identity)
    body = _run(app_mod.aircraft_detail(ICAO))
    assert body["identity"] is None
    assert len(body["legs"]) == 1
    assert body["cargo_hint"] is None  # no identity fields left to read a type from


def test_handler_never_touches_entity_history(stubbed, monkeypatch):
    _forbid_entity_history(monkeypatch)
    body = _run(app_mod.aircraft_detail(ICAO))
    assert body["identity"] == IDENTITY


def test_404_path_never_touches_entity_history_either(monkeypatch):
    async def empty_one(kind, entity_id):
        return None

    async def empty_legs(icao24, limit=20):
        return []

    async def empty_open(icao24):
        return None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", empty_one)
    monkeypatch.setattr(app_mod.storage, "flight_legs_for", empty_legs)
    monkeypatch.setattr(app_mod.storage, "open_flight_leg", empty_open)
    _forbid_entity_history(monkeypatch)

    with pytest.raises(HTTPException):
        _run(app_mod.aircraft_detail("000000"))
