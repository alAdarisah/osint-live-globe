"""What /api/replay hands each layer for one moment, without a database.

The scrubber's whole job is that the map changes as it moves, so the rules
about *when* a layer may stand in live data for recorded data are the thing
worth pinning down. Both fallbacks below were added after the layer they
govern went visibly wrong: fires and news sat empty across the older half of
the range, and ships and aircraft emptied at the live edge whenever their
upstream was failing -- while the live map, serving its last good fetch, was
still drawing them.
"""

import asyncio
import json
import time

import pytest
from fastapi import HTTPException

from backend import app as app_mod
from backend import config, regions, replay
from backend.cache import registry


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def live(monkeypatch):
    """Live payloads for the sources /api/replay reads, as the pollers hold them."""
    states = {}
    for name in ("firms", "gdelt", "acled", "ais", "adsb"):
        if not registry.has(name):
            registry.register(name, True)
        states[name] = registry.get(name)
        monkeypatch.setattr(states[name], "data", [], raising=False)
    return states


@pytest.fixture
def stored(monkeypatch):
    """storage.history_at, keyed by kind."""
    answers = {}

    async def history_at(kind, at, window_seconds=None):
        return answers.get(kind, [])

    monkeypatch.setattr(app_mod.storage, "history_at", history_at)
    return answers


WORLD = regions.bounds_for(None)
SHIP = {"mmsi": "1", "lat": 10.0, "lon": 20.0}
PLANE = {"icao24": "abc", "lat": 30.0, "lon": 40.0}


# --- ships and aircraft ----------------------------------------------------


def test_positions_come_from_the_recorded_history(live, stored):
    stored["adsb"] = [PLANE]
    got = _run(app_mod._replay_positions("adsb", app_mod.history.AIRCRAFT_HISTORY, 1_700_000_000, WORLD))
    assert got == [PLANE]


def test_positions_fall_back_to_the_live_payload_at_the_live_edge(live):
    """An upstream that starts failing doesn't clear the live map -- the poller
    keeps serving its last fetch -- so replaying *now* must not clear it either."""
    live["adsb"].data = [PLANE]
    now = time.time()
    assert _run(app_mod._replay_positions("adsb", app_mod.history.AIRCRAFT_HISTORY, now, WORLD)) == [PLANE]


def test_positions_do_not_fall_back_beyond_the_window(live):
    """The stand-in covers a gap we would still call current, nothing older.
    Otherwise every unrecorded moment would answer with today's positions,
    which is the bug that made dragging the scrubber change nothing."""
    live["adsb"].data = [PLANE]
    stale = time.time() - config.REPLAY_WINDOW_SECONDS["adsb"] - 60
    assert _run(app_mod._replay_positions("adsb", app_mod.history.AIRCRAFT_HISTORY, stale, WORLD)) == []


def test_ships_get_a_longer_window_than_aircraft():
    """A moored vessel records nothing for hours; an aircraft that quiet is gone."""
    assert config.REPLAY_WINDOW_SECONDS["ais"] > config.REPLAY_WINDOW_SECONDS["adsb"]


# --- fires and news --------------------------------------------------------


def _firms(acq_date, acq_time):
    return {"lat": 1.0, "lon": 2.0, "acq_date": acq_date, "acq_time": acq_time}


def test_fires_replay_from_the_live_payload_inside_its_own_window(live, stored):
    live["firms"].data = [_firms("2023-11-14", "1200")]
    stored["firms"] = [_firms("2023-11-01", "1200")]
    at = replay.firms_ts(_firms("2023-11-14", "1300"))
    got = _run(app_mod._replay_source("firms", "firms", replay.firms_ts, at, WORLD))
    assert got == live["firms"].data, "the live payload is what the map draws now"


def test_fires_reach_further_back_through_storage(live, stored):
    """FIRMS fetches one day, so past that the live payload can only ever be
    empty -- which left the fire layer blank across the rest of the range."""
    live["firms"].data = [_firms("2023-11-14", "1200")]
    older = _firms("2023-11-01", "1200")
    stored["firms"] = [older]
    at = replay.firms_ts(_firms("2023-11-01", "1300"))
    assert _run(app_mod._replay_source("firms", "firms", replay.firms_ts, at, WORLD)) == [older]


def test_stored_fires_are_still_filtered_to_the_moment(live, stored):
    """Recorded by then is not the same question as detected by then."""
    stored["firms"] = [_firms("2023-11-02", "1200")]
    at = replay.firms_ts(_firms("2023-11-01", "1300"))
    assert _run(app_mod._replay_source("firms", "firms", replay.firms_ts, at, WORLD)) == []


# --- Task 44: the generalised `kind` parameter -----------------------------
#
# /api/replay's original five kinds (events/firms/gdelt/ais/adsb) each had
# their replay window picked and reviewed by hand. Generalising to "any kind
# with history" opens the door to kinds whose config.ENTITY_STALE_AFTER
# window was only ever sized for eviction, so these tests cover the three
# things that make that safe: a kind outside the original five actually
# works, a kind that has never recorded anything reads as "no data" rather
# than a silently empty "nothing happened", and a kind whose configured
# window is too wide for a single request is refused rather than quietly
# narrowed.


@pytest.fixture
def pool(monkeypatch):
    """storage.get_pool(), toggled independently of kind_has_history/
    history_at below -- app._replay_kind is required to check this first
    rather than inferring "no database" from kind_has_history's own False
    return, which is ambiguous by design (see kind_has_history's docstring)."""

    class _Pool:
        connected = True

    p = _Pool()
    monkeypatch.setattr(app_mod.storage, "get_pool", lambda: object() if p.connected else None)
    return p


@pytest.fixture
def kind_history(monkeypatch):
    """storage.kind_has_history and storage.history_at, both call-counted so
    tests can assert the short-circuit cases never reach the more expensive
    call."""
    known = set()
    windowed = {}
    calls = {"kind_has_history": [], "history_at": []}

    async def kind_has_history(kind):
        calls["kind_has_history"].append(kind)
        return kind in known

    async def history_at(kind, at, window_seconds=None):
        calls["history_at"].append((kind, at, window_seconds))
        return windowed.get(kind, [])

    monkeypatch.setattr(app_mod.storage, "kind_has_history", kind_has_history)
    monkeypatch.setattr(app_mod.storage, "history_at", history_at)
    return known, windowed, calls


def _run_kind(kind, at=1_700_000_000.0, region=None):
    return _run(app_mod.replay_at(at=at, region=region, kind=kind))


def _kind_body(response):
    return json.loads(response.body)


def test_a_kind_outside_the_original_five_replays_generically(pool, kind_history):
    """"jamming" was never one of the five kinds wired in by hand -- proving
    it works through the generic `kind` path is the point of generalising."""
    known, windowed, calls = kind_history
    known.add("jamming")
    windowed["jamming"] = [{"lat": 1.0, "lon": 2.0}]

    body = _kind_body(_run_kind("jamming"))

    assert body["status"] == "ok"
    assert body["kind"] == "jamming"
    assert body["items"] == [{"lat": 1.0, "lon": 2.0}]
    # The window handed to storage.history_at must be the kind's own
    # configured default (config.REPLAY_WINDOW_SECONDS falling back to
    # ENTITY_STALE_AFTER), not some value invented by the endpoint.
    assert calls["history_at"] == [("jamming", 1_700_000_000.0, config.ENTITY_STALE_AFTER["jamming"])]


def test_unknown_kind_name_is_400_and_never_queries_storage(pool, kind_history):
    """A name that was never a real kind (typo, or just never a point
    source) is a validation error, not a quietly empty "no_history" answer --
    that answer is reserved for a kind that genuinely exists but has never
    recorded anything (see the next test)."""
    with pytest.raises(HTTPException) as raised:
        _run_kind("not_a_real_kind")
    assert raised.value.status_code == 400
    assert "not_a_real_kind" in raised.value.detail
    _, _, calls = kind_history
    assert calls == {"kind_has_history": [], "history_at": []}


def test_a_kind_with_no_history_reads_as_no_data_not_nothing_happened(pool, kind_history):
    """"jamming" is a real, known kind (it's in config.ENTITY_STALE_AFTER)
    that simply has never recorded a row yet -- distinct from a kind that has
    history but nothing fell inside this particular window."""
    known, windowed, calls = kind_history  # "jamming" left out of `known`

    body = _kind_body(_run_kind("jamming"))

    assert body["status"] == "no_history"
    assert body["items"] == []
    # The whole point of kind_has_history is a cheap EXISTS probe that never
    # needs a window -- history_at (which does a real ranged scan) must not
    # run at all once that probe says no.
    assert calls["history_at"] == []


def test_nothing_in_the_window_is_a_different_status_than_no_history(pool, kind_history):
    """The kind has recorded history somewhere, just not inside this
    window -- "ok" with an empty list, not "no_history". Collapsing these two
    into one shape is the exact bug Task 44's brief calls out: a kind with no
    rows must read as "no data", which means the *other* case -- rows exist,
    none in range -- must read differently."""
    known, windowed, calls = kind_history
    known.add("jamming")  # history exists; windowed["jamming"] left empty

    body = _kind_body(_run_kind("jamming"))

    assert body["status"] == "ok"
    assert body["items"] == []


def test_database_unavailable_is_a_third_status_not_folded_into_no_history(pool, kind_history):
    """A query that cannot run must not report an empty window as though it
    had run and found nothing -- "unavailable" is a third, distinct fact from
    both "no_history" and "ok" with an empty list."""
    pool.connected = False
    known, windowed, calls = kind_history
    known.add("jamming")  # would answer "ok" if the pool check were skipped

    body = _kind_body(_run_kind("jamming"))

    assert body["status"] == "unavailable"
    assert body["items"] == []
    # Checked via get_pool(), never by trusting kind_has_history's own False
    # return (which is also what "no pool" looks like from inside that
    # helper) -- so kind_has_history must not even be called here.
    assert calls["kind_has_history"] == []
    assert calls["history_at"] == []


def test_window_clamp_refuses_a_kind_whose_default_window_is_too_wide(pool, kind_history):
    """"cities" is real reference data (config.ENTITY_STALE_AFTER["cities"]
    is 30 days, sized for eviction, not for a single replay scan) and its
    configured window is wider than entity_history's own retention
    (config.HISTORY_RETENTION_SECONDS) -- refused outright rather than
    silently queried with a narrower window standing in for the one its own
    configuration asked for."""
    assert config.ENTITY_STALE_AFTER["cities"] > config.HISTORY_RETENTION_SECONDS, (
        "this test needs a real kind whose configured window exceeds retention"
    )
    with pytest.raises(HTTPException) as raised:
        _run_kind("cities")
    assert raised.value.status_code == 400
    assert "cities" in raised.value.detail
    _, _, calls = kind_history
    assert calls == {"kind_has_history": [], "history_at": []}


def test_a_kind_within_the_window_ceiling_is_not_refused(pool, kind_history):
    """The clamp is specifically about the ceiling, not about rejecting
    every generalised kind -- "adsb"'s configured window (REPLAY_WINDOW_
    SECONDS, an hour) sits comfortably under retention and must still work."""
    assert config.REPLAY_WINDOW_SECONDS["adsb"] <= config.HISTORY_RETENTION_SECONDS
    known, windowed, calls = kind_history
    known.add("adsb")

    body = _kind_body(_run_kind("adsb"))

    assert body["status"] == "ok"
