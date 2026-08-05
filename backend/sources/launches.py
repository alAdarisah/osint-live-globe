"""Orbital launches, upcoming and just-flown, at their pads.

The map already carries what is in orbit (backend/sources/satellites.py). This
is where those objects come from, and it closes the obvious gap: a reader
watching a military satellite pass overhead has had no way to see that another
one goes up from Jiuquan in nine hours.

The Launch Library 2 API is public and keyless, and it is the one source in this
package with a rate limit tight enough to shape the code: roughly fifteen
requests an hour for anonymous callers. So this polls every thirty minutes, asks
for both windows in two requests, and treats HTTP 429 as an ordinary backoff
rather than an error -- being throttled is a normal state here, not a fault.

It also requires a User-Agent: the API returns 403 to clients that do not send
one.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.launches")

BASE_URL = "https://ll.thespacedevs.com/2.3.0/launches"
UPCOMING_LIMIT = 40
PREVIOUS_LIMIT = 15
REFRESH_INTERVAL = 30 * 60  # ~15 requests/hour anonymous; two per poll
FAILURE_RETRY_INTERVAL = 120  # scaled by consecutive failures, capped at REFRESH_INTERVAL
# Sent because the API 403s anonymous clients with no User-Agent, and because
# naming the caller is the polite thing to do on a free keyless service.
USER_AGENT = "osint-live-globe/1.0 (+https://github.com/)"


def _iso_to_unix(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def parse_launches(payload: dict, upcoming: bool) -> list[dict]:
    """One page of Launch Library results -> records placed at their pads.

    A launch with no pad coordinate is dropped rather than placed at its
    provider's country or its location's centroid: this is a map, and "roughly
    China" is not a launch site.
    """
    out: list[dict] = []
    for row in (payload or {}).get("results") or []:
        pad = row.get("pad") or {}
        try:
            lat = float(pad["latitude"])
            lon = float(pad["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        mission = row.get("mission") or {}
        orbit = (mission.get("orbit") or {}).get("name")
        status = row.get("status") or {}
        location = pad.get("location") or {}
        # `net` is "no earlier than" -- the scheduled T-0, which for an upcoming
        # launch routinely moves. net_precision says how much to trust it, and
        # is carried through rather than dropped: "accurate to the minute" and
        # "accurate to the month" are very different countdowns.
        precision = (row.get("net_precision") or {}).get("abbrev")
        out.append({
            "id": row.get("id"),
            "kind": "launch",
            "lat": lat,
            "lon": lon,
            "name": row.get("name"),
            "upcoming": upcoming,
            "net": _iso_to_unix(row.get("net")),
            "net_precision": precision,
            "window_start": _iso_to_unix(row.get("window_start")),
            "window_end": _iso_to_unix(row.get("window_end")),
            "status": status.get("name"),
            "status_abbrev": status.get("abbrev"),
            "provider": (row.get("launch_service_provider") or {}).get("name"),
            "rocket": ((row.get("rocket") or {}).get("configuration") or {}).get("full_name"),
            "mission": mission.get("name"),
            "mission_type": mission.get("type"),
            "orbit": orbit,
            "pad": pad.get("name"),
            "site": location.get("name"),
            "url": row.get("url"),
        })
    return out


async def _fetch_window(client: httpx.AsyncClient, path: str, limit: int, upcoming: bool) -> list[dict]:
    resp = await client.get(f"{BASE_URL}/{path}/", params={"limit": limit})
    # 429 is a normal state on a free keyless API, not a failure to log loudly:
    # the previous copy stays on the map and the next poll tries again.
    if resp.status_code == 429:
        raise RuntimeError("rate-limited by Launch Library (429)")
    resp.raise_for_status()
    return parse_launches(resp.json(), upcoming=upcoming)


async def _fetch() -> list[dict]:
    async with httpx.AsyncClient(
        timeout=45, follow_redirects=True, headers={"User-Agent": USER_AGENT}
    ) as client:
        upcoming = await _fetch_window(client, "upcoming", UPCOMING_LIMIT, True)
        previous = await _fetch_window(client, "previous", PREVIOUS_LIMIT, False)
    # A launch that has just flown appears in both windows for a while. Upcoming
    # wins by being inserted second into a dict keyed on id, so the record
    # carries the flown status rather than the stale countdown.
    merged = {r["id"]: r for r in upcoming}
    for record in previous:
        merged[record["id"]] = record
    return [r for r in merged.values() if r["id"]]


async def start():
    state = registry.register("launches", key_configured=True)  # no key required
    consecutive_failures = 0
    while True:
        ok = False
        try:
            launches = await _fetch()
            state.data = launches
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info(
                "Launches: %d total (%d upcoming)",
                len(launches),
                sum(1 for r in launches if r["upcoming"]),
            )
            await storage.record_snapshot("launches", launches, id_field="id")
            await storage.record_source_health("launches", len(launches), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Launch fetch failed: %s", exc)
            await storage.record_source_health("launches", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
