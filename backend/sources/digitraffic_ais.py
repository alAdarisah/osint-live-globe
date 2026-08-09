"""Live AIS from Fintraffic / Digitraffic (Finland) -- Finnish and Baltic waters.

This is a second, independent AIS network alongside the aisstream feed in
backend/sources/ais.py, and the two are kept rigorously apart:

- **Its own kind, never "ais".** Every record is written under
  kind="ais_digitraffic" and carries `source="digitraffic"`. aisstream owns the
  "ais" kind, and a shared (kind, mmsi) key would let one network's position
  silently overwrite the other's last-write-wins, with nothing in the row to say
  which transponder it came from. Two kinds keeps them distinguishable all the
  way to the map.
- **Its own ETA unpack.** Unlike aisstream, which hands over ShipStaticData with
  the ETA already split into month/day/hour/minute, Digitraffic serves the raw
  20-bit AIS field as one packed integer. It is unpacked here by bit-shifting
  (see unpack_eta), *not* reused from ais.py._eta_from_static -- that expects the
  already-split dict and would read this integer as garbage.

Two endpoints, joined by MMSI:

- ``/api/ais/v1/locations`` -- a GeoJSON FeatureCollection of raw position
  reports (~974 live). A location feature carries no name, call sign or IMO; it
  is only where a hull is right now.
- ``/api/ais/v1/vessels`` -- a JSON array of static/voyage metadata (~857) that
  the crew configured: name, IMO, destination, draught, ETA, dimensions.

On any given pull ~122 positions have no metadata yet -- static frames arrive on
their own slower schedule and for some hulls never -- so those are emitted
position-only rather than dropped, exactly as ais.py tolerates a missing
ShipStaticData. Metadata fields are labelled the way ais.py labels the same ones
(draught in metres, destination/eta/dimensions as declared/reported), because
they mean the same thing and a reader should not have to learn two vocabularies.

Keyless. The one courtesy is a ``Digitraffic-User`` header naming the caller
(config.DIGITRAFFIC_USER); gzip is mandatory (the API answers 406 without it),
which httpx satisfies by default. Licence CC BY 4.0, carried on every record.
"""

import asyncio
import logging
import time

import httpx

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.digitraffic_ais")

LOCATIONS_URL = "https://meri.digitraffic.fi/api/ais/v1/locations"
VESSELS_URL = "https://meri.digitraffic.fi/api/ais/v1/vessels"

PUBLISHER = "Fintraffic / digitraffic.fi"
# The attribution the CC BY 4.0 licence requires, verbatim, carried on the row
# rather than left to a frontend lookup -- a caveat that lives somewhere else is
# one a new consumer forgets to apply. It gzips to nothing.
LICENSE = "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"

# Scaled by consecutive failures, capped at the poll interval below. One minute
# is a courteous base against a feed the product itself refreshes every five.
FAILURE_RETRY_INTERVAL = 60

# Maximum static draught is an 8-bit field in tenths of a metre, so 25.5 m tops
# the scale (25.5 itself is saturated, "at least this deep"); anything above it
# did not come off a transponder. Same ceiling ais.py applies.
MAX_DRAUGHT_M = 25.5

# AIS pads its fixed-width six-bit text fields with '@'. Digitraffic usually
# hands back decoded strings, but stripping the padding is cheap insurance
# against a row of at-signs landing in a popup where "not stated" belongs.
_AIS_PAD = "@"

# The AIS message-5 ETA is a 20-bit field packed month(4) day(5) hour(5)
# minute(6), most-significant first. These are the shifts that pull each part
# back out; the masks below (0x0F, 0x1F, 0x3F) are 4, 5 and 6 bits wide.
_ETA_MONTH_SHIFT = 16
_ETA_DAY_SHIFT = 11
_ETA_HOUR_SHIFT = 6


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


def _clean_text(value) -> str | None:
    """A metadata string field with AIS's own '@' padding removed."""
    if not isinstance(value, str):
        return None
    return value.replace(_AIS_PAD, "").strip() or None


def _as_bool(value):
    """posAcc / raim as a real boolean, or None if absent.

    The vendor OpenAPI wrongly declares these ``enum: [false, false]``; the real
    values vary, so the declaration is ignored and the JSON boolean is read as
    what it is. 0/1 integers are tolerated in case a frame arrives that way.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return bool(value)
    return None


def _span(near, far) -> int | None:
    """One dimension pair summed: A+B is length, C+D is beam, in metres.

    Each half is a distance from the reference point, so a single zero is
    ordinary (an antenna at the bow) but a zero sum is the field's "not
    available". Mirrors ais.py._span.
    """
    if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (near, far)):
        return None
    total = near + far
    return total or None


def unpack_eta(packed) -> dict | None:
    """A packed AIS ETA integer -> {month, day[, hour, minute]}, or None.

    Written here rather than reused from ais.py._eta_from_static, which expects
    aisstream's already-split dict: Digitraffic sends the raw 20-bit field as one
    integer, so it is taken apart by shifting.

    ITU-R M.1371 spells "not available" differently per field -- month 0 and day
    0 mean unset, while hour 24 and minute 60 do (hour 0 is midnight and minute 0
    is on the hour, both kept). A value with no usable date is not an ETA at all:
    a time of day with no day attached is a clock reading, so it returns None,
    matching ais.py. The sentinel eta=0 (all zeros) therefore falls out here as
    None without a special case.
    """
    if not isinstance(packed, int) or isinstance(packed, bool):
        return None
    month = (packed >> _ETA_MONTH_SHIFT) & 0x0F
    day = (packed >> _ETA_DAY_SHIFT) & 0x1F
    hour = (packed >> _ETA_HOUR_SHIFT) & 0x1F
    minute = packed & 0x3F
    if not (1 <= month <= 12) or not (1 <= day <= 31):
        return None
    parts = {"month": month, "day": day}
    if 0 <= hour <= 23:      # 24 is M.1371's "not available"
        parts["hour"] = hour
    if 0 <= minute <= 59:    # 60 is M.1371's "not available"
        parts["minute"] = minute
    return parts


def parse_vessel(row: dict) -> tuple[int, dict] | None:
    """One /vessels metadata row -> (mmsi, declared/reported fields), or None.

    Everything here is crew-configured rather than measured -- destination is
    typed, draught and ETA are set before sailing -- so it is labelled the way
    ais.py labels the same fields and never treated as an observation. The guards
    follow ais.py's: an IMO of 0 is "not set" rather than a hull, and a draught
    of 0 is not a floating ship.
    """
    mmsi = row.get("mmsi")
    if not isinstance(mmsi, int) or isinstance(mmsi, bool):
        return None

    static: dict = {}
    name = _clean_text(row.get("name"))
    if name:
        static["name"] = name
    callsign = _clean_text(row.get("callSign"))
    if callsign:
        static["callsign"] = callsign
    imo = row.get("imo")
    if isinstance(imo, int) and not isinstance(imo, bool) and imo > 0:
        static["imo"] = str(imo)
    destination = _clean_text(row.get("destination"))
    if destination:
        static["destination"] = destination

    draught = row.get("draught")
    if isinstance(draught, (int, float)) and not isinstance(draught, bool) and draught > 0:
        # Digitraffic serves draught in tenths of a metre; tenths is the field's
        # own resolution, so anything finer than one decimal is decode noise.
        metres = round(draught / 10.0, 1)
        if 0 < metres <= MAX_DRAUGHT_M:
            static["draught"] = metres

    eta = unpack_eta(row.get("eta"))
    if eta:
        static["eta"] = eta

    ship_type = row.get("shipType")
    if isinstance(ship_type, int) and not isinstance(ship_type, bool):
        static["ship_type"] = ship_type

    length = _span(row.get("referencePointA"), row.get("referencePointB"))
    beam = _span(row.get("referencePointC"), row.get("referencePointD"))
    if length:
        static["length_m"] = length
    if beam:
        static["beam_m"] = beam

    return mmsi, static


def parse_vessels(payload) -> dict[int, dict]:
    """The /vessels array -> {mmsi: declared metadata}, for the join below."""
    out: dict[int, dict] = {}
    for row in payload or []:
        if not isinstance(row, dict):
            continue
        parsed = parse_vessel(row)
        if parsed is None:
            continue
        mmsi, static = parsed
        out[mmsi] = static
    return out


def parse_location(feature: dict) -> dict | None:
    """One /locations GeoJSON feature -> a position record, or None.

    Read defensively by key, never by position. GeoJSON order is [lon, lat];
    reading it the other way round puts every hull in the wrong hemisphere. A
    feature with no usable coordinate is dropped rather than placed.
    """
    if not isinstance(feature, dict):
        return None
    mmsi = feature.get("mmsi")
    if not isinstance(mmsi, int) or isinstance(mmsi, bool):
        return None
    geometry = feature.get("geometry") or {}
    coords = geometry.get("coordinates") or []
    if len(coords) < 2:
        return None
    lon, lat = _num(coords[0]), _num(coords[1])
    if lat is None or lon is None:
        return None
    if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
        return None

    props = feature.get("properties") or {}
    # timestampExternal is epoch milliseconds -- the real observation time.
    # `timestamp` alone is the AIS second-of-minute the report was generated,
    # not a full time, so it is not used for `time`.
    observed = _num(props.get("timestampExternal"))
    return {
        "mmsi": mmsi,
        "lat": lat,
        "lon": lon,
        "speed": _num(props.get("sog")),        # knots, over ground
        "course": _num(props.get("cog")),       # degrees, over ground
        "heading": _num(props.get("heading")),  # true heading, degrees
        "nav_status": props.get("navStat"),
        "rot": _num(props.get("rot")),          # rate of turn, AIS units
        "pos_accuracy": _as_bool(props.get("posAcc")),
        "raim": _as_bool(props.get("raim")),
        "time": observed / 1000.0 if observed is not None else None,
        # The property that keeps this network distinct from aisstream's in a
        # shared table (were the kinds ever merged) and, more usefully, in any
        # popup: this hull's position came from Digitraffic, not aisstream.
        "source": "digitraffic",
        "publisher": PUBLISHER,
        "license": LICENSE,
    }


def build_records(locations_payload, vessels_payload) -> list[dict]:
    """Join the /locations FeatureCollection to /vessels metadata by MMSI.

    A position with no matching metadata yet is emitted position-only rather than
    dropped: static/voyage frames arrive on their own slower schedule and for
    some hulls never, exactly as ais.py tolerates a missing ShipStaticData. Never
    drop a vessel just because its metadata has not arrived.
    """
    static_by_mmsi = parse_vessels(vessels_payload)
    out: list[dict] = []
    for feature in (locations_payload or {}).get("features") or []:
        record = parse_location(feature)
        if record is None:
            continue
        static = static_by_mmsi.get(record["mmsi"])
        if static:
            # No key overlaps a position field, so source/publisher/license and
            # the observed values all survive the merge.
            record.update(static)
        out.append(record)
    return out


def _headers() -> dict:
    # Digitraffic asks every caller to identify itself; not a secret, not gated.
    # Accept-Encoding is deliberately left to httpx (it sends gzip by default) --
    # the API answers 406 without it, so it must not be stripped.
    return {"Digitraffic-User": config.DIGITRAFFIC_USER}


async def _fetch(client: httpx.AsyncClient) -> list[dict]:
    locations = await client.get(LOCATIONS_URL)
    locations.raise_for_status()
    vessels = await client.get(VESSELS_URL)
    vessels.raise_for_status()
    return build_records(locations.json(), vessels.json())


async def start():
    state = registry.register("ais_digitraffic", key_configured=True)  # keyless
    # A failed boot fetch backs off toward the 5-minute interval, so without
    # warming the layer would be blank until then; the last stored snapshot is a
    # real, correctly-attributed stand-in until the next fetch lands. (A ship
    # position is only worth restoring inside its stale window, which
    # ENTITY_STALE_AFTER["ais_digitraffic"] enforces on read-back.)
    await storage.warm_points(state, "ais_digitraffic", "Digitraffic AIS")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            async with httpx.AsyncClient(
                timeout=60, follow_redirects=True, headers=_headers()
            ) as client:
                records = await _fetch(client)
            state.data = records
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info(
                "Digitraffic AIS: %d vessels (%d with metadata)",
                len(records), sum(1 for r in records if r.get("name")),
            )
            await storage.record_snapshot("ais_digitraffic", state.data, id_field="mmsi")
            await storage.record_source_health("ais_digitraffic", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Digitraffic AIS fetch failed: %s", exc)
            await storage.record_source_health("ais_digitraffic", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            config.DIGITRAFFIC_AIS_POLL_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, config.DIGITRAFFIC_AIS_POLL_INTERVAL)
        )
