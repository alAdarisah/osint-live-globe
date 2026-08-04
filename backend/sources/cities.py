import asyncio
import io
import logging
import time
import zipfile

import httpx

from backend.cache import registry

log = logging.getLogger("osint-globe.cities")

CITIES_URL = "http://download.geonames.org/export/dump/cities15000.zip"
MIN_POPULATION = 100_000
REFRESH_INTERVAL = 6 * 3600  # cheap to refetch; city populations don't change fast
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# Column indices in GeoNames' cities15000.txt (tab-separated, no header).
COL_NAME = 1
COL_LAT = 4
COL_LON = 5
COL_COUNTRY_CODE = 8
COL_POPULATION = 14


async def _fetch() -> list[dict]:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        resp = await client.get(CITIES_URL)
        resp.raise_for_status()
        zip_bytes = resp.content

    cities = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        with zf.open("cities15000.txt") as f:
            for raw_line in f:
                parts = raw_line.decode("utf-8", errors="replace").split("\t")
                if len(parts) <= COL_POPULATION:
                    continue
                try:
                    population = int(parts[COL_POPULATION])
                    lat = float(parts[COL_LAT])
                    lon = float(parts[COL_LON])
                except ValueError:
                    continue
                if population < MIN_POPULATION:
                    continue
                cities.append(
                    {
                        "name": parts[COL_NAME],
                        "country_code": parts[COL_COUNTRY_CODE],
                        "lat": lat,
                        "lon": lon,
                        "population": population,
                    }
                )
    cities.sort(key=lambda c: c["population"], reverse=True)
    return cities


async def start():
    state = registry.register("cities", key_configured=True)  # no key required
    consecutive_failures = 0
    while True:
        ok = False
        try:
            state.data = await _fetch()
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Cities: %d with population >= %d", len(state.data), MIN_POPULATION)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Cities fetch failed: %s", exc)
        # An empty exception message (e.g. a bare asyncio.TimeoutError) is
        # still a failure -- branch on whether the fetch itself succeeded,
        # not on the truthiness of the resulting error string.
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL))
