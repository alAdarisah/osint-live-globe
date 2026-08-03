import asyncio
import json
import logging
import time

import websockets

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.ais")

WS_URL = "wss://stream.aisstream.io/v0/stream"
STALE_AFTER = 60 * 30  # drop ships not updated in 30 minutes

_ships: dict[int, dict] = {}
_dirty = False  # set on every incoming position report, cleared once snapshotted

# AIS "Type" (ship type code, from ShipStaticData) is a real classification
# signal PositionReport alone never carries -- e.g. 35 = "Military ops", 80-89
# = tanker. Cached separately per MMSI (static data arrives far less often
# than position reports, and on its own schedule) and merged onto each ship's
# record in _snapshot_loop below.
_ship_types: dict[int, int] = {}


def _bboxes_payload():
    return [
        [[lat_min, lon_min], [lat_max, lon_max]]
        for lat_min, lon_min, lat_max, lon_max in config.AIS_BBOXES
    ]


async def _consume(state):
    global _dirty
    subscribe_msg = {
        "APIKey": config.AISSTREAM_API_KEY,
        "BoundingBoxes": _bboxes_payload(),
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }
    async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps(subscribe_msg))
        state.last_error = None
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("MessageType")
            meta = msg.get("MetaData", {})
            mmsi = meta.get("MMSI")
            if mmsi is None:
                continue

            if msg_type == "ShipStaticData":
                static = msg.get("Message", {}).get("ShipStaticData", {})
                ship_type = static.get("Type")
                if ship_type is not None:
                    _ship_types[mmsi] = ship_type
                    if mmsi in _ships:
                        _ships[mmsi]["ship_type"] = ship_type
                continue

            if msg_type != "PositionReport":
                continue
            report = msg.get("Message", {}).get("PositionReport", {})
            lat = meta.get("latitude", report.get("Latitude"))
            lon = meta.get("longitude", report.get("Longitude"))
            if lat is None or lon is None:
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
                "ship_type": _ship_types.get(mmsi),
                "updated": time.time(),
            }
            _dirty = True


async def _snapshot_loop(state):
    global _dirty
    while True:
        await asyncio.sleep(5)
        cutoff = time.time() - STALE_AFTER
        stale = [m for m, ship in _ships.items() if ship["updated"] < cutoff]
        for mmsi in stale:
            _ships.pop(mmsi, None)
        # Only reassign (which bumps state.version, invalidating every
        # client's ETag) when something actually changed -- a quiet bbox
        # with no traffic used to still push a fresh version every 5s,
        # forcing every polling client to re-fetch identical data.
        if _dirty or stale:
            state.data = list(_ships.values())
            _dirty = False
            await storage.record_snapshot("ais", state.data, "mmsi")
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
