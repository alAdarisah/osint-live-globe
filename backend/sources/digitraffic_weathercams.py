"""Finnish road weather-camera LOCATIONS, from Fintraffic / Digitraffic.

Where the roadside weather cameras stand -- a DeFlock-shaped locations layer, the
same category as backend/sources/deflock.py: it says where a camera is, not what
it sees. Three things about that are deliberate and load-bearing:

- **Locations only, never imagery.** The record carries the camera's id, name,
  coordinates and the public preset image *URLs* as metadata. It never fetches
  or embeds the JPEG bytes, and it never touches the ``/{id}/history`` image
  feeds. The URLs are public and cost nothing to carry; the bytes are not this
  layer's business.

- **No observation time is invented.** These features carry ``dataUpdatedTime``,
  which is when the station *metadata* was last refreshed -- not when anything
  was seen. It is stored under that name, never as a plain ``time``, so nothing
  downstream can mistake a metadata refresh for a sighting. This is the same
  honesty deflock.py applies to an OSM edit timestamp.

- **Stored worldwide, keyed on the camera id.** kind="weathercam", id_field="id".
  The stations are all in Finland, so a conflict-theatre region filter returns
  nothing and this is a World-view layer -- offered on /api/weathercams for
  consistency with the other point sources.

Keyless, with a ``Digitraffic-User`` courtesy header; gzip is mandatory and httpx
sends it by default. The metadata updates hourly (PT1H), so the poll matches.
Licence CC BY 4.0, carried on every record.
"""

import asyncio
import logging
import time

import httpx

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.digitraffic_weathercams")

STATIONS_URL = "https://tie.digitraffic.fi/api/weathercam/v1/stations"

PUBLISHER = "Fintraffic / digitraffic.fi"
LICENSE = "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"

# 810 features at ~465 KB. Seconds over an ordinary link, but a slow one would
# turn the default 5s read timeout into a spurious failure, so the budget is
# generous the way deflock's is for its larger download.
FETCH_TIMEOUT = 60
# Scaled by consecutive failures, capped at the hourly poll interval. Ten minutes
# is a courteous base for a keyless public endpoint.
FAILURE_RETRY_INTERVAL = 600


def _num(value):
    """A numeric field as a float, or None. A bool is never a coordinate."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _preset_image_urls(props: dict) -> list[str]:
    """The public preset image URLs, in order. URLs only -- never the bytes.

    Each preset is one framing of the same camera. The URL is what a reader
    follows to view the image themselves; this module never fetches it.
    """
    urls: list[str] = []
    for preset in props.get("presets") or []:
        if not isinstance(preset, dict):
            continue
        url = preset.get("imageUrl")
        if isinstance(url, str) and url.strip():
            urls.append(url.strip())
    return urls


def parse_camera(feature: dict) -> dict | None:
    """One weathercam GeoJSON feature -> a camera location record, or None.

    Read defensively by key. GeoJSON order is [lon, lat]; a feature with no Point
    geometry or no id is dropped rather than placed.
    """
    if not isinstance(feature, dict):
        return None
    geometry = feature.get("geometry") or {}
    if geometry.get("type") != "Point":
        return None
    coords = geometry.get("coordinates") or []
    if len(coords) < 2:
        return None
    lon, lat = _num(coords[0]), _num(coords[1])
    if lat is None or lon is None:
        return None
    if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
        return None

    props = feature.get("properties") or {}
    camera_id = feature.get("id")
    if camera_id is None:
        camera_id = props.get("id")
    if camera_id is None:
        return None  # no stable identity to key on

    return {
        "id": str(camera_id),
        "kind": "weathercam",
        "lat": lat,
        "lon": lon,
        "name": props.get("name") or feature.get("name"),
        # Public URLs, carried as metadata. Never the JPEG bytes, never the
        # /{id}/history feeds -- see the module docstring.
        "image_urls": _preset_image_urls(props),
        # A metadata refresh time, NOT an observation. Named so a reader cannot
        # mistake it for a sighting, the way deflock names osm_edited_at.
        "data_updated_time": props.get("dataUpdatedTime") or feature.get("dataUpdatedTime"),
        "source": "digitraffic",
        "publisher": PUBLISHER,
        "license": LICENSE,
        "source_url": "https://www.digitraffic.fi/en/road-traffic/weather-cameras/",
    }


def parse_weathercams(payload) -> list[dict]:
    """A weathercam stations FeatureCollection -> camera location records."""
    out: list[dict] = []
    for feature in (payload or {}).get("features") or []:
        record = parse_camera(feature)
        if record is not None:
            out.append(record)
    return out


def _headers() -> dict:
    # Courtesy identifier; not a secret, not gated on. Accept-Encoding is left to
    # httpx (gzip by default) -- the API answers 406 without it.
    return {"Digitraffic-User": config.DIGITRAFFIC_USER}


async def _fetch(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(STATIONS_URL)
    resp.raise_for_status()
    return parse_weathercams(resp.json())


async def start():
    state = registry.register("weathercams", key_configured=True)  # keyless
    # A failed boot fetch backs off toward the hourly interval, so without
    # warming the layer would be blank for up to an hour; the last stored mirror
    # is a correct stand-in until the next fetch lands.
    await storage.warm_points(state, "weathercam", "Weather cameras")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            async with httpx.AsyncClient(
                timeout=FETCH_TIMEOUT, follow_redirects=True, headers=_headers()
            ) as client:
                records = await _fetch(client)
            state.data = records
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Digitraffic weather cameras: %d locations", len(records))
            await storage.record_snapshot("weathercam", state.data, id_field="id")
            await storage.record_source_health("weathercams", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Digitraffic weather cameras fetch failed: %s", exc)
            await storage.record_source_health("weathercams", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            config.DIGITRAFFIC_WEATHERCAM_POLL_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, config.DIGITRAFFIC_WEATHERCAM_POLL_INTERVAL)
        )
