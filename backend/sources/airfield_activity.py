"""How busy each airfield has been, derived from our own ADS-B movement log.

Nothing is fetched here. adsb.py already resolves a nearest airfield for every
aircraft below 10,000 ft or on the ground, and that field has been written to
every history row it appears on and read by nothing since. This aggregates it
into "how much traffic has this field seen in the last day, and how much of it
was military" -- which is the question the airfields layer exists to support and
previously could not answer at all: a pin said an airfield was there, and
nothing more.

The military half is the part worth having. Volume alone reproduces a list of
big civil airports that anyone could recite; the same scan also surfaces a
training field with two dozen movements of which every one is military, and that
is a fact about the world rather than about air travel.

Sits in the refine process alongside dark_vessels.py for the same reason: both
derive a layer from history this system recorded rather than from anything
outside it, and both are therefore useless until Postgres is up.

NOTAMs (Notices to Air Missions -- the official, hour-by-hour airspace
restrictions a pilot flight-plans against) are deliberately not part of this
module or anywhere else on this map: there is no free global NOTAM feed with a
licence this project can use, only paid resellers built on ICAO's own closed
aggregation. What this module publishes is recorded traffic, a different and
narrower claim -- what an ADS-B receiver actually saw fly, not what a
regulator has published as restricted. Do not read a quiet field here as
evidence its airspace is open, or a busy one as evidence it is not restricted.
"""
import asyncio
import logging
import time

from backend import storage
from backend.cache import registry

log = logging.getLogger(__name__)

# The window the sparkline covers, and the number of buckets in it.
WINDOW_HOURS = 24

# Recomputed on this cadence. Deliberately slower than dark_vessels' 15 minutes:
# the two aggregate queries behind this scan roughly five million ADS-B history
# rows and extract JSONB from two million of them, which takes on the order of
# ten seconds against a warm database. That is a fine price twice an hour for a
# figure whose underlying signal is a 24-hour rolling count; it would not be a
# fine price four times as often.
REFRESH_INTERVAL = 30 * 60
FAILURE_RETRY_INTERVAL = 60

# How many fields to keep by traffic volume. Every field with any military
# movement is kept regardless of where it ranks -- see storage.airfield_activity.
TOP_FIELDS = 300

SNAPSHOT_NAME = "airfield_activity"


async def _compute() -> dict:
    return await storage.airfield_activity(
        time.time() - WINDOW_HOURS * 3600, hours=WINDOW_HOURS, top=TOP_FIELDS
    )


async def derive_forever():
    """The airfield aggregation, for the life of the refine process.

    Self-paced rather than scheduled, and backing off on failure, for the same
    reason dark_vessels.derive_forever is: the case where retrying sooner
    matters is exactly the case where the database was too busy to answer, and a
    fixed schedule would wait out the full interval regardless.
    """
    state = registry.ensure(SNAPSHOT_NAME, key_configured=True)  # derives from our own history
    consecutive_failures = 0
    while True:
        ok = False
        try:
            fields = await _compute()
            state.data = fields
            state.last_success = time.time()
            state.last_error = None
            ok = True
            military = sum(1 for f in fields.values() if f["military_aircraft"])
            log.info(
                "Airfield activity: %d fields over %dh, %d with military movements",
                len(fields), WINDOW_HOURS, military,
            )
            # A document keyed by airfield code, not a point layer: the
            # coordinates already exist on the airports layer these attach to
            # (see sources/airports.py), and duplicating them here would create
            # a second copy to drift.
            await storage.record_reference(SNAPSHOT_NAME, fields)
            await storage.record_source_health(SNAPSHOT_NAME, len(fields), True)
        except Exception as exc:  # noqa: BLE001 - keep the derivation alive
            state.last_error = str(exc)
            log.warning("Airfield activity derivation failed: %s", exc)
            await storage.record_source_health(SNAPSHOT_NAME, None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL
            if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
