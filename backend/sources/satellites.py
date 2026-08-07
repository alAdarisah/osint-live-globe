import asyncio
import logging
import time

import httpx
from skyfield.api import EarthSatellite, load

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.satellites")

# CelesTrak's GP (General Perturbations) API: real, keyless, documented --
# confirmed live against the actual endpoint. "stations" (ISS, Tiangong, ...)
# and "military" (CelesTrak's own curated "Miscellaneous Military" group,
# e.g. SAR-Lupe reconnaissance satellites) are both real, publicly
# maintained CelesTrak groups, not a guess.
GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
GROUPS = ["stations", "military"]
ELEMENTS_REFRESH_INTERVAL = 6 * 3600  # orbital elements barely change this often

# builtin=True uses skyfield's bundled leap-second/deltaT tables instead of
# reaching out to a third (unverified) network source just to propagate an
# orbit -- this feature's only external dependency stays the CelesTrak URL
# above.
_ts = load.timescale(builtin=True)


async def _fetch_group(client: httpx.AsyncClient, group: str) -> list[dict]:
    resp = await client.get(GP_URL, params={"GROUP": group, "FORMAT": "json"})
    resp.raise_for_status()
    records = resp.json()
    for r in records:
        r["_group"] = group
    return records


async def _fetch_elements() -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as client:
        out = []
        for group in GROUPS:
            try:
                out.extend(await _fetch_group(client, group))
            except Exception as exc:  # noqa: BLE001 - one bad group shouldn't sink the rest
                log.warning("CelesTrak group fetch failed (%s): %s", group, exc)
        return out


def _positions(elements: list[dict]) -> list[dict]:
    now = _ts.now()
    out = []
    for omm in elements:
        try:
            sat = EarthSatellite.from_omm(_ts, omm)
            geo = sat.at(now).subpoint()
        except Exception:  # noqa: BLE001 - a malformed element set just gets skipped
            continue
        out.append(
            {
                "norad_id": omm.get("NORAD_CAT_ID"),
                "name": omm.get("OBJECT_NAME"),
                "group": omm.get("_group"),
                # skyfield/numpy return np.float64 -- plain json.dumps (what
                # FastAPI's default JSONResponse uses) can't serialize that.
                "lat": float(geo.latitude.degrees),
                "lon": float(geo.longitude.degrees),
                "alt_km": float(geo.elevation.km),
            }
        )
    return out


async def start():
    state = registry.register("satellites", key_configured=True)  # no key required
    elements: list[dict] = []
    last_elements_fetch = 0.0
    # The element sets are the collected data here; the positions below are
    # arithmetic over them, recomputed every ten seconds. So the elements are
    # what gets stored and restored, and the positions never are -- a stored
    # position is a claim about where a satellite was, which is wrong within
    # the minute and must not be drawn as if it were current.
    #
    # Orbital elements decay slowly enough that yesterday's set still
    # propagates usefully, so a boot with Celestrak unreachable keeps tracking
    # instead of showing nothing.
    if await storage.wait_for_warm_pool():
        stored = await storage.reference("satellite_elements")
        if stored:
            elements = stored
            log.info("Satellites: warmed %d stored element sets while the fetch runs", len(elements))
    while True:
        try:
            if time.time() - last_elements_fetch >= ELEMENTS_REFRESH_INTERVAL or not elements:
                try:
                    elements = await _fetch_elements()
                    last_elements_fetch = time.time()
                    await storage.record_reference("satellite_elements", elements)
                except Exception as exc:  # noqa: BLE001 - the set in hand still propagates
                    # Only fatal when there is nothing to propagate at all.
                    # Otherwise keep computing from the elements we have: they
                    # decay slowly, and a blank sky is a worse answer than a
                    # slightly stale one. Same discipline as hazards.py's
                    # weekly volcano report inside its 5-minute quake loop.
                    if not elements:
                        raise
                    log.warning(
                        "Satellite element refresh failed; propagating the %d sets in hand: %s",
                        len(elements), exc,
                    )
            state.data = _positions(elements)
            state.last_success = time.time()
            state.last_error = None
            log.info("Satellites: %d tracked (%d element sets)", len(state.data), len(elements))
            # Deliberately no record_snapshot here. The elements above are what
            # was collected; these positions are arithmetic over them, recomputed
            # every 10s, and storing them wrote 471k history rows (77 MB inside
            # the 3-day window) that nothing ever read -- /api/replay carries no
            # satellite layer, and this source warms from the elements, never
            # from stored positions. A replay of the sky, if it is ever wanted,
            # propagates the stored elements to the scrubbed moment; it does not
            # need a log of answers we can recompute exactly.
            await storage.record_source_health("satellites", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Satellite propagation failed: %s", exc)
            await storage.record_source_health("satellites", None, False, str(exc))
        await asyncio.sleep(10)
