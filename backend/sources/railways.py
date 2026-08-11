"""Railway linework: Natural Earth's coarse linework, with an attributed
OpenStreetMap overlay layered on top where OSM has it.

**Neither half is worldwide.** Both are clipped to the same eleven
conflict-theatre boxes in backend/regions.py -- `_theatre_boxes()` below feeds
`clip_railroads` exactly as it always has, and that predates Task 27. This is
a real gap against this map's own stated intent for the layer ("NE stays as
the global fallback because OSM coverage is uneven" -- the task brief that
added the OSM overlay), not a new one this task introduced: pan to Japan or
Brazil and the layer has always been empty there, before and after this
change. What Task 27 got wrong the first time round was the *prose*, not the
clipping -- an earlier draft of this docstring and the served `provenance`
string both claimed Natural Earth was worldwide, which the code has never
done. Fixed here; see the module's own git history for the mistake if it is
ever worth learning from. Un-clipping Natural Earth to make it genuinely
global is a real candidate for its own task -- see the note on
`_theatre_boxes()` below for the one number that decision needs first.

Until Task 27 the lines were Natural Earth alone (still theatre-clipped), for
a size reason still worth repeating: OSM's own *full* rail linework is ~300 MB
per theatre-scale sweep (186.8 MB for Russia/Ukraine alone, 454x the entire
osm_infra point sweep), which is neither a polite thing to ask a volunteer
Overpass instance for nor a payload any map can carry. What changed is the
selector, not the argument -- backend/sources/osm_infra.py now asks for
exactly the running lines a train uses (railway=rail|light_rail|narrow_gauge,
no sidings/yards/platforms/disused track), which is a small enough slice of
that 300 MB to carry as a second, attributed layer rather than a replacement
for the first.

So this module now merges two sources rather than clipping one, both to the
same eleven theatre boxes:

- **Natural Earth 1:10m railroads** (nvkelso/natural-earth-vector's GeoJSON
  mirror on GitHub), fetched and clipped exactly as before. Public domain,
  unchanged since 2021, ZERO named features -- the coarser of the two, and
  broader than OSM's own selector *within* a theatre (it carries every
  railroad Natural Earth has, not just running lines), but not a step outside
  the same eleven boxes OSM is limited to.
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
or traced. Neither exists outside the conflict theatres, and the served
document's own `provenance` string says so rather than implying otherwise.

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
    """The eleven conflict-theatre boxes, the same set osm_infra sweeps.

    This is what makes Natural Earth theatre-clipped too, not just OSM -- see
    the module docstring's note on why that is honestly stated now rather than
    quietly implied to be global. Un-clipping Natural Earth (serving the
    world file as-is, skipping this call for the NE half only) is plausible:
    it is a static 38 MB file, downloaded at most weekly regardless. What is
    not known, and what the module docstring flags as the number a decision
    to do that needs first, is the byte size of the *stored* document at each
    end -- the eleven-theatre clip today versus the whole world -- since that
    is what a reader's browser actually downloads on every boot fetch of this
    MANUAL, off-by-default layer, not the 38 MB source file itself.
    """
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
    """Natural Earth's coarse theatre-clipped linework + OpenStreetMap's
    attributed theatre overlay, as one list every entry of which states its
    own source. Both inputs are already clipped to the same eleven conflict
    theatres by the time they reach here (see _theatre_boxes) -- this
    function does not widen or narrow either one's coverage, only combines
    them with their provenance intact.

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


def serialize(lines: list[dict], truncated_regions: list[str] | None = None) -> dict:
    """The stored document. The provenance string is not decoration: it is what
    the popup states, so a reader is never misled into treating basemap linework
    as survey-accurate, an unswept theatre's silence as "OSM has no railway
    here" rather than "OSM has not been asked here yet", or either half as
    covering ground it does not -- see the module docstring's own note on the
    coverage claim an earlier draft of this string got wrong.

    `truncated_regions` is passed straight through from osm_infra.py's own
    "railways_osm" document (see its serialize_rail_lines) rather than
    recomputed: this module never sees the raw Overpass element count, only
    the already-parsed lines, so it has no way to know a theatre was capped
    except by being told.
    """
    return {
        "attribution": "Natural Earth + OpenStreetMap contributors",
        "provenance": (
            "Both clipped to this map's eleven conflict theatres, not worldwide: Natural Earth "
            "1:10m (2021, coarse, unnamed) as the coarser of the two within a theatre, with "
            "OpenStreetMap's attributed running lines (name, operator, gauge, electrification) "
            "layered over it where OSM has them -- every line states which of the two it is."
        ),
        "lines": lines,
        "truncated_regions": sorted(truncated_regions or []),
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
            osm_truncated = osm_doc.get("truncated_regions") or []
            lines = merge(ne_paths, osm_lines)
            state.data = serialize(lines, osm_truncated)
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info(
                "Railways: %d lines served (%d Natural Earth, %d OpenStreetMap)%s",
                len(lines), len(ne_paths), len(osm_lines),
                f" -- capped in: {osm_truncated}" if osm_truncated else "",
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
