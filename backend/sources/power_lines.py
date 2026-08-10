"""Transmission line geometry, as OpenStreetMap has it.

Task 28's counterpart to railways.py, and deliberately a much thinner module
than that one: railways.py exists mostly to *merge* two sources (Natural
Earth's global-ish basemap linework and OpenStreetMap's attributed overlay).
There is no Natural Earth-style fallback for the power grid -- nothing else
this app has collected carries transmission-line geometry -- so there is
nothing to merge here, only a stored document to read back and re-serve.

The lines themselves are swept by backend/sources/osm_infra.py, in the ingest
process, on the same daily cadence and the same theatre boxes as everything
else that module collects (see its own module docstring for why: Overpass is
a volunteer service and a 20-minute sweep restarting on every backend
redeploy would be a discourtesy). This module is a plain Postgres read of
what that sweep last found, republished under its own registry state and its
own health row -- the same shape railways.py's own OSM half takes, just
without a second source to fold in.

Keyless and unmetered, so this stays a backend-polled source: reading a
reference document Postgres already holds costs nothing worth moving to the
ingest process for.
"""

import asyncio
import logging
import time

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.power_lines")

# A plain Postgres read of whatever osm_infra.py's sweep last found, not a
# fetch -- so this can run often without asking anyone for anything. Matched
# to railways.py's own MERGE_INTERVAL: the sweep behind it only moves once a
# day, so checking more often than that would just re-serve the same bytes.
REFRESH_INTERVAL = 24 * 3600
FAILURE_RETRY_INTERVAL = 600


def serialize(doc: dict) -> dict:
    """The stored "power_lines_osm" document, re-shaped into what this module
    serves -- same {attribution, provenance, lines, truncated_regions} fields
    osm_infra.py's own serialize_power_lines already produced, carried
    through rather than rebuilt so a reader never sees two slightly different
    provenance strings for the same claim.
    """
    return {
        "attribution": doc.get("attribution") or "OpenStreetMap contributors",
        "provenance": doc.get("provenance") or (
            "OpenStreetMap Overpass, power=line|cable, swept daily across this map's eleven "
            "conflict theatres, not worldwide."
        ),
        "lines": doc.get("lines") or [],
        "truncated_regions": sorted(doc.get("truncated_regions") or []),
    }


async def start():
    state = registry.register("power_lines", key_configured=True)  # no key required
    await storage.warm_reference(state, "power_lines", "Transmission lines (OpenStreetMap)")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            # Not a fetch failure in the ordinary sense: a missing document
            # just means osm_infra.py has not swept yet (a fresh deploy, or a
            # process that started before the first pass landed), the same
            # "not swept yet" reading railways.py gives its own OSM half's
            # empty reference() result.
            doc = (await storage.reference("power_lines_osm")) or {}
            state.data = serialize(doc)
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Power lines: %d lines served%s",
                     len(state.data["lines"]),
                     f" -- capped in: {state.data['truncated_regions']}" if state.data["truncated_regions"] else "")
            await storage.record_reference("power_lines", state.data)
            await storage.record_source_health("power_lines", len(state.data["lines"]), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Power lines refresh failed: %s", exc)
            await storage.record_source_health("power_lines", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
