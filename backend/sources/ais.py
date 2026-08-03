import asyncio
import json
import logging
import time

import websockets

from backend import config
from backend.cache import registry

log = logging.getLogger("osint-globe.ais")

WS_URL = "wss://stream.aisstream.io/v0/stream"
STALE_AFTER = 60 * 30  # drop ships not updated in 30 minutes

_ships: dict[int, dict] = {}


def _bboxes_payload():
    return [
        [[lat_min, lon_min], [lat_max, lon_max]]
        for lat_min, lon_min, lat_max, lon_max in config.AIS_BBOXES
    ]


async def _consume(state):
    subscribe_msg = {
        "APIKey": config.AISSTREAM_API_KEY,
        "BoundingBoxes": _bboxes_payload(),
        "FilterMessageTypes": ["PositionReport"],
    }
    async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps(subscribe_msg))
        state.last_error = None
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("MessageType") != "PositionReport":
                continue
            meta = msg.get("MetaData", {})
            report = msg.get("Message", {}).get("PositionReport", {})
            mmsi = meta.get("MMSI")
            lat = meta.get("latitude", report.get("Latitude"))
            lon = meta.get("longitude", report.get("Longitude"))
            if mmsi is None or lat is None or lon is None:
                continue
            _ships[mmsi] = {
                "mmsi": mmsi,
                "name": (meta.get("ShipName") or "").strip() or None,
                "lat": lat,
                "lon": lon,
                "speed": report.get("Sog"),
                "course": report.get("Cog"),
                "heading": report.get("TrueHeading"),
                "nav_status": report.get("NavigationalStatus"),
                "updated": time.time(),
            }


async def _snapshot_loop(state):
    while True:
        await asyncio.sleep(5)
        cutoff = time.time() - STALE_AFTER
        for mmsi in [m for m, ship in _ships.items() if ship["updated"] < cutoff]:
            _ships.pop(mmsi, None)
        state.data = list(_ships.values())
        if _ships:
            state.last_success = time.time()


async def start():
    key_configured = bool(config.AISSTREAM_API_KEY)
    state = registry.register("ais", key_configured=key_configured)
    if not key_configured:
        state.last_error = "AISSTREAM_API_KEY not set in .env"
        while True:
            await asyncio.sleep(3600)

    asyncio.create_task(_snapshot_loop(state))

    backoff = 5
    while True:
        try:
            await _consume(state)
            backoff = 5
        except Exception as exc:  # noqa: BLE001 - keep reconnecting
            state.last_error = str(exc)
            log.warning("AIS stream error, reconnecting in %ss: %s", backoff, exc)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)
