"""Where an aircraft could have come from, and where it could be going.

The ADS-B layer has always been able to say *what* is flying and *where it is*,
and never able to say the one thing a reader actually asks next: which airfield
is that. This module is the answer to that question -- the OurAirports open
dataset, which is public domain, keyless, and the reference every flight-tracking
site is built on.

Two consumers, deliberately different in shape:

- The **popup**: a proximity index over the whole set, queried per aircraft, so a
  contact orbiting over an airbase says so. This is the point of the module.
- An optional **map layer**, gated hard by zoom. 80k+ airfields is a carpet, not
  a layer, so what is served is a filtered slice (see SERVED_TYPES) and the
  frontend gates it further.

The military flag is an *inference from the airfield's name*, and it is labelled
as one everywhere it surfaces. OurAirports has no military field; a name match
is the only signal available and it will both miss (civil-named military fields)
and over-reach (a civil airport named after an air force officer). It is worth
having anyway -- "RAF Lakenheath" beside a KC-135 is the context that makes the
contact legible -- but it is never presented as a fact from the dataset.
"""

import asyncio
import csv
import io
import logging
import re
import time

import httpx

from backend import storage
from backend.cache import registry
from backend.sources.proximity import ProximityIndex

log = logging.getLogger("osint-globe.airports")

AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
REFRESH_INTERVAL = 24 * 3600  # airfields do not move; the file changes daily at most
FAILURE_RETRY_INTERVAL = 120  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# What reaches the map. Heliports, seaplane bases and closed fields are ~60% of
# the file and none of them help answer "where did that aircraft come from" --
# they are dropped at parse time rather than filtered in the browser, since the
# whole point is to not ship 80k rows to it.
SERVED_TYPES = frozenset({"large_airport", "medium_airport", "small_airport"})

# The proximity index keeps more than the map does: a helicopter really can have
# come from a heliport, and the popup is a per-aircraft lookup with no volume
# problem. Closed fields stay out of both -- an aircraft cannot have come from
# one, and a "closed" airfield named as an origin would be actively wrong.
INDEXED_TYPES = SERVED_TYPES | {"heliport", "seaplane_base"}

# How far from an aircraft an airfield still counts as context rather than
# coincidence. Generous on purpose: at cruise altitude nothing is "at" an
# airfield, and the popup says the distance, so the reader judges.
NEAREST_RADIUS_KM = 40.0

# Name patterns that mark an airfield as military. Anchored to word boundaries
# and, for the service prefixes, to the *start* of the name -- an unanchored
# "NAS" matched "Nassau" and an unanchored "RAF" matched "Rafael", which is
# exactly the kind of confident wrong answer this whole module tries to avoid.
_MILITARY_NAME_RE = re.compile(
    r"(\bair\s+(?:force\s+)?base\b|\bairbase\b|\bair\s+station\b|\bmilitary\b"
    r"|\bAFB\b|\bAAF\b|\bMCAS\b|\bJoint\s+Base\b|\bArmy\s+(?:Air)?field\b"
    r"|^RAF\s|^NAS\s|^NAF\s|^CFB\s|^RAAF\s|^RNZAF\s|^PAF\s|^IAF\s)",
    re.I,
)


def is_military_name(name: str | None) -> bool:
    return bool(name and _MILITARY_NAME_RE.search(name))


def parse_airports(text: str) -> list[dict]:
    """OurAirports' airports.csv -> the rows worth keeping.

    Read by header name rather than by position: unlike the GeoNames files
    elsewhere in this package, this one ships a header row, and OurAirports has
    added columns before.
    """
    out: list[dict] = []
    for row in csv.DictReader(io.StringIO(text)):
        kind = (row.get("type") or "").strip()
        if kind not in INDEXED_TYPES:
            continue
        try:
            lat = float(row["latitude_deg"])
            lon = float(row["longitude_deg"])
        except (KeyError, TypeError, ValueError):
            continue
        name = (row.get("name") or "").strip()
        if not name:
            continue
        # `ident` is unique across the file and is what every other row refers
        # to; `icao_code`/`iata_code` are frequently blank.
        out.append(
            {
                "id": (row.get("ident") or "").strip() or f"{lat},{lon}",
                "name": name,
                "type": kind,
                "lat": lat,
                "lon": lon,
                "country": (row.get("iso_country") or "").strip() or None,
                "municipality": (row.get("municipality") or "").strip() or None,
                "iata": (row.get("iata_code") or "").strip() or None,
                "icao": (row.get("icao_code") or "").strip() or None,
                "scheduled_service": (row.get("scheduled_service") or "").strip() == "yes",
                "military_name": is_military_name(name),
            }
        )
    return out


# --- the live index --------------------------------------------------------
#
# Same swap-in-whole discipline gazetteer.py uses: the index is replaced by a
# single rebind so a lookup racing a refresh sees one complete index or the
# other, never a half-built one.

_index = ProximityIndex([])


def install(points: list[dict]) -> None:
    global _index
    _index = ProximityIndex(points, cell_deg=0.5)


def nearest(lat: float, lon: float, radius_km: float = NEAREST_RADIUS_KM) -> dict | None:
    """The closest known airfield, or None. Never raises: an unbuilt index
    (the file has not downloaded yet) simply has no opinion."""
    return _index.nearest(lat, lon, radius_km)


def current() -> ProximityIndex:
    return _index


async def _fetch() -> list[dict]:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        resp = await client.get(AIRPORTS_URL)
        resp.raise_for_status()
    return parse_airports(resp.text)


async def start():
    state = registry.register("airports", key_configured=True)  # no key required
    consecutive_failures = 0
    while True:
        ok = False
        try:
            airfields = await _fetch()
            install(airfields)
            # Only the served slice reaches state.data (and therefore the map);
            # the index above keeps the wider set for popup lookups.
            served = [a for a in airfields if a["type"] in SERVED_TYPES]
            state.data = served
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info(
                "Airports: %d indexed, %d served (%d military by name)",
                len(airfields),
                len(served),
                sum(1 for a in served if a["military_name"]),
            )
            await storage.record_snapshot("airports", served, id_field="id")
            await storage.record_source_health("airports", len(served), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Airports fetch failed: %s", exc)
            await storage.record_source_health("airports", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
