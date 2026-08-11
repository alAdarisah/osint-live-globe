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

# A second, distinct real H3 cell -- used only by
# test_load_jam_cells_only_returns_the_most_recent_polls_own_top_hundred to
# stand in for a cell left over from an earlier poll's own top hundred.
_STALE_HEX = h3.latlng_to_cell(10.0, 100.0, 4)
_STALE_LAT, _STALE_LON = h3.cell_to_latlng(_STALE_HEX)

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


def test_a_sample_older_than_the_window_rolls_off_the_count():
    """Task 39 review, Important 1: JAM_CROSSCHECK_WINDOW_SECONDS is
    documented as bounding how long a sample stays counted -- a true rolling
    window, not merely how long an idle aircraft's own state entry survives.
    An airframe that keeps transiting the same cell must not accumulate an
    ever-growing count; each sample ages out on its own."""
    lat1, lon1 = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 2.0)
    first_pass = [row(1, 0.0, lat1, lon1), row(2, 300.0, _CENTER_LAT, _CENTER_LON)]
    state = jc.apply_batch(first_pass, _JAM_CELLS, {}, now=300.0)
    assert jc.build_document(state, _JAM_CELLS, now=300.0)["aircraft"][ICAO]["sample_count"] == 1

    # No new rows, but far enough later that the one sample above has aged
    # out of the window -- the cell is still tracked (still in _JAM_CELLS),
    # so this is a real prune, not a cell dropout (see the dropout test
    # just below, which is a different mechanism).
    much_later = 300.0 + config.JAM_CROSSCHECK_WINDOW_SECONDS + 1.0
    aged_state = jc.apply_batch([], _JAM_CELLS, state, now=much_later)
    doc = jc.build_document(aged_state, _JAM_CELLS, now=much_later)
    assert _HEX in doc["cells"]
    assert doc["cells"][_HEX]["status"] == jc.STATUS_NO_TRAFFIC
    assert ICAO not in doc["aircraft"]


def test_a_flag_older_than_the_window_rolls_off_the_cells_own_flagged_count():
    """The flags list is pruned the same way samples are -- a cell must not
    keep reading 'flagged' forever because of one anomaly outside the
    window this document itself claims to cover."""
    far_lat, far_lon = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 60.0)
    rows = [row(1, 0.0, far_lat, far_lon), row(2, 60.0, _CENTER_LAT, _CENTER_LON)]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=60.0)
    assert jc.build_document(state, _JAM_CELLS, now=60.0)["cells"][_HEX]["status"] == jc.STATUS_FLAGGED

    much_later = 60.0 + config.JAM_CROSSCHECK_WINDOW_SECONDS + 1.0
    aged_state = jc.apply_batch([], _JAM_CELLS, state, now=much_later)
    doc = jc.build_document(aged_state, _JAM_CELLS, now=much_later)
    assert doc["cells"][_HEX]["status"] == jc.STATUS_NO_TRAFFIC
    assert doc["cells"][_HEX]["aircraft_flagged"] == 0


def test_cell_status_requires_more_than_a_lone_flag_in_a_busy_cell():
    """Task 39 review, Important 2. The module's own measured rate puts raw
    flag noise above 98% unrelated to jamming (see the module docstring) --
    a single flagged aircraft among many observed must not trip the same
    "flagged" word a quiet cell gets from that same one flag, because a
    busy cell has proportionally more chances to produce one by chance.
    aircraft_flagged itself is never hidden either way -- see the frontend's
    own jamCellCrosscheckNote for the "N of M" wording that always shows it."""
    state = {}
    lat1, lon1 = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 2.0)
    for i in range(20):
        clean_rows = [
            row(1, 0.0, lat1, lon1, icao24=f"clean{i:02d}"),
            row(2, 300.0, _CENTER_LAT, _CENTER_LON, icao24=f"clean{i:02d}"),
        ]
        state = jc.apply_batch(clean_rows, _JAM_CELLS, state, now=300.0)

    far_lat, far_lon = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 60.0)
    flagged_rows = [row(3, 0.0, far_lat, far_lon, icao24="loud"), row(4, 60.0, _CENTER_LAT, _CENTER_LON, icao24="loud")]
    state = jc.apply_batch(flagged_rows, _JAM_CELLS, state, now=300.0)

    cell = jc.build_document(state, _JAM_CELLS, now=300.0)["cells"][_HEX]
    assert cell["aircraft_observed"] == 21
    assert cell["aircraft_flagged"] == 1  # the count is never hidden or rounded away
    assert cell["status"] == jc.STATUS_CLEAN  # but the ratio (1/21) is well under the bar


def test_a_lone_flag_still_flags_a_quiet_cell():
    """The other half of the same rule: a cell with only one aircraft ever
    observed still reads "flagged" if that one aircraft is -- there is no
    larger sample for a single anomaly to be diluted by, and requiring more
    than one aircraft outright would make a genuinely quiet, genuinely
    corroborated cell impossible to ever call flagged at all."""
    far_lat, far_lon = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 60.0)
    rows = [row(1, 0.0, far_lat, far_lon), row(2, 60.0, _CENTER_LAT, _CENTER_LON)]
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=60.0)
    cell = jc.build_document(state, _JAM_CELLS, now=60.0)["cells"][_HEX]
    assert cell["aircraft_observed"] == 1
    assert cell["aircraft_flagged"] == 1
    assert cell["status"] == jc.STATUS_FLAGGED


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


def test_tracking_since_is_stable_across_passes_once_set():
    """The document-wide mirror of tracked_seconds -- set once when a state
    is first built (a genuine first run, or _load_state discarding an
    incompatible one, see below), then carried forward unchanged. It must
    not silently reset just because more time has passed."""
    first = jc.apply_batch([], _JAM_CELLS, {}, now=1000.0)
    assert first["tracking_since"] == 1000.0
    second = jc.apply_batch([], _JAM_CELLS, first, now=5000.0)
    assert second["tracking_since"] == 1000.0


def test_samples_are_capped_at_append_time_not_only_pruned_by_age(monkeypatch):
    """Task 39 review, Important 2: JAM_CROSSCHECK_WINDOW_SECONDS alone only
    bounds *age* -- a single airframe producing many qualifying pairs within
    one still-open window must not grow its own state without bound.
    JAM_CROSSCHECK_MAX_EVENTS_PER_AIRCRAFT is lowered here so the test does
    not need a thousand rows to exercise the cap."""
    monkeypatch.setattr(config, "JAM_CROSSCHECK_MAX_EVENTS_PER_AIRCRAFT", 3)
    rows = [row(1, 0.0, _CENTER_LAT, _CENTER_LON)]
    for i in range(2, 8):  # six more fixes -> six transitions, all inside the cell
        rows.append(row(i, (i - 1) * 60.0, _CENTER_LAT, _CENTER_LON))
    state = jc.apply_batch(rows, _JAM_CELLS, {}, now=rows[-1]["ts"])
    doc = jc.build_document(state, _JAM_CELLS, now=rows[-1]["ts"])

    assert doc["aircraft"][ICAO]["sample_count"] == 3  # capped, not the true six transitions
    kept = state["cells"][_HEX]["aircraft"][ICAO]["samples"]
    assert kept == sorted(kept)  # the most recent ones are kept, not an arbitrary subset
    assert kept[-1] == rows[-1]["ts"]


# --- run_once: cursor/write discipline, matching every other refine job -----


class _FakeStorage:
    """Just enough of backend.storage to drive run_once() without Postgres --
    same shape as test_port_calls.py's own _FakeStorage/test_flight_legs.py's
    equivalent, for the same reason: entity_history_since() answers strictly
    id > after_id, and `write_ok`/`fail_names` play back the failure modes
    run_once has to survive without losing data (a write that logs-and-
    returns-False must never be read as "succeeded" and advance the cursor
    past rows entity_history's own 3-day retention will never offer again).

    `fail_names` fails only the named reference_snapshots writes (Task 39
    review, Critical: the earlier test only ever failed both writes
    together via `write_ok`, which never exercised the one interleaving that
    actually broke -- see test_a_failed_reference_write_does_not_double_
    count_on_retry below), while `write_ok=False` still fails everything, as
    every other refine job's own fake storage does.
    """

    def __init__(self, rows, jamming=(), write_ok=True, fail_names=frozenset()):
        self.history = rows
        self.jamming = list(jamming)
        self.docs = {}
        self.calls = []
        self.write_ok = write_ok
        self.fail_names = set(fail_names)

    async def entity_history_since(self, kind, after_id, limit):
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def entity_latest(self, kind):
        return self.jamming

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        if not self.write_ok or name in self.fail_names:
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


def test_run_once_reports_not_ok_when_only_the_cursor_write_fails(monkeypatch):
    """Pre-merge review, Also fix 1: this function's own docstring calls the
    cursor "the outermost gate of all", but its return value used to be
    discarded -- a Postgres hiccup on exactly that one write still reported
    "ok": True. Unlike vessel_profile.py/lane_density.py's own equivalent
    fix, this one is not just a health-reporting gap: `new_state` is already
    durably written by the time the cursor write runs, so a dropped cursor
    write means the *next* pass replays the same rows against a `state` that
    already reflects them -- see run_once's own docstring on the resulting
    double count. Checking the bool cannot undo that, but it does turn it
    into a visible failure rather than a silently green one."""
    rows = [row(1, 0.0, _CENTER_LAT, _CENTER_LON), row(2, 60.0, _CENTER_LAT, _CENTER_LON)]
    fake = _FakeStorage(rows, fail_names={jc.CURSOR_NAME})
    monkeypatch.setattr(jc, "storage", fake)

    result = _run(jc.run_once())
    assert result["ok"] is False
    assert jc.CURSOR_NAME not in fake.docs
    # The state/document writes did land -- this is the residual
    # double-count risk the fix's own docstring documents, not something a
    # single-write test can eliminate.
    assert jc.STATE_NAME in fake.docs
    assert jc.REFERENCE_NAME in fake.docs


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


def test_a_failed_reference_write_does_not_double_count_on_retry(monkeypatch):
    """Task 39 review, Critical. The first cut wrote the state document
    before the (possibly failing) reference document -- so when only the
    reference write failed, the cursor correctly held back, but the state
    had already advanced. On retry, apply_batch walked the same batch's rows
    forward from that already-advanced state: the first row's dt went
    negative against it (correctly not counted) but was then treated as a
    fresh "last" pointer, letting every following transition in the batch be
    counted a second time.

    Three rows -- two transitions, both landing inside the tracked cell --
    should produce exactly the same sample_count whether the reference
    write fails once and is retried, or never fails at all.
    """
    lat1, lon1 = destination_point(_CENTER_LAT, _CENTER_LON, 180.0, 2.0)
    rows = [
        row(1, 0.0, lat1, lon1),
        row(2, 300.0, _CENTER_LAT, _CENTER_LON),
        row(3, 600.0, lat1, lon1),
    ]
    jamming = [{"hex": _HEX, "lat": _CENTER_LAT, "lon": _CENTER_LON, "jam_ratio": 0.4, "date": "2026-08-10"}]

    # Baseline: the same batch, no failure at all -- what a single clean
    # pass produces.
    clean_fake = _FakeStorage(rows, jamming=jamming)
    monkeypatch.setattr(jc, "storage", clean_fake)
    baseline = _run(jc.run_once())
    assert baseline["ok"] is True
    baseline_count = clean_fake.docs[jc.REFERENCE_NAME]["aircraft"][ICAO]["sample_count"]
    assert baseline_count == 2  # one per transition, not per row

    # The reference write fails once; the state write must not land either,
    # so the retry starts from scratch rather than from a half-advanced
    # state.
    fake = _FakeStorage(rows, jamming=jamming, fail_names={jc.REFERENCE_NAME})
    monkeypatch.setattr(jc, "storage", fake)

    first = _run(jc.run_once())
    assert first["ok"] is False
    assert fake.docs == {}  # neither write landed -- doc failed first, state was never attempted

    fake.fail_names.clear()
    retry = _run(jc.run_once())
    assert retry["ok"] is True
    assert fake.calls == [0, 0]  # both attempts started from the same cursor -- the same batch, not a new one

    assert fake.docs[jc.REFERENCE_NAME]["aircraft"][ICAO]["sample_count"] == baseline_count
    assert fake.docs[jc.REFERENCE_NAME]["cells"][_HEX]["aircraft_observed"] == 1


def test_run_once_recovers_from_an_old_shaped_state_document(monkeypatch, caplog):
    """Task 39 review, Important 1. The live database this branch deploys
    against already holds jam_crosscheck_state rows written by earlier
    builds -- both the pre-review running-counter shape
    ({"count","flag_count","last_ts","flags"}) and this review's own
    unversioned first-fix-pass shape (raw lists, but no schema_version).
    Handed straight to apply_batch, `cell_entry["aircraft"].setdefault(icao,
    {"samples": [], "flags": []})` would return the *existing* (old-shaped)
    dict, and the very next `.append()` would raise KeyError. This drives
    the whole stack through run_once() itself -- _load_state, apply_batch,
    build_document, and the writes -- not just the version check in
    isolation, per the review's own instruction.
    """
    old_shaped_state = {
        "last": {},
        "cells": {
            _HEX: {
                "tracked_since": 0.0,
                "aircraft": {
                    "zz9999": {
                        "count": 3, "flag_count": 1, "last_ts": 0.0,
                        "flags": [{"type": "speed", "ts": 0.0}],
                    },
                },
            },
        },
        # No "schema_version" at all -- exactly what every jam_crosscheck_state
        # document written before this review point looks like.
    }
    rows = [row(1, 0.0, _CENTER_LAT, _CENTER_LON), row(2, 300.0, _CENTER_LAT, _CENTER_LON)]
    jamming = [{"hex": _HEX, "lat": _CENTER_LAT, "lon": _CENTER_LON, "jam_ratio": 0.4, "date": "2026-08-10"}]
    fake = _FakeStorage(rows, jamming=jamming)
    fake.docs[jc.STATE_NAME] = old_shaped_state
    monkeypatch.setattr(jc, "storage", fake)

    with caplog.at_level("WARNING", logger="osint-globe.jam_crosscheck"):
        result = _run(jc.run_once())
    assert result["ok"] is True  # did not raise
    assert any("schema_version" in r.message for r in caplog.records)  # logged, not silent

    doc = fake.docs[jc.REFERENCE_NAME]
    # The old airframe's stale entry is gone -- state was discarded wholesale
    # (not selectively repaired), and the reset is visible on the document
    # itself, not just inferred from an empty aircraft list.
    assert "zz9999" not in doc["aircraft"]
    assert doc["tracking_since"] == rows[-1]["ts"]
    # This pass's own new rows were still processed normally against the
    # freshly-rebuilt state -- recovery, not a pass that gave up entirely.
    assert doc["aircraft"][ICAO]["sample_count"] == 1

    new_state = fake.docs[jc.STATE_NAME]
    assert new_state["schema_version"] == jc.STATE_SCHEMA_VERSION


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


def test_load_jam_cells_drops_a_cell_left_over_from_an_earlier_poll(monkeypatch):
    """Pre-merge review, Critical 3: entity_latest("jamming") returns every
    cell ENTITY_STALE_AFTER["jamming"] (2 days) has not yet evicted, not just
    gpsjam's current top hundred -- measured live against the real database
    (2026-08-11), it returned 298 rows against jamming.MAX_CELLS=100. A cell
    carrying an older `date` than the newest one present is left over from a
    poll gpsjam's own top hundred has already moved past, and must not be
    reported as though it were still tracked today."""
    fake = _FakeStorage([], jamming=[
        {"hex": _HEX, "lat": _CENTER_LAT, "lon": _CENTER_LON, "jam_ratio": 0.4, "date": "2026-08-11"},
        {"hex": _STALE_HEX, "lat": _STALE_LAT, "lon": _STALE_LON, "jam_ratio": 0.3, "date": "2026-08-09"},
    ])
    monkeypatch.setattr(jc, "storage", fake)
    cells = _run(jc._load_jam_cells())
    assert _HEX in cells
    assert _STALE_HEX not in cells


def test_load_jam_cells_keeps_every_point_when_none_carry_a_date(monkeypatch):
    """A store where nothing carries a `date` at all has nothing for this
    filter to compare against -- see _load_jam_cells' own docstring on why
    that degrades to the old staleness-only behaviour rather than dropping
    everything."""
    fake = _FakeStorage([], jamming=[
        {"hex": _HEX, "lat": _CENTER_LAT, "lon": _CENTER_LON, "jam_ratio": 0.4},
        {"hex": _STALE_HEX, "lat": _STALE_LAT, "lon": _STALE_LON, "jam_ratio": 0.3},
    ])
    monkeypatch.setattr(jc, "storage", fake)
    cells = _run(jc._load_jam_cells())
    assert _HEX in cells
    assert _STALE_HEX in cells
