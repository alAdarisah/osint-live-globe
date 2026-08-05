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
    while True:
        try:
            if time.time() - last_elements_fetch >= ELEMENTS_REFRESH_INTERVAL or not elements:
                elements = await _fetch_elements()
                last_elements_fetch = time.time()
            state.data = _positions(elements)
            state.last_success = time.time()
            state.last_error = None
            log.info("Satellites: %d tracked (%d element sets)", len(state.data), len(elements))
            await storage.record_snapshot("satellites", state.data, "norad_id")
            await storage.record_source_health("satellites", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Satellite propagation failed: %s", exc)
            await storage.record_source_health("satellites", None, False, str(exc))
        await asyncio.sleep(10)
