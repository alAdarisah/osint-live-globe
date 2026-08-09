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
    is what area_deg2 exists to rank -- see _ring_area's docstring. It is also
    the only one with antimeridian-spanning features (Bering Sea, the North/
    South Pacific, ...); see _bbox's docstring for how their bbox is kept
    useful instead of collapsing to roughly the whole globe (a rule every
    kind's bbox shares, even though only marine's live data actually
    exercises it), and what that means for a bbox-overlap test built on top
    of this.
  ne_10m_lakes -- named lakes, reservoirs and alkaline lakes.
  ne_10m_rivers_lake_centerlines -- river centrelines, including the segments
    Natural Earth draws through a lake a river flows into, so the line does
    not break where the water does.

Marine and lakes carry Natural Earth's own `ne_id` -- a persistent identifier
meant to survive exactly this, reused directly as `marine:{ne_id}` /
`lake:{ne_id}` (see native_id below; one duplicate ne_id in the raw file,
Great Barrier Reef published twice, is caught by the dedup pass rivers also
needs -- see _dedupe_ids for why it does not actually collide today).
Rivers carries no id of its own at all -- confirmed by fetching the live file
while building this module, not assumed -- so its id is synthesised from name
(or featurecla, where name is missing) and scalerank, in the file's own
feature order; see feature_id below.

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
    """The positional id: "{prefix}:{scalerank}:{slug}".

    rivers.geojson carries no id of its own at all (checked against the live
    file, not assumed -- see the module docstring), so this is what rivers
    uses for every feature. It is built from what a re-download of the same
    static file always repeats: scalerank plus name, read in the file's own
    feature order. Where name is missing (88 of 1455 rivers) featurecla
    stands in for it -- but featurecla alone collides, since many unnamed
    features share both it and a scalerank, so a running index (per call to
    _build_collection, in file order) is appended to break the tie. That
    index is why this scheme's stability depends on the source file's feature
    order staying fixed between runs, which a static download guarantees.

    Also the fallback for native_id below, on the chance a marine or lakes
    feature is ever published without the ne_id every feature in the live
    files currently carries -- id synthesis degrading gracefully rather than
    the poll failing outright over one missing field.
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


def native_id(prefix: str, props: dict, missing_name_seq: list[int]) -> str:
    """id = "{prefix}:{ne_id}" for marine and lakes, which both carry Natural
    Earth's own cross-release identifier on every feature (verified against
    the live files: 306/306 marine, 1355/1355 lakes). ne_id is not quite
    unique on its own -- marine publishes Great Barrier Reef twice under one
    ne_id, a real Polygon and a MultiPolygon of four degenerate slivers --
    so this still goes through the same dedup pass feature_id's synthesised
    ids need; see _dedupe_ids for why that particular pair does not actually
    collide once thinning drops the slivers.
    """
    ne_id = props.get("ne_id")
    if ne_id is not None:
        return f"{prefix}:{ne_id}"
    return feature_id(prefix, props, missing_name_seq)


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


def _walk_lonlat(coords):
    """Recurse into a GeoJSON coordinates array to any depth and yield every
    (lon, lat) pair it contains.

    The same shape regions.py's _walk_coords solves, kept local rather than
    imported: this module has no other reason to depend on regions.py, and
    the recursion is four lines. Handles every geometry type
    _build_collection sees uniformly -- Polygon/MultiPolygon (marine, lakes)
    and LineString/MultiLineString (rivers) all bottom out the same way, a
    list whose first element is a number rather than another list. Interior
    rings (holes) get walked along with the outer ring for a Polygon; that is
    harmless for a bbox, since a hole can never extend past the outer ring
    that contains it.
    """
    if not coords:
        return
    if isinstance(coords[0], (int, float)):
        yield coords[0], coords[1]
        return
    for c in coords:
        yield from _walk_lonlat(c)


def _bbox(geometry: dict) -> tuple[list[float], bool]:
    """[south, west, north, east] and an antimeridian flag, over every point
    in the geometry.

    Shared by every kind _build_collection stores -- Task 5's review found
    that giving bbox to marine only forced /api/water to fall back to
    walking full geometry for lakes and rivers on every request, with no
    cache able to absorb the cost (storage.reference() never returns the
    same object twice, so an identity-keyed memo like regions.filter_geojson's
    never fires for it). A stored bbox for every kind is what makes that
    endpoint's overlap test a cheap rectangle check for all three, not just
    one.

    16 of the 306 marine features are MultiPolygon; measured against the live
    file, 6 of those are split at the antimeridian (Bering Sea, Chukchi Sea,
    Ross Sea, Gulf of Anadyr', and the North/South Pacific) rather than into
    disjoint named pieces, and every one of the 6 spans exactly [-180, 180] in
    raw longitude -- a flat min/max there would produce a box that matches
    every bbox query on Earth rather than the strait or ocean it is actually
    bounding, defeating the cheap rectangle-overlap test built on this. None
    of the other 10 MultiPolygon marine features comes close (10.5 degrees
    wide at most), so "a Multi* geometry whose flat longitude span exceeds
    180 degrees" is a clean, cheap detector for the 6 that need it -- and it
    generalises past marine for free, MultiPolygon and MultiLineString alike,
    since nothing about the test is polygon-specific.

    Checked against the live lakes and rivers files before this was
    generalised: neither comes close either. The widest multi-part longitude
    span in ne_10m_lakes.geojson is 3.16 degrees (one of nine MultiPolygon
    lakes, all disjoint pieces, none near the seam); in
    ne_10m_rivers_lake_centerlines.geojson (every feature MultiLineString) it
    is 30.05 degrees, the widest single river network. Both are far under
    the 180-degree threshold below, so this path exists for correctness
    against a future Natural Earth release, not because today's lakes/rivers
    data exercises it -- test_water_bodies.py proves it works on a synthetic
    lake anyway, since "untested until it happens in the wild" is not a plan.

    For a feature that does wrap, west/east are recomputed by shifting every
    negative longitude into [180, 360) before taking min/max -- unwrapping
    the seam -- then shifting the result back into [-180, 180]. That can
    leave west > east (e.g. Bering Sea: west=162.76, east=-161.44): this is
    not a bug, it is the standard convention for a box that wraps the
    antimeridian, and `antimeridian` is set alongside it so a reader does not
    have to infer the wrap from a numeric comparison. A bbox-overlap test
    built on this must treat west > east as two ranges (west..180 and
    -180..east), not reject it as an inverted box.
    """
    lats: list[float] = []
    lons: list[float] = []
    for lon, lat in _walk_lonlat(geometry.get("coordinates")):
        lats.append(lat)
        lons.append(lon)
    if not lats:
        return [0.0, 0.0, 0.0, 0.0], False
    west, east = min(lons), max(lons)
    antimeridian = geometry["type"].startswith("Multi") and (east - west) > 180
    if antimeridian:
        shifted = [lon + 360 if lon < 0 else lon for lon in lons]
        s_west, s_east = min(shifted), max(shifted)
        west = s_west - 360 if s_west > 180 else s_west
        east = s_east - 360 if s_east > 180 else s_east
    return [min(lats), west, max(lats), east], antimeridian


def _bbox_and_area(geometry: dict) -> tuple[list[float], float, bool]:
    """bbox/antimeridian (delegated to _bbox, which every kind now shares)
    plus area_deg2 -- the shoelace sum over each polygon's outer ring, summed
    across every part for a MultiPolygon.

    Marine-only, unlike bbox: area_deg2 exists purely to rank nested
    polygons on a click (the Mediterranean contains the Aegean, which
    contains the Saronic Gulf -- see _ring_area's docstring), which lakes
    (nested nine times across 1355 features, and never more than one level
    deep) and rivers (lines, which have no area at all) don't need. See
    _build_collection for where that per-kind decision is made.
    """
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    else:
        polygons = geometry["coordinates"]
    area = 0.0
    for polygon in polygons:
        if not polygon:
            continue
        area += _ring_area(polygon[0])
    bbox, antimeridian = _bbox(geometry)
    return bbox, area, antimeridian


def _build_collection(features: list[dict], prefix: str, id_fn) -> dict:
    """One dataset's raw features -> a thinned FeatureCollection.

    id_fn is native_id for marine/lakes (ne_id-backed) and feature_id for
    rivers (positional, rivers having no id of its own) -- see the module
    docstring. A feature whose geometry collapses entirely under thinning (or
    carries none to begin with) is dropped rather than stored with an
    invented shape -- the same rule admin1_boundaries.py follows for the same
    reason.
    """
    out = []
    missing_name_seq = [0]
    for feature in features or []:
        props = feature.get("properties") or {}
        geometry = thin_geometry(feature.get("geometry"), COORD_PRECISION)
        if not geometry:
            continue
        record_props = {
            "id": id_fn(prefix, props, missing_name_seq),
            "name": props.get("name") or None,
            "class": normalise_class(props.get("featurecla")),
            "featurecla": props.get("featurecla") or None,
            "scalerank": int(props["scalerank"]) if props.get("scalerank") is not None else None,
        }
        # Every kind gets bbox/antimeridian -- /api/water needs a cheap
        # stored rectangle to filter any of the three against, not just
        # marine (see _bbox's docstring for why the first cut of this, bbox
        # on marine alone, was a Task 5 review finding: lakes/rivers had to
        # fall back to walking full geometry on every request instead).
        # area_deg2 stays marine-only: it ranks nested polygons on a click,
        # which is a marine problem (the Mediterranean/Aegean/Saronic Gulf
        # nesting) that lakes barely have and rivers, being lines, cannot
        # have at all -- see _bbox_and_area's docstring.
        if prefix == "marine":
            bbox, area_deg2, antimeridian = _bbox_and_area(geometry)
            record_props["bbox"] = bbox
            record_props["area_deg2"] = area_deg2
            record_props["antimeridian"] = antimeridian
        else:
            bbox, antimeridian = _bbox(geometry)
            record_props["bbox"] = bbox
            record_props["antimeridian"] = antimeridian
        out.append({"type": "Feature", "geometry": geometry, "properties": record_props})
    _dedupe_ids(out)
    return {"type": "FeatureCollection", "features": out}


def _dedupe_ids(features: list[dict]) -> None:
    """Break ties when two features land on the same id.

    Neither id scheme is quite unique against the real files. native_id's
    ne_id has one collision in the raw file -- Great Barrier Reef published
    twice under one ne_id, a real Polygon plus a MultiPolygon of four
    degenerate slivers that thin_geometry discards (each ring collapses
    below four points once rounded to COORD_PRECISION), so in practice only
    the real polygon survives to be stored and this pair never actually
    reaches this function today. The guard stays anyway: a future Natural
    Earth release could ship coordinates fine enough that the sliver
    survives thinning, and this is the only thing standing between that and
    a silently overwritten id. feature_id's name+scalerank has many more
    real collisions: 11 pairs of distinct lakes share a name and scalerank
    (two lakes named "Trout Lake" at scalerank 5, among others), and every
    "Lake Centerline" segment in rivers.geojson pairs with a same-named,
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
    return _build_collection((payload or {}).get("features"), "marine", native_id)


def parse_lakes(payload: dict) -> dict:
    return _build_collection((payload or {}).get("features"), "lake", native_id)


def parse_rivers(payload: dict) -> dict:
    return _build_collection((payload or {}).get("features"), "river", feature_id)


def serialize(collection: dict, provenance: str) -> dict:
    """The stored document, carrying the same honesty payload railways.py
    does: which product this is, that it is public domain, and the 1:10m
    scale caveat, spelled out in `provenance` itself (see DATASETS below) so
    a reader of the stored value -- not just this docstring -- sees it. Task
    7 renders `provenance` verbatim in a "Sources & caveats" section; a scale
    ratio and a licence with no warning attached would read as more precise
    than this data actually is."""
    return {
        "attribution": PUBLISHER,
        "publisher": PUBLISHER,
        "provenance": provenance,
        **collection,
    }


# (state key, snapshot name, source URL, id prefix, id function, stored
# provenance string). native_id for marine/lakes (both carry ne_id);
# feature_id for rivers (carries no id of its own -- see the module
# docstring). Every provenance string spells out the 1:10m caveat in words,
# the way railways.py's "coarse basemap linework" does, rather than leaving a
# reader to infer what a scale ratio means: this is schematic, generalised
# geometry and will not align exactly with a coastline, shoreline or
# watercourse drawn from a higher-resolution source.
DATASETS = (
    ("marine", "water_marine", MARINE_URL, "marine", native_id,
     "Natural Earth 1:10m Geography Marine Polygons -- schematic sea/gulf/bay/"
     "strait/sound/channel outlines, generalised at 1:10,000,000 and not "
     "aligned to any higher-resolution coastline, public domain (CC0)"),
    ("lakes", "water_lakes", LAKES_URL, "lake", native_id,
     "Natural Earth 1:10m Lakes -- schematic lake and reservoir outlines, "
     "generalised at 1:10,000,000 and not aligned to any higher-resolution "
     "shoreline, public domain (CC0)"),
    ("rivers", "water_rivers", RIVERS_URL, "river", feature_id,
     "Natural Earth 1:10m Rivers + Lake Centerlines -- schematic river "
     "courses, generalised at 1:10,000,000 and not a surveyed centreline, "
     "public domain (CC0)"),
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
        for key, name, url, prefix, id_fn, provenance in DATASETS:
            payload = await _fetch(client, url)
            collection = _build_collection(payload.get("features"), prefix, id_fn)
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
