"""Task 39: a clean track producing no flag, an implausible jump producing
one, a jump outside any tracked cell never being attributed to jamming, and
the two threshold boundaries -- plus the honesty distinctions the plan's own
global constraints call out by name (a cell nobody has flown through versus
one that was clean, a jam cell that drops out of gpsjam's own top hundred,
too few samples to call an airframe clean, and the cursor/write discipline
every other refine job in this tier is held to).

Real h3 geometry, not mocked: `_HEX`/`_CENTER_LAT`/`_CENTER_LON` are a real
H3 resolution-4 cell and its own real centroid, computed once at import time
the same way backend/sources/jamming.py itself would report them. A position
within a couple of km of the centroid is safely inside the cell (a
resolution-4 hexagon's inradius is roughly 22km -- see
backend/config.py's own JAM_CROSSCHECK_MIN_REVERSAL_KM comment for the
measurement this module's thresholds are grounded in); a position on the
opposite side of the globe is safely outside every cell this test tracks.
"""

import asyncio

import h3
import pytest

from backend import config
from backend.refine import jam_crosscheck as jc
from backend.sources.proximity import destination_point

_HEX = h3.latlng_to_cell(40.0, -3.0, 4)
_CENTER_LAT, _CENTER_LON = h3.cell_to_latlng(_HEX)
_JAM_CELLS = {_HEX: {"lat": _CENTER_LAT, "lon": _CENTER_LON, "jam_ratio": 0.4, "date": "2026-08-10"}}

ICAO = "a1b2c3"
NOW = 1_800_000_000.0


def row(id_, ts, lat, lon, on_ground=False, heading=None, icao24=ICAO):
    payload = {"on_ground": on_ground}
    if heading is not None:
        payload["heading"] = heading
    return {"id": id_, "entity_id": icao24, "ts": ts, "lat": lat, "lon": lon, "payload": payload}


def _run(coro):
    return asyncio.run(coro)


# --- _classify_delta: the two shapes of "implausible", at their boundaries --


def test_ordinary_cruise_speed_does_not_flag():
    last = {"ts": 0.0, "lat": _CENTER_LAT, "lon": _CENTER_LON, "on_ground": False}
    lat, lon = destination_point(_CENTER_LAT, _CENTER_LON, 90.0, 20.0)  # 20km in an hour = 20km/h
    dist_km, flag = jc._classify_delta(last, 3600.0, lat, lon, heading=90.0)
    assert flag is None
    assert dist_km == pytest.approx(20.0, abs=0.05)


def test_speed_just_under_the_threshold_does_not_flag():
    """The comparison is strictly greater-than -- a reading at or just below
    the configured ceiling is not itself implausible, only a reading past
    it. (A literal IEEE-754 boundary is not asserted here: projecting a
    great-circle distance and then measuring it back with haversine_km does
    not round-trip to the same float bit-for-bit, so the meaningful claim is
    "just under does not flag, just over does" -- see the next test.)"""
    last = {"ts": 0.0, "lat": _CENTER_LAT, "lon": _CENTER_LON, "on_ground": False}
    lat, lon = destination_point(_CENTER_LAT, _CENTER_LON, 0.0, config.JAM_CROSSCHECK_MAX_SPEED_KMH - 1.0)
    _dist_km, flag = jc._classify_delta(last, 3600.0, lat, lon, heading=None)
    assert flag is None


def test_speed_just_past_the_threshold_flags():
    last = {"ts": 0.0, "lat": _CENTER_LAT, "lon": _CENTER_LON, "on_ground": False}
    lat, lon = destination_point(_CENTER_LAT, _CENTER_LON, 0.0, config.JAM_CROSSCHECK_MAX_SPEED_KMH + 5.0)
    _dist_km, flag = jc._classify_delta(last, 3600.0, lat, lon, heading=None)
    assert flag is not None
    assert flag["type"] == "speed"
    assert flag["speed_kmh"] > config.JAM_CROSSCHECK_MAX_SPEED_KMH


def test_displacement_below_the_reversal_floor_skips_the_heading_check_entirely():
    """Below JAM_CROSSCHECK_MIN_REVERSAL_KM the bearing is not trusted at
    all, however wildly it disagrees with the reported heading -- see the
    module docstring on why ordinary GPS jitter dominates down there."""
    last = {"ts": 0.0, "lat": _CENTER_LAT, "lon": _CENTER_LON, "on_ground": False}
    lat, lon = destination_point(_CENTER_LAT, _CENTER_LON, 0.0, config.JAM_CROSSCHECK_MIN_REVERSAL_KM - 0.01)
    # Heading points due south while the aircraft moved due north: a full
    # reversal, were it trusted.
    _dist_km, flag = jc._classify_delta(last, 600.0, lat, lon, heading=180.0)
    assert flag is None


def test_heading_deviation_just_under_the_threshold_does_not_flag():
    """Same "just under, not the literal float boundary" reasoning as the
    speed test above -- initial_bearing's own trigonometry does not land on
    an exact integer degree just because the fixture asked for one."""
    last = {"ts": 0.0, "lat": _CENTER_LAT, "lon": _CENTER_LON, "on_ground": False}
    lat, lon = destination_point(_CENTER_LAT, _CENTER_LON, 0.0, config.JAM_CROSSCHECK_MIN_REVERSAL_KM + 15.0)
    heading = config.JAM_CROSSCHECK_MAX_HEADING_DEVIATION_DEG - 1.0  # bearing is ~0deg, so this ~= the deviation
    _dist_km, flag = jc._classify_delta(last, 600.0, lat, lon, heading=heading)
    assert flag is None


def test_heading_deviation_just_past_the_threshold_flags():
    last = {"ts": 0.0, "lat": _CENTER_LAT, "lon": _CENTER_LON, "on_ground": False}
    lat, lon = destination_point(_CENTER_LAT, _CENTER_LON, 0.0, config.JAM_CROSSCHECK_MIN_REVERSAL_KM + 15.0)
    heading = config.JAM_CROSSCHECK_MAX_HEADING_DEVIATION_DEG + 1.0
    _dist_km, flag = jc._classify_delta(last, 600.0, lat, lon, heading=heading)
    assert flag is not None
    assert flag["type"] == "heading_reversal"
    assert flag["deviation_deg"] > config.JAM_CROSSCHECK_MAX_HEADING_DEVIATION_DEG


# --- apply_batch / build_document: cell attribution --------------------------


def test_a_clean_track_inside_a_cell_produces_no_flag():
    lat1, lon1 = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 2.0)
    rows = [
        row(1, 0.0, lat1, lon1),
        row(2, 300.0, _CENTER_LAT, _CENTER_LON),  # ~2km in 5min -- ordinary
    ]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=300.0)
    doc = jc.build_document(state, _JAM_CELLS, now=300.0)

    cell = doc["cells"][_HEX]
    assert cell["status"] == jc.STATUS_CLEAN
    assert cell["aircraft_observed"] == 1
    assert cell["aircraft_flagged"] == 0
    assert ICAO not in doc["aircraft"] or doc["aircraft"][ICAO]["status"] != jc.AIRCRAFT_FLAGGED


def test_an_implausible_jump_into_a_tracked_cell_flags_and_is_attributed():
    far_lat, far_lon = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 60.0)  # 60km south
    rows = [
        row(1, 0.0, far_lat, far_lon),
        row(2, 60.0, _CENTER_LAT, _CENTER_LON),  # 60km in 60s -- ~3600km/h
    ]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=60.0)
    doc = jc.build_document(state, _JAM_CELLS, now=60.0)

    cell = doc["cells"][_HEX]
    assert cell["status"] == jc.STATUS_FLAGGED
    assert cell["aircraft_flagged"] == 1

    aircraft = doc["aircraft"][ICAO]
    assert aircraft["status"] == jc.AIRCRAFT_FLAGGED
    assert aircraft["flag_count"] == 1
    assert aircraft["flags"][0]["type"] == "speed"
    assert aircraft["flags"][0]["jam_cell"] == _HEX


def test_a_jump_outside_every_tracked_cell_is_never_attributed_to_jamming():
    """Required by the brief's own test list. The jump itself is exactly as
    implausible as the flagged one above -- what differs is that neither
    fix sits inside a cell this pass is tracking, and the required behaviour
    is that nothing about it is recorded here at all, not merely unlabelled."""
    # Antipodal-ish to _HEX -- nowhere near it, and specifically not a key in
    # _JAM_CELLS regardless of which real hex it happens to compute to.
    away_lat, away_lon = -_CENTER_LAT, (_CENTER_LON + 180.0 + 360.0) % 360.0 - 180.0
    lat2, lon2 = destination_point(away_lat, away_lon, 0.0, 60.0)
    rows = [
        row(1, 0.0, away_lat, away_lon),
        row(2, 60.0, lat2, lon2),  # same implausible ~3600km/h jump
    ]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=60.0)
    doc = jc.build_document(state, _JAM_CELLS, now=60.0)

    # The one cell this test tracks saw nothing -- this airframe never went
    # near it.
    assert doc["cells"][_HEX]["status"] == jc.STATUS_NO_TRAFFIC
    assert doc["cells"][_HEX]["aircraft_observed"] == 0
    # And the airframe itself has no entry at all: an anomaly outside every
    # tracked cell is not evidence of anything this product reports on.
    assert ICAO not in doc["aircraft"]


def test_an_on_ground_pair_is_never_evaluated_even_if_the_math_would_flag():
    rows = [
        row(1, 0.0, _CENTER_LAT, _CENTER_LON, on_ground=True),
        row(2, 60.0, *destination_point(_CENTER_LAT, _CENTER_LON, 0.0, 60.0), on_ground=True),
    ]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=60.0)
    doc = jc.build_document(state, _JAM_CELLS, now=60.0)
    assert doc["cells"][_HEX]["aircraft_observed"] == 0


def test_a_coverage_gap_past_the_bound_is_not_compared_as_a_continuous_reading():
    rows = [
        row(1, 0.0, _CENTER_LAT, _CENTER_LON),
        row(2, config.JAM_CROSSCHECK_MAX_GAP_SECONDS + 1.0, _CENTER_LAT, _CENTER_LON),
    ]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=rows[-1]["ts"])
    doc = jc.build_document(state, _JAM_CELLS, now=rows[-1]["ts"])
    # Nothing to compare across the gap -- no sample was ever taken.
    assert doc["cells"][_HEX]["aircraft_observed"] == 0


# --- the three-way cell status, and the aircraft-level mirror ---------------


def test_no_traffic_and_clean_and_flagged_are_three_different_cell_statuses():
    assert jc.build_document({}, _JAM_CELLS, now=0.0)["cells"][_HEX]["status"] == jc.STATUS_NO_TRAFFIC

    lat1, lon1 = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 2.0)
    clean_rows = [row(1, 0.0, lat1, lon1), row(2, 300.0, _CENTER_LAT, _CENTER_LON)]
    clean_state = jc.apply_batch(clean_rows, _JAM_CELLS, {}, now=300.0)
    assert jc.build_document(clean_state, _JAM_CELLS, now=300.0)["cells"][_HEX]["status"] == jc.STATUS_CLEAN

    far_lat, far_lon = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 60.0)
    flagged_rows = [row(1, 0.0, far_lat, far_lon), row(2, 60.0, _CENTER_LAT, _CENTER_LON)]
    flagged_state = jc.apply_batch(flagged_rows, _JAM_CELLS, {}, now=60.0)
    assert jc.build_document(flagged_state, _JAM_CELLS, now=60.0)["cells"][_HEX]["status"] == jc.STATUS_FLAGGED


def test_insufficient_samples_becomes_checked_clean_once_min_samples_is_met():
    """Task 39 review scope, direct application of global-constraints.md's
    "found nothing vs did not look": one clean sample must not read the same
    as JAM_CROSSCHECK_MIN_SAMPLES clean samples on the aircraft card."""
    assert config.JAM_CROSSCHECK_MIN_SAMPLES >= 2, "test assumes at least two samples are required"

    lat1, lon1 = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 2.0)
    one_sample = [row(1, 0.0, lat1, lon1), row(2, 300.0, _CENTER_LAT, _CENTER_LON)]
    state = jc.apply_batch(one_sample, _JAM_CELLS, {}, now=300.0)
    doc = jc.build_document(state, _JAM_CELLS, now=300.0)
    assert doc["aircraft"][ICAO]["status"] == jc.AIRCRAFT_INSUFFICIENT

    # A second qualifying pass, same airframe, same cell, still clean.
    more_rows = [row(3, 600.0, lat1, lon1), row(4, 900.0, _CENTER_LAT, _CENTER_LON)]
    state2 = jc.apply_batch(more_rows, _JAM_CELLS, state, now=900.0)
    doc2 = jc.build_document(state2, _JAM_CELLS, now=900.0)
    assert doc2["aircraft"][ICAO]["sample_count"] >= config.JAM_CROSSCHECK_MIN_SAMPLES
    assert doc2["aircraft"][ICAO]["status"] == jc.AIRCRAFT_CHECKED_CLEAN


def test_a_cell_dropping_out_of_the_current_top_hundred_drops_its_state_too():
    """gpsjam's own feed is daily and MAX_CELLS-capped (see jamming.py) -- a
    cell that falls out of the current read is no longer a jam cell by this
    map's own reported source, and carrying its old activity forward would
    misattribute it to a cell nothing currently calls jammed."""
    far_lat, far_lon = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 60.0)
    rows = [row(1, 0.0, far_lat, far_lon), row(2, 60.0, _CENTER_LAT, _CENTER_LON)]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=60.0)
    assert _HEX in state["cells"]

    state_after_dropout = jc.apply_batch([], {}, state, now=61.0)
    assert _HEX not in state_after_dropout["cells"]


def test_tracked_seconds_reflects_how_long_this_job_has_watched_the_cell():
    state = jc.apply_batch([], _JAM_CELLS, {}, now=1000.0)
    doc = jc.build_document(state, _JAM_CELLS, now=1000.0)
    assert doc["cells"][_HEX]["tracked_seconds"] == 0

    later = jc.build_document(state, _JAM_CELLS, now=1000.0 + 3600.0)
    assert later["cells"][_HEX]["tracked_seconds"] == 3600


# --- run_once: cursor/write discipline, matching every other refine job -----


class _FakeStorage:
    """Just enough of backend.storage to drive run_once() without Postgres --
    same shape as test_port_calls.py's own _FakeStorage/test_flight_legs.py's
    equivalent, for the same reason: entity_history_since() answers strictly
    id > after_id, and `write_ok` plays back the one failure mode run_once
    has to survive without losing data (a write that logs-and-returns-False
    must never be read as "succeeded" and advance the cursor past rows
    entity_history's own 3-day retention will never offer again)."""

    def __init__(self, rows, jamming=(), write_ok=True):
        self.history = rows
        self.jamming = list(jamming)
        self.docs = {}
        self.calls = []
        self.write_ok = write_ok

    async def entity_history_since(self, kind, after_id, limit):
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def entity_latest(self, kind):
        return self.jamming

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        if not self.write_ok:
            return False
        self.docs[name] = payload
        return True

    async def record_source_health(self, *args, **kwargs):
        pass


def test_the_cursor_advances_and_a_second_pass_does_not_reprocess(monkeypatch):
    rows = [row(1, 0.0, _CENTER_LAT, _CENTER_LON), row(2, 60.0, _CENTER_LAT, _CENTER_LON)]
    fake = _FakeStorage(rows)
    monkeypatch.setattr(jc, "storage", fake)

    first = _run(jc.run_once())
    assert first["ok"] is True
    assert first["read"] == 2
    assert fake.calls == [0]
    assert fake.docs["jam_crosscheck_cursor"] == {"last_id": 2}

    second = _run(jc.run_once())
    assert second["read"] == 0
    assert fake.calls == [0, 2]


def test_a_failed_write_holds_the_cursor_back_for_a_retry(monkeypatch):
    rows = [row(1, 0.0, _CENTER_LAT, _CENTER_LON), row(2, 60.0, _CENTER_LAT, _CENTER_LON)]
    fake = _FakeStorage(rows, write_ok=False)
    monkeypatch.setattr(jc, "storage", fake)

    result = _run(jc.run_once())
    assert result["ok"] is False
    assert fake.docs == {}  # nothing durable happened

    fake.write_ok = True
    retry = _run(jc.run_once())
    assert retry["ok"] is True
    assert fake.calls == [0, 0]  # both passes started from the same cursor
    assert fake.docs["jam_crosscheck_cursor"] == {"last_id": 2}


def test_run_once_still_republishes_on_an_empty_batch(monkeypatch):
    """gpsjam's own top hundred can change with no new ADS-B rows at all --
    see run_once's own docstring. A pass with nothing new must still refresh
    tracked_seconds and the document, not sit frozen on the last pass that
    happened to see a row."""
    fake = _FakeStorage(
        [], jamming=[{"hex": _HEX, "lat": _CENTER_LAT, "lon": _CENTER_LON, "jam_ratio": 0.3, "date": "2026-08-11"}]
    )
    monkeypatch.setattr(jc, "storage", fake)

    result = _run(jc.run_once())
    assert result["ok"] is True
    assert result["cells"] == 1
    assert "jam_crosscheck" in fake.docs
    assert _HEX in fake.docs["jam_crosscheck"]["cells"]


def test_load_jam_cells_falls_back_to_recomputing_the_hex_from_the_centroid(monkeypatch):
    """A snapshot recorded before Task 39 taught jamming.py to carry `hex`
    itself has none -- see _load_jam_cells' own docstring on why the
    fallback recovers the identical id rather than a nearby one."""
    fake = _FakeStorage([], jamming=[{"lat": _CENTER_LAT, "lon": _CENTER_LON, "jam_ratio": 0.5, "date": "2026-08-11"}])
    monkeypatch.setattr(jc, "storage", fake)
    cells = _run(jc._load_jam_cells())
    assert _HEX in cells
