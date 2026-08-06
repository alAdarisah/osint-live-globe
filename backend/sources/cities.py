import asyncio
import io
import logging
import time
import zipfile

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.cities")

CITIES_URL = "http://download.geonames.org/export/dump/cities15000.zip"
MIN_POPULATION = 100_000
REFRESH_INTERVAL = 6 * 3600  # cheap to refetch; city populations don't change fast
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# Column indices in GeoNames' cities15000.txt (tab-separated, no header).
# Read by position out of a headerless file, so a wrong index does not raise --
# it silently returns a neighbouring field. Pinned by test_cities.py.
COL_GEONAME_ID = 0
COL_NAME = 1
COL_LAT = 4
COL_LON = 5
COL_FEATURE_CODE = 7
COL_COUNTRY_CODE = 8
COL_POPULATION = 14

# GeoNames' feature code for "capital of a political entity". This column was
# in the file all along and simply never read, which is why the map had no
# concept of a capital and the diplomacy layer had nowhere to anchor to.
#
# PPLC only. PPLCH is a *historical* capital and would put a capital pin on
# Kyoto; PPLA is a first-order administrative capital, i.e. every provincial
# seat on earth.
CAPITAL_FEATURE_CODE = "PPLC"


def _parse_cities(text: str) -> list[dict]:
    """GeoNames' headerless TSV -> city records, largest first.

    Split out from the download so the column indices above can be exercised
    by position in a test, the same way gdelt._parse_events is.
    """
    cities = []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) <= COL_POPULATION:
            continue
        try:
            geonameid = int(parts[COL_GEONAME_ID])
            population = int(parts[COL_POPULATION])
            lat = float(parts[COL_LAT])
            lon = float(parts[COL_LON])
        except ValueError:
            continue
        feature_code = parts[COL_FEATURE_CODE].strip()
        is_capital = feature_code == CAPITAL_FEATURE_CODE
        # A national capital is context the map needs whatever its size, and it
        # is what the diplomacy layer anchors to -- so it bypasses the
        # population floor. Measured against the live file: 241 capitals, 78 of
        # them under 100,000, down to Vatican City at 829 and Adamstown at 46.
        # GeoNames' "cities15000" name notwithstanding, PPLC rows are present
        # regardless of population, so the bypass really does recover all of
        # them. Callers must still degrade when a capital is missing -- three
        # countries (IL, PS, EH) carry no PPLC row at all, see capitals.py.
        if population < MIN_POPULATION and not is_capital:
            continue
        cities.append(
            {
                # GeoNames' own stable id. Both the flag and the raw code are
                # kept: the flag is what the frontend reads, the code is the
                # evidence behind it.
                "geonameid": geonameid,
                "name": parts[COL_NAME],
                "country_code": parts[COL_COUNTRY_CODE],
                "feature_code": feature_code,
                "is_capital": is_capital,
                "lat": lat,
                "lon": lon,
                "population": population,
            }
        )
    cities.sort(key=lambda c: c["population"], reverse=True)
    return cities


async def _fetch() -> list[dict]:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        resp = await client.get(CITIES_URL)
        resp.raise_for_status()
        zip_bytes = resp.content

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        with zf.open("cities15000.txt") as f:
            return _parse_cities(f.read().decode("utf-8", errors="replace"))


async def start():
    state = registry.register("cities", key_configured=True)  # no key required
    await storage.warm_points(state, "cities", "Cities")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            state.data = await _fetch()
            state.last_success = time.time()
            state.last_error = None
            ok = True
            capitals = sum(1 for c in state.data if c["is_capital"])
            log.info("Cities: %d with population >= %d, including %d national capitals",
                     len(state.data), MIN_POPULATION, capitals)
            # Keyed on GeoNames' own id. The synthesized fallback
            # (storage._synthetic_id) hashes name/country_code/lat/lon, so a
            # 0.001-degree coordinate revision upstream minted a brand-new
            # entity row for a city that had not moved.
            await storage.record_snapshot("cities", state.data, "geonameid")
            await storage.record_source_health("cities", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Cities fetch failed: %s", exc)
            await storage.record_source_health("cities", None, False, str(exc))
        # An empty exception message (e.g. a bare asyncio.TimeoutError) is
        # still a failure -- branch on whether the fetch itself succeeded,
        # not on the truthiness of the resulting error string.
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL))
