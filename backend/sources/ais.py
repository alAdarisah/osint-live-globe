import asyncio
import json
import logging
import random
import time
from datetime import timezone
from email.utils import parsedate_to_datetime

import websockets

from backend import config, proxypool, storage
from backend.cache import registry
from backend.sources import maritime_watchlists, sanctions

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

# The rest of ShipStaticData worth keeping. All of it is only broadcast in the
# static message -- which arrives every few minutes at best, and for some
# vessels never -- so it is cached per MMSI exactly like the type above rather
# than read off a position report, which carries none of it.
#
# The IMO number is the reason this cache exists: it is the only permanent,
# hull-specific identifier AIS carries, and it is what makes an OFAC match
# something better than a guess (see backend/sources/sanctions.py).
_ship_static: dict[int, dict] = {}

# Everything learned from a static frame that has to outlive the next position
# report, which rebuilds a ship's record from scratch. Named in one place
# because it is read in two: the rebuild merges these in, and
# _preload_from_storage restores them after a restart. A field added to one and
# not the other is dropped on the first position report after a restart --
# silently, and only for hulls that had already gone quiet.
_STATIC_KEYS = ("imo", "callsign", "destination", "draught", "eta", "length_m", "beam_m")

# AIS pads its fixed-width six-bit text fields with '@', so an unconfigured
# destination or call sign arrives as "@@@@@@@@@@@@@@@@@@@@" rather than as an
# empty string. Storing that puts a row of at-signs in the popup where "not
# stated" belongs.
_AIS_PAD = "@"

# Maximum static draught is an 8-bit field in tenths of a metre, so 25.5 m is
# the top of the scale and anything above it did not come off a transponder.
# (25.5 itself is saturated, meaning "at least this deep".)
MAX_DRAUGHT_M = 25.5


def _static_text(value) -> str | None:
    """A ShipStaticData string field, with AIS's own padding removed."""
    if not isinstance(value, str):
        return None
    return value.replace(_AIS_PAD, "").strip() or None


def _identity_from_static(static: dict) -> dict:
    """IMO number and call sign out of a ShipStaticData message.

    Kept separate from _voyage_from_static below, and the split is the point:
    these two fields are what a designation is matched on. An IMO is assigned to
    a hull for life. Everything in the other function is a value somebody typed
    into a transponder before sailing.

    Both are optional and both are routinely broadcast as zero or whitespace by
    vessels that have not configured their transponder -- an IMO of 0 is "not
    set", not a hull, and matching on it would designate every badly-configured
    ship in the Gulf at once.
    """
    identity = {}
    imo = static.get("ImoNumber")
    if isinstance(imo, int) and imo > 0:
        identity["imo"] = str(imo)
    callsign = _static_text(static.get("CallSign"))
    if callsign:
        identity["callsign"] = callsign
    return identity


def _eta_from_static(eta) -> dict | None:
    """The ETA fields, kept as the parts AIS actually sends.

    Deliberately not converted to a timestamp. The AIS ETA carries month, day,
    hour and minute and no year at all, so any absolute time is a guess -- and
    the guess is wrong exactly where it would matter, on a voyage crossing new
    year.

    The ranges are written out rather than tested for truthiness because ITU-R
    M.1371 spells its "not available" values differently per field: month 0 and
    day 0 mean unset, but hour 0 is midnight and minute 0 is on the hour.
    """
    if not isinstance(eta, dict):
        return None

    def _part(value, low, high):
        return value if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high else None

    month = _part(eta.get("Month"), 1, 12)
    day = _part(eta.get("Day"), 1, 31)
    # A time of day with no date attached is a clock reading, not an ETA.
    if month is None or day is None:
        return None
    parts = {"month": month, "day": day}
    hour = _part(eta.get("Hour"), 0, 23)      # 24 is M.1371's "not available"
    minute = _part(eta.get("Minute"), 0, 59)  # 60 is M.1371's "not available"
    if hour is not None:
        parts["hour"] = hour
    if minute is not None:
        parts["minute"] = minute
    return parts


def _span(near, far) -> int | None:
    """One pair of the Dimension field, summed: A+B is length, C+D is beam.

    Each half is a distance from the GPS antenna, so a single zero is ordinary
    (an antenna right at the bow) but a zero sum is the field's "not available".
    """
    if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (near, far)):
        return None
    total = near + far
    return total or None


def _voyage_from_static(static: dict) -> dict:
    """The crew-configured half of ShipStaticData: draught, destination, ETA, size.

    None of this is measured. Draught is a number the crew sets before sailing,
    destination is free text they type, and both are frequently wrong on exactly
    the hulls worth watching -- which is the signal, not a defect: a declared
    destination the track contradicts is a fact about the declaration.

    So nothing here is ever matched on, and nothing here is turned into a
    verdict. In particular no laden/ballast state is computed from draught. That
    inference is *available* -- record_snapshot writes the whole payload into
    entity_history on every movement (see backend/storage.py), so a per-hull
    draught series already accumulates for free alongside the track -- but a
    verdict drawn from a self-reported number is an inference of exactly
    dark_vessels.py's tier, and would have to arrive on the map saying so rather
    than as a fact attached to a ship pin.

    The guards follow _identity_from_static's: that function refuses an IMO of 0
    because "not set" is not a hull, and a draught of 0.0 is not a ship floating
    on the surface.
    """
    voyage = {}
    draught = static.get("MaximumStaticDraught")
    if (
        isinstance(draught, (int, float))
        and not isinstance(draught, bool)
        and 0 < draught <= MAX_DRAUGHT_M
    ):
        # Tenths of a metre is the field's own resolution; anything finer is
        # float noise from the decode, not a more precise reading.
        voyage["draught"] = round(float(draught), 1)
    destination = _static_text(static.get("Destination"))
    if destination:
        voyage["destination"] = destination
    eta = _eta_from_static(static.get("Eta"))
    if eta:
        voyage["eta"] = eta
    dimension = static.get("Dimension")
    if isinstance(dimension, dict):
        length = _span(dimension.get("A"), dimension.get("B"))
        beam = _span(dimension.get("C"), dimension.get("D"))
        if length:
            voyage["length_m"] = length
        if beam:
            voyage["beam_m"] = beam
    return voyage


def _annotations_for(mmsi: int) -> dict:
    """What the reference lists say about this hull, as separate claims.

    Two fields rather than one, and they are not merged. An OFAC designation and
    a Tokyo MoU detention are both "flagged" only if you stop reading: one is a
    legal listing by a government, the other is a port-state inspection that
    found the lifeboats short, and a third of the maritime collection is an
    allegation by a belligerent state's military intelligence service (see
    backend/sources/maritime_watchlists.py). Collapsing them into one dot is the
    failure dark_vessels.py's docstring exists to prevent.

    Called on every position report, so both halves have to be a dict lookup and
    nothing more -- each module pre-indexes by identifier for exactly this.
    Deliberately not matched on `name`: a vessel name is the easiest field in
    AIS to change and the most duplicated.
    """
    identity = _ship_static.get(mmsi) or {}
    imo = identity.get("imo")
    return {
        "sanctions": sanctions.for_vessel(
            imo=imo,
            mmsi=str(mmsi),
            callsign=identity.get("callsign"),
        ),
        "watchlist": maritime_watchlists.for_vessel(imo=imo, mmsi=str(mmsi)),
    }


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


# The live socket, so shutdown can close it politely -- see aclose(). Held
# because the alternative is what this process used to do: get its tasks
# cancelled, drop the TCP connection without a close frame, and leave aisstream
# holding a session it only discards when its own keepalive ping times out.
# Restart inside that window and the new connection is a *second* concurrent
# session as far as they are concerned, from an account that is allowed few.
_connection = None


async def aclose() -> None:
    """Close the AIS socket, before this process's tasks are cancelled.

    Idempotent and never raises: it runs on the shutdown path, where the useful
    behaviour is to try and then get out of the way. Nothing reconnects after
    it -- the stream task is cancelled immediately afterwards -- so a closed
    connection here stays closed.
    """
    global _connection
    connection, _connection = _connection, None
    if connection is None:
        return
    try:
        await connection.close()
        log.info("AIS socket closed cleanly on shutdown")
    except Exception as exc:  # noqa: BLE001 - shutdown is not a place to raise
        log.warning("AIS socket did not close cleanly: %s", exc)


class EgressUnusable(Exception):
    """A proxy never got us as far as aisstream.

    Kept apart from every other failure here because it is not a fact about
    aisstream and must not be recorded as one: most entries in a free proxy list
    are dead, and finding that out is the cost of using one, not an outage. An
    attempt that raises this never reached the service, so it does not touch the
    backoff, the health row or the status panel.
    """


async def _consume(state, proxy: str | None = None):
    global _dirty, _last_message_at, _connection
    subscribe_msg = {
        "APIKey": config.AISSTREAM_API_KEY,
        "BoundingBoxes": _bboxes_payload(),
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }
    received = 0
    connected = False
    # proxy=None is passed explicitly rather than left to default: websockets
    # picks up HTTPS_PROXY/ALL_PROXY from the environment on its own, and an
    # egress chosen by an ambient environment variable is exactly what this
    # source must never have -- the whole point of the plan below is that the
    # path each attempt took is known and can be named in a log line.
    connect_kwargs = {"ping_interval": 20, "ping_timeout": 20, "proxy": proxy}
    if proxy is not None:
        # Most free proxies are dead and the plan tries them in series inside a
        # reconnect cycle, so the wait for one has to be short.
        connect_kwargs["open_timeout"] = config.PROXY_CONNECT_TIMEOUT
    try:
        async with websockets.connect(WS_URL, **connect_kwargs) as ws:
            connected = True
            _connection = ws
            await ws.send(json.dumps(subscribe_msg))
            # Deliberately *not* clearing state.last_error here. Connecting is not
            # succeeding: aisstream accepts the socket and stays silent when the key
            # is recognised but the account isn't streaming, so clearing on connect
            # meant a dead feed reported itself on /api/health as configured,
            # error-free and simply holding no ships -- indistinguishable from an
            # empty ocean, and it stayed that way for as long as nobody read the
            # logs. The error now survives until a frame actually arrives.
            log.info(
                "AIS stream connected via %s, subscribed to %d bounding boxes",
                proxy or "a direct connection", len(config.AIS_BBOXES),
            )
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
                    # Nothing at all before the close. Named, because websockets'
                    # own text for it is "no close frame received or sent" --
                    # true, and no help at all in the one place this ends up,
                    # which is the source-status panel.
                    #
                    # It does not say the key was refused. It did for a while,
                    # and on 2026-08-07 that was wrong: a known-good key and a
                    # fresh one were both closed on within seconds of each
                    # other, which is aisstream closing on everyone rather than
                    # anything about either key.
                    raise StreamRefused(
                        f"aisstream closed the connection before sending anything "
                        f"({exc}) -- either the key in AISSTREAM_API_KEY was refused, "
                        f"or the endpoint is closing on connections outright "
                        f"(check github.com/aisstream/issues before changing the key)"
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
                    # Identity and voyage come out of the same frame and are cached
                    # together, but they are parsed apart on purpose: one half is
                    # what a designation is matched on, the other is what the crew
                    # typed. See both functions.
                    learned = {**_identity_from_static(static), **_voyage_from_static(static)}
                    if learned:
                        _ship_static.setdefault(mmsi, {}).update(learned)
                        if mmsi in _ships:
                            _ships[mmsi].update(learned)
                            _ships[mmsi].update(_annotations_for(mmsi))
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
                    **_annotations_for(mmsi),
                    "updated": time.time(),
                }
                _dirty = True
    except Exception as exc:
        # A failure before the handshake completed, on an attempt that went
        # through a proxy, is attributed to the proxy. It cannot be told apart
        # from here -- a dead node, a node aisstream itself blocks and a genuine
        # aisstream refusal all surface as a connect error -- and "the proxy is
        # dead" is both the common case and the safe way to be wrong: it costs
        # one node a cooldown, where the other reading would write a fault
        # against aisstream that nothing on their side did.
        if proxy is not None and not connected:
            raise EgressUnusable(
                f"{proxy} did not get us to aisstream: {type(exc).__name__}: {exc}"
            ) from exc
        raise
    finally:
        # Whichever way this connection ended, it is no longer the one shutdown
        # should be closing. Left set, aclose() would await a dead object on the
        # way out and log a failure that means nothing.
        _connection = None


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
    # Both reference lists download on their own schedules and land well after
    # the AIS stream is already running, so every ship annotated before they
    # arrived carries nulls -- correct at the time and wrong afterwards.
    # Re-annotating whenever either index changes size is what makes the first
    # successful download (and every later update) reach ships already on the
    # map, instead of only new arrivals.
    last_reference_lens = (-1, -1)
    last_health_at = 0.0
    while True:
        await asyncio.sleep(5)
        reference_lens = (len(sanctions.current()), len(maritime_watchlists.current()))
        if reference_lens != last_reference_lens:
            last_reference_lens = reference_lens
            for mmsi, ship in _ships.items():
                ship.update(_annotations_for(mmsi))
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


# --- being told to slow down -------------------------------------------------
#
# aisstream answers HTTP 429 on the WebSocket upgrade when it wants fewer
# connections from an address. That is a different kind of event from the stream
# breaking, and it was being handled as though it were the same: doubling from
# whatever the schedule happened to be, so a fresh process met a throttle with
# attempts five, eleven and twenty seconds apart and kept the throttle alive.
#
# A 429 is an instruction. The response to it is to stop for a long time, and to
# stop for longer each time it is repeated -- past the ordinary cap, because the
# ordinary cap is evidently not slow enough if they are still saying no at it.
THROTTLED_BACKOFF_START = BACKOFF_CAP
THROTTLED_BACKOFF_CAP = 4 * 3600

# aisstream sends no Retry-After today -- their envoy answers 429 with nothing
# but a date and a content-length, verified 2026-08-09. This is here because the
# header costs nothing to honour and is the one number that would beat a guess
# if they ever add it. Clamped, because a server is allowed to say "next week"
# and this process is not going to sit blind that long without saying so.
MAX_RETRY_AFTER = 4 * 3600


def _retry_after_seconds(raw, now: float) -> float:
    """A Retry-After header as seconds from now. 0.0 for absent or unparseable.

    Both forms in the RFC: a delay in seconds, and an HTTP-date. Garbage is
    treated as absent rather than raised on -- this runs inside a failure path,
    and a malformed header is not worth converting into a second failure.
    """
    if raw is None:
        return 0.0
    text = str(raw).strip()
    try:
        return min(max(float(int(text)), 0.0), MAX_RETRY_AFTER)
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return 0.0
    if when is None:
        return 0.0
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return min(max(when.timestamp() - now, 0.0), MAX_RETRY_AFTER)


def throttle_delay(exc: BaseException, now: float) -> float | None:
    """Seconds aisstream asked us to wait, or None if this was not a throttle.

    Returns 0.0 for a 429 carrying no usable Retry-After, which is every 429 they
    send today -- the caller applies its own floor to that. The distinction that
    matters here is None versus a number, not the size of the number.
    """
    response = getattr(exc, "response", None)
    if getattr(response, "status_code", None) != 429:
        return None
    headers = getattr(response, "headers", None)
    raw = None
    if headers is not None:
        try:
            raw = headers.get("Retry-After")
        except Exception:  # noqa: BLE001 - a header bag that won't be read from
            raw = None
    return _retry_after_seconds(raw, now)


def throttled_backoff(streak: int, asked_for: float) -> float:
    """How long to wait after `streak` consecutive 429s, honouring Retry-After.

    Starts at the ordinary cap rather than climbing to it: the first 429 already
    means the ordinary schedule was too fast. Doubles per repeat up to
    THROTTLED_BACKOFF_CAP, and never returns less than the server asked for.
    """
    ours = THROTTLED_BACKOFF_START * 2 ** min(max(streak - 1, 0), 8)
    return min(max(ours, asked_for), THROTTLED_BACKOFF_CAP)


# How far back a starting process looks to decide whether it is really starting
# fresh.
#
# A day, not an hour. An hour covered the case this was written for -- a rebuild,
# a crash loop, a compose restart -- and missed the one that actually happened on
# 2026-08-09: the machine was off overnight, came back with the outage still
# running, found no health rows in the last hour and started at 5 seconds. Three
# attempts later aisstream was answering 429 again, which is precisely the burst
# this function exists to prevent.
#
# Nothing is lost by widening it, because the wait below is measured from the
# last failure rather than fixed: a process that has been away for twelve hours
# owes nothing, so it attempts immediately and only the *spacing after* that
# attempt is conservative. Recovery is still noticed on the first try.
RESUME_WINDOW = 24 * 3600


def resume_backoff(series: list[tuple[float, int | None, bool]], now: float) -> tuple[float, float]:
    """(backoff, seconds to wait before the first attempt) for a fresh process.

    The backoff above is per-process state, and this process restarts -- a
    rebuild, a crash, `restart: unless-stopped`, a compose up. Every one of those
    put the schedule back to 5 seconds, so a stack that was correctly waiting a
    quarter of an hour went straight back to hammering. Four rebuilds in an hour
    is four bursts of 5s, 10s, 20s, 40s aimed at a service that has already
    answered 429, and aisstream rate-limits by IP -- which is how a client earns
    a block that outlives the outage that provoked it. Someone has already had to
    open an issue apologising for exactly this pattern (aisstream/issues#256).
    On 2026-08-08 this backend did it four times in one morning and was answered
    with 429 for the rest of it.

    Postgres already knows: source_health carries a row per outcome from every
    previous life of this process. A trailing run of failures means the schedule
    was already climbing, so it is resumed where it left off instead of reset --
    and if the last failure is more recent than the resumed delay, the remainder
    of that delay is served before the first attempt rather than skipped.

    The rows counted are every failing row, the once-a-minute heartbeat from
    _snapshot_loop included, not only reconnect failures. That is deliberate: an
    hour of continuous failing heartbeats is an hour of outage, and resuming at
    the cap is exactly the right response to it. One or two is a blip, and
    resumes at five or ten seconds.
    """
    failures = 0
    newest_failure = None
    for ts, _count, ok in reversed(series):
        if ok:
            break
        if newest_failure is None:
            newest_failure = ts
        failures += 1

    if not failures or newest_failure is None:
        return BACKOFF_START, 0.0

    # Closed form of _next_backoff applied `failures - 1` times. The exponent is
    # clamped before it is used: an outage measured in days puts thousands of
    # rows in this window and 2**thousands is not a number worth building to
    # then take the minimum of.
    backoff = min(BACKOFF_START * 2 ** min(failures - 1, 20), BACKOFF_CAP)
    return backoff, max(0.0, backoff - (now - newest_failure))


def _reconnect_delay(backoff: float) -> float:
    return backoff * (1 + random.uniform(-BACKOFF_JITTER, BACKOFF_JITTER))


def _egress_plan(direct_failures: int, proxy_urls: list[str]) -> list[str | None]:
    """Which egresses this cycle may try, in order. None is a direct connection.

    Three properties, and each one is load-bearing:

    * A direct attempt always leads, even deep into an outage. It is the honest
      path -- the one aisstream can attribute to this account and rate limit on
      purpose -- and it is the one that starts working again the moment the
      service does, with nothing to switch back.
    * Proxies appear only after AIS_PROXY_AFTER_FAILURES consecutive direct
      failures, so an ordinary blip is never routed around.
    * The list is capped at AIS_PROXY_ATTEMPTS. What that bounds is how many
      *dead* nodes a cycle walks past, which costs aisstream nothing -- the
      cycle stops at the first proxy that actually reaches them, so no plan
      length makes more than two aisstream-facing attempts per cycle. That is
      what keeps proxying from quietly undoing the backoff above.

    Note what this does *not* do: it never drops the direct attempt in favour of
    a proxy that is working. A proxy is for the case where our IP is the
    problem, and that is a claim to keep re-testing rather than settle into.
    """
    if not config.PROXY_ENABLED or direct_failures < config.AIS_PROXY_AFTER_FAILURES:
        return [None]
    return [None, *proxy_urls[: config.AIS_PROXY_ATTEMPTS]]


async def _egresses(direct_failures: int) -> list[str | None]:
    """_egress_plan, with the proxy list fetched if the plan can use one.

    The fetch is behind the same condition as the plan so that a healthy stack
    never downloads a proxy list at all -- see backend/proxypool.py.
    """
    if not config.PROXY_ENABLED or direct_failures < config.AIS_PROXY_AFTER_FAILURES:
        return [None]
    try:
        proxies = await proxypool.candidates(limit=config.AIS_PROXY_ATTEMPTS)
    except Exception as exc:  # noqa: BLE001 - no proxies is a worse day, not a crash
        log.warning("proxy pool unavailable, staying on the direct connection: %s", exc)
        return [None]
    if proxies:
        log.info(
            "AIS direct connection has failed %d times; trying %s after it (%s)",
            direct_failures, ", ".join(str(p) for p in proxies), proxypool.stats(),
        )
    return _egress_plan(direct_failures, [p.url for p in proxies])


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
        # never, so anything learned from it before the restart is worth
        # keeping: without this the OFAC cross-reference silently drops back to
        # the weaker MMSI match for every preloaded hull, and the declared
        # destination and draught are wiped by the hull's next position report
        # -- which is the moment they become interesting, because that is when
        # there is a track to compare them against.
        static = {k: ship[k] for k in _STATIC_KEYS if ship.get(k) is not None}
        if static:
            _ship_static[mmsi] = static
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

    # Where the previous life of this process left off, rather than 5 seconds
    # flat. See resume_backoff: a restart used to wipe the schedule and start
    # hammering a service that had already asked us to stop.
    backoff, first_wait = resume_backoff(
        await storage.source_health_series("ais", time.time() - RESUME_WINDOW), time.time()
    )
    if first_wait > 0:
        log.info(
            "AIS was already backing off when this process last ran; resuming at "
            "%ds and waiting %ds before the first attempt",
            int(backoff), int(first_wait),
        )
        await asyncio.sleep(first_wait)

    # Consecutive failures of the *direct* connection, which is what decides
    # whether a proxy is worth reaching for. Counted apart from the backoff
    # because the two answer different questions: the backoff is how hard we are
    # allowed to lean on aisstream, this is whether the path we are leaning on
    # is the problem.
    direct_failures = 0
    # Consecutive cycles ending in HTTP 429. Separate from direct_failures and
    # from the backoff because being throttled is not the stream being broken:
    # it is the one failure here we can actually stop causing.
    throttle_streak = 0
    while True:
        delivered = False
        fault: str | None = None
        throttled: float | None = None
        for proxy in await _egresses(direct_failures):
            try:
                await _consume(state, proxy=proxy)
            except EgressUnusable as exc:
                # Never reached aisstream, so it is not an aisstream fault and
                # is not recorded as one. One dead node out of a list of
                # mostly-dead nodes is what a free proxy list is.
                proxypool.record(proxy, ok=False)
                log.debug("AIS egress unusable: %s", exc)
                continue
            except Exception as exc:  # noqa: BLE001 - keep reconnecting
                if proxy is None:
                    direct_failures += 1
                    # Only the direct path's rate is ours to control -- a 429
                    # through a proxy is that proxy's address being throttled,
                    # and slowing this loop down would not answer it.
                    throttled = throttle_delay(exc, time.time())
                    fault = (
                        "aisstream is rate limiting this address (HTTP 429). Nothing "
                        "is wrong with the key or the subscription; the throttle "
                        "clears on its own once the attempts stop, so this is "
                        "waiting rather than retrying."
                        if throttled is not None
                        else str(exc)
                    )
                    # Set as we go, not at the end of the cycle: the direct
                    # verdict is the one the source-status panel exists to
                    # show, and a cycle can run for a minute before it ends.
                    state.last_error = fault
                    continue
                # A proxy that got us to aisstream and was then refused or
                # starved has answered the only question it was asked: our IP is
                # not what is wrong. Trying three more would be three more
                # connections to a service that just said no through a different
                # address, so the cycle ends here and the backoff takes over.
                # This is what holds aisstream-facing attempts to two per cycle
                # however many proxies the plan holds -- the rest of the list is
                # only ever walked past dead nodes, which cost aisstream nothing.
                #
                # Recorded as a success for the proxy, because it was one: what
                # this pool ranks on is whether a node carries a connection to
                # the origin, not whether the origin was pleased to get it.
                proxypool.record(proxy, ok=True)
                fault = f"via {proxy}: {exc}"
                break
            # Returned normally, which only a connection that delivered frames
            # does (see _consume). Resetting the backoff on any return at all
            # turned a stream that connects and immediately ends into a silent
            # hot reconnect loop -- no error, no log, nothing on /api/health.
            delivered = True
            if proxy is None:
                direct_failures = 0
            else:
                proxypool.record(proxy, ok=True)
                log.info("AIS stream is being served through %s", proxy)
            break

        if delivered:
            backoff = BACKOFF_START
            continue

        if fault:
            state.last_error = fault

        if throttled is not None:
            throttle_streak += 1
            backoff = throttled_backoff(throttle_streak, throttled)
        elif throttle_streak:
            # Accepted again, so the throttle has lifted. Back to the ordinary
            # schedule -- but at its cap, not at five seconds: the connection
            # being accepted says nothing about how fast we may now go, and
            # dropping straight back to a fast retry is how the last one was
            # earned.
            throttle_streak = 0
            backoff = BACKOFF_CAP

        delay = _reconnect_delay(backoff)
        log.warning("AIS stream error, reconnecting in %ds: %s", delay, state.last_error)
        await storage.record_source_health("ais", None, False, state.last_error)
        await asyncio.sleep(delay)
        if throttled is None:
            # Left alone while throttled: the streak above owns that schedule,
            # and _next_backoff would clamp it back down to the ordinary cap --
            # undoing the escalation on the one failure worth escalating for.
            backoff = _next_backoff(backoff)
