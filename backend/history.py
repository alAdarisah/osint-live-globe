"""Replay-time position lookups for ships/aircraft. Every other replayed
layer (conflict, fires, news) already carries its own real-world timestamp
in the data ACLED/FIRMS/GDELT publish, so those can be replayed by filtering
the existing live payload (see replay.py) -- no storage needed. Ship and
aircraft feeds are the opposite: the live payload only ever holds *current*
position, nothing about where a vessel or aircraft was an hour ago.

The actual movement log now lives in backend/storage.py's SQLite-backed
entity_history table, written directly from ais.py's snapshot loop and
adsb.py's poll loop on every real position change (see storage.py's
record_snapshot). This module is just a thin HistoryBuffer wrapper around
storage.py's history_at() query, kept so app.py's /api/replay handler
(SHIP_HISTORY.at(ts) / AIRCRAFT_HISTORY.at(ts)) didn't need to change shape,
just add an `await`.
"""

from backend import storage


class HistoryBuffer:
    def __init__(self, kind: str) -> None:
        self._kind = kind

    async def at(self, ts: float) -> list[dict]:
        """Nearest position at or before ts, per entity. Falls back to each
        entity's earliest kept position if ts predates everything (e.g.
        scrubbing to a point before this process was even running), and to
        empty if nothing's been captured yet at all."""
        return await storage.history_at(self._kind, ts)


SHIP_HISTORY = HistoryBuffer("ais")
AIRCRAFT_HISTORY = HistoryBuffer("adsb")
