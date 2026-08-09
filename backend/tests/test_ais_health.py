"""What the AIS feed says about itself, and why anything depends on it.

The stream is a websocket that can fail by going quiet -- aisstream accepts the
socket and sends nothing when a key is recognised but the account isn't
streaming -- so "are we connected" is not the same question as "is the feed
working", and only the second one is worth recording.

Two things read the answer:

  /api/health      a reader looking at an empty ocean needs to be able to tell a
                   quiet feed from a dead one.
  dark_vessels.py  its whole layer rests on distinguishing a ship that stopped
                   transmitting from a feed that stopped delivering, which it
                   can only do from successful rows it can take a baseline from.

The second is why this is tested rather than left as a log line: the AIS feed
used to record failures only, so that baseline was never computable, the guard
silently never fired, and a total outage read as every vessel in every watched
box going dark at the same moment.
"""

import asyncio

import pytest

from backend.sources import ais, dark_vessels

NOW = 1_786_000_000.0


@pytest.fixture(autouse=True)
def _isolated_stream_state(monkeypatch):
    """Module globals are process-wide; give every test its own."""
    monkeypatch.setattr(ais, "_ships", {}, raising=False)
    monkeypatch.setattr(ais, "_last_message_at", None, raising=False)


def test_a_feed_that_has_never_sent_a_frame_is_not_healthy():
    """The case that went unnoticed for a day: connected, subscribed, silent."""
    count, ok, error = ais.health_row(NOW)
    assert (count, ok) == (0, False)
    assert error  # and it says so, rather than recording a blank failure


def test_holding_ships_is_not_evidence_the_stream_is_live(monkeypatch):
    """_ships survives 30 minutes past the last report and can be filled from
    storage at boot, so it can be full while nothing at all is arriving."""
    monkeypatch.setattr(ais, "_ships", {1: {"mmsi": 1}, 2: {"mmsi": 2}}, raising=False)
    count, ok, _error = ais.health_row(NOW)
    assert (count, ok) == (2, False)


def test_a_stream_delivering_now_is_healthy_and_reports_its_size(monkeypatch):
    monkeypatch.setattr(ais, "_ships", {1: {"mmsi": 1}, 2: {"mmsi": 2}}, raising=False)
    monkeypatch.setattr(ais, "_last_message_at", NOW - 3, raising=False)
    assert ais.health_row(NOW) == (2, True, None)


def test_silence_becomes_a_fault_on_the_same_threshold_the_reconnect_uses(monkeypatch):
    """One threshold, so the health row and the stream's own "this is broken"
    can't disagree about when the feed stopped."""
    monkeypatch.setattr(ais, "_ships", {1: {"mmsi": 1}}, raising=False)

    monkeypatch.setattr(ais, "_last_message_at", NOW - (ais.SILENCE_IS_A_FAULT_AFTER - 1), raising=False)
    assert ais.health_row(NOW)[1] is True

    monkeypatch.setattr(ais, "_last_message_at", NOW - ais.SILENCE_IS_A_FAULT_AFTER, raising=False)
    assert ais.health_row(NOW)[1] is False


def test_the_rows_this_writes_are_the_rows_the_dark_vessel_guard_needs(monkeypatch):
    """End to end across the two modules, because the bug was exactly the seam
    between them: rows that satisfy feed_health_baseline, and an outage that
    then suppresses a gap instead of reporting it as a vessel going dark."""
    monkeypatch.setattr(ais, "_ships", {i: {"mmsi": i} for i in range(900)}, raising=False)
    series = []
    for i in range(12):
        ts = NOW + i * ais.HEALTH_INTERVAL
        monkeypatch.setattr(ais, "_last_message_at", ts - 2, raising=False)
        count, ok, _error = ais.health_row(ts)
        series.append((ts, count, ok))

    baseline = dark_vessels.feed_health_baseline(series)
    assert baseline == 900.0  # unknowable (None) before this source recorded successes

    healthy_end = series[-1][0]
    assert dark_vessels.feed_was_healthy(series, NOW, healthy_end, baseline) is True

    # Now the stream goes quiet: the rows keep coming (the snapshot loop is
    # still running) and keep saying it isn't delivering. Started two intervals
    # on, so every row in it is past the silence threshold rather than the first
    # one straddling it.
    outage = []
    for i in range(14, 22):
        ts = NOW + i * ais.HEALTH_INTERVAL
        count, ok, _error = ais.health_row(ts)  # _last_message_at left where it was
        outage.append((ts, count, ok))
    assert all(not ok for _ts, _count, ok in outage)
    assert dark_vessels.feed_was_healthy(series + outage, outage[0][0], outage[-1][0], baseline) is False


# --- reconnect pacing ------------------------------------------------------
#
# aisstream's characteristic outage is long (the 2026-08-05 one ran over a day)
# and completely passive: the socket is accepted, pings are answered, and no
# data arrives. Nothing about it slows a client down, so the only thing that
# limits how hard this backend leans on a service already in trouble is the
# backoff -- and aisstream rate-limits by account and IP, so leaning too hard
# earns a block that outlives the outage it was reacting to.


def test_backoff_climbs_to_a_cap_measured_in_minutes_not_seconds():
    backoff, schedule = ais.BACKOFF_START, []
    for _ in range(12):
        schedule.append(backoff)
        backoff = ais._next_backoff(backoff)
    assert schedule[:4] == [5, 10, 20, 40]  # still quick off the mark
    assert schedule[-1] == ais.BACKOFF_CAP
    assert ais.BACKOFF_CAP >= 600


def test_a_day_long_outage_costs_the_service_tens_of_attempts_not_hundreds():
    """The number the cap exists for. At the old 60s cap this was ~480."""
    elapsed, attempts, backoff = 0.0, 0, ais.BACKOFF_START
    while elapsed < 24 * 3600:
        elapsed += ais.SILENCE_IS_A_FAULT_AFTER + backoff
        attempts += 1
        backoff = ais._next_backoff(backoff)
    assert attempts < 100


def test_recovery_is_still_noticed_within_the_cap():
    """The whole price of backing off: blindness after the feed returns."""
    assert ais.BACKOFF_CAP <= 900


def test_the_delay_is_jittered_so_every_client_does_not_retry_in_lockstep():
    delays = {ais._reconnect_delay(ais.BACKOFF_CAP) for _ in range(50)}
    assert len(delays) > 1
    assert all(
        ais.BACKOFF_CAP * (1 - ais.BACKOFF_JITTER) <= d <= ais.BACKOFF_CAP * (1 + ais.BACKOFF_JITTER)
        for d in delays
    )


def test_silence_is_not_reported_as_a_key_problem():
    """It was, for a day, during an outage in which every user's key was equally
    'at fault' and no change on this end could have helped. A refused key is a
    close within a second, and that is the case that gets to say 'key'."""
    silent = ais.SILENT_STREAM_DIAGNOSIS.format(seconds=ais.SILENCE_IS_A_FAULT_AFTER)
    assert "accepted" in silent
    assert "outage" in silent
    assert issubclass(ais.StreamRefused, Exception)


# --- restarts ---------------------------------------------------------------
#
# The backoff above is per-process, and this process restarts: rebuilds, crash
# loops, `restart: unless-stopped`. Every restart used to reset the schedule to
# 5 seconds, so four rebuilds in a morning was four bursts of 5/10/20/40s at a
# service that had already answered 429 -- and aisstream rate-limits by IP, so
# that is a self-inflicted block that outlives the outage that provoked it.


def _failing(count, start=NOW, step=60.0):
    return [(start + i * step, 0, False) for i in range(count)]


def test_a_process_with_no_history_starts_at_the_bottom_of_the_schedule():
    assert ais.resume_backoff([], NOW) == (ais.BACKOFF_START, 0.0)


def test_a_stack_that_was_healthy_last_run_starts_fresh():
    series = _failing(5) + [(NOW + 400, 900, True)]
    assert ais.resume_backoff(series, NOW + 500) == (ais.BACKOFF_START, 0.0)


def test_one_failure_is_a_blip_not_a_reason_to_wait():
    backoff, _wait = ais.resume_backoff(_failing(1), NOW + 60)
    assert backoff == ais.BACKOFF_START


def test_the_schedule_resumes_where_it_left_off():
    """Same doubling as _next_backoff, picked up rather than restarted."""
    expected = ais.BACKOFF_START
    for failures in range(1, 8):
        backoff, _wait = ais.resume_backoff(_failing(failures), NOW + failures * 60)
        assert backoff == expected
        expected = ais._next_backoff(expected)


def test_an_outage_measured_in_hours_resumes_at_the_cap():
    """The case that matters: the heartbeat writes a failing row a minute, so an
    hour of outage is 60 of them and the answer is the cap, immediately."""
    backoff, _wait = ais.resume_backoff(_failing(60), NOW + 3600)
    assert backoff == ais.BACKOFF_CAP


def test_a_day_long_outage_does_not_build_an_astronomical_number():
    backoff, _wait = ais.resume_backoff(_failing(1440), NOW + 86400)
    assert backoff == ais.BACKOFF_CAP


def test_the_remainder_of_the_delay_is_served_before_the_first_attempt():
    """The whole point. A rebuild three seconds after a failure does not get a
    free connection attempt -- it waits out what the previous process owed."""
    series = _failing(60)
    newest = series[-1][0]
    _backoff, wait = ais.resume_backoff(series, newest + 3)
    assert wait == pytest.approx(ais.BACKOFF_CAP - 3)


def test_a_delay_already_served_is_not_served_twice():
    series = _failing(60)
    _backoff, wait = ais.resume_backoff(series, series[-1][0] + ais.BACKOFF_CAP + 10)
    assert wait == 0.0


# --- shutdown ---------------------------------------------------------------


def test_the_socket_is_closed_before_the_process_goes(monkeypatch):
    """aisstream holds a dropped session until its own ping times out, and a
    rebuild inside that window is a second concurrent session on an account
    permitted very few."""
    closed = []

    class _Socket:
        async def close(self):
            closed.append(True)

    monkeypatch.setattr(ais, "_connection", _Socket(), raising=False)
    asyncio.run(ais.aclose())
    assert closed == [True]
    assert ais._connection is None


def test_closing_twice_is_harmless():
    asyncio.run(ais.aclose())
    asyncio.run(ais.aclose())


def test_a_socket_that_refuses_to_close_does_not_stop_the_shutdown(monkeypatch):
    class _Stuck:
        async def close(self):
            raise OSError("connection already gone")

    monkeypatch.setattr(ais, "_connection", _Stuck(), raising=False)
    asyncio.run(ais.aclose())  # must not raise
    assert ais._connection is None


def test_the_ingest_process_actually_calls_it():
    """The function existing is not the fix; being on the shutdown path is, and
    it has to run *before* the task cancellations rather than after."""
    import inspect

    from backend.ingest import __main__ as ingest_main

    source = inspect.getsource(ingest_main.main)
    assert "await ais.aclose()" in source
    assert source.index("await ais.aclose()") < source.index("task.cancel()")


# --- coverage ---------------------------------------------------------------


def test_the_subscription_covers_the_whole_planet():
    """Since 2026-08-08 the stream collects globally rather than from eight
    chokepoint boxes. One box, and it is the world."""
    assert ais._bboxes_payload() == [[[-90.0, -180.0], [90.0, 180.0]]]


def test_collecting_globally_is_not_the_same_as_watching_globally():
    """The split that made a global subscription affordable. WATCHED_WATERS is
    what dark_vessels infers inside and what gfw_detections spends satellite
    tiles on; re-coupling them to the subscription would put the tile sweep at
    1,024 tiles and let a mid-ocean gap -- where the ordinary explanation is
    that nobody was listening -- be reported as a vessel going dark."""
    from backend import config

    assert config.WATCHED_WATERS != config.AIS_BBOXES
    assert len(config.WATCHED_WATERS) == 8
    # Nothing in the watched set spans a hemisphere.
    assert all(
        lat_max - lat_min <= 30 and lon_max - lon_min <= 30
        for lat_min, lon_min, lat_max, lon_max in config.WATCHED_WATERS
    )


# --- egress -----------------------------------------------------------------
#
# The stream can be routed through a proxy when the direct connection keeps
# failing (see backend/proxypool.py). What is tested here is the policy, not the
# plumbing: which egresses a cycle is allowed to try, in what order, and what
# that costs the service. The policy is the part with teeth -- a fallback that
# quietly became the normal path, or one that multiplied connection attempts
# during an outage, would each undo something the rest of this file exists to
# protect.


@pytest.fixture
def proxying(monkeypatch):
    """PROXY_ENABLED, with small deterministic thresholds."""
    monkeypatch.setattr(ais.config, "PROXY_ENABLED", True)
    monkeypatch.setattr(ais.config, "AIS_PROXY_AFTER_FAILURES", 3)
    monkeypatch.setattr(ais.config, "AIS_PROXY_ATTEMPTS", 3)


POOL = [f"socks5://10.0.0.{i}:1080" for i in range(1, 9)]


def test_no_proxy_is_considered_while_the_feature_is_off(monkeypatch):
    monkeypatch.setattr(ais.config, "PROXY_ENABLED", False)
    assert ais._egress_plan(99, POOL) == [None]


def test_an_ordinary_blip_is_never_routed_around(proxying):
    """A failure or two is aisstream being aisstream. Reaching for a different
    IP over that would make the fallback the normal path within a day."""
    assert ais._egress_plan(0, POOL) == [None]
    assert ais._egress_plan(2, POOL) == [None]


def test_a_direct_attempt_still_leads_every_cycle(proxying):
    """The honest path -- the one aisstream can attribute to this account -- and
    the one that starts working again the moment the service does, with nothing
    to switch back. A plan that dropped it would strand us on a proxy for as
    long as the proxy kept working."""
    for failures in (3, 10, 500):
        assert ais._egress_plan(failures, POOL)[0] is None


def test_the_plan_is_capped_however_many_proxies_are_available(proxying):
    plan = ais._egress_plan(3, POOL)
    assert plan == [None, *POOL[:3]]


def test_an_empty_pool_is_a_direct_attempt_and_nothing_else(proxying):
    assert ais._egress_plan(3, []) == [None]


def test_a_day_of_proxying_still_costs_the_service_two_attempts_a_cycle(proxying):
    """The number that matters to aisstream, and the reason the cycle stops at
    the first proxy that actually reaches them (see stream_forever): the plan
    may be four long, but three of those are dead nodes that never open a
    connection to aisstream at all. Walking past them is free to the service;
    only the direct attempt and at most one live proxy are not.
    """
    plan = ais._egress_plan(3, POOL)
    reached_per_cycle = 2  # the direct attempt, plus the first proxy that gets through
    assert len(plan) == 4

    elapsed, cycles, backoff = 0.0, 0, ais.BACKOFF_START
    while elapsed < 24 * 3600:
        elapsed += ais.SILENCE_IS_A_FAULT_AFTER + backoff
        cycles += 1
        backoff = ais._next_backoff(backoff)
    assert cycles * reached_per_cycle < 200  # ~170; at a 60s cap it would be ~960
