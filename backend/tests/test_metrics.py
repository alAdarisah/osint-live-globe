"""The two properties that make /metrics safe to scrape on a fixed interval.

A metrics endpoint fails in ways an ordinary endpoint does not, because
Prometheus keeps asking whether or not anything is well:

  * If a scrape does I/O, a slow database turns into a scrape timeout -- and
    the series that would have explained the outage are the ones that go
    missing during it.
  * If a label can take an unbounded set of values, a crawler hitting random
    URLs mints a time series per URL, and that cost lands on Prometheus and
    stays there long after the crawler leaves.

Both are design rules that nothing else enforces, so they are pinned here.
The rest of the file covers the smaller trap: a gauge that reports 0 where it
means "never", which reads on a dashboard as "just now".
"""

import asyncio

import pytest

from backend import app as app_mod
from backend import metrics, storage
from backend.cache import registry
from backend.ratelimit import TokenBucket


def _run(coro):
    return asyncio.run(coro)


class _StubRequest:
    """Just enough of starlette's Request for route_label."""

    def __init__(self, endpoint, app=None):
        self.scope = {} if endpoint is None else {"endpoint": endpoint}
        self.app = app or app_mod.app


@pytest.fixture
def source(monkeypatch):
    """A source in the registry, removed again afterwards.

    The registry is a process-global that the real pollers also write to, so a
    test that registered without cleaning up would leak a series into every
    later assertion about the exposition.
    """
    created = []

    def make(name, **kwargs):
        state = registry.register(name, key_configured=kwargs.pop("key_configured", True))
        for attribute, value in kwargs.items():
            setattr(state, attribute, value)
        created.append(name)
        return state

    yield make

    for name in created:
        registry._sources.pop(name, None)


# --- a scrape must not do I/O ----------------------------------------------


def test_rendering_does_not_touch_the_database(monkeypatch, source):
    """The rule the whole module is arranged around.

    active_alerts() is the one number here that lives in Postgres, and it is
    refreshed on a timer precisely so that a scrape never waits on the database.
    If someone later reaches for it from a collector, this fails.
    """
    async def forbidden():
        raise AssertionError("a scrape queried Postgres")

    monkeypatch.setattr(storage, "active_alerts", forbidden)
    source("scrape_io_probe", last_success=1_000_000.0)

    assert b"osint_source_up" in metrics.render()


def test_rendering_survives_storage_being_down(monkeypatch):
    """With no pool, every read answers empty and every write is dropped -- and
    the exposition still has to say so rather than fail."""
    monkeypatch.setattr(storage, "get_pool", lambda: None)

    body = metrics.render().decode()

    assert "osint_storage_up 0.0" in body
    # No pool means no occupancy to report; a 0 here would be indistinguishable
    # from a pool that exists and is entirely idle.
    assert "osint_db_pool_connections" not in body


def test_pool_occupancy_is_read_from_the_pool_not_the_database(monkeypatch):
    class _FakePool:
        def get_size(self):
            return 7

        def get_idle_size(self):
            return 2

        def get_max_size(self):
            return 10

    monkeypatch.setattr(storage, "get_pool", lambda: _FakePool())

    body = metrics.render().decode()

    assert 'osint_db_pool_connections{state="in_use"} 5.0' in body
    assert 'osint_db_pool_connections{state="idle"} 2.0' in body
    assert "osint_db_pool_max_connections 10.0" in body


# --- labels stay bounded ---------------------------------------------------


def test_a_route_is_labelled_by_its_template(monkeypatch):
    """/api/track/{kind}/{entity_id} is one series, not one per entity."""
    monkeypatch.setattr(metrics, "_route_paths", {})

    assert metrics.route_label(_StubRequest(app_mod.track)) == "/api/track/{kind}/{entity_id}"
    assert metrics.route_label(_StubRequest(app_mod.health)) == "/api/health"


def test_an_unmatched_request_collapses_to_one_label(monkeypatch):
    """A 404 from a scanner must cost one series in total, not one per URL tried."""
    monkeypatch.setattr(metrics, "_route_paths", {})

    assert metrics.route_label(_StubRequest(None)) == "unmatched"
    assert metrics.route_label(_StubRequest(lambda: None)) == "unmatched"


# --- absent is not zero ----------------------------------------------------


def test_a_source_that_has_never_succeeded_reports_no_age(source):
    """0 seconds since the last success reads as 'just refreshed'. A source that
    has never succeeded must be absent instead, so an alert on staleness cannot
    be silenced by a source that has never worked at all."""
    source("never_polled", last_success=None)

    body = metrics.render().decode()

    assert 'osint_source_up{source="never_polled"}' in body
    assert 'osint_source_seconds_since_success{source="never_polled"}' not in body


def test_an_outstanding_error_puts_the_source_down(source):
    source("broken_source", last_success=1_000_000.0, last_error="502 from upstream")
    source("working_source", last_success=1_000_000.0)

    body = metrics.render().decode()

    assert 'osint_source_up{source="broken_source"} 0.0' in body
    assert 'osint_source_up{source="working_source"} 1.0' in body


def test_item_counts_and_refreshes_are_published(source):
    state = source("counted_source", last_success=1_000_000.0)
    state.data = [{"id": "a"}, {"id": "b"}, {"id": "c"}]

    body = metrics.render().decode()

    assert 'osint_source_items{source="counted_source"} 3.0' in body
    # version starts at 0 and the assignment above bumps it to 1.
    assert 'osint_source_refresh_total{source="counted_source"} 1.0' in body


# --- reading a rate limiter must not rate-limit anything -------------------


def test_reading_a_bucket_does_not_consume_from_it():
    """Scraping the gauge would otherwise be indistinguishable, to the bucket,
    from a request -- so monitoring the rate limit would cause rate limiting."""
    bucket = TokenBucket(capacity=5, refill_per_second=0.0)

    assert bucket.available == pytest.approx(5)
    assert bucket.available == pytest.approx(5)
    assert bucket.take() is True
    assert bucket.available == pytest.approx(4)


def test_tracked_buckets_and_caches_appear_in_the_exposition(monkeypatch):
    from backend.ratelimit import LruTtlCache

    monkeypatch.setitem(metrics._token_buckets, "probe", TokenBucket(capacity=9, refill_per_second=1.0))
    cache = LruTtlCache(maxsize=4, ttl=60)
    cache.set("a", 1)
    cache.set("b", 2)
    monkeypatch.setitem(metrics._local_caches, "probe", cache)

    body = metrics.render().decode()

    assert 'osint_ratelimit_tokens_capacity{bucket="probe"} 9.0' in body
    assert 'osint_local_cache_entries{cache="probe"} 2.0' in body


# --- the alert gauge, which is the one thing refreshed off a timer ---------


def test_the_alert_gauge_reports_zero_rather_than_nothing():
    """An absent series and a healthy stack look identical on a dashboard. The
    severities are pre-seeded so 'no alerts' is stated, not implied."""
    body = metrics.render().decode()

    assert 'osint_alerts_active{severity="warning"}' in body
    assert 'osint_alerts_active{severity="critical"}' in body


def test_the_refresher_counts_open_alerts_by_severity(monkeypatch):
    async def active_alerts():
        return [
            {"severity": "critical", "subject": "ais"},
            {"severity": "warning", "subject": "redis"},
            {"severity": "warning", "subject": "gdelt"},
        ]

    monkeypatch.setattr(storage, "active_alerts", active_alerts)
    _run(metrics.refresh_alerts())

    body = metrics.render().decode()
    assert 'osint_alerts_active{severity="critical"} 1.0' in body
    assert 'osint_alerts_active{severity="warning"} 2.0' in body


def test_a_cleared_alert_returns_the_gauge_to_zero(monkeypatch):
    async def two_then_none():
        return [{"severity": "warning"}, {"severity": "warning"}]

    monkeypatch.setattr(storage, "active_alerts", two_then_none)
    _run(metrics.refresh_alerts())

    async def none():
        return []

    monkeypatch.setattr(storage, "active_alerts", none)
    _run(metrics.refresh_alerts())

    assert 'osint_alerts_active{severity="warning"} 0.0' in metrics.render().decode()


def test_a_failing_alert_read_does_not_stop_the_refresher(monkeypatch):
    """The refresher runs beside the sources for the life of the process. A
    database blip must cost one stale gauge, not the task -- a task that dies
    freezes the gauge at a value that goes on looking current forever."""
    attempts = []

    async def active_alerts():
        attempts.append(1)
        raise ConnectionError("server closed the connection")

    monkeypatch.setattr(storage, "active_alerts", active_alerts)

    async def scenario():
        task = asyncio.create_task(metrics.refresh_loop(interval=0.001))
        deadline = asyncio.get_running_loop().time() + 2
        while len(attempts) < 2 and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.001)
        still_running = not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return still_running

    # It tried again after the failure, and the task was alive to do so.
    assert _run(scenario()) is True
    assert len(attempts) >= 2
