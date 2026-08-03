"""Coarse position-history buffers for the replay timeline's ships/aircraft
layers. Every other replayed layer (conflict, fires, news) already carries
its own real-world timestamp in the data ACLED/FIRMS/GDELT publish, so those
can be replayed by filtering the existing live payload (see replay.py) --
no storage needed. Ship and aircraft feeds are the opposite: the live
payload only ever holds *current* position, nothing about where a vessel or
aircraft was an hour ago. This module is what makes their movement
scrubbable -- a periodic snapshot task (registered as a poller in app.py's
lifespan, same as every other source) appends the current live payload here
on a coarse interval and prunes anything older than the replay window.
"""

import asyncio
import logging
import time

from backend.cache import registry

log = logging.getLogger("osint-globe.history")

# 3 days, matching the replay timeline's range and ACLED's own 3-day fetch
# window (see backend/sources/acled.py) -- no point keeping ship/aircraft
# history the rest of the replay range can't use anyway.
RETENTION_SECONDS = 3 * 24 * 3600

# 5 minutes: coarse enough that 3 days of snapshots for both layers stays a
# few tens of MB in memory (a few hundred ships/aircraft per snapshot,
# ~864 snapshots), fine-grained enough that scrubbing still reads as
# genuine movement rather than a handful of jumps.
SNAPSHOT_INTERVAL = 300


class HistoryBuffer:
    def __init__(self) -> None:
        self._snapshots: list[tuple[float, list[dict]]] = []

    def append(self, data: list[dict]) -> None:
        now = time.time()
        self._snapshots.append((now, data))
        cutoff = now - RETENTION_SECONDS
        while self._snapshots and self._snapshots[0][0] < cutoff:
            self._snapshots.pop(0)

    def at(self, ts: float) -> list[dict]:
        """Nearest snapshot at or before ts. Falls back to the oldest kept
        snapshot if ts predates everything (e.g. scrubbing to a point before
        this process was even running), and to empty if nothing's been
        captured yet at all."""
        if not self._snapshots:
            return []
        best = self._snapshots[0][1]
        for snap_ts, data in self._snapshots:
            if snap_ts > ts:
                break
            best = data
        return best


SHIP_HISTORY = HistoryBuffer()
AIRCRAFT_HISTORY = HistoryBuffer()


def _ready(name: str) -> bool:
    # registry.has() only means the source called .register() -- that
    # happens almost immediately on startup, well before its first real
    # fetch completes. version > 0 means .data has actually been assigned
    # at least once (see SourceState's setter in cache.py), i.e. there's
    # real data to snapshot instead of the empty placeholder list.
    return registry.has(name) and registry.get(name).version > 0


async def start() -> None:
    # lifespan starts every poller's task at once, so which one actually
    # runs first -- and how long its first real fetch takes -- is up to
    # asyncio's scheduler and the network, not creation order. Snapshotting
    # before either source has real data would silently bake an empty
    # snapshot into the buffer's very first (and for a while, only) entry.
    while not (_ready("ais") and _ready("adsb")):
        await asyncio.sleep(1)

    while True:
        SHIP_HISTORY.append(registry.get("ais").data)
        AIRCRAFT_HISTORY.append(registry.get("adsb").data)
        await asyncio.sleep(SNAPSHOT_INTERVAL)
