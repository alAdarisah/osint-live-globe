"""DeFlock: where the automated license plate readers are.

The locations of ALPR cameras -- Flock Safety, Motorola, Genetec and the rest --
as OpenStreetMap has them, served by DeFlock as a daily bulk mirror of one
Overpass query. This is surveillance-infrastructure *location metadata*, the
same category as osm_infra's military installations and power plants: it says
where a camera stands, not what it sees. There is no camera access here and
nothing to view -- only the pin.

Two things about this layer are deliberate and load-bearing:

- **Stored worldwide, never clipped to the conflict theatres.** The feed is
  99.78% United States, and backend/regions.py has no US theatre -- so clipping
  it the way osm_infra clips its sweep would store zero rows. That is why this
  is a whole-world snapshot. The accepted consequence is that the layer is
  visible only on the unfiltered World view (every named region is elsewhere);
  that is a property of the data's geography, not a defect, and must not be
  "fixed" later by clipping it to nothing.

- **There is no observation time, and none is invented.** A record carries
  `osm_edited_at` (OSM's `osmTimestamp`), which is the last time the OSM object
  was *edited*, not when the camera was seen or installed. It is stored under
  that name, never as a plain `time`/observation field, so nothing downstream
  can mistake an edit for a sighting. The popup must label it an edit time --
  the same honesty hazards.py applies to a GVP weekly report, which is "a report
  about a week, not a live reading".

Identity reuses osm_infra's exact `osm:{type}/{id}` scheme (same identity
space, verified), so an ALPR node and an OSM power plant can never collide.

The endpoint is keyless (HTTP 200, no auth, no User-Agent gating). Despite the
`.gz` name Cloudflare serves it as plain GeoJSON with no content-encoding, so it
is parsed directly -- gunzipping it would fail. It is ~32 MiB and refreshed
daily (`s-maxage=86400`); polling faster than that buys nothing.

Underlying data is OpenStreetMap under ODbL 1.0. Every record carries that
attribution -- `source`, `licence`, `source_url` -- so it reaches the reader
rather than only living in this comment.
"""

import asyncio
import logging
import time

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.deflock")

# Cloudflare serves this as plain GeoJSON despite the `.gz` suffix (no
# Content-Encoding), so httpx hands back the JSON directly -- do not gunzip.
CAMERAS_URL = "https://data.dontgetflocked.com/cameras.geojson.gz"

# DeFlock's own cadence: the file carries Cache-Control s-maxage=86400 and is a
# once-a-day mirror of one Overpass query, so anything faster is wasted bandwidth
# against an unchanged 32 MiB body.
REFRESH_INTERVAL = 24 * 3600
# Scaled by consecutive failures, capped at REFRESH_INTERVAL below. Ten minutes
# is a courteous base for a 32 MiB download off a volunteer-adjacent mirror --
# the same base osm_infra uses for its daily Overpass sweep.
FAILURE_RETRY_INTERVAL = 600

# ~32 MiB over an ordinary link is seconds, but a slow one can take a while, and
# the default 5s read timeout would turn every such fetch into a failure.
FETCH_TIMEOUT = 120

# Named as a courtesy even though the endpoint does not gate on it, the same way
# osm_infra identifies itself to Overpass -- a keyless public mirror is owed a
# caller it can attribute traffic to.
USER_AGENT = "osint-live-globe/1.0 (+https://github.com/)"


def _number(value):
    """A numeric field as a float, or None.

    OSM tags are freehand: `direction` is usually degrees but is occasionally a
    compass letter, and a value we cannot read as a number is left out rather
    than guessed at -- the field is named `direction_deg` and must mean degrees.
    """
    if isinstance(value, bool):  # bool is an int subclass; never a coordinate/bearing
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def parse_cameras(payload: dict) -> list[dict]:
    """A DeFlock cameras.geojson FeatureCollection -> ALPR location records.

    Read defensively by key, never by position. A feature is kept only if it has
    a Point coordinate and an OSM identity to key on; anything else is dropped
    rather than placed.

    The one case worth naming: ~18 features are `way`-type and carry no direct
    point (a way is a line/area in OSM). They have no coordinate of their own, so
    requiring a Point geometry drops them here rather than letting them land at
    null island. Inventing a centroid for them would be a coordinate DeFlock did
    not publish, so they are dropped -- honestly absent beats wrongly placed.
    """
    out: list[dict] = []
    for feature in (payload or {}).get("features") or []:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry") or {}
        # Only a Point carries a single [lon, lat]; a way's LineString/Polygon
        # (or a null geometry) is exactly the 18-feature case above, and drops.
        if geometry.get("type") != "Point":
            continue
        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue
        # GeoJSON order is [lon, lat]; reading it as [lat, lon] silently puts
        # every US camera in the Indian Ocean.
        lon, lat = _number(coords[0]), _number(coords[1])
        if lat is None or lon is None:
            continue

        props = feature.get("properties") or {}
        osm_type = props.get("osmType")
        osm_id = props.get("osmId")
        if not osm_type or osm_id is None:
            continue  # no stable identity to dedup or link on

        out.append(
            {
                # Same scheme as osm_infra (verified same identity space), so an
                # ALPR node cannot collide with any other OSM feature we hold.
                "id": f"osm:{osm_type}/{osm_id}",
                "osm_type": osm_type,
                "osm_id": osm_id,
                "kind": "deflock_alpr",
                "lat": lat,
                "lon": lon,
                # Present on only ~17.6% of records; carried as-is (None when
                # absent) rather than backfilled from brand.
                "operator": props.get("operator"),
                "brand": props.get("brand"),
                "direction_deg": _number(props.get("direction")),
                "zone": props.get("surveillanceZone"),
                "mount": props.get("mountType"),
                "osm_version": props.get("osmVersion"),
                # NOT an observation time -- see the module docstring. This is
                # when the OSM object was last edited, and the popup must say so.
                "osm_edited_at": props.get("osmTimestamp"),
                # Attribution travels with the evidence, not just in a comment.
                "source": "OpenStreetMap contributors (via DeFlock)",
                "licence": "ODbL",
                "source_url": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
            }
        )
    return out


async def _fetch(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(CAMERAS_URL)
    resp.raise_for_status()
    # Plain GeoJSON despite the `.gz` name (see CAMERAS_URL) -- parse directly.
    return parse_cameras(resp.json())


async def start():
    state = registry.register("deflock", key_configured=True)  # no key required
    # A failed boot fetch backs off to the 24h interval, so without warming the
    # layer would be blank for the rest of the day; the last stored mirror is a
    # perfectly good stand-in until the next fetch lands.
    await storage.warm_points(state, "deflock_alpr", "DeFlock ALPR")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            async with httpx.AsyncClient(
                timeout=FETCH_TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT}
            ) as client:
                records = await _fetch(client)
            state.data = records
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("DeFlock: %d ALPR locations", len(records))
            await storage.record_snapshot("deflock_alpr", state.data, id_field="id")
            await storage.record_source_health("deflock", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("DeFlock fetch failed: %s", exc)
            await storage.record_source_health("deflock", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
