"""Country outlines, from Natural Earth's 1:50m admin-0 set.

The 1:50m cut rather than 1:110m, which this served until now. 1:110m is a
world-at-a-glance generalisation -- 177 features, 10,654 vertices, a median
country drawn with 37 points -- and the map it is drawn on is CARTO's basemap,
which is accurate at every zoom. The two disagree visibly the moment anyone
zooms in: a hover highlight cuts across the coastline it is supposed to trace, a
choropleth fill spills into the sea, and a click on a coastal city lands outside
the country it is in. 1:50m carries 242 features and 99,613 vertices, a median
country drawn with 180 points, and closes most of that gap.

It also stops dropping places. 1:110m has no feature at all for 65 of the
territories 1:50m carries, and 29 of those are sovereign states in their own
right -- Malta, Bahrain, Mauritius, Singapore, Andorra, most of the Caribbean
and most of the Pacific. Clicking one of them returned nothing, because on this
map they did not exist.

Not 1:10m, which would be the next step up. That file is ~24 MB of GeoJSON for a
payload every client downloads whole, against 2.1 MB here -- and unlike the
admin-1 layer (sources/admin1_boundaries.py), which is served one country at a
time, this collection is the world in one response because the hit-test index,
the choropleth and the region filter all read across every country at once.

Coordinates are rounded to five decimals on the way in, which is both about a
metre and exactly the lattice the frontend's border editor quantizes to (see
settings/borderOverrides.js). Storing anything finer would mean the editor's
shared-vertex lookup and the stored geometry disagree in the last digits, which
is what keeps a dragged border from tearing a gap between two countries. It
halves the payload as a side effect: Natural Earth publishes these with up to
fifteen decimals, or a picometre of false precision.
"""
import asyncio
import csv
import io
import logging
import time

import httpx

from backend import storage
from backend.cache import registry
from backend.sources.admin2_boundaries import thin_geometry

log = logging.getLogger("osint-globe.countries")

GEOJSON_URL = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector/geojson/ne_50m_admin_0_countries.geojson"

# Decimal places kept. Five is ~1.1 m, and is the same constant as
# BORDER_PRECISION in the frontend's settings/borderOverrides.js -- see the
# module docstring for why the two have to agree. Measured over this file:
# rounding to 5dp leaves all 78,539 distinct coordinates distinct, where 4dp
# merges 3 pairs and 3dp merges 23.
COORD_PRECISION = 5
# Note: World Bank's "mrnev=1" (most-recent-non-empty-value) param throws a
# server error for some country codes (e.g. RUS) -- so instead we pull the
# last few years ourselves (without mrnev) and pick the first non-null value.
WB_POP_URL = "https://api.worldbank.org/v2/country/{code}/indicator/SP.POP.TOTL?format=json&per_page=6"
WB_DENSITY_URL = "https://api.worldbank.org/v2/country/{code}/indicator/EN.POP.DNST?format=json&per_page=6"
# World Bank doesn't carry HDI (it's a UNDP measure) -- OWID mirrors UNDP's
# HDI series as one flat CSV (all countries/years in a single request), so
# it's fetched and indexed once per refresh instead of per-country like the
# World Bank indicators above.
OWID_HDI_CSV_URL = "https://ourworldindata.org/grapher/human-development-index.csv"
REFRESH_INTERVAL = 24 * 3600  # population/density/boundaries are annual-ish data, not "live"
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

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


async def _fetch_hdi_by_code(client: httpx.AsyncClient) -> dict:
    """One flat CSV (Entity,Code,Year,HDI,region) covering every country/year --
    keep only the latest year's value per ISO3 code."""
    try:
        resp = await client.get(OWID_HDI_CSV_URL, timeout=30)
        resp.raise_for_status()
        reader = csv.DictReader(io.StringIO(resp.text))
        latest: dict[str, tuple[int, float]] = {}
        for row in reader:
            code = row.get("Code")
            year_raw = row.get("Year")
            value_raw = row.get("Human Development Index")
            if not code or not year_raw or not value_raw:
                continue
            year = int(year_raw)
            if code not in latest or year > latest[code][0]:
                latest[code] = (year, float(value_raw))
        return {code: value for code, (_year, value) in latest.items()}
    except Exception as exc:  # noqa: BLE001 - HDI is a bonus field, not worth failing the whole fetch over
        log.warning("HDI fetch failed: %s", exc)
        return {}


async def _enrich(client: httpx.AsyncClient, feature: dict, geometry: dict, hdi_by_code: dict) -> dict:
    props = feature["properties"]
    code = props.get("ADM0_A3") or props.get("ISO_A3")
    population = pop_year = density = None
    if code and code != "-99":
        population, pop_year = await _fetch_wb_value(client, code, WB_POP_URL)
        density, _ = await _fetch_wb_value(client, code, WB_DENSITY_URL)
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {
            "name": props.get("ADMIN") or props.get("NAME"),
            "iso_a3": code,
            "iso_a2": props.get("ISO_A2"),
            "population": population,
            "pop_year": pop_year,
            "density": round(density, 1) if isinstance(density, (int, float)) else None,
            "hdi": hdi_by_code.get(code) if code else None,
        },
    }


def shape_features(raw_features: list[dict]) -> list[tuple[dict, dict]]:
    """Each published feature paired with its rounded geometry.

    A feature whose geometry survives rounding as nothing at all is dropped
    rather than emitted with a null geometry: L.geoJSON would skip it silently,
    but countryHitTest and the region bbox index both walk `geometry.coordinates`
    unconditionally. Nothing in the 1:50m set is that small -- at five decimals a
    ring has to be under a metre across to collapse -- so this is a guard against
    a future release, not a filter that currently removes anything.
    """
    shaped = []
    for feature in raw_features or []:
        geometry = thin_geometry(feature.get("geometry"), COORD_PRECISION)
        if geometry:
            shaped.append((feature, geometry))
    return shaped


async def _fetch() -> dict:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.get(GEOJSON_URL)
        resp.raise_for_status()
        raw = resp.json()
        shaped = shape_features(raw.get("features") or [])
        dropped = len(raw.get("features") or []) - len(shaped)
        if dropped:
            log.warning("Countries: %d feature(s) had no geometry left after rounding", dropped)
        hdi_by_code = await _fetch_hdi_by_code(client)
        features = await asyncio.gather(*(_enrich(client, f, g, hdi_by_code) for f, g in shaped))
    return {"type": "FeatureCollection", "features": list(features)}


async def start():
    state = registry.register("countries", key_configured=True)  # no key required
    # A world GeoJSON is a slow first fetch, and it backs off to the full
    # 24-hour refresh on failure. Boundaries are annual-ish data, so last
    # night's copy is as good as tonight's -- serve it while the fetch runs.
    await storage.warm_reference(state, "countries", "Countries")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            state.data = await _fetch()
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Countries: %d boundaries loaded", len(state.data["features"]))
            # A GeoJSON FeatureCollection, not lat/lon rows -- stored whole.
            await storage.record_reference("countries", state.data)
            await storage.record_source_health("countries", len(state.data["features"]), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Countries fetch failed: %s", exc)
            await storage.record_source_health("countries", None, False, str(exc))
        # An empty exception message (e.g. a bare asyncio.TimeoutError) is
        # still a failure -- branch on whether the fetch itself succeeded,
        # not on the truthiness of the resulting error string.
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL))
