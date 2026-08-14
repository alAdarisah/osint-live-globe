"""Departure/arrival legs at their boundaries, and the incremental read they
run on -- the aviation twin of test_port_calls.py.

ADS-B broadcasts no flight plan. What these tests hold the line on is exactly
what counts as "observed" (a real on_ground or altitude transition) versus
"inferred" (an airframe first seen already in the air, with nothing earlier
to compare against), the arithmetic (distance, max altitude) that has to keep
accumulating across an open leg rather than freeze at its first row, the
cursor discipline a job reading entity_history exactly once has to hold to,
and -- Task 23 review, Critical -- that a coverage gap is never mistaken for
continuous tracking (see the "resumption after a gap" section below).

Rows meant to represent a genuinely continuously-tracked flight are spaced
well under COVERAGE_GAP_SECONDS (30 minutes) apart, the same way real
entity_history rows for an airborne aircraft would be -- this matters now in
a way it did not before the review fix: a gap wider than that bound is no
longer treated as "the previous reading", so a fixture using an unrealistic
multi-hour gap to mean "later in the same flight" would silently exercise the
abandonment path instead of the path it claims to test.
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
        pos(3, 960.0, on_ground=False, airfield_km=20.0, altitude=8000),  # en route, far from a field
        pos(4, 1860.0, on_ground=True, airfield_km=0.5, altitude=None),   # wheels down
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1  # opened and closed within one batch -- one row, not two
    leg = upserts[0]
    assert leg["departed_at"] == 60.0
    assert leg["arrived_at"] == 1860.0
    assert leg["origin_code"] == "TEST"
    assert leg["dest_code"] == "TEST"
    assert leg["confidence"] == "observed_both"
    assert ICAO not in state or state[ICAO].get("leg") is None


def test_a_leg_spanning_two_batches_still_closes():
    """The two-pass path port_calls' own tests drive directly: a leg opened in
    one apply_positions call must still close in a later call fed the first
    call's own returned state. The batch boundary is a row-count limit
    (BATCH_LIMIT), not a time limit -- unlike the dedicated gap tests below,
    nothing here should be far enough apart in wall-clock time to trip
    COVERAGE_GAP_SECONDS."""
    first = [pos(1, 0.0, on_ground=True, airfield_km=1.0), pos(2, 60.0, on_ground=False, airfield_km=1.0)]
    upserts_1, state_1 = fl.apply_positions(first, {})
    assert len(upserts_1) == 1
    assert state_1[ICAO]["leg"]["arrived_at"] is None

    second = [pos(3, 900.0, on_ground=True, airfield_km=0.5)]
    upserts_2, state_2 = fl.apply_positions(second, state_1)
    assert len(upserts_2) == 1
    assert upserts_2[0]["departed_at"] == 60.0
    assert upserts_2[0]["arrived_at"] == 900.0
    assert upserts_2[0]["confidence"] == "observed_both"
    assert ICAO not in state_2 or state_2[ICAO].get("leg") is None


# --- resumption after a coverage gap (Task 23 review, Critical) -------------


def test_a_gap_past_the_coverage_bound_abandons_the_open_leg_rather_than_closing_it():
    """The critical case from the review: an airframe that departs, goes dark
    for a long time, and resurfaces on the ground somewhere else must not
    have that whole blackout counted as continuous coverage. The resumption
    is not an observed arrival -- nothing about it should be written at all,
    let alone as observed_both."""
    first = [pos(1, 0.0, on_ground=True, airfield_km=1.0), pos(2, 60.0, on_ground=False, airfield_km=1.0)]
    upserts_1, state_1 = fl.apply_positions(first, {})
    assert upserts_1[0]["confidence"] == "observed_one"

    thirty_days_later = 60.0 + 30 * 24 * 3600
    second = [pos(3, thirty_days_later, lat=40.0, lon=-70.0, on_ground=True, airfield_km=0.5)]
    upserts_2, state_2 = fl.apply_positions(second, state_1)

    # Nothing closes the old leg -- it is simply abandoned. Its last durably
    # written state (from pass one: open, observed_one, no arrival) stands.
    assert upserts_2 == []
    assert state_2[ICAO].get("leg") is None


def test_a_gap_past_the_coverage_bound_does_not_let_a_resumed_leg_inherit_the_old_ones_distance():
    """A resumption row that is itself airborne *can* open a brand new leg --
    that is fine and expected (see the "inferred" case) -- but it must start
    from zero, not from wherever the abandoned leg's own track left off, and
    it must not silently inherit the old leg's departure_observed=True."""
    first = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),
        pos(3, 960.0, lat=10.5, lon=20.5, on_ground=False, altitude=5000.0, airfield_km=25.0),
    ]
    _upserts_1, state_1 = fl.apply_positions(first, {})
    assert state_1[ICAO]["leg"]["distance_km"] > 0  # some track accumulated before the gap

    thirty_days_later = 960.0 + 30 * 24 * 3600
    second = [pos(4, thirty_days_later, lat=40.0, lon=-70.0, on_ground=False, altitude=30000.0)]
    upserts_2, state_2 = fl.apply_positions(second, state_1)

    # One upsert -- the fresh leg's own opening progress write, the same as
    # any newly opened leg gets (see test_takeoff_opens_a_leg_...) -- not the
    # abandoned one, which writes nothing here at all.
    assert len(upserts_2) == 1
    fresh = upserts_2[0]
    assert fresh["departed_at"] == thirty_days_later
    assert fresh["distance_km"] == 0.0  # not the thirty-day hop from the old leg's last position
    assert fresh["confidence"] == "inferred"  # genuinely not observed departing
    assert state_2[ICAO]["leg"]["departure_observed"] is False


def test_a_gap_just_inside_the_coverage_bound_is_still_treated_as_continuous():
    """The bound is a real cutoff, not a hair-trigger -- a gap just under
    COVERAGE_GAP_SECONDS must behave exactly as before this review fix."""
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),
        pos(3, 60.0 + fl.COVERAGE_GAP_SECONDS - 1, on_ground=True, airfield_km=0.5),
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    assert upserts[0]["confidence"] == "observed_both"


# --- last_seen_at (Task 23 review, Important 1) ------------------------------


def test_last_seen_at_tracks_the_most_recent_row_that_touched_the_leg():
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),   # opens -- last_seen_at starts here
        pos(3, 600.0, on_ground=False, altitude=5000.0, airfield_km=25.0),  # still open -- advances
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1  # still open -- this pass's own progress write
    assert upserts[0]["last_seen_at"] == 600.0
    assert state[ICAO]["leg"]["last_seen_at"] == 600.0


def test_last_seen_at_is_the_closing_rows_own_timestamp():
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),
        pos(3, 900.0, on_ground=True, airfield_km=0.5),  # closes
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert upserts[0]["last_seen_at"] == 900.0


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
        pos(4, 1020.0, on_ground=True, altitude=2500.0, airfield_km=30.0),  # cruising past 1500, far from any field
        pos(5, 1920.0, on_ground=True, altitude=800.0, airfield_km=3.0),    # crosses back down, near a field
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    leg = upserts[0]
    assert leg["departed_at"] == 120.0
    assert leg["arrived_at"] == 1920.0
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


# --- altitude hysteresis (Task 23 review, Minor) -----------------------------


def test_altitude_oscillating_within_the_hysteresis_band_does_not_open_a_leg():
    """A reading wobbling either side of the plain 1,500 ft line -- but never
    clearing ALTITUDE_HYSTERESIS_FT past it -- must not toggle departure on
    every crossing. Every other altitude test in this file crosses
    monotonically once; this one does not cross cleanly at all."""
    rows = [
        pos(1, 0.0, on_ground=True, altitude=None, airfield_km=2.0),
        pos(2, 60.0, on_ground=True, altitude=1000.0, airfield_km=2.0),   # establishes "below"
        pos(3, 120.0, on_ground=True, altitude=1600.0, airfield_km=2.0),  # inside the band -- still "below"
        pos(4, 180.0, on_ground=True, altitude=1400.0, airfield_km=2.0),  # back down, unsurprising
        pos(5, 240.0, on_ground=True, altitude=1620.0, airfield_km=2.0),  # inside the band again -- still "below"
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert upserts == []
    assert state[ICAO].get("leg") is None


def test_altitude_clearing_the_far_side_of_the_hysteresis_band_still_opens():
    """The hysteresis band has a far side -- a reading that actually clears
    it still opens a leg, same as before this review fix."""
    rows = [
        pos(1, 0.0, on_ground=True, altitude=None, airfield_km=2.0),
        pos(2, 60.0, on_ground=True, altitude=1000.0, airfield_km=2.0),   # "below"
        pos(3, 120.0, on_ground=True, altitude=1600.0, airfield_km=2.0),  # inside the band -- no toggle
        pos(4, 180.0, on_ground=True, altitude=1700.0, airfield_km=2.0),  # clears the far side -- genuine departure
    ]
    upserts, state = fl.apply_positions(rows, {})
    assert len(upserts) == 1
    assert upserts[0]["departed_at"] == 180.0


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

    second = [pos(2, 1900.0, on_ground=True, airfield_km=1.0)]
    upserts_2, state_2 = fl.apply_positions(second, state_1)
    assert len(upserts_2) == 1
    leg = upserts_2[0]
    assert leg["departed_at"] == 1000.0
    assert leg["arrived_at"] == 1900.0
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
    mirrors test_port_calls.py's own _FakeStorage exactly, including
    `fail_names` for failing only the named reference_snapshots write (see
    test_a_failed_state_write_holds_the_cursor_back_and_does_not_double_the_
    open_leg below, the aviation twin of test_port_calls.py's own equivalent)."""

    def __init__(self, rows, write_ok=True, fail_names=frozenset()):
        self.history = rows
        self.docs = {}
        self.calls = []
        self.leg_batches = []
        self.write_ok = write_ok
        self.fail_names = set(fail_names)

    async def entity_history_since(self, kind, after_id, limit):
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        if not self.write_ok or name in self.fail_names:
            return False
        self.docs[name] = payload
        return True

    async def record_flight_legs(self, rows):
        self.leg_batches.append(rows)
        return self.write_ok


def test_the_cursor_advances_and_a_second_pass_does_not_reprocess(monkeypatch):
    rows = [
        pos(1, 0.0, on_ground=True, airfield_km=1.0),
        pos(2, 60.0, on_ground=False, airfield_km=1.0),
        pos(3, 900.0, on_ground=True, airfield_km=0.5),
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


def test_a_failed_state_write_holds_the_cursor_back_and_does_not_double_the_open_leg(monkeypatch):
    """Pre-merge review, Critical: the aviation twin of test_port_calls.py's
    own equivalent test. record_flight_legs durably wrote the open leg, but
    the state document write that follows it failed on its own -- the old
    code discarded that bool and wrote the cursor anyway, which lost the only
    durable record that this airframe already has an open leg. The next
    transition this icao24 makes would then open a second, unrelated leg
    rather than ever closing the first one."""
    rows = [pos(1, 0.0, on_ground=True, airfield_km=1.0), pos(2, 60.0, on_ground=False, airfield_km=1.0)]
    fake = _FakeStorage(rows, fail_names={fl.STATE_NAME})
    monkeypatch.setattr(fl, "storage", fake)

    first = _run(fl.run_once())
    assert first["ok"] is False
    assert first["legs"] == 0
    # The leg itself did land durably (record_flight_legs is idempotent and
    # ran first) -- what's missing is the state that would stop it being
    # opened a second time.
    assert len(fake.leg_batches) == 1
    assert fake.leg_batches[0][0]["departed_at"] == 60.0  # the row that observed the transition
    assert fake.leg_batches[0][0]["arrived_at"] is None
    # Nothing else is durable: neither the state document nor the cursor.
    assert fl.STATE_NAME not in fake.docs
    assert fl.CURSOR_NAME not in fake.docs

    # The database recovers; the same batch -- read from the same untouched
    # cursor, against the same (still-empty) state -- is replayed.
    fake.fail_names.clear()
    retry = _run(fl.run_once())
    assert retry["ok"] is True
    assert retry["legs"] == 1
    assert fake.calls == [0, 0]  # both passes started from the same cursor
    assert fake.docs[fl.CURSOR_NAME] == {"last_id": 2}

    # Idempotent replay, not a second leg: the retry's own batch is exactly
    # the first attempt's batch, not a second departure opened alongside it.
    assert len(fake.leg_batches) == 2
    assert fake.leg_batches[0] == fake.leg_batches[1]
    assert fake.docs[fl.STATE_NAME]["entities"][ICAO]["leg"]["arrived_at"] is None


# --- Task 52: recovering from an old-shaped state document -----------------


def test_run_once_recovers_from_the_pre_wrap_state_shape(monkeypatch, caplog):
    """Every flight_legs_state document on disk before Task 52 is a bare
    {icao24: entry} map -- no "entities" key, no "schema_version" key -- the
    aviation twin of test_port_calls.py's own equivalent test. Drives the
    whole stack through run_once() itself -- _load_state, apply_positions,
    both writes -- not just the version check in isolation."""
    old_shaped_state = {ICAO: {"last": {"on_ground": True, "altitude_state": None, "ts": -600.0}}}
    rows = [pos(1, 0.0, on_ground=True, airfield_km=1.0), pos(2, 60.0, on_ground=False, airfield_km=1.0)]
    fake = _FakeStorage(rows)
    fake.docs[fl.STATE_NAME] = old_shaped_state
    monkeypatch.setattr(fl, "storage", fake)

    with caplog.at_level("WARNING", logger="osint-globe.refine"):
        result = _run(fl.run_once())
    assert result["ok"] is True  # did not raise
    assert any("schema_version" in r.message for r in caplog.records)  # logged, not silent

    # The old "last" pointer is gone -- state was discarded wholesale, not
    # selectively repaired -- so this pass's own on_ground transition opens a
    # fresh leg exactly as it would against a genuinely empty state (not, for
    # instance, comparing against the discarded on_ground=True and treating
    # this as a continuation of a leg that was never durably recorded).
    assert result["legs"] == 1
    assert fake.docs[fl.STATE_NAME]["schema_version"] == fl.STATE_SCHEMA_VERSION
    assert fake.docs[fl.STATE_NAME]["entities"][ICAO]["leg"]["departure_observed"] is True
    # The cursor still advanced past this pass's own rows -- a state reset
    # must never rewind or stall the cursor.
    assert fake.docs[fl.CURSOR_NAME] == {"last_id": 2}


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
