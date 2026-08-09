"""Every source persists what it collects, and reads it back at startup.

These are structural tests over the source modules rather than behavioural
tests of any one of them. They exist because the failure they catch is silent:
a new source that forgets to call storage looks completely healthy -- it polls,
it serves, /api/health is green -- and the only symptom is that its layer is
empty for a while after every restart, which reads as a rendering bug.

Both lists below are deliberately explicit. Adding a source means adding a line
here or a storage call there, and the exemption list has to say why.
"""

import ast
import asyncio
import pathlib
from datetime import datetime, timezone

import pytest

from backend import config, storage
from backend.app import _SOURCE_MODULES, _mirrored_specs
from backend.ingest import all_jobs
from backend.refine import all_jobs as refine_jobs

SOURCES = pathlib.Path(__file__).resolve().parent.parent / "sources"

# The sources that moved to the ingest process. They are still checked for
# writes -- more strictly than before, since a write is now the *only* way their
# data reaches anyone -- but not for reading their own data back: they serve no
# one, so there is nothing for a warm to fill. What replaces that check is
# test_every_ingested_kind_is_mirrored below.
_INGEST_MODULES = tuple(job.module for job in all_jobs())

# The refine jobs that live in sources/, on the same footing: they derive rather
# than fetch, but a derivation nothing persists is just as invisible. escalation
# is excluded because it is not in sources/ and writes a reference document
# rather than point rows -- test_refine_jobs.py covers it instead.
_REFINE_MODULES = tuple(
    job.module.rsplit(".", 1)[1]
    for job in refine_jobs()
    if job.module.startswith("backend.sources.")
)

# Sources that must not serve stored data at startup, and why. Writing is still
# required of them -- the point of the write is the replay timeline.
NOT_WARMED = {
    # Publishes positions that are wrong within the minute, so restoring them
    # would draw a satellite where it used to be as though that were where it
    # is. It recomputes from stored orbital elements instead, which is the
    # honest equivalent. (adsb used to sit here for the same reason; it moved to
    # the ingest process, and the backend does now read its positions back --
    # see the docstring on adsb.ingest_once for why that became unavoidable and
    # what bounds it.)
    "satellites": "positions are recomputed from stored elements, never restored",
    # The only source whose layer is served without going through its registry
    # state at all: /api/district-boundaries reads storage.reference() per
    # country on each cache miss (see app.py), because six countries of geometry
    # is several megabytes and handing over all of it to a reader looking at one
    # of them is the thing that endpoint exists to avoid. So the geometry is
    # already warm from Postgres the moment the process starts, and state.data
    # holds only the per-country feature counts /api/health reports. A warm here
    # would restore a number, not a layer.
    "admin2_boundaries": "the layer is read from Postgres per request, not from registry state",
    # Same arrangement, one admin level up: /api/admin1-boundaries reads
    # storage.reference() per country, so the geometry is warm from Postgres
    # without this module restoring anything into its registry state.
    "admin1_boundaries": "the layer is read from Postgres per request, not from registry state",
}

_WRITE_CALLS = ("record_snapshot", "record_reference")
_READ_CALLS = ("warm_points", "warm_reference", "entity_latest", "reference")


def _storage_calls(module_name: str) -> set[str]:
    """Every storage.X(...) attribute called anywhere in the module."""
    tree = ast.parse((SOURCES / f"{module_name}.py").read_text(encoding="utf-8"))
    called = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "storage"
        ):
            called.add(func.attr)
    return called


@pytest.mark.parametrize("module_name", _SOURCE_MODULES + _INGEST_MODULES + _REFINE_MODULES)
def test_every_source_writes_what_it_collects_to_postgres(module_name):
    called = _storage_calls(module_name)
    assert called & set(_WRITE_CALLS), (
        f"{module_name} collects data but never persists it. Point rows go to "
        f"storage.record_snapshot; whole documents (no per-row lat/lon) go to "
        f"storage.record_reference."
    )


@pytest.mark.parametrize("module_name", _INGEST_MODULES + _REFINE_MODULES)
def test_every_ingested_kind_is_mirrored(module_name):
    """An ingest source nothing mirrors is collected, stored, and never shown.

    That failure is silent in the worst way: the ingest container is healthy,
    the rows are in Postgres, and the only symptom is a permanently empty map
    layer -- with nothing on /api/health to say so, because a source the backend
    never registered has no state to go red. Both sides are built from the same
    job table for exactly this reason; this asserts that stays true.
    """
    mirrored = {spec.kind for spec in _mirrored_specs()}
    job = next(
        job for job in all_jobs() + refine_jobs()
        if job.module.rsplit(".", 1)[-1] == module_name
    )
    for pub in job.publishes:
        assert pub.kind in mirrored, (
            f"{module_name} writes entity_latest kind {pub.kind!r} but nothing "
            f"in backend/mirror.py reads it back, so the backend will never "
            f"serve it."
        )


@pytest.mark.parametrize("module_name", _SOURCE_MODULES)
def test_every_source_reads_its_own_data_back_at_startup(module_name):
    if module_name in NOT_WARMED:
        pytest.skip(f"{module_name}: {NOT_WARMED[module_name]}")
    called = _storage_calls(module_name)
    assert called & set(_READ_CALLS), (
        f"{module_name} persists data but never restores it, so its layer is "
        f"empty after every restart until the next successful fetch. Use "
        f"storage.warm_points / storage.warm_reference, or add {module_name} to "
        f"NOT_WARMED with a reason."
    )


def test_satellites_stores_elements_not_positions():
    """The exemption above is only honest if the elements really are stored.

    And only *complete* if the positions are not stored alongside them. They
    were, for a while: a record_snapshot call put 471k recomputed positions into
    entity_history that no reader ever asked for -- /api/replay has no satellite
    layer and this source warms from the elements. The rule was written down and
    passed its test while the code did the opposite, so the second half is
    asserted here rather than left to the docstring.
    """
    text = (SOURCES / "satellites.py").read_text(encoding="utf-8")
    assert 'record_reference("satellite_elements"' in text
    assert 'reference("satellite_elements")' in text
    assert "record_snapshot(" not in text, (
        "satellites.py stores positions. They are arithmetic over the stored "
        "elements -- recompute them at the moment asked for instead."
    )


# --- storage.warm_* semantics ---------------------------------------------


class _FakeState:
    """Stands in for cache.SourceState: warm_* only touches .data."""

    def __init__(self, data=None):
        self.data = data if data is not None else []


def _run(coro):
    return asyncio.run(coro)


def _patch_pool(monkeypatch, available=True):
    async def wait_for_pool(timeout=30.0):
        return available

    monkeypatch.setattr(storage, "wait_for_pool", wait_for_pool)


def test_warm_fills_an_empty_state(monkeypatch):
    _patch_pool(monkeypatch)

    async def load():
        return [{"id": "a"}]

    state = _FakeState()
    assert _run(storage._warm(state, load, "test")) is True
    assert state.data == [{"id": "a"}]


def test_warm_never_overwrites_data_a_live_fetch_already_produced(monkeypatch):
    """The whole point is to fill a gap, not to undo a fast first fetch."""
    _patch_pool(monkeypatch)

    async def load():
        return [{"id": "stored"}]

    state = _FakeState([{"id": "live"}])
    assert _run(storage._warm(state, load, "test")) is False
    assert state.data == [{"id": "live"}]


def test_warm_rechecks_after_waiting_for_the_pool(monkeypatch):
    """Waiting for Postgres can take seconds; a fetch landing in that window wins.

    Without the second check this would restore an older snapshot over data
    that arrived while the pool was still connecting -- a race that only shows
    up on a cold Postgres, which is exactly the case this code path exists for.
    """
    state = _FakeState()

    async def wait_for_pool(timeout=30.0):
        state.data = [{"id": "live"}]  # the poller wins the race mid-await
        return True

    monkeypatch.setattr(storage, "wait_for_pool", wait_for_pool)

    async def load():
        return [{"id": "stored"}]

    assert _run(storage._warm(state, load, "test")) is False
    assert state.data == [{"id": "live"}]


def test_warm_is_a_no_op_without_a_database(monkeypatch):
    _patch_pool(monkeypatch, available=False)

    async def load():
        raise AssertionError("must not read without a pool")

    state = _FakeState()
    assert _run(storage._warm(state, load, "test")) is False
    assert state.data == []


def test_warm_leaves_the_state_empty_when_nothing_is_stored(monkeypatch):
    _patch_pool(monkeypatch)

    async def load():
        return []

    state = _FakeState()
    assert _run(storage._warm(state, load, "test")) is False
    assert state.data == []


# --- storage.history_at semantics -----------------------------------------
#
# What the replay scrubber reads. Both properties below were once wrong in
# ways no test could see: the query took every entity recorded up to `at`
# (so scrubbing to yesterday drew every aircraft of the last three days at
# once), and when it found none it returned each entity's earliest position
# instead (so every timestamp older than the log returned the same bytes,
# and dragging changed nothing on the map).


class _FakeConn:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    async def fetch(self, query, *args):
        self.calls.append((query, args))
        return self.rows


class _FakePool:
    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        pool_conn = self.conn

        class _Ctx:
            async def __aenter__(self):
                return pool_conn

            async def __aexit__(self, *exc):
                return False

        return _Ctx()


def _history_conn(monkeypatch, rows=()):
    conn = _FakeConn(list(rows))
    monkeypatch.setattr(storage, "_pool", _FakePool(conn))
    return conn


def test_history_at_only_asks_for_entities_live_at_that_moment(monkeypatch):
    conn = _history_conn(monkeypatch)
    _run(storage.history_at("adsb", 1_700_000_000))

    (_, args), = conn.calls
    kind, when, window = args
    assert kind == "adsb"
    assert when.timestamp() == 1_700_000_000
    assert window.total_seconds() == config.REPLAY_WINDOW_SECONDS["adsb"]


def test_history_at_falls_back_to_the_eviction_window(monkeypatch):
    """Kinds without a replay window of their own refresh slowly enough that
    "forget it" and "too old to place" are the same question."""
    conn = _history_conn(monkeypatch)
    _run(storage.history_at("cities", 1_700_000_000))

    (_, (_, _, window)), = conn.calls
    assert window.total_seconds() == config.ENTITY_STALE_AFTER["cities"]


def test_history_at_window_can_be_narrowed_by_the_caller(monkeypatch):
    """FIRMS rows outlive what its feed actually holds -- see /api/replay."""
    conn = _history_conn(monkeypatch)
    _run(storage.history_at("firms", 1_700_000_000, window_seconds=6 * 3600))

    (_, (_, _, window)), = conn.calls
    assert window.total_seconds() == 6 * 3600


def test_history_at_is_empty_before_anything_was_recorded(monkeypatch):
    conn = _history_conn(monkeypatch, rows=[])
    assert _run(storage.history_at("ais", 1_700_000_000)) == []
    assert len(conn.calls) == 1, "no second, unwindowed query may run as a fallback"


# --- storage.sweep_stale_entities ------------------------------------------
#
# Eviction that survives its producer. record_snapshot applies the same cutoff,
# but it returns early on a poll with no items -- so when AIS stopped on
# 2026-08-05, its 839 last-known ships stayed in entity_latest for 28 hours
# against a 30-minute window, and the dark-vessel detector went on reading
# gaps out of them. These tests are that case.


class _SweepConn:
    """Just enough asyncpg to drive sweep_stale_entities: kinds in, tags out."""

    def __init__(self, kinds, deleted=None):
        self.kinds = kinds
        self.deleted = deleted or {}
        self.deletes = []
        self.notified = []

    async def fetch(self, query, *args):
        assert "DISTINCT kind" in query
        return [{"kind": k} for k in self.kinds]

    async def execute(self, query, *args):
        if query.lstrip().startswith("SELECT pg_notify"):
            self.notified.append(args[1])
            return "SELECT 1"
        self.deletes.append(args)
        return f"DELETE {self.deleted.get(args[0], 0)}"


def test_sweep_evicts_a_dead_sources_rows_with_no_poll_involved():
    now = datetime(2026, 8, 6, 18, 0, tzinfo=timezone.utc)
    conn = _SweepConn(["ais"], deleted={"ais": 839})

    assert _run(storage.sweep_stale_entities(conn, now)) == {"ais": 839}
    assert conn.notified == ["ais"], (
        "an eviction has to announce itself like a write, or the mirror keeps "
        "serving the rows it just dropped"
    )


def test_sweep_applies_each_kinds_own_window():
    now = datetime(2026, 8, 6, 18, 0, tzinfo=timezone.utc)
    conn = _SweepConn(["ais", "cities"])
    _run(storage.sweep_stale_entities(conn, now))

    cutoffs = {kind: cutoff for kind, cutoff in conn.deletes}
    assert (now - cutoffs["ais"]).total_seconds() == config.ENTITY_STALE_AFTER["ais"]
    assert (now - cutoffs["cities"]).total_seconds() == config.ENTITY_STALE_AFTER["cities"]


def test_sweep_stays_quiet_when_nothing_has_expired():
    conn = _SweepConn(["adsb"], deleted={"adsb": 0})
    now = datetime(2026, 8, 6, 18, 0, tzinfo=timezone.utc)

    assert _run(storage.sweep_stale_entities(conn, now)) == {}
    assert conn.notified == [], "a no-op sweep must not invalidate every client's ETag"


def test_sweep_reads_the_kinds_from_the_table():
    """Not from a list. A kind stops being produced long before anyone edits a
    list, and that is precisely when its rows need sweeping."""
    conn = _SweepConn(["ais", "adsb", "some_retired_kind"])
    _run(storage.sweep_stale_entities(conn, datetime.now(timezone.utc)))

    assert [kind for kind, _ in conn.deletes] == ["ais", "adsb", "some_retired_kind"]
