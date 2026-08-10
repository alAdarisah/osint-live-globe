"""Railway linework: Natural Earth's coarse global fallback, with an attributed
OpenStreetMap overlay layered on top where OSM has it.

Until Task 27 the lines were Natural Earth alone, for a size reason still worth
repeating: OSM's own *full* rail linework is ~300 MB per theatre-scale sweep
(186.8 MB for Russia/Ukraine alone, 454x the entire osm_infra point sweep),
which is neither a polite thing to ask a volunteer Overpass instance for nor a
payload any map can carry. What changed is the selector, not the argument --
backend/sources/osm_infra.py now asks for exactly the running lines a train
uses (railway=rail|light_rail|narrow_gauge, no sidings/yards/platforms/disused
track), which is a small enough slice of that 300 MB to carry as a second,
attributed layer rather than a replacement for the first.

So this module now merges two sources rather than clipping one:

- **Natural Earth 1:10m railroads** (nvkelso/natural-earth-vector's GeoJSON
  mirror on GitHub), fetched and clipped exactly as before. Public domain,
  unchanged since 2021, ZERO named features -- the global fallback, everywhere
  OSM's theatre-scoped sweep does not reach.
- **OpenStreetMap's attributed overlay**, swept daily by osm_infra.py in the
  ingest process (a different process; Overpass is a volunteer service and a
  20-minute sweep restarting on every backend redeploy would be a discourtesy
  -- see the note on _SOURCE_MODULES in backend/app.py) and read back here as
  a stored reference document, "railways_osm". Carries name, operator, gauge,
  electrified, usage and service where OSM has them, clipped to the eleven
  conflict theatres only.

Honesty requirement, carried in the stored document and meant for the popup:
**every line states which of the two it came from** (`source: "ne" | "osm"`),
never merged into one undifferentiated claim. A Natural Earth run is still
unnamed 1:10m basemap context that will not sit exactly on the OSM station
points; an OSM way is a named, attributed feature a mapper actually surveyed
or traced, only where the conflict-theatre sweep reaches.

Stored as a whole document, exactly like cables.py stores cable routes: lines
have no per-row lat/lon and belong in reference_snapshots, not entity_latest.
Keyless and unmetered, so this stays a backend-polled source -- the OSM half
is a plain Postgres read, not a second Overpass client, so restarting this
process costs nothing beyond the weekly Natural Earth download's own schedule.
"""

import asyncio
import json
import logging
import time

import httpx

from backend import regions, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.railways")

# nvkelso/natural-earth-vector, the canonical GeoJSON mirror of Natural Earth.
# The 10m railroads file is ~37.8 MB; the shapefile (~14.4 MB) would be smaller
# on the wire but would pull in a shapefile reader, which json does not.
RAILROADS_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_10m_railroads.geojson"
)

# The file is static (unchanged since 2021), so this is about being a good
# citizen of GitHub's raw CDN rather than about freshness -- weekly re-download
# of a 38 MB file that never changes is already more than it warrants. Governs
# only the Natural Earth half below; see MERGE_INTERVAL for the OSM half.
REFRESH_INTERVAL = 7 * 24 * 3600
# How often the merged document is rebuilt and republished. Separate from
# REFRESH_INTERVAL above on purpose: osm_infra.py sweeps the OSM overlay once a
# day in a different process, and this is a plain Postgres read of what it
# found, not a fetch -- so it costs nothing to check daily even though the 38
# MB Natural Earth download it merges with stays on its own weekly clock. A
# reader who reloads the page picks up a new theatre's OSM lines within a day
# of the sweep finding them, without this module downloading anything of its
# own more than once a week.
MERGE_INTERVAL = 24 * 3600
# Scaled by consecutive failures, capped at MERGE_INTERVAL. Starts wide because
# the Natural Earth half of a failed pass may have been a large download; the
# OSM half's own read is cheap and would happily retry sooner; matching the
# slower one is the safe default.
FAILURE_RETRY_INTERVAL = 600


def _theatre_boxes() -> list[tuple[float, float, float, float]]:
    """The eleven conflict-theatre boxes, the same set osm_infra sweeps."""
    return [entry["bounds"] for entry in regions.REGIONS.values() if entry.get("bounds")]


def _in_any_box(lat: float, lon: float, boxes) -> bool:
    for south, west, north, east in boxes:
        if south <= lat <= north and west <= lon <= east:
            return True
    return False


def _clip_path(path: list[list[float]], boxes) -> list[list[list[float]]]:
    """Split one [lat, lon] path into the runs that fall inside any theatre box.

    A point-membership clip, not a true geometric line-box intersection: at
    1:10m the linework is coarse enough that cutting exactly on a box edge would
    be false precision. Consecutive in-box points form one run; the first point
    outside every box ends it. Runs of fewer than two points are dropped -- a
    single point is not a line.
    """
    runs: list[list[list[float]]] = []
    current: list[list[float]] = []
    for lat, lon in path:
        if _in_any_box(lat, lon, boxes):
            current.append([lat, lon])
        elif current:
            runs.append(current)
            current = []
    if current:
        runs.append(current)
    return [run for run in runs if len(run) >= 2]


def clip_railroads(payload: dict, boxes) -> list[list[list[float]]]:
    """The Natural Earth FeatureCollection -> theatre-clipped [lat, lon] lines.

    Every feature is a LineString or MultiLineString; anything else is skipped.
    GeoJSON is lon/lat and Leaflet wants lat/lon, so the swap is done once here
    rather than per point in the browser -- the same choice parse_cables makes.
    Natural Earth carries no usable per-feature identity (no name, operator or
    gauge), so a line is just its geometry: there is nothing else to keep.
    """
    out: list[list[list[float]]] = []
    for feature in (payload or {}).get("features") or []:
        geometry = feature.get("geometry") or {}
        gtype = geometry.get("type")
        raw = geometry.get("coordinates") or []
        if gtype == "LineString":
            segments = [raw]
        elif gtype == "MultiLineString":
            segments = raw
        else:
            continue
        for segment in segments:
            latlon = [[float(pt[1]), float(pt[0])] for pt in segment if len(pt) >= 2]
            out.extend(_clip_path(latlon, boxes))
    return out


def ne_line_records(paths: list[list[list[float]]]) -> list[dict]:
    """Natural Earth's [lat, lon] runs -> line records carrying source="ne".

    Natural Earth has no per-feature identity (see clip_railroads' own note) --
    no name, no id, nothing to keep beyond the geometry -- so wrapping it is
    only ever about adding the one thing every line here must carry: which of
    the two sources it came from.
    """
    return [{"source": "ne", "path": path} for path in paths]


def merge(ne_paths: list[list[list[float]]], osm_lines: list[dict]) -> list[dict]:
    """Natural Earth's coarse global fallback + OpenStreetMap's attributed
    theatre overlay, as one list every entry of which states its own source.

    Per-feature provenance, not a document-level flag: `source: "ne" | "osm"`
    rides every record, which is what lets the popup and the renderer treat a
    named, attributed OSM way differently from an unnamed 1:10m basemap run
    without this module maintaining two separate documents or the frontend
    making two separate fetches. OSM's own records already carry source="osm"
    at the point of collection (see osm_infra.parse_rail_lines) -- this only
    adds it to the Natural Earth half and concatenates the two. Neither list
    is deduplicated against the other: they are different claims about
    (mostly) the same tracks, not two copies of one claim, so both are kept.
    """
    return ne_line_records(ne_paths) + list(osm_lines or [])


def serialize(lines: list[dict]) -> dict:
    """The stored document. The provenance string is not decoration: it is what
    the popup states, so a reader is never misled into treating basemap linework
    as survey-accurate, or an unswept theatre's silence as "OSM has no railway
    here" rather than "OSM has not been asked here yet"."""
    return {
        "attribution": "Natural Earth + OpenStreetMap contributors",
        "provenance": (
            "Natural Earth 1:10m (2021, coarse, unnamed) worldwide, with OpenStreetMap's "
            "attributed running lines (name, operator, gauge, electrification) layered on "
            "top across the conflict theatres only -- every line states which of the two it is."
        ),
        "lines": lines,
    }


async def _fetch() -> dict:
    # ~38 MB over GitHub's raw CDN. The timeout is generous because the payload
    # is large, not because the endpoint is slow; a stall past this just means
    # the layer keeps whatever it warmed with and retries later.
    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
        resp = await client.get(RAILROADS_URL)
    resp.raise_for_status()
    return json.loads(resp.content)


async def start():
    state = registry.register("railways", key_configured=True)  # no key required
    # Weekly refresh with a failure backoff of the same order, so a failed boot
    # fetch would otherwise leave the layer blank for up to a week. The stored
    # copy is served meanwhile; the fetch below overwrites it when it lands.
    await storage.warm_reference(state, "railways", "Railways (Natural Earth + OpenStreetMap)")
    consecutive_failures = 0
    # Cached across iterations so MERGE_INTERVAL's daily cycle does not
    # re-download the 38 MB Natural Earth file every time it only needs to
    # pick up a new OSM sweep -- see MERGE_INTERVAL's own note.
    ne_paths: list[list[list[float]]] = []
    last_ne_fetch = 0.0
    while True:
        ok = False
        try:
            if not ne_paths or time.time() - last_ne_fetch >= REFRESH_INTERVAL:
                ne_paths = clip_railroads(await _fetch(), _theatre_boxes())
                last_ne_fetch = time.time()
                log.info("Railways: %d Natural Earth line segments clipped to %d theatres",
                         len(ne_paths), len(_theatre_boxes()))
            # A plain Postgres read of whatever osm_infra.py's own Overpass
            # sweep last found, in a different process, on its own daily
            # clock -- not a fetch, so there is nothing here to fail loudly on
            # a cold theatre; an empty or missing document just means "not
            # swept yet", the same as any other reference() miss.
            osm_doc = await storage.reference("railways_osm") or {}
            osm_lines = osm_doc.get("lines") or []
            lines = merge(ne_paths, osm_lines)
            state.data = serialize(lines)
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info(
                "Railways: %d lines served (%d Natural Earth, %d OpenStreetMap)",
                len(lines), len(ne_paths), len(osm_lines),
            )
            # Lines have no per-row lat/lon, so they are a whole document in
            # reference_snapshots -- the same shape cables.py stores its routes.
            await storage.record_reference("railways", state.data)
            await storage.record_source_health("railways", len(lines), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Railways fetch failed: %s", exc)
            await storage.record_source_health("railways", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            MERGE_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, MERGE_INTERVAL)
        )
