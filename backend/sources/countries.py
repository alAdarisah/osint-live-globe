import asyncio
import logging
import time

import httpx

from backend.cache import registry

log = logging.getLogger("osint-globe.countries")

GEOJSON_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_110m_admin_0_countries.geojson"
# Note: World Bank's "mrnev=1" (most-recent-non-empty-value) param throws a
# server error for some country codes (e.g. RUS) -- so instead we pull the
# last few years ourselves (without mrnev) and pick the first non-null value.
WB_POP_URL = "https://api.worldbank.org/v2/country/{code}/indicator/SP.POP.TOTL?format=json&per_page=6"
WB_DENSITY_URL = "https://api.worldbank.org/v2/country/{code}/indicator/EN.POP.DNST?format=json&per_page=6"
REFRESH_INTERVAL = 24 * 3600  # population/density/boundaries are annual-ish data, not "live"

# World Bank's API is fast per-request but unreliable under concurrency --
# a wide-open semaphore silently fails most requests, even though the same
# request retried alone succeeds instantly. Keep concurrency modest and
# retry before giving up on a country.
_WB_SEM = asyncio.Semaphore(4)

# Natural Earth's ISO_A3/ADM0_A3 occasionally disagrees with the code World
# Bank actually uses for the same territory.
_WB_CODE_ALIASES = {"PSX": "PSE", "SDS": "SSD", "KOS": "XKX"}


async def _fetch_wb_value(client: httpx.AsyncClient, code: str, url_template: str):
    url = url_template.format(code=_WB_CODE_ALIASES.get(code, code))
    async with _WB_SEM:
        for attempt in range(3):
            try:
                resp = await client.get(url, timeout=15)
                resp.raise_for_status()
                payload = resp.json()
                rows = payload[1] if isinstance(payload, list) and len(payload) > 1 else None
                for row in rows or []:
                    if row.get("value") is not None:
                        return row["value"], row.get("date")
                return None, None  # request succeeded, indicator just has no data
            except Exception:  # noqa: BLE001 - retry, then give up on this country
                if attempt < 2:
                    await asyncio.sleep(0.5 * (attempt + 1))
    return None, None


async def _enrich(client: httpx.AsyncClient, feature: dict) -> dict:
    props = feature["properties"]
    code = props.get("ADM0_A3") or props.get("ISO_A3")
    population = pop_year = density = None
    if code and code != "-99":
        population, pop_year = await _fetch_wb_value(client, code, WB_POP_URL)
        density, _ = await _fetch_wb_value(client, code, WB_DENSITY_URL)
    return {
        "type": "Feature",
        "geometry": feature["geometry"],
        "properties": {
            "name": props.get("ADMIN") or props.get("NAME"),
            "iso_a3": code,
            "iso_a2": props.get("ISO_A2"),
            "population": population,
            "pop_year": pop_year,
            "density": round(density, 1) if isinstance(density, (int, float)) else None,
        },
    }


async def _fetch() -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(GEOJSON_URL)
        resp.raise_for_status()
        raw = resp.json()
        features = await asyncio.gather(*(_enrich(client, f) for f in raw["features"]))
    return {"type": "FeatureCollection", "features": list(features)}


async def start():
    state = registry.register("countries", key_configured=True)  # no key required
    while True:
        try:
            state.data = await _fetch()
            state.last_success = time.time()
            state.last_error = None
            log.info("Countries: %d boundaries loaded", len(state.data["features"]))
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Countries fetch failed: %s", exc)
        await asyncio.sleep(REFRESH_INTERVAL)
