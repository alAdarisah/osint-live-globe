"""Seas, lakes and rivers, from Natural Earth's 1:10m GeoJSON.

Water does not otherwise exist as data on this map. The frontend infers
"maritime" by sampling a grid and counting how many points fall outside every
country polygon (see frontend/src/map/viewportProfile.js) -- sea is treated as
the absence of land, which cannot be clicked, named, or used to keep a
dark-ship reachability contour off dry land. This module lands the first real
water geometry, the same way railways.py lands linework: a static file from
nvkelso/natural-earth-vector's GeoJSON mirror, keyless, public domain, and
static enough between Natural Earth releases that a weekly refresh is already
generous.

Three files rather than one blob, because they are three different kinds of
thing:
  ne_10m_geography_marine_polys -- named oceans, seas, gulfs, bays, straits,
    sounds, channels. The only one of the three with real nesting (the
    Mediterranean contains the Aegean, which contains the Saronic Gulf), which
    is what area_deg2 exists to rank -- see _ring_area's docstring.
  ne_10m_lakes -- named lakes, reservoirs and alkaline lakes.
  ne_10m_rivers_lake_centerlines -- river centrelines, including the segments
    Natural Earth draws through a lake a river flows into, so the line does
    not break where the water does.

None of the three carries a stable id of its own -- Natural Earth is built for
cartography, not for being joined against -- so one is synthesised per
feature; see feature_id below.

Stored as three whole documents in reference_snapshots (water_marine /
water_lakes / water_rivers), not entity_latest: none of this has a per-row
lat/lon, it has a shape. Kept as three names rather than one merged document
for the same reason admin1_boundaries.py keeps 251 country documents apart --
a future endpoint reading this back can hand over one dataset without the
other two, the way /api/admin1-boundaries hands over one country's states
without the other 250.

Registry state holds only per-dataset feature counts, not the geometry itself,
and is therefore not warmed at startup -- see NOT_WARMED's entry for this
module in test_persistence_coverage.py, which is the same arrangement
admin1_boundaries.py and admin2_boundaries.py use and for the same reason: the
geometry is read back out of Postgres by whichever endpoint later tasks add,
not carried in every backend process's memory on the chance it is asked for.
"""

import asyncio
import json
import logging
import re
import time

import httpx

from backend import config, storage
from backend.cache import registry
from backend.sources.admin2_boundaries import thin_geometry

log = logging.getLogger("osint-globe.water_bodies")

_GEOJSON_BASE = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
)
MARINE_URL = _GEOJSON_BASE + "ne_10m_geography_marine_polys.geojson"
LAKES_URL = _GEOJSON_BASE + "ne_10m_lakes.geojson"
RIVERS_URL = _GEOJSON_BASE + "ne_10m_rivers_lake_centerlines.geojson"

REFRESH_INTERVAL = config.WATER_POLL_INTERVAL
# Scaled by consecutive failures, capped at REFRESH_INTERVAL -- three
# multi-megabyte downloads in one poll, so a cheap fast retry is not on offer.
# Same floor as railways.py, whose downloads are the same order of size.
FAILURE_RETRY_INTERVAL = 600

# ~110 m at the equator, the same cut admin1_boundaries.py uses for state
# borders. These are read at the same zoom range -- a sea or a lake selected
# and looked at closely, not the whole globe at once -- so the same precision
# answers for both.
COORD_PRECISION = 3

PUBLISHER = "Natural Earth"

# featurecla -> the shared class enum, case-insensitive. Most values already
# are the enum name; the exceptions are lakes.geojson's "Reservoir" and
# "Alkaline Lake" (still lakes, for anything this map does with them) and
# rivers.geojson's "Lake Centerline" (the segment drawn through a lake so a
# river's line does not break where the water does -- part of the river
# network, not the lake polygon it crosses). Marine featurecla values with no
# home in the enum (generic, lagoon, fjord, reef, inlet) fall through to
# "other" rather than being guessed at.
_CLASS_MAP = {
    "ocean": "ocean",
    "sea": "sea",
    "gulf": "gulf",
    "bay": "bay",
    "strait": "strait",
    "channel": "channel",
    "sound": "sound",
    "river": "river",
    "lake centerline": "river",
    "lake": "lake",
    "reservoir": "lake",
    "alkaline lake": "lake",
}


def normalise_class(featurecla: str | None) -> str:
    return _CLASS_MAP.get((featurecla or "").strip().lower(), "other")


def _slug(text: str | None) -> str:
    """Lowercase, non-alphanumerics collapsed to a single '-', as the id
    synthesis below needs. Never empty -- an all-punctuation or blank input
    still has to produce something feature_id can append an index to."""
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    return slug or "unnamed"


def feature_id(prefix: str, props: dict, missing_name_seq: list[int]) -> str:
    """id = "{prefix}:{scalerank}:{slug}".

    Natural Earth carries no stable id for any of the three files, so one is
    built from what a re-download of the same static file always repeats:
    scalerank plus name, read in the file's own feature order. Where name is
    missing (11 of 306 marine features, 610 of 1355 lakes, 88 of 1455 rivers)
    featurecla stands in for it -- but featurecla alone collides, since many
    unnamed features share both it and a scalerank, so a running index (per
    call to _build_collection, in file order) is appended to break the tie.
    That index is why id stability depends on the source file's feature order
    staying fixed between runs, which a static download guarantees.
    """
    scalerank = props.get("scalerank")
    scalerank = int(scalerank) if scalerank is not None else 0
    name = props.get("name")
    if name:
        slug = _slug(name)
    else:
        missing_name_seq[0] += 1
        slug = f"{_slug(props.get('featurecla'))}-{missing_name_seq[0]}"
    return f"{prefix}:{scalerank}:{slug}"


def _ring_area(ring: list[list[float]]) -> float:
    """The shoelace formula over one outer ring, in square degrees.

    Not an area in km^2, and not meant to be read as one: a degree of
    longitude covers a different ground distance at the equator than at 60N,
    and nothing here corrects for that. It exists solely to rank overlapping
    marine polygons against each other when a click lands inside more than
    one -- the Mediterranean contains the Aegean, which contains the Saronic
    Gulf -- by preferring the smallest. A consistent, wrong-in-the-same-way
    unit is all that ranking needs; a true km^2 area would need a projection
    this module has no other reason to carry.
    """
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def _bbox_and_area(geometry: dict) -> tuple[list[float], float]:
    """[south, west, north, east] plus area_deg2, over every polygon in the
    geometry. 16 of the 306 marine features are MultiPolygon -- split across
    the antimeridian or into separate named pieces -- so the bbox spans every
    part and the area sums every part's outer ring."""
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    else:
        polygons = geometry["coordinates"]
    lats: list[float] = []
    lons: list[float] = []
    area = 0.0
    for polygon in polygons:
        if not polygon:
            continue
        outer = polygon[0]
        lons.extend(pt[0] for pt in outer)
        lats.extend(pt[1] for pt in outer)
        area += _ring_area(outer)
    if not lats:
        return [0.0, 0.0, 0.0, 0.0], 0.0
    return [min(lats), min(lons), max(lats), max(lons)], area


def _build_collection(features: list[dict], prefix: str) -> dict:
    """One dataset's raw features -> a thinned FeatureCollection.

    A feature whose geometry collapses entirely under thinning (or carries
    none to begin with) is dropped rather than stored with an invented shape
    -- the same rule admin1_boundaries.py follows for the same reason.
    """
    out = []
    missing_name_seq = [0]
    for feature in features or []:
        props = feature.get("properties") or {}
        geometry = thin_geometry(feature.get("geometry"), COORD_PRECISION)
        if not geometry:
            continue
        record_props = {
            "id": feature_id(prefix, props, missing_name_seq),
            "name": props.get("name") or None,
            "class": normalise_class(props.get("featurecla")),
            "featurecla": props.get("featurecla") or None,
            "scalerank": int(props["scalerank"]) if props.get("scalerank") is not None else None,
        }
        # bbox/area_deg2 are for ranking nested polygons on click, which is
        # only a marine problem -- lakes and river centrelines do not nest.
        if prefix == "marine":
            bbox, area_deg2 = _bbox_and_area(geometry)
            record_props["bbox"] = bbox
            record_props["area_deg2"] = area_deg2
        out.append({"type": "Feature", "geometry": geometry, "properties": record_props})
    _dedupe_ids(out)
    return {"type": "FeatureCollection", "features": out}


def _dedupe_ids(features: list[dict]) -> None:
    """Break ties when two features land on the same synthesised id.

    feature_id's name+scalerank is not actually unique against the real
    files: 11 pairs of distinct lakes share a name and scalerank (two lakes
    named "Trout Lake" at scalerank 5, among others), and every "Lake
    Centerline" segment in rivers.geojson pairs with a same-named,
    same-scalerank "River" segment of the same watercourse -- 243 such pairs,
    because Natural Earth splits one river into a normal segment and a
    through-the-lake segment but gives both the river's own name. Suffixing
    the second and later occurrence is the same fix admin1_boundaries.py
    applies to Natural Earth's duplicate ISO 3166-2 codes: the id stays the
    clean form for the (large majority) common case and only grows a suffix
    where the source itself collides. Order is the file's own feature order,
    so which occurrence is "first" is stable across runs.
    """
    seen: dict[str, int] = {}
    for feature in features:
        props = feature["properties"]
        base = props["id"]
        seen[base] = seen.get(base, 0) + 1
        if seen[base] > 1:
            props["id"] = f"{base}#{seen[base]}"


def parse_marine(payload: dict) -> dict:
    return _build_collection((payload or {}).get("features"), "marine")


def parse_lakes(payload: dict) -> dict:
    return _build_collection((payload or {}).get("features"), "lake")


def parse_rivers(payload: dict) -> dict:
    return _build_collection((payload or {}).get("features"), "river")


def serialize(collection: dict, provenance: str) -> dict:
    """The stored document, carrying the same honesty payload railways.py
    does: which product this is, that it is public domain, and the 1:10m
    scale caveat -- this will not sit exactly on a coastline drawn by a
    higher-resolution source, and the popup a later task adds is expected to
    say so."""
    return {
        "attribution": PUBLISHER,
        "publisher": PUBLISHER,
        "provenance": provenance,
        **collection,
    }


# (state key, snapshot name, source URL, id prefix, stored provenance string)
DATASETS = (
    ("marine", "water_marine", MARINE_URL, "marine",
     "Natural Earth 1:10m Geography Marine Polygons, public domain (CC0)"),
    ("lakes", "water_lakes", LAKES_URL, "lake",
     "Natural Earth 1:10m Lakes, public domain (CC0)"),
    ("rivers", "water_rivers", RIVERS_URL, "river",
     "Natural Earth 1:10m Rivers + Lake Centerlines, public domain (CC0)"),
)


async def _fetch(client: httpx.AsyncClient, url: str) -> dict:
    resp = await client.get(url)
    resp.raise_for_status()
    return json.loads(resp.content)


async def refresh_once() -> dict[str, int]:
    """Fetch all three datasets, store each as its own reference_snapshots
    row, return per-dataset feature counts.

    One HTTP client, three requests in sequence rather than fanned out: three
    files at 1.7-7.3 MB each is not worth parallelising against GitHub's raw
    CDN, and a failure partway through is easier to reason about one file at a
    time. A failure on any of the three fails the whole poll -- nothing is
    stored from a partial run -- so a reader never sees marine polygons from
    today paired with lakes from last week inside what looks like one refresh.
    """
    counts: dict[str, int] = {}
    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
        for key, name, url, prefix, provenance in DATASETS:
            payload = await _fetch(client, url)
            collection = _build_collection(payload.get("features"), prefix)
            await storage.record_reference(name, serialize(collection, provenance))
            counts[key] = len(collection["features"])
    log.info(
        "Water bodies: %d marine, %d lakes, %d river segments",
        counts.get("marine", 0), counts.get("lakes", 0), counts.get("rivers", 0),
    )
    return counts


async def start():
    state = registry.ensure("water_bodies", key_configured=True)  # keyless, public domain
    consecutive_failures = 0
    while True:
        ok = False
        try:
            counts = await refresh_once()
            # Counts only, not the geometry -- see the NOT_WARMED entry this
            # module has in test_persistence_coverage.py and the module
            # docstring above for why nothing here is warmed into memory.
            state.data = counts
            state.last_success = time.time()
            state.last_error = None
            ok = True
            await storage.record_source_health("water_bodies", sum(counts.values()), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Water bodies fetch failed: %s", exc)
            await storage.record_source_health("water_bodies", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
