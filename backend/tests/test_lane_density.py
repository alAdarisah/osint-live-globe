"""The AIS traffic grid: cell keying at both resolutions, the circular mean
over courses that straddle the 0/360 seam, distinct-MMSI transit counting,
the decay factor's own arithmetic, and the incremental cursor these all sit
on top of.

See backend/refine/lane_density.py's module docstring for why this grid is
"where we have seen ships", never "where shipping lanes are".
"""

import asyncio
import math

import pytest

from backend import config
from backend import storage as real_storage
from backend.refine import lane_density


def pos(id_, ts, lat, lon, mmsi, course=None, ship_type=None) -> dict:
    payload: dict = {}
    if course is not None:
        payload["course"] = course
    if ship_type is not None:
        payload["ship_type"] = ship_type
    return {"id": id_, "entity_id": mmsi, "ts": ts, "lat": lat, "lon": lon, "payload": payload}


def _run(coro):
    return asyncio.run(coro)


# --- resolution and cell keying ---------------------------------------------


def test_resolution_is_finer_inside_watched_waters():
    lat_min, lon_min, lat_max, lon_max = config.WATCHED_WATERS[0]
    inside_lat = (lat_min + lat_max) / 2
    inside_lon = (lon_min + lon_max) / 2
    assert lane_density._resolution(inside_lat, inside_lon) == lane_density.WATCHED_RES
    # (0, 0) falls inside none of the default WATCHED_WATERS boxes -- the
    # South China Sea box shares lat_min=0 but starts its longitude at 105.
    assert lane_density._resolution(0.0, 0.0) == lane_density.GLOBAL_RES


def test_cell_key_encodes_resolution_so_the_two_grids_cannot_collide():
    """Chosen so the raw bin index is numerically identical between the two
    resolutions -- 0.25 / 0.05 == 5 and 0.10 / 0.02 == 5 -- which is exactly
    the case a cell_key built from the bin index alone would collide on."""
    key_global, _lat, _lon = lane_density._cell(0.25, 0.25, lane_density.GLOBAL_RES)
    key_watched, _lat2, _lon2 = lane_density._cell(0.10, 0.10, lane_density.WATCHED_RES)
    assert key_global != key_watched


def test_cell_binning_is_stable_across_the_cell_not_just_at_its_corner():
    """Two positions a few metres apart, both inside [0.05, 0.10), must land
    on the same cell_key -- the whole point of floor-division binning over a
    running centroid."""
    key_a, lat_a, lon_a = lane_density._cell(0.051, 0.051, lane_density.GLOBAL_RES)
    key_b, lat_b, lon_b = lane_density._cell(0.099, 0.099, lane_density.GLOBAL_RES)
    assert key_a == key_b
    assert (lat_a, lon_a) == (lat_b, lon_b) == pytest.approx((0.05, 0.05))


# --- compute_cells: transits, by_class, course vector -----------------------


def test_transits_count_distinct_mmsi_not_position_reports():
    rows = [
        pos(1, 0.0, 10.000, 10.000, "111", ship_type=72),  # cargo
        pos(2, 1.0, 10.001, 10.001, "111", ship_type=72),  # same hull, reports again
        pos(3, 2.0, 10.002, 10.002, "222", ship_type=84),  # tanker
    ]
    cells = lane_density.compute_cells(rows)
    assert len(cells) == 1
    cell = cells[0]
    assert cell["transits"] == 2  # two distinct hulls, not three reports
    assert cell["positions"] == 3
    assert cell["by_class"] == {"cargo": 1, "tanker": 1}


def test_by_class_never_out_reports_a_hull_with_no_decoded_ship_type():
    rows = [pos(1, 0.0, 10.0, 10.0, "111")]  # no ship_type ever decoded
    cell = lane_density.compute_cells(rows)[0]
    assert cell["transits"] == 1
    assert cell["by_class"] == {}


def test_a_repeated_hull_is_tallied_once_in_by_class_not_once_per_report():
    rows = [
        pos(1, 0.0, 10.000, 10.000, "111", ship_type=72),
        pos(2, 1.0, 10.001, 10.001, "111", ship_type=72),
        pos(3, 2.0, 10.002, 10.002, "111", ship_type=72),
    ]
    cell = lane_density.compute_cells(rows)[0]
    assert cell["transits"] == 1
    assert cell["by_class"] == {"cargo": 1}
    assert sum(cell["by_class"].values()) <= cell["transits"]


def test_course_vector_handles_the_0_360_seam():
    """Two transits at 359deg and 1deg should average to ~0deg (due north),
    not 180deg -- averaging raw degrees across the seam would give exactly
    that wrong answer, which is the entire reason mean_sin/mean_cos exist."""
    rows = [
        pos(1, 0.0, 10.0, 10.0, "111", course=359.0),
        pos(2, 1.0, 10.0, 10.0, "222", course=1.0),
    ]
    cell = lane_density.compute_cells(rows)[0]
    mean_deg = math.degrees(math.atan2(cell["mean_sin"], cell["mean_cos"])) % 360.0
    assert min(mean_deg, 360.0 - mean_deg) == pytest.approx(0.0, abs=1e-6)


def test_course_sentinel_360_is_dropped_not_folded_into_the_vector():
    """AIS's own "not available" value (raw COG=3600, i.e. 360.0deg) is not a
    genuine due-north reading and must not bias the cell's course vector."""
    rows = [pos(1, 0.0, 10.0, 10.0, "111", course=360.0)]
    cell = lane_density.compute_cells(rows)[0]
    assert (cell["mean_sin"], cell["mean_cos"]) == (0.0, 0.0)


def test_a_row_with_no_usable_position_is_skipped_rather_than_crashing():
    rows = [{"id": 1, "entity_id": "111", "ts": 0.0, "lat": None, "lon": 10.0, "payload": {}}]
    assert lane_density.compute_cells(rows) == []


# --- the decay factor's own arithmetic ---------------------------------------


def test_decay_factor_halves_a_cells_contribution_in_about_thirty_days():
    """The whole point of deriving the factor from the cadence: applying it
    once per tick, for as many ticks as fit in 30 days at the configured
    LANE_DENSITY_INTERVAL, must multiply a cell's contribution by exactly
    0.5 -- not approximately, by construction of the exponent."""
    ticks_per_half_life = (30 * 86400) / config.LANE_DENSITY_INTERVAL
    assert lane_density.DECAY_FACTOR == pytest.approx(0.5 ** (1.0 / ticks_per_half_life))
    assert lane_density.DECAY_FACTOR ** ticks_per_half_life == pytest.approx(0.5)


def test_decay_factor_is_below_one_but_not_by_much_per_tick():
    """A sanity check on the shape of the number, not just its formula: one
    hourly tick should barely move a cell, or the 30-day half-life promised
    in the module docstring would be a lie told in a comment."""
    assert 0.99 < lane_density.DECAY_FACTOR < 1.0


# --- the cursor: advancing, and never asked twice ----------------------------


class _FakeStorage:
    """Just enough of backend.storage to drive run_once() without Postgres --
    the same shape backend/tests/test_port_calls.py uses for port_calls.py.

    `write_ok` mirrors storage.upsert_lane_cells's own return value, which
    this task added specifically so a refine job reading entity_history
    through an ever-advancing cursor could tell a dropped write apart from a
    successful one -- see storage.upsert_lane_cells's docstring.
    """

    def __init__(self, rows, write_ok=True):
        self.history = rows
        self.docs = {}
        self.calls = []
        self.lane_batches = []
        self.write_ok = write_ok
        # A tiny stand-in for the real lane_cells table, merged with the real
        # storage._combine_lane_cell -- not a second, hand-rolled copy of that
        # accumulation logic -- so a test asserting on cross-pass behaviour
        # (see test_a_stationary_hull_accumulates_a_sighting_on_every_pass
        # below) is exercising the actual merge rule, not a fake's guess at it.
        self.cells: dict[str, dict] = {}
        self.decay_calls = 0
        self.health: list[tuple] = []
        # Set by a test to make entity_history_since raise instead of
        # returning -- see test_decay_runs_even_when_the_ingest_pass_raises.
        self.raise_on_history = False

    async def entity_history_since(self, kind, after_id, limit):
        if self.raise_on_history:
            raise RuntimeError("boom")
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        self.docs[name] = payload
        # True (durable write) by default -- Task 36's run_once now checks
        # this return value to gate the cursor advance, mirroring
        # storage.record_reference's own real signature. Every test in this
        # file drives a batch through run_once, which now also writes and
        # reads the chokepoint_state/chokepoint_transits documents through
        # this same method (see lane_density.CHOKEPOINT_STATE_NAME/
        # CHOKEPOINT_DOC_NAME) -- returning True here is what keeps every
        # test written before Task 36 passing without having to know that.
        return True

    async def upsert_lane_cells(self, rows):
        self.lane_batches.append(rows)
        if not self.write_ok:
            return False
        for row in rows:
            key = row["cell_key"]
            self.cells[key] = real_storage._combine_lane_cell(self.cells.get(key), row)
        return True

    async def decay_lane_cells(self, factor, floor):
        self.decay_calls += 1
        return 0

    async def record_source_health(self, source, item_count, ok, error=None):
        self.health.append((source, item_count, ok, error))


def test_the_cursor_advances_and_a_second_pass_does_not_reprocess(monkeypatch):
    rows = [
        pos(1, 0.0, 10.0, 10.0, "111", course=90.0),
        pos(2, 1.0, 10.0, 10.0, "222", course=90.0),
    ]
    fake = _FakeStorage(rows)
    monkeypatch.setattr(lane_density, "storage", fake)

    first = _run(lane_density.run_once())
    assert first["read"] == 2
    assert first["ok"] is True
    assert fake.calls == [0]  # no cursor stored yet -- starts from id 0
    assert fake.docs["lane_density_cursor"] == {"last_id": 2}

    # Nothing new since the last pass: the second call must ask for
    # everything past id 2, not repeat the first request.
    second = _run(lane_density.run_once())
    assert second["read"] == 0
    assert fake.calls == [0, 2]


def test_a_pass_with_nothing_new_leaves_the_cursor_untouched(monkeypatch):
    fake = _FakeStorage([pos(1, 0.0, 10.0, 10.0, "111", course=90.0)])
    monkeypatch.setattr(lane_density, "storage", fake)

    _run(lane_density.run_once())
    stored_after_first = dict(fake.docs)
    result = _run(lane_density.run_once())
    assert result == {"read": 0, "cells": 0, "ok": True}
    assert fake.docs == stored_after_first


def test_a_failed_write_holds_the_cursor_back_for_a_retry(monkeypatch):
    """A batch storage.upsert_lane_cells fails to write must be retried, not
    silently dropped -- entity_history is pruned at three days, so a batch
    read and never durably written would otherwise be gone for good.

    Task 36's chokepoint writes run and durably succeed *before*
    upsert_lane_cells is even attempted (see run_once's own docstring on why
    that order, not the reverse, is what keeps a later failure safe to
    retry) -- so this failure leaves the chokepoint documents written, just
    not the cursor. That is the intended difference from the pre-Task-36
    world this test used to assert ("nothing durable happened" at all):
    chokepoint accounting is idempotent under replay, so writing it ahead of
    a write that is not costs nothing on a retry.
    """
    rows = [pos(1, 0.0, 10.0, 10.0, "111", course=90.0)]
    fake = _FakeStorage(rows, write_ok=False)
    monkeypatch.setattr(lane_density, "storage", fake)

    result = _run(lane_density.run_once())
    assert result["ok"] is False
    assert result["read"] == 1
    assert lane_density.CURSOR_NAME not in fake.docs  # the cursor itself was never stored
    assert lane_density.CHOKEPOINT_DOC_NAME in fake.docs  # but the idempotent chokepoint write landed

    # The database recovers; the same batch is offered again, not skipped.
    fake.write_ok = True
    retry = _run(lane_density.run_once())
    assert retry["ok"] is True
    assert fake.calls == [0, 0]  # both passes started from the same cursor
    assert fake.docs["lane_density_cursor"] == {"last_id": 1}


# --- Task 19 review: transits accumulates sightings, not distinct hulls -----


def test_a_stationary_hull_accumulates_a_sighting_on_every_pass_it_is_seen(monkeypatch):
    """Task 19 review, Important: `transits` is a true distinct-MMSI count
    *within one pass* (see compute_cells), but storage.upsert_lane_cells adds
    that per-pass count onto the running total every time the job finds the
    same hull still sitting in the same cell -- so a hull that never moves
    keeps adding to the very same column a genuine, different ship passing
    through would. This is what "sightings" (see backend/app.py's
    lanes_endpoint, which renames the field for exactly this reason) has to
    mean: how many times a hull was seen, not how many distinct hulls ever
    called here.
    """
    mmsi = "111"
    fake = _FakeStorage([pos(1, 0.0, 10.0, 10.0, mmsi, course=90.0)])
    monkeypatch.setattr(lane_density, "storage", fake)

    _run(lane_density.run_once())
    (key,) = fake.cells.keys()
    assert fake.cells[key]["transits"] == 1

    # A second pass, later, finds the same hull still sitting in the same
    # cell -- not a different ship, the same one that never left.
    fake.history.append(pos(2, 3600.0, 10.0, 10.0, mmsi, course=90.0))
    _run(lane_density.run_once())
    assert fake.cells[key]["transits"] == 2  # accumulated, not deduplicated

    fake.history.append(pos(3, 7200.0, 10.0, 10.0, mmsi, course=90.0))
    _run(lane_density.run_once())
    assert fake.cells[key]["transits"] == 3


# --- Task 19 review: decay must survive an exception, not just ok=False -----


def test_decay_runs_after_a_normal_pass(monkeypatch):
    fake = _FakeStorage([pos(1, 0.0, 10.0, 10.0, "111", course=90.0)])
    monkeypatch.setattr(lane_density, "storage", fake)
    _run(lane_density._tick())
    assert fake.decay_calls == 1


def test_decay_runs_after_a_failed_write(monkeypatch):
    fake = _FakeStorage([pos(1, 0.0, 10.0, 10.0, "111", course=90.0)], write_ok=False)
    monkeypatch.setattr(lane_density, "storage", fake)
    _run(lane_density._tick())
    assert fake.decay_calls == 1


def test_decay_runs_even_when_the_ingest_pass_raises_outright(monkeypatch):
    """Task 19 review, Minor 1: the previous version only ran decay on the
    two paths inside run_once's own try block, so an exception raised before
    reaching decay_lane_cells (entity_history_since, reference and
    upsert_lane_cells can all raise) silently skipped a tick's worth of
    aging -- a small drift, but one the module docstring's "runs every tick"
    claim did not actually make true. _tick's `finally` is what this test
    holds to that claim."""
    fake = _FakeStorage([pos(1, 0.0, 10.0, 10.0, "111", course=90.0)])
    fake.raise_on_history = True
    monkeypatch.setattr(lane_density, "storage", fake)

    _run(lane_density._tick())  # must not raise past _tick itself

    assert fake.decay_calls == 1
    assert fake.docs == {}  # nothing durable happened on the failed pass
