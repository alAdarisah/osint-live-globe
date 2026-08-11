"""/api/vessel/{mmsi} and its port-card sibling /api/vessel/port/{port_id}.

Task 17 wires up the card Task 14 (identity), Task 15 (port_calls.py's
vessel_port_calls) and Task 16 (vessel_profile.py's vessel_profiles) already
have data for, but nothing served yet. These tests follow test_water_endpoint.py's
style: call the endpoint function directly and monkeypatch storage to a fake
in-memory backing, rather than standing up Postgres.

What they hold the line on: the 404 shape when an MMSI is entirely unknown,
the response shape when every piece is present, port_id -> name/country
resolution (curated list first, World Port Index second), and -- the one a
regression here would be silent about -- that the handler never reads
entity_history. A vessel card that quietly grew an entity_history query would
still work in every manual check; it would just cost 11 GB of table scan on
every click, which is exactly the failure global-constraints.md's
performance rule exists to catch before it ships.
"""

import asyncio

import pytest
from fastapi import HTTPException

from backend import app as app_mod

MMSI = "244660724"


def _run(coro):
    return asyncio.run(coro)


IDENTITY = {"mmsi": MMSI, "name": "MV Test Hull", "ship_type": 80}

PROFILE = {
    "mmsi": MMSI,
    "cargo_class": "tanker",
    "cargo_class_basis": "derived",
    "laden_state": "laden",
    "laden_state_basis": "inferred",
    "laden_state_reason": None,
    "draught_current": 14.2,
    "draught_max_seen": 14.5,
    "draught_min_seen": 8.1,
    "sample_count": 12,
    "laden_threshold": 0.85,
    "ballast_threshold": 0.55,
    "min_sample_threshold": 5,
    "implied_trade": "Implied only from AIS, not a cargo manifest: ... No commodity is asserted.",
    "inferred": True,
    "updated": 1_700_000_000.0,
}

PORT_CALL = {
    "mmsi": MMSI, "port_id": "curated-port", "arrived_at": 1_699_000_000.0,
    "departed_at": 1_699_010_000.0, "draught_in": 14.3, "draught_out": 9.9,
    "confidence": "exact",
}

OPEN_CALL = {
    "mmsi": MMSI, "port_id": "wpi-port", "arrived_at": 1_700_500_000.0,
    "departed_at": None, "draught_in": 13.0, "draught_out": None,
    "confidence": "proximity",
}

CURATED_PORT = {"id": "curated-port", "type": "port", "name": "Curated Harbour", "country": "Testland"}
WPI_PORT = {"id": "wpi-port", "name": "WPI Harbour", "country": "Otherland"}


@pytest.fixture
def stubbed(monkeypatch):
    """Every storage call the handler is allowed to make, wired to fixed
    fixtures, plus a record of what was asked for -- used both to assert the
    happy-path shape and, in the no-entity_history tests below, to prove the
    forbidden calls were never reached."""
    calls = []

    async def entity_latest_one(kind, entity_id):
        calls.append(("entity_latest_one", kind, str(entity_id)))
        if kind == "ais" and str(entity_id) == MMSI:
            return dict(IDENTITY)
        if kind == "ports" and str(entity_id) == "wpi-port":
            return dict(WPI_PORT)
        return None

    async def reference(name):
        calls.append(("reference", name))
        if name == "vessel_profiles":
            return {MMSI: dict(PROFILE)}
        return None

    async def port_calls_for(mmsi, limit=20):
        calls.append(("port_calls_for", str(mmsi), limit))
        return [dict(PORT_CALL)] if str(mmsi) == MMSI else []

    async def open_port_call(mmsi):
        calls.append(("open_port_call", str(mmsi)))
        return dict(OPEN_CALL) if str(mmsi) == MMSI else None

    async def port_calls_at(port_id, limit=50):
        calls.append(("port_calls_at", str(port_id), limit))
        return [dict(PORT_CALL)] if str(port_id) == "curated-port" else []

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", entity_latest_one)
    monkeypatch.setattr(app_mod.storage, "reference", reference)
    monkeypatch.setattr(app_mod.storage, "port_calls_for", port_calls_for)
    monkeypatch.setattr(app_mod.storage, "open_port_call", open_port_call)
    monkeypatch.setattr(app_mod.storage, "port_calls_at", port_calls_at)
    monkeypatch.setattr(app_mod.infrastructure, "INFRA_SITES", [CURATED_PORT])
    return calls


def _forbid_entity_history(monkeypatch):
    """entity_history is ~11 GB and a request path must never open it (see
    global-constraints.md). Wiring these to fail loudly turns a regression
    that added such a call into a test failure instead of a silent table
    scan on every card open.

    All five of storage.py's entity_history readers are covered here, not
    just the three this handler happens to be nowhere near today
    (entity_history_since, entity_track, history_at) -- position_gaps and
    airfield_activity read the same table and are exactly the shape a future
    "gaps in AIS coverage" fold on this same card would reach for. Listing
    all five is what keeps this test proving the rule instead of just
    describing today's implementation.
    """

    async def _forbidden(*args, **kwargs):
        raise AssertionError("a per-request handler must not read entity_history")

    for name in ("entity_history_since", "entity_track", "history_at", "position_gaps", "airfield_activity"):
        monkeypatch.setattr(app_mod.storage, name, _forbidden)


# --- /api/vessel/{mmsi} -----------------------------------------------------


def test_unknown_mmsi_is_404(monkeypatch):
    async def empty_one(kind, entity_id):
        return None

    async def empty_ref(name):
        return None

    async def empty_calls(mmsi, limit=20):
        return []

    async def empty_open(mmsi):
        return None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", empty_one)
    monkeypatch.setattr(app_mod.storage, "reference", empty_ref)
    monkeypatch.setattr(app_mod.storage, "port_calls_for", empty_calls)
    monkeypatch.setattr(app_mod.storage, "open_port_call", empty_open)

    with pytest.raises(HTTPException) as raised:
        _run(app_mod.vessel_detail("999999999"))
    assert raised.value.status_code == 404
    assert "999999999" in raised.value.detail


def test_full_shape_carries_identity_profile_calls_and_open_call(stubbed):
    body = _run(app_mod.vessel_detail(MMSI))

    assert body["identity"] == IDENTITY
    assert body["profile"] == PROFILE

    assert len(body["port_calls"]) == 1
    call = body["port_calls"][0]
    assert call["mmsi"] == MMSI
    assert call["confidence"] == "exact"
    # Resolved from the curated list (INFRA_SITES), not the World Port Index.
    assert call["port_name"] == "Curated Harbour"
    assert call["port_country"] == "Testland"

    assert body["open_call"]["port_id"] == "wpi-port"
    # This one isn't curated, so it falls back to the World Port Index lookup
    # via storage.entity_latest_one("ports", ...).
    assert body["open_call"]["port_name"] == "WPI Harbour"
    assert body["open_call"]["port_country"] == "Otherland"

    # The distance a `confidence` value stands for travels with the response
    # -- vessel_port_calls itself only stores the tier (see port_calls.py's
    # _classify), so this is the one place a reader can see what "exact" or
    # "proximity" actually means in kilometres.
    assert body["confidence_radius_km"]["exact"] == 3.0
    assert body["confidence_radius_km"]["proximity"] == 15.0
    assert body["confidence_radius_km"]["inferred"] == 50.0


def test_a_hull_with_only_a_profile_and_no_live_position_is_not_404(stubbed, monkeypatch):
    # A hull can go dark (transponder off) and still carry a profile --
    # vessel_profile.py's own docstring says laden_state decays to
    # insufficient_samples rather than the record vanishing. identity being
    # None must not itself be a 404 as long as something else is known.
    async def no_identity(kind, entity_id):
        if kind == "ais":
            return None
        return None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", no_identity)
    body = _run(app_mod.vessel_detail(MMSI))
    assert body["identity"] is None
    assert body["profile"] == PROFILE


def test_a_hull_with_no_profile_yet_is_not_404_when_it_has_port_calls(stubbed, monkeypatch):
    async def no_profile(name):
        return None

    monkeypatch.setattr(app_mod.storage, "reference", no_profile)
    body = _run(app_mod.vessel_detail(MMSI))
    assert body["profile"] is None
    assert len(body["port_calls"]) == 1


def test_handler_never_touches_entity_history(stubbed, monkeypatch):
    _forbid_entity_history(monkeypatch)
    body = _run(app_mod.vessel_detail(MMSI))
    assert body["identity"] == IDENTITY


def test_404_path_never_touches_entity_history_either(monkeypatch):
    async def empty_one(kind, entity_id):
        return None

    async def empty_ref(name):
        return None

    async def empty_calls(mmsi, limit=20):
        return []

    async def empty_open(mmsi):
        return None

    monkeypatch.setattr(app_mod.storage, "entity_latest_one", empty_one)
    monkeypatch.setattr(app_mod.storage, "reference", empty_ref)
    monkeypatch.setattr(app_mod.storage, "port_calls_for", empty_calls)
    monkeypatch.setattr(app_mod.storage, "open_port_call", empty_open)
    _forbid_entity_history(monkeypatch)

    with pytest.raises(HTTPException):
        _run(app_mod.vessel_detail("000000000"))


# --- /api/vessel/port/{port_id} ---------------------------------------------


def test_port_calls_endpoint_shape_and_vessel_name(stubbed):
    body = _run(app_mod.vessel_port_calls("curated-port"))
    assert body["port_id"] == "curated-port"
    assert len(body["port_calls"]) == 1
    row = body["port_calls"][0]
    assert row["mmsi"] == MMSI
    assert row["confidence"] == "exact"
    assert row["vessel_name"] == "MV Test Hull"


def test_port_with_no_traffic_is_an_empty_list_not_an_error(stubbed):
    body = _run(app_mod.vessel_port_calls("nowhere"))
    assert body["port_id"] == "nowhere"
    assert body["port_calls"] == []
    assert body["confidence_radius_km"]["exact"] == 3.0


def test_port_endpoint_never_touches_entity_history(stubbed, monkeypatch):
    _forbid_entity_history(monkeypatch)
    _run(app_mod.vessel_port_calls("curated-port"))
