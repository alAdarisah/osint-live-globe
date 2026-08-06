"""The read-through cache, and the two ways a cache can be worse than none.

It can serve data older than the database just reported (so the map goes
backwards), or it can fail loudly enough to take the site with it. Both are
tested here, because neither shows up as an error anywhere else: a stale hit
looks like fresh data, and a raised exception from a cache read surfaces as a
broken layer with a database that was fine all along.
"""

import asyncio
import json

import pytest

from backend import cachestore, config


def _run(coro):
    return asyncio.run(coro)


class _FakeRedis:
    """Enough of redis.asyncio for mget/pipeline, with a failure switch."""

    def __init__(self, fail=False):
        self.store = {}
        self.fail = fail
        self.writes = 0

    async def mget(self, *keys):
        if self.fail:
            raise ConnectionError("connection refused")
        return [self.store.get(k) for k in keys]

    def pipeline(self, transaction=True):
        outer = self

        class _Pipe:
            def __init__(self):
                self.ops = []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            def set(self, key, value, ex=None):
                self.ops.append((key, value))

            async def execute(self):
                if outer.fail:
                    raise ConnectionError("connection refused")
                # Applied together, never one at a time -- see the transaction
                # test below for why that matters.
                for key, value in self.ops:
                    outer.store[key] = value if isinstance(value, bytes) else str(value).encode()
                outer.writes += 1

        return _Pipe()


@pytest.fixture
def redis(monkeypatch):
    fake = _FakeRedis()
    monkeypatch.setattr(cachestore, "_client", fake)
    monkeypatch.setattr(cachestore, "_unavailable_logged", False)
    return fake


# --- the correctness property --------------------------------------------


def test_a_payload_is_returned_only_for_the_watermark_it_was_built_from(redis):
    _run(cachestore.set_payload("firms", "2026-01-01T00:00:00", [{"id": "a"}]))

    assert _run(cachestore.get_payload("firms", "2026-01-01T00:00:00")) == [{"id": "a"}]


def test_a_newer_watermark_is_a_miss_not_a_stale_hit(redis):
    """The property that makes this safe to share between processes: serving the
    old payload here would show data older than Postgres reported a moment ago."""
    _run(cachestore.set_payload("firms", "2026-01-01T00:00:00", [{"id": "old"}]))

    assert _run(cachestore.get_payload("firms", "2026-01-01T00:05:00")) is None


def test_an_absent_entry_is_a_miss(redis):
    assert _run(cachestore.get_payload("firms", "2026-01-01T00:00:00")) is None


def test_nothing_is_cached_without_a_watermark(redis):
    """A kind with no rows has no watermark, and an entry keyed on None could
    never be invalidated."""
    _run(cachestore.set_payload("firms", None, [{"id": "a"}]))
    assert redis.writes == 0
    assert _run(cachestore.get_payload("firms", None)) is None


def test_the_payload_and_its_watermark_are_written_together(redis):
    """Separately, a reader could see the new watermark against the old payload
    -- serving stale data while claiming to be current."""
    _run(cachestore.set_payload("firms", "2026-01-01T00:00:00", [{"id": "a"}]))
    assert redis.writes == 1, "the pair must go in one transaction, not two writes"
    assert cachestore.payload_key("firms") in redis.store
    assert cachestore.watermark_key("firms") in redis.store


def test_kinds_do_not_share_keys(redis):
    _run(cachestore.set_payload("firms", "w", [{"id": "fire"}]))
    _run(cachestore.set_payload("ais", "w", [{"id": "ship"}]))

    assert _run(cachestore.get_payload("firms", "w")) == [{"id": "fire"}]
    assert _run(cachestore.get_payload("ais", "w")) == [{"id": "ship"}]


# --- degrading rather than failing ---------------------------------------


def test_a_read_against_a_dead_cache_is_a_miss(redis):
    redis.fail = True
    assert _run(cachestore.get_payload("firms", "w")) is None


def test_a_write_against_a_dead_cache_does_not_raise(redis):
    redis.fail = True
    _run(cachestore.set_payload("firms", "w", [{"id": "a"}]))  # must not raise


def test_no_cache_configured_is_a_miss_and_a_no_op(monkeypatch):
    monkeypatch.setattr(cachestore, "_client", None)
    assert _run(cachestore.get_payload("firms", "w")) is None
    _run(cachestore.set_payload("firms", "w", [{"id": "a"}]))  # must not raise


def test_a_corrupt_entry_is_a_miss(redis):
    redis.store[cachestore.watermark_key("firms")] = b"w"
    redis.store[cachestore.payload_key("firms")] = b"{not json"

    assert _run(cachestore.get_payload("firms", "w")) is None


def test_an_oversized_payload_is_skipped_rather_than_evicting_everything(redis, monkeypatch):
    """One entry big enough to pass maxmemory would evict every other kind to
    hold itself, which is worse than that one kind reading from Postgres."""
    monkeypatch.setattr(config, "CACHE_MAX_PAYLOAD_BYTES", 100)
    _run(cachestore.set_payload("firms", "w", [{"id": "x" * 500}]))

    assert redis.writes == 0
    assert _run(cachestore.get_payload("firms", "w")) is None


def test_an_unserializable_payload_does_not_raise(redis):
    _run(cachestore.set_payload("firms", "w", [{"when": object()}]))  # default=str handles it
    assert redis.writes == 1


# --- the mirror's use of it ----------------------------------------------


def test_the_mirror_falls_back_to_postgres_on_a_miss(monkeypatch, redis):
    """The whole point: a cache miss must be invisible except in latency."""
    from datetime import datetime, timezone

    from backend import mirror, storage
    from backend.cache import SourceState

    reads = []

    async def kind_watermark(kind):
        return datetime(2026, 1, 1, tzinfo=timezone.utc)

    async def entity_latest(kind, order_by_recency=False):
        reads.append(kind)
        return [{"id": "from-postgres"}]

    async def source_health_latest(source):
        return None, None

    monkeypatch.setattr(storage, "kind_watermark", kind_watermark)
    monkeypatch.setattr(storage, "entity_latest", entity_latest)
    monkeypatch.setattr(storage, "source_health_latest", source_health_latest)
    monkeypatch.setattr(storage, "get_pool", lambda: object())

    follower = mirror._Follower.__new__(mirror._Follower)
    follower.spec = mirror.Mirrored(
        name="firms", kind="firms", label="FIRMS", expected_every=900
    )
    follower.state = SourceState(name="firms", key_configured=True)
    follower.watermark = None

    _run(follower.refresh())
    assert follower.state.data == [{"id": "from-postgres"}]
    assert reads == ["firms"]
    # And the result is now cached against that watermark, so a second backend
    # -- or this one after a restart -- skips the table scan.
    assert _run(cachestore.get_payload("firms", "2026-01-01T00:00:00+00:00")) == [
        {"id": "from-postgres"}
    ]
