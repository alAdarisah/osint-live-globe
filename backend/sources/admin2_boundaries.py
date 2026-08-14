"""Admin-2 district boundaries, from OCHA's Common Operational Datasets.

Exists to give the district conflict counts (sources/hapi_conflict.py) something
to be drawn on. Those counts carry no coordinates at all -- 56,000 district
months keyed only by name and p-code -- so until there is geometry they can only
ever be sentences in a country card.

Why COD-AB rather than geoBoundaries, which is the more obvious open source:
p-codes. HAPI and COD-AB are both OCHA, and both carry the identical
`adm2_pcode`, so the join is exact. geoBoundaries ships no p-code at all (its
`shapeISO` is empty for every country checked), leaving only name matching --
which for Afghanistan reached 58% on exact names and 82% with normalisation and
fuzzy matching, against 99.7% on p-codes. That gap is 70 Afghan districts, and a
district with no polygon is drawn exactly like a district with no violence.

Downloaded once a week. These are administrative boundaries: they change when a
country reorganises its provinces, which is not a weekly event, and each country
is a ~14 MB zip from HDX that it would be rude to pull more often.
"""
import asyncio
import io
import json
import logging
import time
import zipfile

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger(__name__)

HDX_PACKAGE = "https://data.humdata.org/api/3/action/package_show?id=cod-ab-{iso3}"

# Which countries get geometry. Deliberately not "every country HAPI covers":
# each one is a ~14 MB download and roughly a megabyte of stored geometry, and
# these six are 63% of all district-months in the feed. The rest can be added
# here as they are wanted -- nothing else in this module is country-specific.
COUNTRIES = ("AFG", "VEN", "YEM", "SDN", "COD", "UKR")

REFRESH_INTERVAL = 7 * 24 * 3600
FAILURE_RETRY_INTERVAL = 60 * 60

SNAPSHOT_PREFIX = "admin2_boundaries"

# Coordinate precision, in decimal places. Two is about 1.1 km at the equator,
# which is finer than one screen pixel below zoom 6 -- and this layer is a
# district choropleth, read at country and region zoom, not a cadastral map.
#
# It is also the difference between shipping this and not: Afghanistan's ADM2
# layer is 17.3 MB as published, 5.5 MB rounded to three decimals and 1.2 MB at
# two. Six countries at full precision would be about a hundred megabytes of
# geometry to store and serve for a layer that paints each district one colour.
COORD_PRECISION = 2


def _first(props: dict, *names: str):
    """A property by name, case-insensitively.

    COD-AB is per-country data assembled by per-country teams and the casing of
    its field names genuinely varies between them (`adm2_pcode` in Afghanistan's
    release, `ADM2_PCODE` in others), so reading them literally works for some
    countries and silently returns nothing for the rest.
    """
    lowered = {k.lower(): v for k, v in props.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value not in (None, ""):
            return value
    return None


def _thin_ring(ring: list, precision: int) -> list | None:
    """One ring, rounded and de-duplicated, or None if it collapsed.

    Rounding merges points that were distinct only below the new precision, so
    consecutive duplicates have to be dropped or the ring keeps its original
    point count and none of the size is actually saved. A ring reduced below
    four points no longer encloses anything and is discarded rather than emitted
    as a degenerate shape for Leaflet to try to fill.
    """
    out: list[list[float]] = []
    for point in ring:
        if len(point) < 2:
            continue
        rounded = [round(float(point[0]), precision), round(float(point[1]), precision)]
        if not out or rounded != out[-1]:
            out.append(rounded)
    if len(out) < 4:
        return None
    if out[0] != out[-1]:
        out.append(list(out[0]))
    return out


def _thin_line(line: list, precision: int) -> list | None:
    """One LineString's coordinates, rounded and de-duplicated like a ring.

    A line is not a ring: it does not have to close, and two points are
    already a line rather than a degenerate one, so this drops _thin_ring's
    four-point minimum and closing-point rule and keeps only the rounding and
    consecutive-duplicate collapse both shapes need.
    """
    out: list[list[float]] = []
    for point in line:
        if len(point) < 2:
            continue
        rounded = [round(float(point[0]), precision), round(float(point[1]), precision)]
        if not out or rounded != out[-1]:
            out.append(rounded)
    return out if len(out) >= 2 else None


def thin_geometry(geometry: dict, precision: int) -> dict | None:
    """Public because admin1_boundaries.py and water_bodies.py thin the same
    way against different sources -- rounding-plus-dedup is the one part of
    all three modules that has to behave identically, and a second copy is
    how they would stop.

    LineString/MultiLineString exist for water_bodies.py's river centrelines,
    which are the one geometry kind here with no ring to close.
    """
    kind = (geometry or {}).get("type")
    if kind == "Polygon":
        rings = [r for r in (_thin_ring(r, precision) for r in geometry["coordinates"]) if r]
        return {"type": "Polygon", "coordinates": rings} if rings else None
    if kind == "MultiPolygon":
        polys = []
        for poly in geometry["coordinates"]:
            rings = [r for r in (_thin_ring(r, precision) for r in poly) if r]
            if rings:
                polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    if kind == "LineString":
        line = _thin_line(geometry["coordinates"], precision)
        return {"type": "LineString", "coordinates": line} if line else None
    if kind == "MultiLineString":
        lines = [l for l in (_thin_line(seg, precision) for seg in geometry["coordinates"]) if l]
        return {"type": "MultiLineString", "coordinates": lines} if lines else None
    return None


def build_collection(features: list[dict], iso3: str) -> dict:
    """COD-AB's ADM2 features, reduced to what a choropleth needs.

    Everything except the p-code, the name and the geometry is dropped: the
    published layer carries thirty properties per district (four language
    variants of every name, validity dates, area, region codes) and none of them
    are read by anything here.
    """
    out = []
    for feature in features:
        props = feature.get("properties") or {}
        pcode = _first(props, "adm2_pcode")
        geometry = thin_geometry(feature.get("geometry"), COORD_PRECISION)
        if not pcode or not geometry:
            continue
        out.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "pcode": str(pcode).strip(),
                "name": _first(props, "adm2_name", "adm2_en", "adm2_ref_name"),
                "admin1": _first(props, "adm1_name", "adm1_en"),
                "country_code": iso3,
            },
        })
    return {"type": "FeatureCollection", "features": out}


async def _fetch_country(client: httpx.AsyncClient, iso3: str) -> dict | None:
    package = (await client.get(HDX_PACKAGE.format(iso3=iso3.lower()))).json()["result"]
    url = next(
        (r["download_url"] for r in package["resources"] if (r.get("format") or "").lower() == "geojson"),
        None,
    )
    if not url:
        log.warning("COD-AB for %s publishes no GeoJSON resource", iso3)
        return None
    blob = (await client.get(url)).content
    archive = zipfile.ZipFile(io.BytesIO(blob))
    member = next(
        (n for n in archive.namelist() if "admin2" in n.lower() and n.lower().endswith(".geojson")),
        None,
    )
    if not member:
        log.warning("COD-AB archive for %s holds no admin2 layer (members: %s)", iso3, archive.namelist())
        return None
    return build_collection(json.loads(archive.read(member))["features"], iso3)


async def refresh_once() -> dict[str, int]:
    """Fetch every configured country, store each one, return feature counts."""
    stored: dict[str, int] = {}
    # One country at a time. These are ~14 MB downloads from a public
    # humanitarian data host, and fetching six in parallel to save a couple of
    # minutes on a weekly job is not a reasonable trade against their bandwidth.
    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
        for iso3 in COUNTRIES:
            try:
                collection = await _fetch_country(client, iso3)
            except Exception as exc:  # noqa: BLE001 - one bad country must not stop the rest
                log.warning("COD-AB fetch failed for %s: %s", iso3, exc)
                continue
            if not collection or not collection["features"]:
                continue
            await storage.record_reference(f"{SNAPSHOT_PREFIX}:{iso3}", collection)
            stored[iso3] = len(collection["features"])
            log.info("COD-AB %s: stored %d districts", iso3, stored[iso3])
    return stored


async def start():
    state = registry.ensure(SNAPSHOT_PREFIX, key_configured=True)  # keyless, public domain
    while True:
        try:
            stored = await refresh_once()
            state.data = stored
            state.last_success = time.time()
            state.last_error = None
            await storage.record_source_health(SNAPSHOT_PREFIX, sum(stored.values()), True)
            await asyncio.sleep(REFRESH_INTERVAL)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Admin-2 boundary refresh failed: %s", exc)
            await storage.record_source_health(SNAPSHOT_PREFIX, None, False, str(exc))
            await asyncio.sleep(FAILURE_RETRY_INTERVAL)
