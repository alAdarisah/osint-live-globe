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
import time

import pytest

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
