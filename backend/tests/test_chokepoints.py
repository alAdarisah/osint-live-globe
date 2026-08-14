"""Task 36: distinct-hull chokepoint counting, riding lane_density's own
incremental pass over entity_history -- see lane_density.py's module
docstring ("Task 36: chokepoint transit counters ride this same pass") and
compute_chokepoints' own docstring for why this needs a different
accumulator shape from lane_cells' per-pass-count-that-gets-summed.

Covers, per the brief: distinct-hull counting across a day boundary, a hull
crossing twice, and the trend when a day has no data (which must render as
"missing", never as a zero) -- plus the cursor-discipline property run_once's
own docstring calls out: a chokepoint write failure must never cause
storage.upsert_lane_cells to be retried on a batch it already durably
applied.
"""

import asyncio
from datetime import datetime, timezone

from backend import config
from backend import storage as real_storage
from backend.refine import lane_density

# The Strait of Hormuz / Persian Gulf box (config.WATCHED_WATERS[3]) -- a
# single, non-overlapping watched box for tests that only care about one.
HORMUZ_LABEL = "Strait of Hormuz / Persian Gulf"
HORMUZ_POINT = (26.0, 52.0)  # well inside (24,48,30,57), nowhere near an edge

# Nowhere near any of the eight default watched boxes -- the same "outside
# every box" point test_lane_density.py's own resolution test uses.
OUTSIDE_ANY_BOX = (0.0, 0.0)


def _run(coro):
    return asyncio.run(coro)


def _ts(day: str, hour: int = 12) -> float:
    y, m, d = (int(p) for p in day.split("-"))
    return datetime(y, m, d, hour, tzinfo=timezone.utc).timestamp()


def row(id_, day, lat, lon, mmsi, hour=12, ship_type=None) -> dict:
    payload: dict = {}
    if ship_type is not None:
        payload["ship_type"] = ship_type
    return {"id": id_, "entity_id": mmsi, "ts": _ts(day, hour), "lat": lat, "lon": lon, "payload": payload}


# --- distinct-hull counting: repeats, a day boundary, an overlap -----------


def test_distinct_hulls_counted_once_per_day_not_per_position_report():
    lat, lon = HORMUZ_POINT
    rows = [
        row(1, "2026-08-01", lat, lon, "111", hour=1),
        row(2, "2026-08-01", lat + 0.01, lon, "111", hour=5),
        row(3, "2026-08-01", lat + 0.02, lon, "111", hour=9),
    ]
    state = lane_density.compute_chokepoints(rows, {})
    day = state["boxes"][HORMUZ_LABEL]["days"]["2026-08-01"]
    assert len(day["mmsis"]) == 1  # three reports, one hull


def test_a_hull_crossing_twice_in_one_day_still_counts_once():
    """Enters the box, leaves it entirely, re-enters the same calendar day --
    the brief's own "a hull crossing twice" case. Still one distinct hull for
    that day, not two."""
    lat, lon = HORMUZ_POINT
    outside_lat, outside_lon = OUTSIDE_ANY_BOX
    rows = [
        row(1, "2026-08-01", lat, lon, "111", hour=1),
        row(2, "2026-08-01", outside_lat, outside_lon, "111", hour=3),
        row(3, "2026-08-01", lat + 0.1, lon + 0.1, "111", hour=6),
    ]
    state = lane_density.compute_chokepoints(rows, {})
    day = state["boxes"][HORMUZ_LABEL]["days"]["2026-08-01"]
    assert len(day["mmsis"]) == 1


def test_distinct_hulls_split_across_a_day_boundary_are_counted_separately():
    """The same hull, present just before and just after UTC midnight, is one
    distinct hull on each of the two days -- never summed into one count for
    either day, and never merged into a single "2" anywhere."""
    lat, lon = HORMUZ_POINT
    rows = [
        row(1, "2026-08-01", lat, lon, "111", hour=23),
        row(2, "2026-08-02", lat, lon, "111", hour=1),
    ]
    state = lane_density.compute_chokepoints(rows, {})
    days = state["boxes"][HORMUZ_LABEL]["days"]
    assert len(days["2026-08-01"]["mmsis"]) == 1
    assert len(days["2026-08-02"]["mmsis"]) == 1
    # Neither total the compute step would report is "2" for either day.
    assert set(days["2026-08-01"]["mmsis"]) == {"111"}
    assert set(days["2026-08-02"]["mmsis"]) == {"111"}


def test_a_hull_in_the_overlap_of_two_boxes_counts_toward_both():
    """Red Sea (12,32,30,43) and the Gulf of Aden approach (10,43,15,52)
    overlap at lon=43 -- config.WATCHED_WATERS' own overlap, not a contrived
    one. A hull sitting there legitimately counts in both boxes' totals."""
    rows = [row(1, "2026-08-01", 13.0, 43.0, "111")]
    state = lane_density.compute_chokepoints(rows, {})
    assert "111" in state["boxes"]["Red Sea"]["days"]["2026-08-01"]["mmsis"]
    assert "111" in state["boxes"]["Gulf of Aden / Bab-el-Mandeb approach"]["days"]["2026-08-01"]["mmsis"]


def test_by_class_tallies_distinct_hulls_never_folds_in_an_undecoded_type():
    lat, lon = HORMUZ_POINT
    rows = [
        row(1, "2026-08-01", lat, lon, "111", ship_type=84),        # tanker
        row(2, "2026-08-01", lat + 0.01, lon, "111", ship_type=84),  # same hull again
        row(3, "2026-08-01", lat + 0.02, lon, "222", ship_type=72),  # cargo
        row(4, "2026-08-01", lat + 0.03, lon, "333"),                # never decoded
    ]
    state = lane_density.compute_chokepoints(rows, {})
    doc = lane_density.build_chokepoint_document(state)
    today = doc["boxes"][HORMUZ_LABEL]["trend"][-1]
    assert today["status"] == "partial"  # this is the only, and so the latest, day
    assert today["total"] == 3  # three distinct hulls
    assert today["by_class"] == {"tanker": 1, "cargo": 1}  # "333" never decoded -- absent, not "other"
    assert sum(today["by_class"].values()) <= today["total"]


def test_a_row_outside_every_watched_box_still_marks_its_day_as_observed():
    """Not itself a chokepoint fact, but this is exactly what lets
    build_chokepoint_document tell "no traffic here" apart from "never
    looked" -- see the missing-vs-zero tests below."""
    outside_lat, outside_lon = OUTSIDE_ANY_BOX
    rows = [row(1, "2026-08-01", outside_lat, outside_lon, "999")]
    state = lane_density.compute_chokepoints(rows, {})
    assert "2026-08-01" in state["days_seen"]
    assert state["boxes"] == {}  # no box was ever touched


# --- the trend: missing vs. a real counted zero vs. still-partial ----------


def test_a_day_never_observed_at_all_is_missing_not_zero():
    """The brief's own third case: a day with no data must never read as
    zero traffic."""
    lat, lon = HORMUZ_POINT
    rows = [row(1, "2026-08-30", lat, lon, "111")]  # the only day this job has ever seen
    state = lane_density.compute_chokepoints(rows, {})
    doc = lane_density.build_chokepoint_document(state)
    trend = {e["date"]: e for e in doc["boxes"][HORMUZ_LABEL]["trend"]}
    earliest = min(trend)  # far before 2026-08-30 -- inside the 30-day window, never touched
    assert trend[earliest]["status"] == "missing"
    assert trend[earliest]["total"] is None
    assert trend[earliest]["by_class"] is None


def test_a_day_the_job_watched_with_no_traffic_in_this_box_is_a_real_zero():
    """A day this job has since moved well past (outside the grace window),
    where some row was processed but none of them touched this box, is a
    genuine, finished zero -- "counted", not "missing" and not "partial"."""
    outside_lat, outside_lon = OUTSIDE_ANY_BOX
    lat, lon = HORMUZ_POINT
    rows = [
        row(1, "2026-08-01", outside_lat, outside_lon, "999"),  # watched, nowhere near a box
        row(2, "2026-08-05", lat, lon, "111"),  # pushes latest_day forward, closing 08-01
    ]
    state = lane_density.compute_chokepoints(rows, {})
    doc = lane_density.build_chokepoint_document(state)
    trend = {e["date"]: e for e in doc["boxes"][HORMUZ_LABEL]["trend"]}
    assert trend["2026-08-01"]["status"] == "counted"
    assert trend["2026-08-01"]["total"] == 0
    assert trend["2026-08-01"]["by_class"] == {}


def test_the_current_day_is_partial_even_with_zero_traffic_so_far():
    """The day this job is still accumulating is never presented as a
    finished zero, even for a box that has not seen anything yet today --
    the day is not over, so "0 so far" and "0, final" must not read alike."""
    outside_lat, outside_lon = OUTSIDE_ANY_BOX
    rows = [row(1, "2026-08-30", outside_lat, outside_lon, "999")]
    state = lane_density.compute_chokepoints(rows, {})
    doc = lane_density.build_chokepoint_document(state)
    today = doc["boxes"][HORMUZ_LABEL]["trend"][-1]
    assert today["date"] == "2026-08-30"
    assert today["status"] == "partial"
    assert today["total"] == 0


def test_every_configured_box_appears_even_one_never_touched():
    lat, lon = HORMUZ_POINT
    rows = [row(1, "2026-08-01", lat, lon, "111")]
    state = lane_density.compute_chokepoints(rows, {})
    doc = lane_density.build_chokepoint_document(state)
    assert set(doc["boxes"]) == set(config.WATCHED_WATERS_LABELS)
    black_sea = doc["boxes"]["Black Sea"]
    assert len(black_sea["trend"]) == lane_density.CHOKEPOINT_TREND_DAYS
    assert black_sea["trend"][-1]["status"] in ("missing", "counted", "partial")


def test_empty_state_and_no_rows_produce_an_empty_but_well_shaped_document():
    doc = lane_density.build_chokepoint_document({})
    assert doc["as_of_day"] is None
    assert doc["boxes"][HORMUZ_LABEL]["trend"] == []
    assert doc["boxes"][HORMUZ_LABEL]["today"] is None
    assert doc["provenance"] == "derived"


# --- bounding: a closed day drops its raw membership, old days fall off ----


def test_a_day_outside_the_grace_window_drops_its_raw_membership():
    """The whole of how this document stays bounded: once a day is old
    enough that no more of this job's own catch-up backlog could land in it,
    its membership set (which scales with real traffic) collapses to two
    small integers that do not."""
    lat, lon = HORMUZ_POINT
    rows = [
        row(1, "2026-08-01", lat, lon, "111"),
        row(2, "2026-08-01", lat, lon, "222"),
        row(3, "2026-08-05", lat, lon, "333"),  # far enough ahead to close 08-01
    ]
    state = lane_density.compute_chokepoints(rows, {})
    day = state["boxes"][HORMUZ_LABEL]["days"]["2026-08-01"]
    assert day["status"] == "counted"
    assert "mmsis" not in day  # the raw set is gone, not just ignored
    assert day["total"] == 2
    assert day["by_class"] == {}


def test_days_older_than_the_trend_window_are_dropped_from_the_state_entirely():
    """Not merely excluded from the served document -- gone from
    chokepoint_state, the accumulator this job persists across passes. That
    is the size bound: at most CHOKEPOINT_TREND_DAYS day-entries per box,
    ever."""
    lat, lon = HORMUZ_POINT
    old_row = row(1, "2026-01-01", lat, lon, "111")
    state = lane_density.compute_chokepoints([old_row], {})
    assert "2026-01-01" in state["boxes"][HORMUZ_LABEL]["days"]

    # A batch landing 40 days later pushes the window well past 2026-01-01.
    later_row = row(2, "2026-02-10", lat, lon, "222")
    state = lane_density.compute_chokepoints([later_row], state)
    assert "2026-01-01" not in state["boxes"][HORMUZ_LABEL]["days"]
    assert "2026-01-01" not in state["days_seen"]
    assert len(state["boxes"][HORMUZ_LABEL]["days"]) <= lane_density.CHOKEPOINT_TREND_DAYS


def test_replaying_the_same_batch_against_the_same_state_is_a_no_op():
    """compute_chokepoints' own claimed idempotence -- the property run_once
    leans on to write chokepoint accounting ahead of the non-idempotent
    storage.upsert_lane_cells (see run_once's docstring)."""
    rows = [
        row(1, "2026-08-01", *HORMUZ_POINT, "111", ship_type=84),
        row(2, "2026-08-01", *HORMUZ_POINT, "222"),
    ]
    once = lane_density.compute_chokepoints(rows, {})
    twice = lane_density.compute_chokepoints(rows, once)
    assert twice == once


# --- cursor discipline: run_once's write ordering ---------------------------


class _FakeStorage:
    """Enough of backend.storage to drive lane_density.run_once() without
    Postgres -- the same shape test_lane_density.py's own fake uses, with an
    independent failure switch for the chokepoint writes specifically
    (`choke_write_ok`) so the two write paths can be broken one at a time.
    """

    def __init__(self, rows, write_ok=True, choke_write_ok=True):
        self.history = rows
        self.docs = {}
        self.calls = []
        self.lane_batches = []
        self.write_ok = write_ok
        self.choke_write_ok = choke_write_ok
        self.cells: dict[str, dict] = {}
        self.decay_calls = 0
        self.health: list[tuple] = []

    async def entity_history_since(self, kind, after_id, limit):
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        if name in (lane_density.CHOKEPOINT_STATE_NAME, lane_density.CHOKEPOINT_DOC_NAME):
            if not self.choke_write_ok:
                return False
        self.docs[name] = payload
        return True

    async def upsert_lane_cells(self, rows):
        self.lane_batches.append(rows)
        if not self.write_ok:
            return False
        for row_ in rows:
            key = row_["cell_key"]
            self.cells[key] = real_storage._combine_lane_cell(self.cells.get(key), row_)
        return True

    async def decay_lane_cells(self, factor, floor):
        self.decay_calls += 1
        return 0

    async def record_source_health(self, source, item_count, ok, error=None):
        self.health.append((source, item_count, ok, error))


def test_a_failed_chokepoint_write_holds_the_cursor_back_and_never_touches_lane_cells(monkeypatch):
    """run_once's own ordering claim: if the chokepoint write fails,
    upsert_lane_cells must not even be attempted this pass -- otherwise a
    retry (forced by the withheld cursor) would call it a second time on a
    batch a *later* successful chokepoint write might have already covered,
    which is exactly the double-count run_once's docstring warns about."""
    rows = [row(1, "2026-08-01", *HORMUZ_POINT, "111")]
    fake = _FakeStorage(rows, choke_write_ok=False)
    monkeypatch.setattr(lane_density, "storage", fake)

    result = _run(lane_density.run_once())
    assert result["ok"] is False
    assert lane_density.CURSOR_NAME not in fake.docs
    assert fake.lane_batches == []  # upsert_lane_cells was never even called

    # Recovers; the batch is retried and this time goes all the way through.
    fake.choke_write_ok = True
    retry = _run(lane_density.run_once())
    assert retry["ok"] is True
    assert fake.docs[lane_density.CURSOR_NAME] == {"last_id": 1}
    assert len(fake.lane_batches) == 1  # upsert_lane_cells ran exactly once


def test_a_failed_lane_cell_write_leaves_chokepoint_counts_correct_after_a_retry(monkeypatch):
    """The reverse failure: chokepoint writes land durably, then
    upsert_lane_cells fails. The cursor is withheld and the whole batch is
    reprocessed next pass -- which replays compute_chokepoints against a
    state that already includes this batch. That replay must be a no-op, not
    a double count, which is what makes it safe to have written chokepoints
    first at all."""
    mmsi = "111"
    rows = [row(1, "2026-08-01", *HORMUZ_POINT, mmsi, ship_type=84)]
    fake = _FakeStorage(rows, write_ok=False)
    monkeypatch.setattr(lane_density, "storage", fake)

    first = _run(lane_density.run_once())
    assert first["ok"] is False
    assert lane_density.CURSOR_NAME not in fake.docs
    choke_doc_after_first_failure = fake.docs[lane_density.CHOKEPOINT_DOC_NAME]
    today = choke_doc_after_first_failure["boxes"][HORMUZ_LABEL]["today"]
    assert today["total"] == 1  # the durable write already reflects this batch

    # The database recovers; the same batch is retried.
    fake.write_ok = True
    second = _run(lane_density.run_once())
    assert second["ok"] is True
    assert fake.docs[lane_density.CURSOR_NAME] == {"last_id": 1}
    replayed_today = fake.docs[lane_density.CHOKEPOINT_DOC_NAME]["boxes"][HORMUZ_LABEL]["today"]
    assert replayed_today["total"] == 1  # still one distinct hull, not two -- the replay was a no-op

    # upsert_lane_cells was *attempted* twice (once failed, once succeeded),
    # but only the second attempt actually merged into the stored grid --
    # the first returned False before touching it. Checking the merged
    # result, not just the call count, is what actually proves no cell was
    # double counted.
    assert len(fake.lane_batches) == 2
    (cell,) = fake.cells.values()
    assert cell["transits"] == 1


def test_a_pass_with_nothing_new_writes_nothing(monkeypatch):
    fake = _FakeStorage([])
    monkeypatch.setattr(lane_density, "storage", fake)
    result = _run(lane_density.run_once())
    assert result == {"read": 0, "cells": 0, "ok": True}
    assert fake.docs == {}


# --- Task 52: recovering from an old-shaped chokepoint_state document ------


def test_run_once_recovers_from_an_old_shaped_chokepoint_state(monkeypatch, caplog):
    """A day-entry shape change is the concrete hazard Task 52's own brief
    names for this module: _finalize_and_prune's `mmsis.values()` (called
    once a day-entry is old enough to close, see that function) raises
    AttributeError against a day whose own "mmsis" is a list rather than a
    dict -- a plausible earlier shape (membership as a bare list of MMSIs,
    before by_class tallying needed a dict) that would otherwise freeze this
    job's cursor forever while decay keeps running (see the module
    docstring's "worst case" note). This drives the whole stack through
    run_once() itself -- _cursor.load_state, compute_chokepoints,
    _finalize_and_prune, both writes -- not just the version check in
    isolation, matching jam_crosscheck.py's own equivalent test.
    """
    old_shaped_state = {
        "schema_version": 0,  # an explicitly incompatible, superseded shape
        "days_seen": ["2026-07-01"],
        "latest_day": "2026-07-01",
        "boxes": {
            HORMUZ_LABEL: {
                "days": {
                    # Old-shaped: a bare list of MMSIs rather than {mmsi: cls}.
                    # Handed straight to _finalize_and_prune once this pass's
                    # own new rows push latest_day far enough past
                    # 2026-07-01 to close it, `mmsis.values()` would raise.
                    "2026-07-01": {"status": "open", "mmsis": ["999"]},
                },
            },
        },
    }
    lat, lon = HORMUZ_POINT
    rows = [row(1, "2026-08-05", lat, lon, "111")]  # far past 2026-07-01 -- would force the close path
    fake = _FakeStorage(rows)
    fake.docs[lane_density.CHOKEPOINT_STATE_NAME] = old_shaped_state
    monkeypatch.setattr(lane_density, "storage", fake)

    with caplog.at_level("WARNING", logger="osint-globe.refine"):
        result = _run(lane_density.run_once())
    assert result["ok"] is True  # did not raise
    assert any("schema_version" in r.message for r in caplog.records)  # logged, not silent

    new_state = fake.docs[lane_density.CHOKEPOINT_STATE_NAME]
    assert new_state["schema_version"] == lane_density.CHOKEPOINT_STATE_SCHEMA_VERSION
    # The old, incompatible 2026-07-01 entry is gone -- state was discarded
    # wholesale, not selectively repaired -- so this pass's own new row is
    # the only thing in the rebuilt state.
    assert "2026-07-01" not in new_state.get("days_seen", [])
    assert new_state["days_seen"] == ["2026-08-05"]
    doc = fake.docs[lane_density.CHOKEPOINT_DOC_NAME]
    today = doc["boxes"][HORMUZ_LABEL]["today"]
    assert today["date"] == "2026-08-05"
    assert today["total"] == 1
    # The cursor still advanced past this pass's own rows -- a state reset
    # must never rewind or stall the cursor (see the module docstring).
    assert fake.docs[lane_density.CURSOR_NAME] == {"last_id": 1}


def test_a_pre_task_52_state_document_with_no_schema_version_is_not_reset(monkeypatch, caplog):
    """CHOKEPOINT_STATE_SCHEMA_VERSION's own comment claims adopting this
    guard does not, by itself, discard a real chokepoint_state document that
    predates it -- every one of those has no "schema_version" key at all,
    which _cursor.load_state treats as version 1 by default (see that
    function's docstring), matching CHOKEPOINT_STATE_SCHEMA_VERSION==1
    exactly. Unlike port_calls.py/flight_legs.py/vessel_profile.py, this
    document's shape is not changing in Task 52 -- so, unlike those three
    modules' own equivalent tests, real pre-existing state must survive
    unchanged into this pass's own output, not be discarded."""
    assert lane_density.CHOKEPOINT_STATE_SCHEMA_VERSION == 1
    pre_task_52_state = {
        "days_seen": ["2026-08-01"],
        "latest_day": "2026-08-01",
        "boxes": {HORMUZ_LABEL: {"days": {"2026-08-01": {"status": "open", "mmsis": {"111": None}}}}},
    }
    assert "schema_version" not in pre_task_52_state

    lat, lon = HORMUZ_POINT
    rows = [row(1, "2026-08-01", lat, lon, "222")]  # same day -- extends the still-open entry
    fake = _FakeStorage(rows)
    fake.docs[lane_density.CHOKEPOINT_STATE_NAME] = pre_task_52_state
    monkeypatch.setattr(lane_density, "storage", fake)

    with caplog.at_level("WARNING", logger="osint-globe.refine"):
        result = _run(lane_density.run_once())
    assert result["ok"] is True
    assert not any("schema_version" in r.message for r in caplog.records)  # no reset -- nothing to log

    day = fake.docs[lane_density.CHOKEPOINT_STATE_NAME]["boxes"][HORMUZ_LABEL]["days"]["2026-08-01"]
    # Both the pre-existing "111" and this pass's own "222" are present --
    # the old entry was carried forward and extended, not wiped and rebuilt.
    assert set(day["mmsis"]) == {"111", "222"}
