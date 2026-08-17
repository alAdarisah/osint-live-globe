"""The backend's read side for the ingest process's data.

Two properties carry this module, and both fail silently when they break.

The watermark gate is an ETag test wearing a database costume: state.version is
the ETag (see backend/cache.py and app.py's _cached_source_response), and a
mirror that republishes unchanged data bumps it, so every client re-downloads a
100k-point payload several times a minute and nothing looks wrong from either
end.

health_verdict is the difference between a dead ingest container being visible
and the map showing hours-old data under a green light.
"""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend import config, mirror, storage
from backend.cache import SourceState


def _run(coro):
    return asyncio.run(coro)


NOW = 1_700_000_000.0


def _ts(seconds_ago):
    return datetime.fromtimestamp(NOW - seconds_ago, tz=timezone.utc)


def _spec(**overrides):
    base = dict(name="firms", kind="firms", label="FIRMS", expected_every=900)
    base.update(overrides)
    return mirror.Mirrored(**base)


# --- health_verdict -------------------------------------------------------


def test_a_source_that_has_never_run_says_so():
    """Distinct from "ran and found nothing": an empty layer looks the same
    either way, and only one of them means the container is broken."""
    last_success, error = mirror.health_verdict(None, None, 900, NOW, "the ingest service")
    assert last_success is None
    assert "the ingest service" in error


def test_a_recent_successful_run_reports_the_ingests_own_timestamp():
    """Not the time the backend read the database -- that number would say the
    mirror is healthy, which was never in question."""
    row = {"ts": _ts(30), "item_count": 5, "ok": True, "error": None}
    last_success, error = mirror.health_verdict(row, row, 900, NOW, "the ingest service")
    assert last_success == pytest.approx(NOW - 30)
    assert error is None


def test_a_rate_limited_source_is_not_frozen_inside_its_configured_window():
    """marinesia is scheduled every 1800s but its key affords one request an hour, so a
    three-box rotation legitimately takes hours. Judged on the interval alone it was called
    frozen while it was working -- 4729s old against a 4500s threshold -- and the alert said
    so once a minute. ENTITY_STALE_AFTER already carries the real window for exactly these
    sources; the verdict has to honour it."""
    row = {"ts": _ts(4729), "item_count": 19, "ok": True, "error": None}
    _, without = mirror.health_verdict(row, row, 1800, NOW, "the ingest service")
    assert "frozen" in without, "the interval alone still calls this overdue"

    _, with_window = mirror.health_verdict(
        row, row, 1800, NOW, "the ingest service", stale_after=4 * 3600
    )
    assert with_window is None


def test_the_configured_window_is_a_floor_and_never_a_ceiling():
    """A source with a generous window still goes overdue once it passes it -- the floor
    raises the threshold for a rate-limited source, it does not excuse a dead one."""
    row = {"ts": _ts(5 * 3600), "item_count": 19, "ok": True, "error": None}
    _, error = mirror.health_verdict(
        row, row, 1800, NOW, "the ingest service", stale_after=4 * 3600
    )
    assert "frozen" in error


def test_a_source_with_no_configured_window_keeps_the_interval_rule():
    """Most sources have no ENTITY_STALE_AFTER entry, and nothing about them changes."""
    row = {"ts": _ts(4000), "item_count": 5, "ok": True, "error": None}
    _, floorless = mirror.health_verdict(row, row, 900, NOW, "the ingest service")
    _, explicit_none = mirror.health_verdict(
        row, row, 900, NOW, "the ingest service", stale_after=None
    )
    assert "frozen" in floorless
    assert floorless == explicit_none


def test_a_failing_source_carries_the_producers_message_and_its_last_good_time():
    failed = {"ts": _ts(10), "item_count": None, "ok": False, "error": "401 Unauthorized"}
    succeeded = {"ts": _ts(3600), "item_count": 12}
    last_success, error = mirror.health_verdict(
        failed, succeeded, 900, NOW, "the ingest service"
    )
    assert last_success == pytest.approx(NOW - 3600)
    assert "401 Unauthorized" in error
    assert "the ingest service" in error, "the reader has to know which process failed"


def test_a_stale_failure_says_both_what_broke_and_how_long_ago():
    """A producer that writes one failure and then dies leaves that row newest
    forever. Reporting only its message showed a live-looking error for a
    process that had not run in hours -- which is how a stopped ingest container
    looked in practice."""
    failed = {"ts": _ts(7200), "item_count": None, "ok": False, "error": "stream closed"}
    _, error = mirror.health_verdict(failed, None, 60, NOW, "the ingest service")
    assert "stream closed" in error
    assert "7200s" in error


def test_a_recent_failure_is_not_dressed_up_as_a_stale_one():
    failed = {"ts": _ts(5), "item_count": None, "ok": False, "error": "stream closed"}
    _, error = mirror.health_verdict(failed, None, 60, NOW, "the ingest service")
    assert error == "the ingest service: stream closed"


def test_a_source_that_stopped_running_is_reported_as_frozen():
    """The case the whole verdict exists for: the last run succeeded, so every
    field looks healthy, and it was two hours ago."""
    row = {"ts": _ts(7200), "item_count": 900, "ok": True, "error": None}
    _, error = mirror.health_verdict(row, row, 900, NOW, "the ingest service")
    assert "frozen" in error
    assert "7200s" in error


def test_a_run_slightly_over_its_interval_is_not_yet_a_failure():
    """One slow poll -- an ACLED login retrying, a long Overpass sweep -- must
    not read as a dead container."""
    row = {"ts": _ts(int(900 * config.INGEST_STALE_MULTIPLIER) - 60), "item_count": 3, "ok": True, "error": None}
    _, error = mirror.health_verdict(row, row, 900, NOW, "the ingest service")
    assert error is None


def test_the_staleness_threshold_scales_with_the_sources_own_cadence():
    """200s is nothing for ACLED's half-hour cadence and very late for AIS's 60s."""
    row = {"ts": _ts(200), "item_count": 1, "ok": True, "error": None}
    _, slow_source = mirror.health_verdict(row, row, 1800, NOW, "p")
    _, fast_source = mirror.health_verdict(row, row, 60, NOW, "p")
    assert slow_source is None
    assert fast_source is not None


# --- the watermark gate ---------------------------------------------------


class _Storage:
    """Stands in for the storage module's read calls."""

    def __init__(self, watermark=None, rows=None, health=(None, None), pool=True):
        self.watermark = watermark
        self.rows = rows if rows is not None else []
        self.health = health
        self.pool = pool
        self.payload_reads = 0

    def install(self, monkeypatch):
        async def kind_watermark(kind):
            return self.watermark

        async def entity_latest(kind, order_by_recency=False):
            self.payload_reads += 1
            return list(self.rows)

        async def source_health_latest(source):
            return self.health

        monkeypatch.setattr(storage, "kind_watermark", kind_watermark)
        monkeypatch.setattr(storage, "entity_latest", entity_latest)
        monkeypatch.setattr(storage, "source_health_latest", source_health_latest)
        monkeypatch.setattr(storage, "get_pool", lambda: object() if self.pool else None)
        return self


def _follower(spec=None):
    follower = mirror._Follower.__new__(mirror._Follower)
    follower.spec = spec or _spec()
    follower.state = SourceState(name="firms", key_configured=True)
    follower.watermark = None
    return follower


def test_a_changed_watermark_publishes_and_bumps_the_version_once(monkeypatch):
    fake = _Storage(watermark=_ts(10), rows=[{"id": "a"}]).install(monkeypatch)
    follower = _follower()

    _run(follower.refresh())
    assert follower.state.data == [{"id": "a"}]
    assert follower.state.version == 1
    assert fake.payload_reads == 1


def test_an_unchanged_watermark_reads_nothing_and_leaves_the_etag_alone(monkeypatch):
    """The ETag regression. state.version is the ETag; a re-read that produces
    identical data still invalidates every client's cached copy."""
    fake = _Storage(watermark=_ts(10), rows=[{"id": "a"}]).install(monkeypatch)
    follower = _follower()

    _run(follower.refresh())
    version_after_first = follower.state.version
    for _ in range(5):
        _run(follower.refresh())

    assert follower.state.version == version_after_first
    assert fake.payload_reads == 1, "the payload was re-read despite nothing changing"


def test_a_watermark_moving_again_republishes(monkeypatch):
    fake = _Storage(watermark=_ts(30), rows=[{"id": "a"}]).install(monkeypatch)
    follower = _follower()
    _run(follower.refresh())

    fake.watermark = _ts(5)
    fake.rows = [{"id": "a"}, {"id": "b"}]
    _run(follower.refresh())

    assert follower.state.data == [{"id": "a"}, {"id": "b"}]
    assert follower.state.version == 2


def test_everything_ageing_out_is_published_as_empty(monkeypatch):
    """A kind whose rows were all evicted really is empty, and saying so is the
    honest answer -- as distinct from the database being unreachable below."""
    fake = _Storage(watermark=_ts(30), rows=[{"id": "a"}]).install(monkeypatch)
    follower = _follower()
    _run(follower.refresh())

    fake.watermark = None
    fake.rows = []
    _run(follower.refresh())

    assert follower.state.data == []


def test_a_database_outage_keeps_the_last_payload(monkeypatch):
    """Not evidence the world emptied. Blanking the map on a Postgres restart
    is both wrong and alarming."""
    fake = _Storage(watermark=_ts(30), rows=[{"id": "a"}]).install(monkeypatch)
    follower = _follower()
    _run(follower.refresh())

    fake.pool = False
    _run(follower.refresh())

    assert follower.state.data == [{"id": "a"}]
    assert "no database connection" in follower.state.last_error


def test_a_failed_watermark_read_keeps_the_last_payload(monkeypatch):
    fake = _Storage(watermark=_ts(30), rows=[{"id": "a"}]).install(monkeypatch)
    follower = _follower()
    _run(follower.refresh())

    async def broken(kind):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(storage, "kind_watermark", broken)
    _run(follower.refresh())

    assert follower.state.data == [{"id": "a"}]
    assert "connection reset" in follower.state.last_error


def test_health_is_applied_to_the_state_on_every_pass(monkeypatch):
    stale = {"ts": _ts(9999), "item_count": 4, "ok": True, "error": None}
    _Storage(watermark=_ts(9999), rows=[{"id": "a"}], health=(stale, stale)).install(monkeypatch)
    follower = _follower()

    _run(follower.refresh())
    assert "frozen" in follower.state.last_error


# --- wiring ---------------------------------------------------------------


def test_the_backend_mirrors_everything_the_other_two_processes_publish():
    """The anti-drift check. A kind produced by neither table would be collected,
    stored, and never served -- with no health state to go red about it."""
    from backend.app import _mirrored_specs
    from backend.ingest import published as ingest_published
    from backend.refine import published as refine_published

    expected = {pub.kind for pub in ingest_published()} | {pub.kind for pub in refine_published()}
    assert {spec.kind for spec in _mirrored_specs()} == expected


def test_each_mirrored_source_names_the_process_that_produces_it():
    """"the ingest service is overdue" and "the refine service is overdue" send
    someone to different containers."""
    from backend.app import _mirrored_specs

    by_name = {spec.name: spec.producer for spec in _mirrored_specs()}
    assert by_name["firms"] == "the ingest service"
    assert by_name["events"] == "the refine service"


def test_register_creates_every_state_before_any_request_can_arrive():
    """app.py's endpoints do registry.get(name), which raises on an unknown one."""
    from backend.app import _mirrored_specs
    from backend.cache import registry

    specs = _mirrored_specs()
    mirror.register(specs)
    for spec in specs:
        assert registry.has(spec.name)


def test_register_does_not_discard_state_when_called_twice():
    """follow() calls it again after app.py already did."""
    from backend.app import _mirrored_specs
    from backend.cache import registry

    specs = _mirrored_specs()
    mirror.register(specs)
    state = registry.get("firms")
    state.data = [{"id": "x"}]
    version = state.version

    mirror.register(specs)
    assert registry.get("firms") is state
    assert registry.get("firms").version == version


def test_a_notification_wakes_only_the_kind_it_names():
    async def scenario():
        woken = asyncio.Event()
        other = asyncio.Event()
        mirror._wakeups["ais"] = woken
        mirror._wakeups["firms"] = other
        mirror._wake("ais")
        return woken.is_set(), other.is_set()

    assert _run(scenario()) == (True, False)


def test_a_notification_for_an_unmirrored_kind_is_ignored():
    """conflict_events notifies on the same channel and has no follower."""
    mirror._wakeups.clear()
    mirror._wake("conflict_events")  # must not raise
