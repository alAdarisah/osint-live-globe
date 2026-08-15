"""The optional read-replica pool (Phase 2 of the read-replica plan).

The whole safety property of this feature is one sentence: a missing, unset, or
broken replica must degrade to reading the primary, never to an error. These
tests pin that -- and the credential redaction, because the one new log line
prints a DSN that carries a password.
"""

import asyncio

import pytest

from backend import config, storage


def _run(coro):
    return asyncio.run(coro)


# --- redaction -------------------------------------------------------------


def test_redact_dsn_strips_the_password_but_keeps_the_identity():
    out = storage._redact_dsn("postgresql://osint:secret@postgres-replica:5432/osint")
    assert out == "postgresql://osint@postgres-replica:5432/osint"
    assert "secret" not in out


def test_redact_dsn_leaves_a_passwordless_or_odd_dsn_alone():
    assert storage._redact_dsn("postgresql://postgres-replica:5432/osint") == (
        "postgresql://postgres-replica:5432/osint"
    )
    assert storage._redact_dsn("not-a-dsn") == "not-a-dsn"


# --- fallback --------------------------------------------------------------


def test_get_read_pool_falls_back_to_the_primary_when_no_replica(monkeypatch):
    primary = object()
    monkeypatch.setattr(storage, "_pool", primary)
    monkeypatch.setattr(storage, "_read_pool", None)
    assert storage.get_read_pool() is primary


def test_get_read_pool_prefers_the_replica_when_open(monkeypatch):
    primary, replica = object(), object()
    monkeypatch.setattr(storage, "_pool", primary)
    monkeypatch.setattr(storage, "_read_pool", replica)
    assert storage.get_read_pool() is replica


def test_get_read_pool_is_none_only_when_the_primary_is_also_down(monkeypatch):
    monkeypatch.setattr(storage, "_pool", None)
    monkeypatch.setattr(storage, "_read_pool", None)
    assert storage.get_read_pool() is None


# --- init ------------------------------------------------------------------


def test_init_read_pool_noops_when_unconfigured(monkeypatch):
    monkeypatch.setattr(config, "READ_REPLICA_URL", None)
    monkeypatch.setattr(storage, "_read_pool", None)

    async def fail(*a, **k):  # create_pool must not be reached
        raise AssertionError("create_pool called with no replica configured")

    monkeypatch.setattr(storage.asyncpg, "create_pool", fail)
    _run(storage.init_read_pool())
    assert storage._read_pool is None


def test_init_read_pool_opens_the_configured_replica(monkeypatch):
    replica = object()
    seen = {}

    async def fake_create_pool(dsn, **kwargs):
        seen["dsn"] = dsn
        seen["kwargs"] = kwargs
        return replica

    monkeypatch.setattr(config, "READ_REPLICA_URL", "postgresql://osint:secret@host:5432/osint")
    monkeypatch.setattr(storage, "_read_pool", None)
    monkeypatch.setattr(storage.asyncpg, "create_pool", fake_create_pool)
    _run(storage.init_read_pool())
    assert storage._read_pool is replica
    assert seen["dsn"] == "postgresql://osint:secret@host:5432/osint"


def test_init_read_pool_swallows_a_broken_replica_and_stays_on_primary(monkeypatch):
    primary = object()

    async def boom(*a, **k):
        raise OSError("replica still seeding")

    monkeypatch.setattr(config, "READ_REPLICA_URL", "postgresql://osint:secret@host:5432/osint")
    monkeypatch.setattr(storage, "_pool", primary)
    monkeypatch.setattr(storage, "_read_pool", None)
    monkeypatch.setattr(storage.asyncpg, "create_pool", boom)
    _run(storage.init_read_pool(retries=1))  # must not raise
    assert storage._read_pool is None
    assert storage.get_read_pool() is primary  # reads keep working, on the primary


def test_init_read_pool_keeps_trying_while_the_standby_seeds(monkeypatch):
    """The regression that motivated the retry: a standby doing pg_basebackup is
    not merely slow to answer, its name does not resolve at all, so a single
    attempt at boot loses the race and nothing ever tries again."""
    replica = object()
    attempts = {"n": 0}

    async def create_pool(dsn, **kwargs):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise OSError("[Errno -3] Temporary failure in name resolution")
        return replica

    slept: list[float] = []

    async def no_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(config, "READ_REPLICA_URL", "postgresql://osint:secret@host:5432/osint")
    monkeypatch.setattr(storage, "_read_pool", None)
    monkeypatch.setattr(storage.asyncpg, "create_pool", create_pool)
    monkeypatch.setattr(storage.asyncio, "sleep", no_sleep)

    _run(storage.init_read_pool(retries=5, delay=10.0))
    assert storage._read_pool is replica
    assert attempts["n"] == 3
    assert slept == [10.0, 10.0]  # waited between attempts, did not spin


def test_init_read_pool_gives_up_within_its_budget(monkeypatch):
    primary = object()
    attempts = {"n": 0}

    async def boom(*a, **k):
        attempts["n"] += 1
        raise OSError("no standby here")

    async def no_sleep(seconds):
        pass

    monkeypatch.setattr(config, "READ_REPLICA_URL", "postgresql://osint:secret@host:5432/osint")
    monkeypatch.setattr(storage, "_pool", primary)
    monkeypatch.setattr(storage, "_read_pool", None)
    monkeypatch.setattr(storage.asyncpg, "create_pool", boom)
    monkeypatch.setattr(storage.asyncio, "sleep", no_sleep)

    _run(storage.init_read_pool(retries=4, delay=10.0))
    assert attempts["n"] == 4  # bounded, not forever
    assert storage.get_read_pool() is primary


# --- routing (_reader + the readers that opt in) ---------------------------


def test_reader_picks_primary_or_replica_by_flag(monkeypatch):
    primary, replica = object(), object()
    monkeypatch.setattr(storage, "_pool", primary)
    monkeypatch.setattr(storage, "_read_pool", replica)
    assert storage._reader(False) is primary
    assert storage._reader(True) is replica


def test_reader_falls_back_to_primary_when_replica_absent(monkeypatch):
    primary = object()
    monkeypatch.setattr(storage, "_pool", primary)
    monkeypatch.setattr(storage, "_read_pool", None)
    assert storage._reader(True) is primary  # opt-in, but no replica -> primary


class _FakePool:
    """Records, via the shared `used` list, that a read acquired it."""

    def __init__(self, tag, used):
        self.tag, self.used = tag, used

    def acquire(self):
        pool = self

        class _Ctx:
            async def __aenter__(self):
                class _Conn:
                    async def fetch(_self, *a, **k):
                        pool.used.append(pool.tag)
                        return []

                    async def fetchval(_self, *a, **k):
                        pool.used.append(pool.tag)
                        return 0

                return _Conn()

            async def __aexit__(self, *a):
                return False

        return _Ctx()


@pytest.mark.parametrize("fn", ["position_gaps", "entity_latest_with_times", "source_health_series"])
def test_dark_vessel_reads_hit_the_replica_when_opted_in(monkeypatch, fn):
    used: list[str] = []
    monkeypatch.setattr(storage, "_pool", _FakePool("primary", used))
    monkeypatch.setattr(storage, "_read_pool", _FakePool("replica", used))

    call = {
        "position_gaps": lambda: storage.position_gaps("ais", 0.0, 3600, prefer_replica=True),
        "entity_latest_with_times": lambda: storage.entity_latest_with_times("ais", prefer_replica=True),
        "source_health_series": lambda: storage.source_health_series("ais", 0.0, prefer_replica=True),
    }[fn]
    _run(call())
    assert used == ["replica"]  # the whole point of Phase 3


def test_the_same_reads_default_to_the_primary(monkeypatch):
    used: list[str] = []
    monkeypatch.setattr(storage, "_pool", _FakePool("primary", used))
    monkeypatch.setattr(storage, "_read_pool", _FakePool("replica", used))
    _run(storage.position_gaps("ais", 0.0, 3600))  # no prefer_replica
    assert used == ["primary"]  # every other caller is untouched


def test_airfield_activity_hits_the_replica_when_opted_in(monkeypatch):
    used: list[str] = []
    monkeypatch.setattr(storage, "_pool", _FakePool("primary", used))
    monkeypatch.setattr(storage, "_read_pool", _FakePool("replica", used))
    _run(storage.airfield_activity(0.0, prefer_replica=True))
    assert used == ["replica"]


def test_airfield_activity_defaults_to_the_primary(monkeypatch):
    used: list[str] = []
    monkeypatch.setattr(storage, "_pool", _FakePool("primary", used))
    monkeypatch.setattr(storage, "_read_pool", _FakePool("replica", used))
    _run(storage.airfield_activity(0.0))
    assert used == ["primary"]


def test_escalation_reads_the_replica(monkeypatch):
    """escalation.compute runs only in refine and writes nothing, so its
    per-region scans belong on the standby."""
    from backend import escalation

    used: list[str] = []
    monkeypatch.setattr(storage, "_pool", _FakePool("primary", used))
    monkeypatch.setattr(storage, "_read_pool", _FakePool("replica", used))
    # fetchval returns 0 polls, so compute() stops at the coverage guard -- after
    # it has acquired the pool, which is the thing under test.
    assert _run(escalation.compute()) == []
    assert used == ["replica"]
