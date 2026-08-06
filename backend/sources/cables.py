"""Submarine cables and their landing points.

Very nearly the whole of the internet between continents runs through about 500
cables, and the places they come ashore are a short, published list of specific
buildings. Neither has been visible on this map, which means a cable cut -- one
of the most consequential things that can happen to a country short of an
invasion -- had nowhere to show up.

TeleGeography publish the map behind submarinecablemap.com as plain GeoJSON with
no key: 718 cable routes as MultiLineStrings, 1,922 landing points as Points.
The geometry is schematic rather than survey-accurate (it is drawn for a map,
not for a chart), which is stated in the popup: this is where a cable runs, not
where to find it on the seabed.

Paired with backend/sources/outages.py, which is the other half of the story --
a landing point next to a country whose connectivity just collapsed.
"""

import asyncio
import logging
import time

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.cables")

CABLES_URL = "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json"
LANDINGS_URL = "https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json"
REFRESH_INTERVAL = 24 * 3600  # new cables land a few times a year
FAILURE_RETRY_INTERVAL = 300  # scaled by consecutive failures, capped at REFRESH_INTERVAL


def parse_cables(payload: dict) -> list[dict]:
    """The cable FeatureCollection -> one record per cable, routes flattened.

    A cable arrives as a MultiLineString because it lands in several places and
    the drawing is split at the antimeridian; the segments are kept as a list of
    coordinate paths so the frontend can draw each as its own polyline instead
    of joining Tokyo to Los Angeles across the map.
    """
    out: list[dict] = []
    for feature in (payload or {}).get("features") or []:
        props = feature.get("properties") or {}
        geometry = feature.get("geometry") or {}
        kind = geometry.get("type")
        raw = geometry.get("coordinates") or []
        if kind == "LineString":
            segments = [raw]
        elif kind == "MultiLineString":
            segments = raw
        else:
            continue
        # GeoJSON is lon/lat; Leaflet wants lat/lon, and doing the swap once
        # here beats doing it per point in the browser for 718 cables.
        paths = [
            [[float(pt[1]), float(pt[0])] for pt in segment if len(pt) >= 2]
            for segment in segments
        ]
        paths = [p for p in paths if len(p) >= 2]
        if not paths:
            continue
        cable_id = props.get("id") or props.get("feature_id")
        if not cable_id:
            continue
        out.append({
            "id": cable_id,
            "name": props.get("name") or cable_id,
            # TeleGeography's own per-cable colour. Reused so a cable looks the
            # same here as on the map every reader has already seen.
            "color": props.get("color"),
            "paths": paths,
        })
    return out


def parse_landings(payload: dict) -> list[dict]:
    """The landing-point FeatureCollection -> points.

    `is_tbd` marks a planned landing whose site is not settled. Kept, because
    "a cable is about to come ashore here" is itself worth knowing, but flagged
    so it is never drawn as an existing facility.
    """
    out: list[dict] = []
    for feature in (payload or {}).get("features") or []:
        props = feature.get("properties") or {}
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            continue
        landing_id = props.get("id")
        if not landing_id:
            continue
        out.append({
            "id": landing_id,
            "name": props.get("name") or landing_id,
            "lat": lat,
            "lon": lon,
            "planned": bool(props.get("is_tbd")),
        })
    return out


def serialize(cables: list[dict], landings: list[dict]) -> dict:
    return {"cables": cables, "landings": landings}


async def _fetch() -> tuple[list[dict], list[dict]]:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        cables_resp, landings_resp = await asyncio.gather(
            client.get(CABLES_URL), client.get(LANDINGS_URL)
        )
    cables_resp.raise_for_status()
    landings_resp.raise_for_status()
    return parse_cables(cables_resp.json()), parse_landings(landings_resp.json())


async def start():
    state = registry.register("cables", key_configured=True)  # no key required
    # Refetched once a day, and a failed fetch backs off to the same day, so a
    # bad boot used to leave the layer empty until tomorrow. The stored copy is
    # served in the meantime; the fetch below overwrites it when it lands.
    await storage.warm_reference(state, "cables", "Submarine cables")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            cables, landings = await _fetch()
            state.data = serialize(cables, landings)
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Submarine cables: %d routes, %d landing points", len(cables), len(landings))
            # Two writes, because this source publishes two shapes. The landing
            # points are entities with a position and belong in the point store
            # (that is what puts them on the replay timeline); the routes are
            # lines, which have no place there, so the served document is also
            # stored whole -- without that the routes were the one thing this
            # source collected that never reached Postgres at all.
            await storage.record_snapshot("cable_landings", landings, id_field="id")
            await storage.record_reference("cables", state.data)
            await storage.record_source_health("cables", len(cables), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Submarine cable fetch failed: %s", exc)
            await storage.record_source_health("cables", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
