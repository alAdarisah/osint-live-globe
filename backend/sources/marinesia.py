"""Vessel positions from Marinesia's REST API -- a second supplier for the ships layer.

Why this exists
---------------
The ships layer had exactly one supplier, and on 2026-08-06 that supplier
stopped. Not refused, not errored: aisstream accepted the socket, accepted the
subscription, and sent nothing for days, while every other user reported the
same (aisstream/issues #259, #261-#267, no maintainer reply). Everything that
could be tested from this end was -- a second key, three client versions, four
egress IPs across four countries -- and all of it produced the same silence. A
layer with one supplier is a layer with one point of failure, and no amount of
correct client code fixes that.

What this is not
----------------
A replacement. Marinesia advertise roughly 100,000 AIS messages a day
*worldwide*; the eight watched chokepoints alone were producing about 140,000
movement rows a day through aisstream. So this is a thinner picture of the same
water, and it is registered as its own kind rather than written into "ais" for
exactly that reason: two feeds of different density merged under one name would
make "the ships layer" mean something different depending on which supplier was
up, and the dark-vessel detector reads that history to decide whether a hull
went quiet. Its own kind keeps both statements honest, and the map can draw
whichever it has.

Shape
-----
REST, polled, one request per watched box against /api/v2/vessel/area. Better
suited to this stack than another websocket: it becomes an ordinary scheduled
job with no persistent connection, no reconnect schedule, and no way to earn a
rate limit through restarts -- all of which ais.py had to grow the hard way.

One real advantage over aisstream: every record carries identity *and* position
together -- name, IMO, flag, type and hull dimensions in the same response as
the fix. aisstream splits those into ShipStaticData messages that arrive minutes
apart and, for some hulls, never; the whole `_ship_static` cache in ais.py
exists to paper over that. An IMO on every record also makes the OFAC
cross-reference a hull match rather than an MMSI guess -- see
ais._annotations_for for why that distinction is worth having.

Credentials and terms
---------------------
The key travels as a query parameter, which is the provider's design and not a
choice available here. Same exposure class as FIRMS, and covered by the same
mitigation: the ingest process pins httpx's logger to WARNING precisely so that
request URLs never reach the container log (see backend/ingest/__main__.py).

Marinesia publish their data "as is" and "as available", with no warranty as to
accuracy, completeness or timeliness. Every record below therefore carries its
own `source` and `attribution`, and nothing derived from it should read as more
certain than that.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx

from backend import config, storage
from backend.cache import registry
from backend.sources import maritime_watchlists, sanctions

log = logging.getLogger("osint-globe.marinesia")

BASE_URL = "https://api.marinesia.com"
AREA_PATH = "/api/v2/vessel/area"

ATTRIBUTION = "Vessel position via Marinesia (marinesia.com), provided as is."
SOURCE = "marinesia"

_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

# The free tier is documented as "up to 5 requests per minute", so one request
# every 13 seconds leaves margin for the clock disagreeing with theirs. Eight
# watched boxes therefore take about 100 seconds per sweep, which is why
# MARINESIA_POLL_INTERVAL is minutes rather than seconds.
# One request per hour. Not the documented "up to 5 requests per minute" -- that
# is what this module was built against, and it is wrong for this key's tier.
# Measured against the live API: every response carries `x-ratelimit-limit: 1`
# with an `x-ratelimit-reset` about 3600 seconds out, and a sweep of eight boxes
# every five minutes spent the whole budget on its first request and then took
# 429s for the rest of the hour. The layer held ten hulls from the one box that
# got through before the wall.
#
# So a sweep is one request, and the box list is a rotation rather than a batch.
# The arithmetic that follows from it is worth stating, because it is the ceiling
# on what this supplier can be: with N boxes and one request an hour, a given box
# is refreshed every N hours, and the positions on screen are up to N hours old.
# That is why the default box list is a prioritised subset rather than all eight
# watched waters -- fewer, fresher beats more, staler for a fallback whose job is
# to say roughly where the traffic is while the real feed is down.
REQUEST_SPACING = 13.0

# What a 429 costs. The response names its own reset instant, which is honoured
# when present; this is the fallback for a 429 that does not.
RATE_LIMIT_BACKOFF = float(config.MARINESIA_BUDGET_INTERVAL)

# Set from a 429's x-ratelimit-reset, so later sweeps do not spend their turn
# re-learning that the budget is gone. Module scope rather than the registry
# state because it is this process's own bookkeeping, not something to publish.
_rate_limited_until = 0.0


def _scrub(text: str) -> str:
    """The API key removed from anything about to be logged or published.

    Marinesia take the key as a query parameter -- their design, not a choice
    available here -- so every httpx error message carries the full URL, key and
    all. This module's docstring claimed the ingest process pinning httpx to
    WARNING kept request URLs out of the log, and that is true of httpx's own
    logging and false of ours: `log.warning("... %s", exc)` on an HTTPStatusError
    prints the URL that httpx put in the message. The key was in the container
    log on every 429, which during this outage meant several times a minute.
    """
    key = config.MARINESIA_API_KEY
    if key and key in text:
        text = text.replace(key, "<key>")
    return text

# Maximum static draught is an 8-bit field in tenths of a metre (ITU-R M.1371),
# so 25.5 m is the top of the scale. Same constant and same reason as
# ais.MAX_DRAUGHT_M -- restated rather than imported so that this module does
# not pull the websocket client in behind it.
MAX_DRAUGHT_M = 25.5

# AIS pads its fixed-width six-bit text fields with '@', so an unconfigured
# destination arrives as a row of at-signs rather than as an empty string.
_AIS_PAD = "@"


def _text(value) -> str | None:
    """A string field with AIS's own padding removed, or None if it says nothing."""
    if not isinstance(value, str):
        return None
    return value.replace(_AIS_PAD, "").strip() or None


def _number(value) -> float | None:
    """A numeric field, rejecting booleans (which are ints in Python) and junk."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _span(near, far) -> int | None:
    """One pair of the AIS dimension fields summed: a+b is length, c+d is beam.

    Each half is a distance from the GPS antenna, so a single zero is ordinary
    (an antenna at the bow) but a zero sum is the field's "not available". Same
    rule as ais._span; Marinesia expose the four parts under their AIS names.
    """
    values = [_number(near), _number(far)]
    if any(v is None or v < 0 for v in values):
        return None
    total = int(values[0] + values[1])
    return total or None


def _eta(raw) -> dict | None:
    """Marinesia's "MM-DD HH:MM" ETA, as the parts AIS actually sends.

    Deliberately not converted to a timestamp, for the same reason as
    ais._eta_from_static: the AIS ETA carries no year, so any absolute time is a
    guess, and the guess is wrong exactly where it matters -- a voyage crossing
    new year.

    "00-00 00:00" is the unset case and by far the most common value. Month and
    day of zero mean "not stated"; hour zero is midnight and minute zero is on
    the hour, so those two are kept whenever the date half is real.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        date_part, _, time_part = text.partition(" ")
        month_s, _, day_s = date_part.partition("-")
        month, day = int(month_s), int(day_s)
    except ValueError:
        return None
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    parts = {"month": month, "day": day}
    if time_part:
        try:
            hour_s, _, minute_s = time_part.partition(":")
            hour, minute = int(hour_s), int(minute_s)
        except ValueError:
            return parts
        if 0 <= hour <= 23:
            parts["hour"] = hour
        if 0 <= minute <= 59:
            parts["minute"] = minute
    return parts


def _timestamp(raw) -> float | None:
    """Their `ts` as epoch seconds. Naive values are read as UTC.

    Marinesia send ISO 8601 without an offset. Reading that as local time would
    shift every position by the container's timezone -- which is UTC here, so
    the bug would be invisible in this deployment and wrong everywhere else.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def parse_vessel(entry, now: float) -> dict | None:
    """One /api/v2/vessel/area record, or None if it isn't usable.

    A record with no MMSI or no position is not a vessel sighting, and there is
    nothing useful to do with it: MMSI is the identity every downstream join is
    keyed on, and a position is the entire content of the observation.

    Field names are deliberately the same as ais.py's where they mean the same
    thing (`lat`/`lon`/`speed`/`course`/`heading`/`updated`), so a popup or a
    trail renderer can read either source without branching -- and deliberately
    different where they do not: `ship_type_name` is Marinesia's own text label
    ("Cargo"), not the ITU numeric code that ais.py's `ship_type` carries.
    """
    if not isinstance(entry, dict):
        return None
    mmsi = entry.get("mmsi")
    if isinstance(mmsi, str) and mmsi.isdigit():
        mmsi = int(mmsi)
    if not isinstance(mmsi, int) or isinstance(mmsi, bool) or mmsi <= 0:
        return None

    lat, lon = _number(entry.get("lat")), _number(entry.get("lng"))
    if lat is None or lon is None:
        return None
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return None

    record = {
        "mmsi": mmsi,
        "name": _text(entry.get("name")),
        "lat": lat,
        "lon": lon,
        "speed": _number(entry.get("sog")),
        "course": _number(entry.get("cog")),
        "heading": _number(entry.get("hdt")),
        # Not in this endpoint's payload. Named and set to None rather than
        # omitted, so that a consumer reading both sources sees a field that is
        # absent here rather than a key that only sometimes exists.
        "nav_status": None,
        "ship_type": None,
        "ship_type_name": _text(entry.get("type")),
        "flag": _text(entry.get("flag")),
        "source": SOURCE,
        "attribution": ATTRIBUTION,
    }

    # An IMO of 0 is "not set", not a hull. Matching on it would designate every
    # badly-configured ship at once -- the same guard as ais._identity_from_static.
    imo = entry.get("imo")
    if isinstance(imo, int) and not isinstance(imo, bool) and imo > 0:
        record["imo"] = str(imo)

    destination = _text(entry.get("dest"))
    if destination:
        record["destination"] = destination

    eta = _eta(entry.get("eta"))
    if eta:
        record["eta"] = eta

    draught = _number(entry.get("draught"))
    if draught is not None and 0 < draught <= MAX_DRAUGHT_M:
        record["draught"] = round(draught, 1)

    length = _span(entry.get("a"), entry.get("b"))
    beam = _span(entry.get("c"), entry.get("d"))
    if length:
        record["length_m"] = length
    if beam:
        record["beam_m"] = beam

    # The reference lists, as separate claims -- never merged into one "flagged"
    # flag. An OFAC designation and a port-state detention are different kinds
    # of statement about a hull; see ais._annotations_for and
    # backend/sources/maritime_watchlists.py.
    record["sanctions"] = sanctions.for_vessel(
        imo=record.get("imo"), mmsi=str(mmsi), callsign=None
    )
    record["watchlist"] = maritime_watchlists.for_vessel(
        imo=record.get("imo"), mmsi=str(mmsi)
    )

    # `updated` is the observation's own time where they give one, and the poll
    # time only as a fallback. Getting this backwards would make a stale fix
    # look live -- and their published examples were a year old, so the field is
    # not one to assume about.
    observed = _timestamp(entry.get("ts"))
    record["updated"] = observed if observed is not None else now
    record["reported_at"] = observed
    return record


class RateLimited(Exception):
    """The hourly budget is gone, and when it comes back.

    Its own type because it is not a failure of this source: nothing is broken,
    the quota is simply spent, and the two want different handling -- a failure is
    worth an error row and a red light, a spent quota is worth waiting.
    """

    def __init__(self, reset_at: float) -> None:
        super().__init__("rate limit reached")
        self.reset_at = reset_at


def _reset_at(response) -> float:
    """When the provider says the budget returns, or an hour from now."""
    for header in ("x-ratelimit-reset", "ratelimit-reset"):
        raw = response.headers.get(header)
        if not raw:
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        # Either an absolute epoch or seconds-from-now, depending on the vendor.
        # Anything smaller than a plausible epoch is the latter.
        return value if value > 1_000_000_000 else time.time() + value
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return time.time() + float(retry_after)
        except ValueError:
            pass
    return time.time() + RATE_LIMIT_BACKOFF


async def _fetch_box(client: httpx.AsyncClient, box) -> list[dict]:
    """One bounding box. Raises on transport or status errors."""
    lat_min, lon_min, lat_max, lon_max = box
    params = {
        "lat_min": lat_min,
        "lat_max": lat_max,
        "long_min": lon_min,
        "long_max": lon_max,
        # Query parameter rather than a header: the provider's design. It is
        # kept out of the log by the ingest process pinning httpx to WARNING.
        "key": config.MARINESIA_API_KEY,
    }
    response = await client.get(f"{BASE_URL}{AREA_PATH}", params=params)
    if response.status_code == 429:
        # Read the provider's own reset instant rather than guessing. Raised as a
        # RateLimited carrying that number so the caller can stop asking until
        # then, instead of spending every later sweep rediscovering the wall.
        raise RateLimited(_reset_at(response))
    response.raise_for_status()
    payload = response.json()
    # Documented as a bare list. A dict with a `data` key is the shape their
    # other endpoints use, so it is accepted rather than dropped -- the two
    # differ across their own examples and this should not go blank over it.
    if isinstance(payload, dict):
        payload = payload.get("data")
    return payload if isinstance(payload, list) else []


def _freshness(records: list[dict], now: float) -> str:
    """How old these fixes are, for the log.

    Worth one line on every poll because it is the open question about this
    supplier: their advertised volume is low and their published examples were a
    year stale, so "did we get positions" and "did we get *current* positions"
    have to be answered separately from the first run onwards.
    """
    ages = sorted(now - r["reported_at"] for r in records if r.get("reported_at"))
    if not ages:
        return "no timestamps"
    median = ages[len(ages) // 2]
    return f"median fix age {int(median // 60)}m, oldest {int(max(ages) // 60)}m"


def _box_contains(box, lat, lon) -> bool:
    lat_min, lon_min, lat_max, lon_max = box
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def choose_box(boxes, stored, now):
    """Which box this sweep spends its one request on.

    The box we know least about: whichever has no stored fix at all, or the oldest
    newest-fix. Derived from the data rather than from a rotation counter, and that
    is deliberate -- a counter in this process resets to zero on every restart, so a
    nightly redeploy would re-poll the first box forever and never reach the last.
    Reading it back from what is stored is self-correcting, and it also naturally
    re-prioritises a box whose own request failed.

    `stored` is (lat, lon, updated_at_epoch) triples.

    @returns (box, index, age_seconds_or_None)
    """
    freshest = [None] * len(boxes)
    for lat, lon, updated in stored:
        for i, box in enumerate(boxes):
            if _box_contains(box, lat, lon):
                if freshest[i] is None or updated > freshest[i]:
                    freshest[i] = updated
    # -inf for "never seen", so an unpolled box always outranks a stale one.
    def staleness(i):
        return float("inf") if freshest[i] is None else now - freshest[i]
    index = max(range(len(boxes)), key=staleness)
    age = None if freshest[index] is None else now - freshest[index]
    return boxes[index], index, age


async def _stored_positions():
    """Every stored marinesia fix as (lat, lon, updated_at epoch)."""
    out = []
    for row in await storage.entity_latest_with_times(SOURCE):
        payload = row.get("payload") or {}
        lat, lon = payload.get("lat"), payload.get("lon")
        updated = row.get("updated_at")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        out.append((float(lat), float(lon), updated.timestamp() if updated else 0.0))
    return out


async def ingest_once():
    """One request against one box. Scheduled from backend/ingest.

    It used to be a sweep of every box in one run, paced 13 seconds apart on the
    assumption of five requests a minute. The real budget for this key is one
    request an hour (see REQUEST_SPACING's note), so that spent everything on the
    first box and took 429s for the remaining seven, every five minutes, for the
    rest of the hour -- which is why the layer held ten hulls.

    Accumulation is Postgres's job, not this function's: every sweep upserts its
    one box into entity_latest, and rows age out on MARINESIA_STALE_AFTER, so what
    the map draws is the union of however many boxes are still inside that window.
    That is also why the staleness window has to be wider than a full rotation --
    narrower, and each sweep's box would expire before the rotation came back to
    it, leaving exactly one box's worth on screen no matter how long it ran.
    """
    global _rate_limited_until

    key_configured = bool(config.MARINESIA_API_KEY)
    state = registry.ensure(SOURCE, key_configured=key_configured)
    if not key_configured:
        state.last_error = "MARINESIA_API_KEY not set in .env"
        # Recorded, not just held: this process has no /api/health of its own,
        # and without a row the backend reports the job as never having run --
        # which sends someone to the container instead of to the missing key.
        await storage.record_source_health(SOURCE, None, False, state.last_error)
        return

    boxes = config.MARINESIA_BBOXES
    if not boxes:
        state.last_error = "no MARINESIA_BBOXES configured"
        await storage.record_source_health(SOURCE, None, False, state.last_error)
        return

    now = time.time()
    if now < _rate_limited_until:
        # Not an error, and deliberately not recorded as one: the quota is spent,
        # nothing is broken, and writing a failed health row here would turn a
        # working supplier red for most of every hour.
        log.info(
            "Marinesia: hourly request budget spent, next request in %ds",
            int(_rate_limited_until - now),
        )
        return

    try:
        stored = await _stored_positions()
    except Exception as exc:  # noqa: BLE001 - a read failure must not skip the poll
        log.warning("Marinesia could not read stored positions: %s", _scrub(str(exc)))
        stored = []

    box, index, age = choose_box(boxes, stored, now)

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            entries = await _fetch_box(client, box)
    except RateLimited as limited:
        _rate_limited_until = limited.reset_at
        log.info(
            "Marinesia: rate limited on box %d/%d, budget returns in %ds",
            index + 1, len(boxes), int(limited.reset_at - now),
        )
        # The layer keeps whatever is already stored, and the health row stays as
        # it was: a spent quota is not a dead source.
        return
    except Exception as exc:  # noqa: BLE001 - one failed poll is not a dead source
        message = _scrub(f"{type(exc).__name__}: {exc}")
        state.last_error = message
        log.warning("Marinesia box %d/%d failed: %s", index + 1, len(boxes), message)
        await storage.record_source_health(SOURCE, None, False, message)
        return

    by_mmsi: dict[int, dict] = {}
    for entry in entries:
        record = parse_vessel(entry, now)
        if record is None:
            continue
        existing = by_mmsi.get(record["mmsi"])
        if existing is None or record["updated"] >= existing["updated"]:
            by_mmsi[record["mmsi"]] = record
    records = list(by_mmsi.values())

    try:
        await storage.record_snapshot(SOURCE, records, "mmsi")
    except Exception as exc:  # noqa: BLE001
        message = _scrub(f"{type(exc).__name__}: {exc}")
        state.last_error = message
        log.warning("Marinesia could not store box %d: %s", index + 1, message)
        await storage.record_source_health(SOURCE, None, False, message)
        return

    # What the *layer* holds, which is every box still inside the staleness window
    # rather than just the one polled -- so the count reported here and the count
    # on screen are the same number.
    try:
        held = len(await storage.entity_latest(SOURCE))
    except Exception:  # noqa: BLE001 - reporting only
        held = 0
    # An empty read right after writing `records` is not an empty table, it is a
    # table this process could not see -- no pool, or a read that lost a race with
    # its own write. Reporting 0 held while three hulls were just stored would put a
    # working supplier's count below what it had actually collected.
    held = held or len(records)

    state.last_success = time.time()
    state.last_error = None
    await storage.record_source_health(SOURCE, held, True, None)
    log.info(
        "Marinesia box %d/%d (%s): %d vessels, %d held across the rotation (%s, %d sanctioned)",
        index + 1, len(boxes),
        "never polled" if age is None else f"last seen {int(age // 60)}m ago",
        len(records), held,
        _freshness(records, time.time()),
        sum(1 for r in records if r.get("sanctions")),
    )
