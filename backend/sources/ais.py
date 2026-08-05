import asyncio
import json
import logging
import time

import websockets

from backend import config, storage
from backend.cache import registry
from backend.sources import sanctions

log = logging.getLogger("osint-globe.ais")

WS_URL = "wss://stream.aisstream.io/v0/stream"
STALE_AFTER = 60 * 30  # drop ships not updated in 30 minutes

_ships: dict[int, dict] = {}
_dirty = False  # set on every incoming position report, cleared once snapshotted
_snapshot_task = None  # strong reference to the snapshot loop -- see start()

# AIS "Type" (ship type code, from ShipStaticData) is a real classification
# signal PositionReport alone never carries -- e.g. 35 = "Military ops", 80-89
# = tanker. Cached separately per MMSI (static data arrives far less often
# than position reports, and on its own schedule) and merged onto each ship's
# record in _snapshot_loop below.
_ship_types: dict[int, int] = {}

# The rest of ShipStaticData worth keeping: the IMO number and the call sign.
# Both are only broadcast in the static message -- which arrives every few
# minutes at best, and for some vessels never -- so they are cached per MMSI
# exactly like the type above rather than read off a position report.
#
# The IMO number is the reason this cache exists: it is the only permanent,
# hull-specific identifier AIS carries, and it is what makes an OFAC match
# something better than a guess (see backend/sources/sanctions.py).
_ship_static: dict[int, dict] = {}


def _identity_from_static(static: dict) -> dict:
    """IMO number and call sign out of a ShipStaticData message.

    Both are optional and both are routinely broadcast as zero or whitespace by
    vessels that have not configured their transponder -- an IMO of 0 is "not
    set", not a hull, and matching on it would designate every badly-configured
    ship in the Gulf at once.
    """
    identity = {}
    imo = static.get("ImoNumber")
    if isinstance(imo, int) and imo > 0:
        identity["imo"] = str(imo)
    callsign = (static.get("CallSign") or "").strip()
    if callsign:
        identity["callsign"] = callsign
    return identity


def _sanctions_for(mmsi: int, name: str | None) -> dict | None:
    """Whether this hull is on the OFAC SDN list, and on what evidence.

    Called on every position report, so it has to be a dict lookup and nothing
    more -- see backend/sources/sanctions.py, which pre-indexes by identifier
    for exactly this. Deliberately not matched on `name`: a vessel name is the
    easiest field in AIS to change and the most duplicated.
    """
    identity = _ship_static.get(mmsi) or {}
    return sanctions.for_vessel(
        imo=identity.get("imo"),
        mmsi=str(mmsi),
        callsign=identity.get("callsign"),
    )


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
                identity = _identity_from_static(static)
                if identity:
                    _ship_static.setdefault(mmsi, {}).update(identity)
                    if mmsi in _ships:
                        _ships[mmsi].update(identity)
                        _ships[mmsi]["sanctions"] = _sanctions_for(mmsi, _ships[mmsi].get("name"))
                        _dirty = True
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
                **(_ship_static.get(mmsi) or {}),
                "sanctions": _sanctions_for(mmsi, (meta.get("ShipName") or "").strip() or None),
                "updated": time.time(),
            }
            _dirty = True


async def _snapshot_loop(state):
    global _dirty
    # The OFAC list downloads on its own schedule and lands well after the AIS
    # stream is already running, so every ship annotated before it arrived
    # carries `sanctions: None` -- correct at the time and wrong afterwards.
    # Re-annotating whenever the index changes size is what makes the first
    # successful download (and every later update) reach ships already on the
    # map, instead of only new arrivals.
    last_sanctions_len = -1
    while True:
        await asyncio.sleep(5)
        sanctions_len = len(sanctions.current())
        if sanctions_len != last_sanctions_len:
            last_sanctions_len = sanctions_len
            for mmsi, ship in _ships.items():
                ship["sanctions"] = _sanctions_for(mmsi, ship.get("name"))
            if _ships:
                _dirty = True
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


async def _preload_from_storage():
    """Seed _ships/_ship_types from the last known position per MMSI so a
    backend restart doesn't blank out sparse-traffic boxes (Red Sea, Hormuz)
    for however long it takes fresh PositionReports to trickle back in --
    busy boxes (South China Sea) refill fast on their own, these don't."""
    global _dirty
    cutoff = time.time() - STALE_AFTER
    for ship in await storage.entity_latest("ais"):
        mmsi, updated = ship.get("mmsi"), ship.get("updated")
        if mmsi is None or updated is None or updated < cutoff:
            continue
        _ships[mmsi] = ship
        ship_type = ship.get("ship_type")
        if ship_type is not None:
            _ship_types[mmsi] = ship_type
        # ShipStaticData arrives minutes apart at best and for some vessels
        # never, so an IMO number learned before the restart is worth keeping:
        # without this the OFAC cross-reference silently drops back to the
        # weaker MMSI/call-sign match for every preloaded hull.
        identity = {k: ship[k] for k in ("imo", "callsign") if ship.get(k)}
        if identity:
            _ship_static[mmsi] = identity
    if _ships:
        _dirty = True


async def start():
    key_configured = bool(config.AISSTREAM_API_KEY)
    state = registry.register("ais", key_configured=key_configured)
    if not key_configured:
        state.last_error = "AISSTREAM_API_KEY not set in .env"
        while True:
            await asyncio.sleep(3600)

    # Seed from the last known positions before the stream starts, so sparse
    # boxes aren't blank while fresh PositionReports trickle in.
    await _preload_from_storage()

    # Held in a module-level global, not discarded: asyncio keeps only a weak
    # reference to a running task, so a bare create_task() can be garbage
    # collected mid-execution. That would silently stop the snapshot loop --
    # taking /api/ships' updates and all AIS persistence with it, while the
    # websocket kept happily filling _ships and nothing looked wrong.
    global _snapshot_task
    _snapshot_task = asyncio.create_task(_snapshot_loop(state))

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
