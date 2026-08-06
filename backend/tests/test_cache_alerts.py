"""What the cache worker reports, and the one thing it must never do.

evaluate() is pure, so every condition is reachable here without a Redis, a
Postgres or a clock -- which matters because most of these fire only during an
outage nobody can reproduce on demand.
"""

import ast
import pathlib

import pytest

from backend import cacheworker, config
from backend.cacheworker import SERVER, Alert, Probe, evaluate


def _conditions(alerts):
    return {(a.subject, a.condition) for a in alerts}


# --- the contract --------------------------------------------------------


def test_the_worker_never_writes_a_cache_key():
    """The defining rule of this tier.

    A monitor that also repairs cannot distinguish "healthy" from "broken and
    being patched every 60 seconds" -- the symptom vanishes and the cause does
    not. Enforced structurally because the tempting call site (a kind with rows
    in Postgres and nothing cached) is one line away from being written.
    """
    package = pathlib.Path(cacheworker.__file__).parent
    forbidden = {"set_payload", "set", "mset", "setex", "delete", "flushdb", "flushall"}
    for path in package.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                assert node.func.attr not in forbidden, (
                    f"{path.name} calls {node.func.attr}(); the cache worker watches, "
                    f"it does not repair -- repopulating belongs on the backend's read path"
                )


# --- server-wide conditions ----------------------------------------------


def test_an_unreachable_cache_is_critical_but_says_the_map_still_works():
    alerts = evaluate(Probe(reachable=False))
    assert _conditions(alerts) == {(SERVER, "unreachable")}
    assert alerts[0].severity == "critical"
    assert "map is unaffected" in alerts[0].detail.lower() or "unaffected" in alerts[0].detail


def test_an_unreachable_cache_reports_nothing_else():
    """Every other check reads from the thing that is down; reporting eight
    consequences of one cause is how an alert channel gets muted."""
    alerts = evaluate(Probe(reachable=False, watermarks={"ais": (None, "x")}))
    assert len(alerts) == 1


def test_memory_pressure_is_reported_before_eviction_starts():
    probe = Probe(used_memory=90, maxmemory=100)
    assert (SERVER, "memory") in _conditions(evaluate(probe))


def test_memory_well_under_the_limit_is_quiet():
    assert evaluate(Probe(used_memory=10, maxmemory=100)) == []


def test_eviction_is_measured_as_a_delta_not_a_lifetime_total():
    """Redis never resets these counters, so the absolute number only says the
    server has evicted something at some point since it started."""
    assert evaluate(Probe(evicted_keys=500, previous_evicted=500)) == []
    assert (SERVER, "evicting") in _conditions(
        evaluate(Probe(evicted_keys=505, previous_evicted=500))
    )


def test_the_first_probe_cannot_report_eviction():
    """No previous sample means no delta, and treating the lifetime total as one
    would fire on every worker restart."""
    assert evaluate(Probe(evicted_keys=9999, previous_evicted=None)) == []


def test_a_low_hit_ratio_is_reported_once_there_is_enough_traffic():
    probe = Probe(hits=10, misses=90, previous_evicted=None)
    assert (SERVER, "low_hit_ratio") in _conditions(evaluate(probe))


def test_a_low_ratio_on_a_handful_of_lookups_is_noise_not_an_alert():
    """Two misses on a fresh Redis is 0%, and alerting on that trains everyone
    to ignore the channel."""
    assert evaluate(Probe(hits=0, misses=2)) == []


def test_a_healthy_ratio_is_quiet():
    assert evaluate(Probe(hits=990, misses=10)) == []


# --- per-kind conditions -------------------------------------------------


def test_a_kind_with_rows_but_no_cache_entry_is_reported_once_it_persists():
    alerts = evaluate(Probe(
        watermarks={"ais": (None, "2026-01-01")},
        uncached_streak={"ais": config.CACHE_UNCACHED_PROBES},
    ))
    assert _conditions(alerts) == {("ais", "not_cached")}


def test_a_briefly_uncached_kind_is_not_an_alert():
    """Redis starts empty after every restart, and the backend fills it on the
    read path -- so on any deploy every kind is uncached at once. Alerting on
    that fires seven times per deploy and teaches everyone to ignore it."""
    assert evaluate(Probe(
        watermarks={"ais": (None, "2026-01-01")},
        uncached_streak={"ais": 1},
    )) == []


def test_a_kind_that_has_simply_not_changed_yet_is_not_an_alert():
    """osm_infra changes once a day. Between a Redis restart and its next sweep
    it is legitimately uncached, and nothing is wrong."""
    assert evaluate(Probe(watermarks={"osm_infra": (None, "2026-01-01")})) == []


def test_a_kind_empty_in_postgres_too_is_not_a_fault():
    """An empty cache for an empty kind is the correct state, not a miss."""
    assert evaluate(Probe(watermarks={"acled": (None, None)})) == []


def test_a_cached_copy_older_than_postgres_is_reported():
    alerts = evaluate(Probe(watermarks={"firms": ("2026-01-01", "2026-01-02")}))
    assert _conditions(alerts) == {("firms", "cache_behind")}


def test_a_matching_watermark_is_quiet():
    assert evaluate(Probe(watermarks={"firms": ("2026-01-01", "2026-01-01")})) == []


# --- producers -----------------------------------------------------------


def test_a_stopped_producer_is_critical_and_keeps_the_backends_own_wording():
    """One definition of "overdue", shared with /api/health -- so the alert and
    the health endpoint never describe the same outage differently."""
    alerts = evaluate(Probe(producers={"adsb": "the ingest service last ran 400s ago"}))
    assert _conditions(alerts) == {("adsb", "producer")}
    assert alerts[0].severity == "critical"
    assert alerts[0].detail == "the ingest service last ran 400s ago"


def test_healthy_producers_are_quiet():
    assert evaluate(Probe(producers={"adsb": None, "firms": None})) == []


# --- dedupe --------------------------------------------------------------


def test_an_alerts_identity_is_its_subject_and_condition():
    """What storage.record_alert upserts on, so a condition true for six hours
    is one row and one notification rather than 360 of each."""
    first = Alert("ais", "not_cached", "warning", "one wording")
    later = Alert("ais", "not_cached", "warning", "a slightly different wording")
    assert first.key() == later.key()


def test_different_kinds_with_the_same_condition_are_distinct_alerts():
    a = Alert("ais", "not_cached", "warning", "x")
    b = Alert("firms", "not_cached", "warning", "x")
    assert a.key() != b.key()


# --- thresholds are configurable -----------------------------------------


def test_thresholds_come_from_config(monkeypatch):
    monkeypatch.setattr(config, "CACHE_MEMORY_WARN_FRACTION", 0.99)
    assert evaluate(Probe(used_memory=90, maxmemory=100)) == []

    monkeypatch.setattr(config, "CACHE_MIN_SAMPLES_FOR_RATIO", 1_000_000)
    assert evaluate(Probe(hits=1, misses=99)) == []
