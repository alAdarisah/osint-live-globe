"""What the ingest process is scheduled to do, and what it must never do.

The job table (backend/ingest) is the contract between two processes that never
talk to each other, so most of what can go wrong here is silent: a source in
neither list is simply never collected, a stream on an interval trigger hammers
a service that is already down, and a shortened ADS-B interval spends a credit
budget that only shows up as 429s in the afternoon.
"""

import asyncio

import pytest

from backend import config, ingest, storage


def _run(coro):
    return asyncio.run(coro)


def _job(module_name):
    return next(job for job in ingest.all_jobs() if job.module == module_name)


# --- what is in the table -------------------------------------------------


def test_scheduled_jobs_are_exactly_the_metered_pollers():
    assert {job.module for job in ingest.jobs()} == {
        "acled", "firms", "adsb", "gfw_detections",
    }


def test_self_paced_sources_are_not_on_an_interval():
    """Both would be actively harmful on a timer -- see the Job entries' comments."""
    assert {job.module for job in ingest.streams()} == {"ais", "osm_infra"}
    for job in ingest.streams():
        assert job.interval is None


def test_every_job_publishes_at_least_one_state():
    for job in ingest.all_jobs():
        assert job.publishes, f"{job.module} collects data nothing is registered to serve"


def test_acled_publishes_the_live_feed_and_the_reviewed_history_separately():
    """Fusing them would let a month-old verified dataset read as current events."""
    assert [pub.kind for pub in _job("acled").publishes] == ["acled", "conflict_history"]


def test_published_kinds_are_unique():
    kinds = [pub.kind for pub in ingest.published()]
    assert len(kinds) == len(set(kinds)), "two jobs writing one kind would overwrite each other"


def test_every_published_kind_has_a_retention_window():
    """A kind missing from ENTITY_STALE_AFTER silently falls back to 24h.

    For AIS that is 48x its intended 30 minutes, so the map would keep drawing
    ships that reported yesterday as though they were there now.
    """
    for pub in ingest.published():
        assert pub.kind in config.ENTITY_STALE_AFTER, (
            f"{pub.kind} has no entry in config.ENTITY_STALE_AFTER and would be "
            f"evicted on the {config.ENTITY_STALE_AFTER_DEFAULT}s default"
        )


# --- intervals ------------------------------------------------------------


def test_adsb_interval_respects_the_opensky_credit_budget(monkeypatch):
    """OpenSky charges 4 credits per global states/all against 4000 a day.

    That makes the real ceiling 1000 polls a day, so anything under 86.4s runs
    the account dry before evening and answers 429 until the reset. This is a
    regression test for the number, not a restatement of it -- the reasoning
    lives on config.ADSB_POLL_INTERVAL_AUTH.
    """
    monkeypatch.setattr(config, "OPENSKY_CLIENT_ID", "id")
    monkeypatch.setattr(config, "OPENSKY_CLIENT_SECRET", "secret")
    interval = _job("adsb").interval()
    assert interval == config.ADSB_POLL_INTERVAL_AUTH
    credits_per_day = (86400 / interval) * 4
    assert credits_per_day <= 4000, (
        f"{interval}s spends {credits_per_day:.0f} OpenSky credits a day against a "
        f"4000 budget -- the account runs dry before evening and answers 429"
    )


def test_adsb_falls_back_to_the_anonymous_interval_without_credentials(monkeypatch):
    monkeypatch.setattr(config, "OPENSKY_CLIENT_ID", "")
    monkeypatch.setattr(config, "OPENSKY_CLIENT_SECRET", "")
    assert _job("adsb").interval() == config.ADSB_POLL_INTERVAL_ANON


def test_acled_polls_at_the_ucdp_rate_without_credentials(monkeypatch):
    """Without an ACLED account the only thing moving is UCDP's monthly file."""
    monkeypatch.setattr(config, "ACLED_EMAIL", "")
    monkeypatch.setattr(config, "ACLED_PASSWORD", "")
    assert _job("acled").interval() == config.UCDP_POLL_INTERVAL

    monkeypatch.setattr(config, "ACLED_EMAIL", "a@b.c")
    monkeypatch.setattr(config, "ACLED_PASSWORD", "pw")
    assert _job("acled").interval() == config.ACLED_POLL_INTERVAL


def test_expected_every_matches_the_interval_for_scheduled_jobs():
    for job in ingest.jobs():
        assert job.expected_every() == job.interval()


@pytest.mark.parametrize(
    "module_name,constant",
    [("ais", "HEALTH_INTERVAL"), ("osm_infra", "REFRESH_INTERVAL")],
)
def test_stream_health_cadence_matches_the_source_module(module_name, constant):
    """The two hardcoded copies in the job table, checked against the originals.

    They are copied rather than imported so the backend can read the job table
    without loading websocket and HTTP client machinery. This is the price of
    that: an assertion that the copy is still true.
    """
    import importlib

    module = importlib.import_module(f"backend.sources.{module_name}")
    assert _job(module_name).expected_every() == getattr(module, constant)


# --- dispatch -------------------------------------------------------------


class _Recorder:
    def __init__(self):
        self.rows = []

    async def record(self, source, item_count, ok, error=None):
        self.rows.append((source, item_count, ok, error))


def test_run_job_records_a_failure_instead_of_raising(monkeypatch):
    """A raising job must not reach the scheduler.

    APScheduler would log it and carry on, but /api/health is built from
    source_health rows, not from that log -- so an ingest job crashing every
    interval would leave the layer showing its last good data under a green
    light, indefinitely.
    """
    recorder = _Recorder()
    monkeypatch.setattr(storage, "record_source_health", recorder.record)

    async def boom():
        raise RuntimeError("upstream on fire")

    module = type("M", (), {"ingest_once": staticmethod(boom)})
    monkeypatch.setattr(
        ingest.importlib, "import_module", lambda name: module
    )

    _run(ingest.run_job(_job("firms")))
    assert recorder.rows == [("firms", None, False, "upstream on fire")]


def test_run_job_records_a_failure_for_every_state_the_job_publishes(monkeypatch):
    """ACLED's two halves fail together, so both have to go red together."""
    recorder = _Recorder()
    monkeypatch.setattr(storage, "record_source_health", recorder.record)

    async def boom():
        raise RuntimeError("no token")

    module = type("M", (), {"ingest_once": staticmethod(boom)})
    monkeypatch.setattr(ingest.importlib, "import_module", lambda name: module)

    _run(ingest.run_job(_job("acled")))
    assert [row[0] for row in recorder.rows] == ["acled", "conflict_history"]


def test_run_job_writes_nothing_when_the_job_succeeds(monkeypatch):
    """The job records its own health; run_job only covers the crash case."""
    recorder = _Recorder()
    monkeypatch.setattr(storage, "record_source_health", recorder.record)

    async def fine():
        return None

    module = type("M", (), {"ingest_once": staticmethod(fine)})
    monkeypatch.setattr(ingest.importlib, "import_module", lambda name: module)

    _run(ingest.run_job(_job("firms")))
    assert recorder.rows == []


def test_every_entrypoint_exists_on_its_module():
    """Catches a rename that would otherwise only fail in the running container."""
    import importlib

    for job in ingest.all_jobs():
        module = importlib.import_module(f"backend.sources.{job.module}")
        assert hasattr(module, job.entrypoint), (
            f"backend/ingest names {job.module}.{job.entrypoint}, which does not exist"
        )


def test_moved_sources_no_longer_expose_a_backend_poll_loop():
    """`start()` is what app.py schedules. Leaving one behind on a moved source
    would let the backend poll a metered API again the moment someone re-added
    it to _SOURCE_MODULES -- which is the exact bug this split removed."""
    import importlib

    for job in ingest.all_jobs():
        module = importlib.import_module(f"backend.sources.{job.module}")
        assert not hasattr(module, "start"), (
            f"{job.module} still has start(); it is ingested now, not polled"
        )
