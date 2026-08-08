"""Railway *linework*, as coarse basemap context under the OSM station points.

The station/halt/yard/border *points* come from Overpass, inside the existing
osm_infra sweep. The lines do not, and cannot: OSM's own rail linework is ~300
MB per theatre-scale sweep (186.8 MB for Russia/Ukraine alone, 454x the entire
osm_infra sweep), which is neither a polite thing to ask a volunteer Overpass
instance for nor a payload any map can carry.

So the lines come from a static file instead -- Natural Earth's 1:10m railroads,
which nvkelso/natural-earth-vector mirrors as GeoJSON on GitHub. The GeoJSON is
preferred over the shapefile purely so this needs nothing but stdlib `json`: no
shapefile parser, no new dependency. The file is public domain (CC0) and has not
changed since 2021, so a once-a-week download of ~38 MB is generous.

Honesty requirement, carried in the stored document and meant for the popup:
this is 1:10m basemap linework. It has ZERO named features, no operator and no
gauge, it is static since 2021, and it will not sit exactly on the OSM station
points -- it is context, not survey data. Attribution is "Natural Earth".

Stored as a whole document, exactly like cables.py stores cable routes: lines
have no per-row lat/lon and belong in reference_snapshots, not entity_latest.
Keyless and unmetered, so this is a backend-polled source.
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
# of a 38 MB file that never changes is already more than it warrants.
REFRESH_INTERVAL = 7 * 24 * 3600
# Scaled by consecutive failures, capped at REFRESH_INTERVAL. Starts wide
# because each attempt is a large download; there is no cheap retry here.
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


def serialize(lines: list[list[list[float]]]) -> dict:
    """The stored document. The provenance string is not decoration: it is what
    the popup states, so a reader is never misled into treating basemap linework
    as survey-accurate or expecting it to align with the OSM station points."""
    return {
        "attribution": "Natural Earth",
        "provenance": "Natural Earth 1:10m, 2021, coarse basemap linework, unnamed",
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
    await storage.warm_reference(state, "railways", "Railways (Natural Earth)")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            lines = clip_railroads(await _fetch(), _theatre_boxes())
            state.data = serialize(lines)
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Railways: %d Natural Earth line segments clipped to %d theatres",
                     len(lines), len(_theatre_boxes()))
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
            REFRESH_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
