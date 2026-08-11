"""backend/app.py's _derived_job_health -- the health rows for refine jobs
that write straight to Postgres rather than publishing a registry-mirrored
layer (port_calls, vessel_profiles, lane_density, flight_legs; see their Job
entries in backend/refine/__init__.py, all with publishes=()).

Before Task 31 these were invisible on /api/health entirely: registry.health()
only knows about sources a poller or a mirror follower registered a
SourceState for, and none of these four ever got one. This is the same
"a layer collected correctly, stored correctly and never shown, with nothing
in /api/health to say so" failure mirror.py's own module docstring warns
about, just for a table instead of a point layer -- and this module's tests
are the same shape test_mirror.py already uses for the mirrored half.
"""

import asyncio
import time
from datetime import datetime, timezone

from backend.app import _DERIVED_JOB_HEALTH_NAMES, _derived_job_health
from backend.refine import all_jobs


def _run(coro):
    return asyncio.run(coro)


def _ts(seconds_ago):
    # _derived_job_health() calls time.time() itself rather than taking a
    # `now` argument (unlike mirror.health_verdict, which test_mirror.py
    # drives against a fixed constant) -- so these rows have to be timestamped
    # against the real clock, not a fake one, or "30 seconds ago" would
    # actually be however far the fake epoch sits from today.
    return datetime.fromtimestamp(time.time() - seconds_ago, tz=timezone.utc)


def test_the_four_named_jobs_are_real_entries_in_the_job_table():
    """The anti-drift check test_mirror.py's own wiring tests run for the
    mirrored half: a name in _DERIVED_JOB_HEALTH_NAMES that no longer matches
    a Job.health_name would silently produce no row at all."""
    known = {job.health_name for job in all_jobs()}
    assert _DERIVED_JOB_HEALTH_NAMES <= known


def test_a_job_that_has_never_run_says_so(monkeypatch):
    from backend import storage

    async def source_health_latest(name):
        return None, None

    monkeypatch.setattr(storage, "source_health_latest", source_health_latest)
    health = _run(_derived_job_health())
    assert set(health) == _DERIVED_JOB_HEALTH_NAMES
    for name, row in health.items():
        assert row["item_count"] == 0
        assert row["last_success"] is None
        assert "the refine service" in row["last_error"]


def test_a_healthy_job_reports_its_own_row_count(monkeypatch):
    from backend import storage

    row = {"ts": _ts(30), "item_count": 42, "ok": True, "error": None}

    async def source_health_latest(name):
        return row, row

    monkeypatch.setattr(storage, "source_health_latest", source_health_latest)
    health = _run(_derived_job_health())
    assert health["port_calls"]["item_count"] == 42
    assert health["port_calls"]["last_error"] is None
    assert health["port_calls"]["seconds_since_success"] is not None


def test_a_stalled_job_is_reported_frozen_using_its_own_interval(monkeypatch):
    """expected_every comes from the job table (config.PORT_CALL_INTERVAL
    etc.), not a restated number -- a job whose interval changes cannot drift
    this health check out of step with it."""
    from backend import config, storage

    stale = {
        "ts": _ts(int(config.LANE_DENSITY_INTERVAL * 3)),
        "item_count": 900,
        "ok": True,
        "error": None,
    }

    async def source_health_latest(name):
        return stale, stale

    monkeypatch.setattr(storage, "source_health_latest", source_health_latest)
    health = _run(_derived_job_health())
    assert "frozen" in health["lane_density"]["last_error"]


def test_health_endpoint_merges_registry_and_derived_rows_and_alerts(monkeypatch):
    from backend import app as app_module
    from backend import storage
    from backend.cache import registry

    registry.register("some_source", key_configured=True)

    async def source_health_latest(name):
        return None, None

    async def active_alerts():
        return []

    monkeypatch.setattr(storage, "source_health_latest", source_health_latest)
    monkeypatch.setattr(storage, "active_alerts", active_alerts)

    body = _run(app_module.health())
    assert "some_source" in body
    assert _DERIVED_JOB_HEALTH_NAMES <= set(body)
    assert body["alerts"] == []
