"""Departure/arrival legs at their boundaries, and the incremental read they
run on -- the aviation twin of test_port_calls.py.

ADS-B broadcasts no flight plan. What these tests hold the line on is exactly
what counts as "observed" (a real on_ground or altitude transition) versus
"inferred" (an airframe first seen already in the air, with nothing earlier
to compare against), the arithmetic (distance, max altitude) that has to keep
accumulating across an open leg rather than freeze at its first row, and the
cursor discipline a job reading entity_history exactly once has to hold to.
"""

import asyncio
import copy

from backend.refine import flight_legs as fl
from backend.sources.proximity import haversine_km

ICAO = "a1b2c3"


def pos(id_, ts, lat=10.0, lon=20.0, on_ground=None, altitude=None,
        airfield_km=None, airfield_code="TEST", callsign="TST123", icao24=ICAO):
    payload = {"on_ground": on_ground, "altitude": altitude, "callsign": callsign}
    if airfield_km is not None:
        payload["nearest_airfield"] = {
            "name": "Test Field", "code": airfield_code, "km": airfield_km, "military_name": False,
        }
    return {"id": id_, "entity_id": icao24, "ts": ts, "lat": lat, "lon": lon, "payload": payload}


def _run(coro):
    return asyncio.run(coro)


# --- open and close, via the on_ground transition ---------------------------


def test_takeoff_opens_a_leg_still_waiting_on_an_arrival():
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),  # wheels up
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    leg = upserts[0]
    assert leg["icao24"] == ICAO
    assert leg["departed_at"] == 60.0
    assert leg["arrived_at"] is None
    assert leg["origin_code"] == "TEST"
    assert leg["confidence"] == "observed_one"  # departure watched, arrival not (yet)
    assert state[ICAO]["leg"]["departure_observed"] is True


def test_landing_closes_the_leg_and_resolves_both_ends():
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),
        pos(3, 3600.0, on_ground=False, airfield_km=20.0, altitude=8000),  # en route, far from a field
        pos(4, 7200.0, on_ground=True, airfield_km=0.5, altitude=None),   # wheels down
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1  # opened and closed within one batch -- one row, not two
    leg = upserts[0]
    assert leg["departed_at"] == 60.0
    assert leg["arrived_at"] == 7200.0
    assert leg["origin_code"] == "TEST"
    assert leg["dest_code"] == "TEST"
    assert leg["confidence"] == "observed_both"
    assert ICAO not in state or state[ICAO].get("leg") is None


def test_a_leg_spanning_two_batches_still_closes():
    """The two-pass path port_calls' own tests drive directly: a leg opened in
    one apply_positions call must still close in a later call fed the first
    call's own returned state."""
    first = [pos(1, 0.0, on_ground=True, airfield_km=1.0), pos(2, 60.0, on_ground=False, airfield_km=1.0)]
    upserts_1, state_1 = fl.apply_positions(first, {})
    assert len(upserts_1) == 1
    assert state_1[ICAO]["leg"]["arrived_at"] is None

    second = [pos(3, 7200.0, on_ground=True, airfield_km=0.5)]
    upserts_2, state_2 = fl.apply_positions(second, state_1)
    assert len(upserts_2) == 1
    assert upserts_2[0]["departed_at"] == 60.0
    assert upserts_2[0]["arrived_at"] == 7200.0
    assert upserts_2[0]["confidence"] == "observed_both"
    assert ICAO not in state_2 or state_2[ICAO].get("leg") is None


# --- the altitude-threshold path ---------------------------------------------


def test_climbing_through_1500ft_near_a_field_opens_a_leg_without_on_ground():
    """Some transponders never reliably report on_ground=false; the altitude
    crossing near a known field is the fallback signal for those."""
    rows = [
        pos(1, 0.0, on_ground=True, altitude=None, airfield_km=2.0),
        pos(2, 60.0, on_ground=True, altitude=1000.0, airfield_km=2.0),
        pos(3, 120.0, on_ground=True, altitude=2000.0, airfield_km=2.0),  # crosses 1500
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    leg = upserts[0]
    assert leg["departed_at"] == 120.0
    assert leg["confidence"] == "observed_one"
    assert state[ICAO]["leg"]["departure_observed"] is True


def test_descending_through_1500ft_near_a_field_closes_it():
    rows = [
        pos(1, 0.0, on_ground=True, altitude=None, airfield_km=2.0),
        pos(2, 60.0, on_ground=True, altitude=1000.0, airfield_km=2.0),
        pos(3, 120.0, on_ground=True, altitude=2000.0, airfield_km=2.0),    # opens
        pos(4, 3600.0, on_ground=True, altitude=2500.0, airfield_km=30.0),  # cruising past 1500, far from any field
        pos(5, 7200.0, on_ground=True, altitude=800.0, airfield_km=3.0),    # crosses back down, near a field
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    leg = upserts[0]
    assert leg["departed_at"] == 120.0
    assert leg["arrived_at"] == 7200.0
    assert leg["confidence"] == "observed_both"


def test_the_altitude_threshold_is_gated_by_distance_to_a_field():
    """The same crossing 35km from the nearest field is not evidence of a
    departure there -- ALTITUDE_AIRFIELD_RADIUS_KM is deliberately tighter
    than adsb.py's own 40km popup radius (see the module docstring)."""
    rows = [
        pos(1, 0.0, on_ground=True, altitude=1000.0, airfield_km=35.0),
        pos(2, 60.0, on_ground=True, altitude=2000.0, airfield_km=35.0),
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert upserts == []
    assert state.get(ICAO, {}).get("leg") is None


# --- single-ended legs and the confidence values -----------------------------


def test_a_first_row_with_unknown_on_ground_does_not_open_a_phantom_leg():
    """The "inferred" open only fires when on_ground is positively known to
    already be False -- not for a row this defensive about its own fields."""
    rows = [pos(1, 0.0, on_ground=None, altitude=30000.0)]
    upserts, state = fl.apply_positions(rows, {})
    assert upserts == []
    assert state[ICAO].get("leg") is None


def test_an_airframe_first_seen_already_airborne_opens_an_inferred_leg():
    """Nothing was observed departing -- the very first row this job has ever
    read for this airframe already shows it in the air. See the module
    docstring's "inferred" case."""
    rows = [pos(1, 1000.0, on_ground=False, altitude=30000.0)]  # no airfield nearby at cruise
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    leg = upserts[0]
    assert leg["departed_at"] == 1000.0
    assert leg["origin_code"] is None
    assert leg["confidence"] == "inferred"
    assert state[ICAO]["leg"]["departure_observed"] is False


def test_an_inferred_legs_landing_is_observed_one_never_observed_both():
    """The departure genuinely never was observed, however far downstream the
    leg is watched to close -- it can never earn "observed_both"."""
    first = [pos(1, 1000.0, on_ground=False, altitude=30000.0)]
    _upserts_1, state_1 = fl.apply_positions(first, {})
    assert state_1[ICAO]["leg"]["departure_observed"] is False

    second = [pos(2, 5000.0, on_ground=True, airfield_km=1.0)]
    upserts_2, state_2 = fl.apply_positions(second, state_1)
    assert len(upserts_2) == 1
    leg = upserts_2[0]
    assert leg["departed_at"] == 1000.0
    assert leg["arrived_at"] == 5000.0
    assert leg["dest_code"] == "TEST"
    assert leg["confidence"] == "observed_one"
    assert ICAO not in state_2 or state_2[ICAO].get("leg") is None


def test_a_leg_that_never_lands_stays_observed_one_in_state():
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),
    ]
    _upserts, state = fl.apply_positions(rows, {})
    leg = state[ICAO]["leg"]
    assert leg["departure_observed"] is True
    assert leg.get("arrival_observed", False) is False
    assert fl._confidence(leg) == "observed_one"


# --- distance and altitude arithmetic ----------------------------------------


def test_distance_and_max_altitude_accumulate_over_the_whole_open_track():
    p0, p1, p2 = (10.0, 20.0), (10.5, 20.3), (11.0, 20.9)
    rows = [
        pos(1, 0.0, lat=p0[0], lon=p0[1], on_ground=True, airfield_km=1.0),
        pos(2, 60.0, lat=p0[0], lon=p0[1], on_ground=False, altitude=1000.0, airfield_km=1.0),  # opens here
        pos(3, 600.0, lat=p1[0], lon=p1[1], on_ground=False, altitude=15000.0, airfield_km=25.0),
        pos(4, 1200.0, lat=p2[0], lon=p2[1], on_ground=False, altitude=9000.0, airfield_km=25.0),
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1  # still open -- this batch's own "leg is still in progress" write
    leg = upserts[0]
    expected = round(
        haversine_km(p0[0], p0[1], p1[0], p1[1]) + haversine_km(p1[0], p1[1], p2[0], p2[1]), 1
    )
    assert leg["distance_km"] == expected
    # 15000 (row 3), not 9000 (the last row, row 4) -- the running maximum
    # over the whole track, not the most recent reading.
    assert leg["max_alt_ft"] == 15000
    assert leg["confidence"] == "observed_one"


def test_callsign_is_backfilled_from_a_later_row_without_overwriting():
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0, callsign=""),
        pos(2, 60.0, on_ground=False, airfield_km=1.0, callsign=""),   # opens with no callsign yet
        pos(3, 120.0, on_ground=False, altitude=5000.0, airfield_km=25.0, callsign="ABC123"),
        pos(4, 180.0, on_ground=False, altitude=5000.0, airfield_km=25.0, callsign="XYZ999"),
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    # First non-empty callsign wins and is not later replaced by a different one.
    assert upserts[0]["callsign"] == "ABC123"


# --- the cursor: advancing, and never asked twice ----------------------------


class _FakeStorage:
    """Just enough of backend.storage to drive run_once() without Postgres --
    mirrors test_port_calls.py's own _FakeStorage exactly."""

    def __init__(self, rows, write_ok=True):
        self.history = rows
        self.docs = {}
        self.calls = []
        self.leg_batches = []
        self.write_ok = write_ok

    async def entity_history_since(self, kind, after_id, limit):
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        self.docs[name] = payload

    async def record_flight_legs(self, rows):
        self.leg_batches.append(rows)
        return self.write_ok


def test_the_cursor_advances_and_a_second_pass_does_not_reprocess(monkeypatch):
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),
        pos(3, 7200.0, on_ground=True, airfield_km=0.5),
    ]
    fake = _FakeStorage(rows)
    monkeypatch.setattr(fl, "storage", fake)

    first = _run(fl.run_once())
    assert first["read"] == 3
    assert first["ok"] is True
    assert first["legs"] == 1  # opened and closed within this one pass
    assert fake.calls == [0]  # no cursor stored yet -- starts from id 0
    assert fake.docs["flight_legs_cursor"] == {"last_id": 3}

    # Nothing new since the last pass: the second call must ask for
    # everything past id 3, not repeat the first request.
    second = _run(fl.run_once())
    assert second["read"] == 0
    assert fake.calls == [0, 3]


def test_a_pass_with_nothing_new_leaves_the_cursor_untouched(monkeypatch):
    fake = _FakeStorage([
        pos(1, 0.0, on_ground=True, airfield_km=1.0), pos(2, 60.0, on_ground=False, airfield_km=1.0),
    ])
    monkeypatch.setattr(fl, "storage", fake)

    _run(fl.run_once())
    stored_after_first = dict(fake.docs)
    result = _run(fl.run_once())
    assert result == {"read": 0, "legs": 0, "ok": True}
    assert fake.docs == stored_after_first


def test_a_failed_write_holds_the_cursor_back_for_a_retry(monkeypatch):
    """record_flight_legs logging and returning on a Postgres hiccup must not
    read as "succeeded" here -- entity_history is pruned on its own schedule,
    so a batch never durably written would otherwise be gone for good."""
    rows = [pos(1, 0.0, on_ground=True, airfield_km=1.0), pos(2, 60.0, on_ground=False, airfield_km=1.0)]
    fake = _FakeStorage(rows, write_ok=False)
    monkeypatch.setattr(fl, "storage", fake)

    result = _run(fl.run_once())
    assert result["ok"] is False
    assert result["read"] == 2
    assert fake.docs == {}  # nothing durable happened: no cursor, no state document

    # The database recovers; the same batch is offered again, not skipped.
    fake.write_ok = True
    retry = _run(fl.run_once())
    assert retry["ok"] is True
    assert retry["legs"] == 1
    assert fake.calls == [0, 0]  # both passes started from the same cursor
    assert fake.docs["flight_legs_cursor"] == {"last_id": 2}


def test_apply_positions_does_not_mutate_the_state_it_was_given():
    original = {ICAO: {"leg": {
        "departed_at": 0.0, "departure_observed": True, "origin_code": "TEST",
        "callsign": None, "max_alt_ft": 1000.0, "distance_km": 0.0,
        "last_lat": 10.0, "last_lon": 20.0, "arrived_at": None, "dest_code": None,
        "arrival_observed": False,
    }}}
    frozen = copy.deepcopy(original)

    rows = [pos(1, 60.0, lat=10.1, lon=20.1, on_ground=False, altitude=5000.0, airfield_km=25.0)]
    fl.apply_positions(rows, original)

    assert original == frozen


# --- aircraft cargo hint: "aircraft class suggests freight", nothing more ---


def test_cargo_hint_is_none_for_an_ordinary_passenger_type():
    assert fl.aircraft_cargo_hint("B738", "Boeing 737-800", "Test Air", "TEST", "OTHER") is None


def test_cargo_hint_is_none_when_only_a_bare_type_code_is_known():
    """type_code alone is rarely distinguishing -- ICAO's own designators
    mostly share one code between a freighter and its passenger sibling (e.g.
    B763 covers both the 767-300F and the passenger 767-300). No signal here
    means no hint, honestly, rather than a guess from the code alone."""
    assert fl.aircraft_cargo_hint("B763", None, None, None, None) is None


def test_cargo_hint_fires_on_a_freighter_type_desc_suffix():
    hint = fl.aircraft_cargo_hint("B763", "Boeing 767-300F", "Cargo Air", "KJFK", "EGLL")
    assert hint is not None
    assert "aircraft class suggests freight" in hint
    assert "No cargo or commodity is asserted" in hint
    assert "Boeing 767-300F" in hint
    assert "Cargo Air" in hint
    assert "KJFK to EGLL" in hint


def test_cargo_hint_fires_on_the_word_freighter():
    hint = fl.aircraft_cargo_hint(None, "Douglas DC-8 Freighter", None, None, None)
    assert hint is not None
    assert "aircraft class suggests freight" in hint


def test_cargo_hint_never_asserts_a_route_it_does_not_have():
    hint = fl.aircraft_cargo_hint(None, "Boeing 747-8F", "Cargo Co", None, None)
    assert hint is not None
    assert "tracked" not in hint

    hint_one_end = fl.aircraft_cargo_hint(None, "Boeing 747-8F", None, "KJFK", None)
    assert "tracked via KJFK" in hint_one_end
