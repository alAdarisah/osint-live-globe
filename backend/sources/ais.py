import asyncio
import json
import logging
import random
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

# When aisstream last sent us anything at all, or None if it never has this
# process. This is the only honest measure of whether the feed is working:
# _ships stays populated for half an hour after the last report (and can be
# populated at boot from storage without a single frame having arrived), so
# "we are holding ships" and "the stream is live" are different questions.
_last_message_at: float | None = None

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


# How long a connected-but-silent stream is given before it's called a fault.
# aisstream accepts the socket and says nothing whenever it has nothing to give
# -- whether that is an upstream failure on its side or an account that isn't
# streaming -- while a key it does not recognise is closed on within a second.
# Silence therefore has to be timed to be noticed at all: the world's oceans do
# not go quiet for two minutes.
SILENCE_IS_A_FAULT_AFTER = 120

# What silence means, in the words of the only two things it can be. The
# distinction matters because the two have opposite remedies and this string is
# printed verbatim in the source-status panel: for a day this file asserted the
# key was at fault, during an outage in which every aisstream user's key was
# equally "at fault" and nothing on this end could have helped.
SILENT_STREAM_DIAGNOSIS = (
    "connected to aisstream and subscribed, but it sent nothing for {seconds}s. "
    "The key was accepted -- aisstream closes on an unrecognised one within a "
    "second -- so this is aisstream having no data to give: either a service-side "
    "outage (they run for hours to days; check github.com/aisstream/issues) or an "
    "account that isn't streaming. Reconnecting on a long backoff until it returns."
)


class StreamSilent(Exception):
    """Connected, subscribed, and nothing came back."""


class StreamRefused(Exception):
    """Closed on before a single frame -- the subscription was never accepted."""


async def _consume(state):
    global _dirty, _last_message_at
    subscribe_msg = {
        "APIKey": config.AISSTREAM_API_KEY,
        "BoundingBoxes": _bboxes_payload(),
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }
    received = 0
    async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps(subscribe_msg))
        # Deliberately *not* clearing state.last_error here. Connecting is not
        # succeeding: aisstream accepts the socket and stays silent when the key
        # is recognised but the account isn't streaming, so clearing on connect
        # meant a dead feed reported itself on /api/health as configured,
        # error-free and simply holding no ships -- indistinguishable from an
        # empty ocean, and it stayed that way for as long as nobody read the
        # logs. The error now survives until a frame actually arrives.
        log.info("AIS stream connected, subscribed to %d bounding boxes", len(config.AIS_BBOXES))
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=SILENCE_IS_A_FAULT_AFTER)
            except asyncio.TimeoutError:
                raise StreamSilent(
                    SILENT_STREAM_DIAGNOSIS.format(seconds=SILENCE_IS_A_FAULT_AFTER)
                ) from None
            except websockets.ConnectionClosed as exc:
                if received:
                    return  # ordinary disconnect, reconnect on the caller's terms
                # Nothing at all before the close, which is what a refused key
                # looks like (~1s, usually without even a close frame). Named,
                # because websockets' own text for it is "no close frame
                # received or sent" -- true, and no help at all in the one place
                # this ends up, which is the source-status panel.
                raise StreamRefused(
                    f"aisstream closed the connection before sending anything "
                    f"({exc}) -- the key in AISSTREAM_API_KEY was refused, or "
                    f"the endpoint is rejecting connections outright"
                ) from None
            received += 1
            _last_message_at = time.time()
            if received == 1:
                state.last_error = None
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # aisstream reports a rejected subscription as a plain error frame
            # rather than by closing, and every frame that isn't a position
            # report used to be dropped on the floor here -- so the one message
            # explaining the silence was the one message guaranteed to be
            # ignored.
            error = msg.get("error") or msg.get("Error")
            if error:
                raise RuntimeError(f"aisstream rejected the subscription: {error}")
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


# How often the snapshot loop writes a source_health row. The loop itself runs
# every 5 seconds, which is far more often than anything reads this: the one
# consumer is dark_vessels.feed_health_baseline, which takes a median over
# hours, and a row every 5s would be 17k rows a day to say the same thing.
HEALTH_INTERVAL = 60


def health_row(now: float) -> tuple[int, bool, str | None]:
    """This moment's AIS feed health, as record_source_health's arguments.

    Exists because the AIS feed used to record *only* failures, and
    dark_vessels.py reads this table to answer the objection that its whole
    layer rests on: a vessel that stops reporting and a feed that stops
    delivering look identical from one ship's history. That guard needs
    successful rows to take a baseline from, so with none ever written it
    could never fire -- during a total outage every ship in every watched box
    "went dark" at once and the map said so.

    Measured from the last frame received rather than from what _ships holds,
    for the reason _last_message_at exists at all, and using _consume's own
    silence threshold so the heartbeat and the reconnect logic can't disagree
    about when the feed has stopped.
    """
    if _last_message_at is None:
        # "this process", not "this backend": these rows are written by the
        # ingest process now, and the backend reads them back and prefixes them
        # with which service produced them (see backend/mirror.py). Saying
        # "backend" here produced "the ingest service: no AIS frames received
        # since this backend started", which names the wrong process twice.
        return len(_ships), False, "no AIS frames received since this process started"
    silent_for = now - _last_message_at
    if silent_for >= SILENCE_IS_A_FAULT_AFTER:
        return len(_ships), False, f"no AIS frames for {int(silent_for)}s"
    return len(_ships), True, None


async def _snapshot_loop(state):
    global _dirty
    # The OFAC list downloads on its own schedule and lands well after the AIS
    # stream is already running, so every ship annotated before it arrived
    # carries `sanctions: None` -- correct at the time and wrong afterwards.
    # Re-annotating whenever the index changes size is what makes the first
    # successful download (and every later update) reach ships already on the
    # map, instead of only new arrivals.
    last_sanctions_len = -1
    last_health_at = 0.0
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

        now = time.time()
        if now - last_health_at >= HEALTH_INTERVAL:
            last_health_at = now
            await storage.record_source_health("ais", *health_row(now))

        # Frames, not ships. _ships is non-empty for half an hour after the last
        # report and can be non-empty at boot without a single frame having
        # arrived (see _preload_from_storage), so reporting a successful poll
        # from it is what let a dead stream keep a green light on /api/health.
        if _last_message_at is not None:
            state.last_success = _last_message_at


# Reconnect backoff, in seconds. The cap used to be a minute, which is the
# right number for a service that fails for a minute. aisstream does not: its
# failures are measured in hours and days, with the socket still accepting
# connections and still answering pings while delivering nothing, so nothing
# about the failure itself slows a client down. At a 60s cap that is roughly
# 500 connection attempts a day aimed at an endpoint that is already
# struggling, and aisstream rate-limits by account and IP rather than by key
# (aisstream/issues#253) -- users have had to open issues apologising for
# exactly this pattern and asking to be unblocked (#256), which converts their
# outage into a self-inflicted one that outlives it.
#
# 15 minutes costs at most 15 minutes of blindness after the feed returns.
# That is the whole price, and it is the right side of the trade.
BACKOFF_START = 5
BACKOFF_CAP = 900

# Every client hits the same wall at the same second when a service-wide outage
# starts, and a pure doubling schedule keeps them in lockstep all the way up --
# each retry tier arriving as one synchronised burst. The jitter is what spreads
# them out, and it is applied to the sleep rather than folded back into the
# schedule so the schedule itself stays exact and testable.
BACKOFF_JITTER = 0.25


def _next_backoff(backoff: float) -> float:
    return min(backoff * 2, BACKOFF_CAP)


def _reconnect_delay(backoff: float) -> float:
    return backoff * (1 + random.uniform(-BACKOFF_JITTER, BACKOFF_JITTER))


async def _preload_from_storage():
    """Seed _ships/_ship_types from the last known position per MMSI so a
    backend restart doesn't blank out sparse-traffic boxes (Red Sea, Hormuz)
    for however long it takes fresh PositionReports to trickle back in --
    busy boxes (South China Sea) refill fast on their own, these don't."""
    global _dirty
    # app.py's lifespan schedules init_pool as a task rather than awaiting it,
    # so at the moment this runs the pool is normally still connecting and
    # entity_latest() answers [] -- which is not "nothing stored", it is "asked
    # too early". Without this wait the preload had never once done anything
    # under compose, silently, since every read path is written to degrade
    # rather than raise. Bounded by the same short budget every other warm path
    # uses (storage._WARM_POOL_WAIT), so a run with no database at all doesn't
    # delay the stream.
    if not await storage.wait_for_warm_pool():
        return
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


async def stream_forever():
    """The AIS subscription, for the life of the ingest process.

    Deliberately not a scheduled job like the other ingest sources: this is a
    persistent websocket, and the reconnect backoff at the bottom -- capped at
    15 minutes and jittered -- exists because aisstream's outages last hours
    while the socket still accepts connections. Re-entering this on a timer
    would step straight over that backoff, which is the one thing keeping us
    from hammering a service that is already down.

    _preload_from_storage below stays worth doing here even though this process
    serves nobody: _ships is the accumulator that gets snapshotted, so seeding
    it is what stops an ingest restart from writing away a sparse box's ships as
    though they had vanished.
    """
    key_configured = bool(config.AISSTREAM_API_KEY)
    state = registry.ensure("ais", key_configured=key_configured)
    if not key_configured:
        state.last_error = "AISSTREAM_API_KEY not set in .env"
        # Written to source_health, not just held on the state: this process has
        # no /api/health of its own, and without a row the backend reports the
        # ingest service as never having run -- which sends someone looking at
        # the container instead of at the missing key.
        await storage.record_source_health("ais", None, False, state.last_error)
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

    backoff = BACKOFF_START
    while True:
        try:
            await _consume(state)
            # Only a connection that actually delivered something returns
            # normally (see _consume), so this really does mean "that one
            # worked". Resetting the backoff on any return at all turned a
            # stream that connects and immediately ends into a silent hot
            # reconnect loop -- no error, no log, nothing on /api/health.
            backoff = BACKOFF_START
        except Exception as exc:  # noqa: BLE001 - keep reconnecting
            state.last_error = str(exc)
            delay = _reconnect_delay(backoff)
            log.warning("AIS stream error, reconnecting in %ds: %s", delay, exc)
            await storage.record_source_health("ais", None, False, str(exc))
            await asyncio.sleep(delay)
            backoff = _next_backoff(backoff)
