"""Live Finnish trains and the station gazetteer, from Fintraffic / Digitraffic.

Two products from rata.digitraffic.fi, kept in one module because they are one
subject and share the same courtesy header and licence, but stored two different
ways because they are two different kinds of thing:

- **Live train positions** (``/api/v1/train-locations/latest``, ~111 trains).
  Point observations that move every minute, so they are snapshotted into
  entity_latest under kind="rail_live" and warmed back from it.

  The trap here is identity: ``trainNumber`` is reused every day (train 1 today
  is a different run from train 1 tomorrow). So the entity id is the synthetic
  composite ``departureDate:trainNumber``, computed onto each record as ``id``
  and handed to record_snapshot as its id_field. Keying on trainNumber alone
  would smear yesterday's IC 1 and today's IC 1 into one entity_history track
  that teleports across the country at midnight.

- **Stations** (``/api/v1/metadata/stations``, 563 stations). Static reference
  metadata -- names, codes, coordinates -- that does not move and has no per-row
  lifecycle worth tracking, so it is stored as a whole document in
  reference_snapshots (like railways.py's linework), refreshed on a slow clock
  inside the live loop the way hazards.py refetches its weekly report. A failure
  fetching stations must never take the position feed down or discard the copy
  already in hand.

Position-only is a deliberate MVP. Train *category* (IC / long-distance /
freight, operator) lives only on a separate, expensive endpoint
(``/api/v1/trains/{date}``, ~12.8 MB/day), and blocking the position feed on it
would be the wrong trade. See the TODO in start() for how to add it later
without that coupling.

Keyless, with a ``Digitraffic-User`` courtesy header; gzip is mandatory and httpx
sends it by default. Licence CC BY 4.0, carried on every record.
"""

import asyncio
import logging
import time
from datetime import datetime

import httpx

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.digitraffic_rail")

TRAINS_URL = "https://rata.digitraffic.fi/api/v1/train-locations/latest"
STATIONS_URL = "https://rata.digitraffic.fi/api/v1/metadata/stations"

PUBLISHER = "Fintraffic / digitraffic.fi"
LICENSE = "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"

# Scaled by consecutive failures, capped at the 60s poll interval. Half the
# interval as a base keeps a blip from retrying tighter than the feed updates.
FAILURE_RETRY_INTERVAL = 30


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


def _iso_to_epoch(value):
    """An ISO 8601 timestamp string -> unix seconds, or None.

    Digitraffic stamps positions like ``2026-08-09T12:34:56.789Z``. Everything
    else in this backend keeps time as unix seconds, so it is converted once here
    rather than left as a string for the client to reparse.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")  # fromisoformat wants an offset
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def parse_train(row: dict) -> dict | None:
    """One /train-locations row -> a live position record, or None.

    Read defensively by key. GeoJSON order is [lon, lat]. A train whose GPS is
    absent (no ``location``) is dropped rather than placed at null island.
    """
    if not isinstance(row, dict):
        return None
    train_number = row.get("trainNumber")
    if not isinstance(train_number, int) or isinstance(train_number, bool):
        return None
    departure_date = row.get("departureDate")
    if not isinstance(departure_date, str) or not departure_date.strip():
        # Without the date half the identity is ambiguous (trainNumber recurs
        # daily), so a row missing it is dropped rather than mis-keyed.
        return None
    departure_date = departure_date.strip()

    location = row.get("location") or {}
    coords = location.get("coordinates") or []
    if len(coords) < 2:
        return None
    lon, lat = _num(coords[0]), _num(coords[1])
    if lat is None or lon is None:
        return None
    if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
        return None

    return {
        # trainNumber is reused every day, so identity is the date+number pair.
        # record_snapshot(id_field="id") reads this composite key.
        "id": f"{departure_date}:{train_number}",
        "kind": "rail_live",
        "train_number": train_number,
        "departure_date": departure_date,
        "lat": lat,
        "lon": lon,
        "speed": _num(row.get("speed")),        # km/h
        "accuracy": _num(row.get("accuracy")),  # metres
        "time": _iso_to_epoch(row.get("timestamp")),
        "source": "digitraffic",
        "publisher": PUBLISHER,
        "license": LICENSE,
    }


def parse_trains(payload) -> list[dict]:
    """The /train-locations array -> live position records."""
    out: list[dict] = []
    for row in payload or []:
        record = parse_train(row)
        if record is not None:
            out.append(record)
    return out


def parse_station(row: dict) -> dict | None:
    """One /metadata/stations row -> a station record, or None.

    A station with no coordinate or no short code is dropped: the short code is
    the stable key every other rail dataset joins on, and a station with no
    position is not something to place.
    """
    if not isinstance(row, dict):
        return None
    short = row.get("stationShortCode")
    if not isinstance(short, str) or not short.strip():
        return None
    lat = _num(row.get("latitude"))
    lon = _num(row.get("longitude"))
    if lat is None or lon is None:
        return None
    if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
        return None
    return {
        "id": short.strip(),
        "name": row.get("stationName"),
        "short_code": short.strip(),
        # The UIC code is the international join key; carried alongside the short
        # code the way ports.py carries UN/LOCODE next to its own id.
        "uic_code": row.get("stationUICCode"),
        "country_code": row.get("countryCode"),
        "lat": lat,
        "lon": lon,
        "passenger_traffic": bool(row.get("passengerTraffic")),
        "type": row.get("type"),
        "publisher": PUBLISHER,
        "license": LICENSE,
    }


def parse_stations(payload) -> list[dict]:
    """The /metadata/stations array -> station records (a whole document)."""
    out: list[dict] = []
    for row in payload or []:
        record = parse_station(row)
        if record is not None:
            out.append(record)
    return out


def _headers() -> dict:
    # Courtesy identifier; not a secret, not gated on. Accept-Encoding is left to
    # httpx (gzip by default) -- the API answers 406 without it.
    return {"Digitraffic-User": config.DIGITRAFFIC_USER}


async def _fetch_trains(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(TRAINS_URL)
    resp.raise_for_status()
    return parse_trains(resp.json())


async def _fetch_stations(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(STATIONS_URL)
    resp.raise_for_status()
    return parse_stations(resp.json())


async def start():
    # Two registry states: the live layer served from entity_latest, and the
    # station gazetteer served from its reference document. Both are warmed so a
    # restart shows the last known state immediately.
    live_state = registry.register("rail_live", key_configured=True)  # keyless
    stations_state = registry.register("rail_stations", key_configured=True)
    await storage.warm_points(live_state, "rail_live", "Rail (live)")
    await storage.warm_reference(stations_state, "rail_stations", "Rail stations")

    consecutive_failures = 0
    stations_fetched_at = 0.0
    while True:
        ok = False
        try:
            async with httpx.AsyncClient(
                timeout=30, follow_redirects=True, headers=_headers()
            ) as client:
                trains = await _fetch_trains(client)

                # Stations are static reference data on a slow clock. A failure
                # here must not discard the copy in hand nor take the position
                # feed (the primary layer) down with it -- so it is caught
                # separately, the way hazards.py isolates its weekly report.
                #
                # TODO: train category (IC / long-distance / freight, operator)
                # is not fetched. It lives only on /api/v1/trains/{date}, ~12.8
                # MB/day, which must not gate the 60s position feed. To add it,
                # fetch that endpoint on a once-daily clock like this one, cache
                # trainNumber -> category, and join it onto parse_train's output.
                if time.time() - stations_fetched_at >= config.DIGITRAFFIC_RAIL_STATIONS_INTERVAL:
                    try:
                        stations = await _fetch_stations(client)
                        stations_state.data = stations
                        stations_state.last_success = time.time()
                        stations_state.last_error = None
                        stations_fetched_at = time.time()
                        # No per-row lat/lon lifecycle: the gazetteer is one
                        # document, replaced wholesale, like railways.py's lines.
                        await storage.record_reference("rail_stations", stations)
                        await storage.record_source_health("rail_stations", len(stations), True)
                        log.info("Digitraffic rail stations: %d", len(stations))
                    except Exception as exc:  # noqa: BLE001 - trains still publish
                        stations_state.last_error = str(exc)
                        log.warning("Digitraffic rail stations fetch failed: %s", exc)
                        await storage.record_source_health("rail_stations", None, False, str(exc))

            live_state.data = trains
            live_state.last_success = time.time()
            live_state.last_error = None
            ok = True
            log.info("Digitraffic rail: %d live trains", len(trains))
            await storage.record_snapshot("rail_live", trains, id_field="id")
            await storage.record_source_health("rail_live", len(trains), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            live_state.last_error = str(exc)
            log.warning("Digitraffic rail live fetch failed: %s", exc)
            await storage.record_source_health("rail_live", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            config.DIGITRAFFIC_RAIL_POLL_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, config.DIGITRAFFIC_RAIL_POLL_INTERVAL)
        )
