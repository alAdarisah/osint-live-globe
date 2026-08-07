"""Where a ship can legitimately be sitting still: the NGA World Port Index.

This map already infers ship-to-ship transfers from AIS (see
backend/sources/dark_vessels.py), and that inference is only as good as its
answer to "is this pair simply in port". Until now the answer came from the 40
hand-curated harbours in backend/infrastructure.py -- 15 of them inside the
eleven theatres in backend/regions.py, one in the whole Persian Gulf -- so
almost every real port on earth was, to that detector, open water.

The World Port Index is NGA Pub 150: 2,951 ports, every one with its own
coordinate, keyless, and a work of the US Government in the public domain. It
is a *gazetteer*, not a feed. Nothing here is an event and nothing here is
current; it is the reference layer that lets a derived layer stop guessing.

**Vintage, stated rather than implied.** The payload carries no publication
date of any kind -- no revision field, no `Last-Modified` worth trusting -- and
every sibling product in NGA's MSI database has stopped moving: their broadcast
navigational warnings feed has returned no messages for 2025 or 2026. Treat
this as roughly 2024-vintage reference data. For a port gazetteer that is
acceptable (harbours are not built and demolished on a news cycle) in a way it
would emphatically not be for a warnings feed, and every record says so rather
than letting a fetch timestamp imply freshness.

Coordinates, and the two traps in them
--------------------------------------
Each row carries its position twice: as `ycoord`/`xcoord` (numeric decimal
degrees) and as `latitude`/`longitude` DMS strings. The numeric pair is used
where it is present -- it agreed with the parsed strings to within 1.2e-6
degrees (~13 cm) across all 2,951 rows on 2026-08-06 -- and the string parse is
the fallback. Both traps below are real and both are handled, because the
fallback is exactly the path nobody exercises until the day it matters:

1. **Never match on the degree sign.** Served as UTF-8, `30°20'00"N` becomes
   `30Â°20'00"N` the moment anything decodes those bytes as Latin-1 -- which is
   what a client does when the response arrives with no charset in its
   Content-Type, and NGA has served this endpoint both ways. (On 2026-08-06 the
   full dump declared `charset=UTF-8` and read cleanly, so this is a trap that
   comes and goes, which is the worst kind.) The separator is therefore `\\D+`
   and the parser cannot tell the difference.
2. **Seconds can be fractional.** 55 rows -- mostly Italian; Ancona is
   `43°37'44.4"N` -- carry decimal seconds. A `(\\d+)` seconds group parses
   2,896 of 2,951 and silently drops the rest, which looks like nothing at all
   going wrong. `([\\d.]+)` takes all 2,951.

What is kept
------------
Clipped, like dams.py and osm_infra.py, rather than served whole -- but clipped
to the union of two areas, not just the theatres:

  - the eleven theatre boxes in regions.py (303 ports), which is what the map
    itself navigates by, and
  - the AIS watch boxes in config.AIS_BBOXES (263 ports), which is the only
    water where a ship-to-ship candidate can arise at all.

The second half is not redundant: 90 ports sit in watched water and in no
theatre -- Alexandria, Damietta, Port Said, Suez, Benghazi, the Turkish Black
Sea and Mediterranean coasts, Cyprus. Clipping to theatres alone would have
handed the STS detector a coverage hole shaped exactly like the Eastern
Mediterranean. 393 ports survive the union, out of 2,951.

`globalId` is the id because it is NGA's own stable key. `unloCode` is carried
alongside it (blank on 387 rows) as the one genuine cross-dataset join key
here: a future port-call or berth-occupancy source will join on UN/LOCODE, not
on a name that appears twice in this file ("Aberdeen" is two different ports).
"""

import asyncio
import logging
import re
import time

import httpx

from backend import config, regions, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.ports")

WPI_URL = "https://msi.nga.mil/api/publications/world-port-index?output=json"

# Ports do not move, and this file has no publication date to watch. Monthly is
# already generous for a product whose siblings have not been revised since
# 2024: weekly would be 52 downloads of 6.3 MB a year to observe the same 2,951
# rows, and daily -- what airports.py does, for a file that genuinely changes
# daily -- would be 2.3 GB of someone else's bandwidth to learn nothing.
FETCH_INTERVAL = 30 * 86400

# The loop nevertheless ticks twelve-hourly, and re-writes the snapshot on every
# tick without refetching. Two reasons, neither of them about the upstream file:
#
#   - entity_latest evicts by kind (see storage._stale_after). "ports" has no
#     window of its own in config.ENTITY_STALE_AFTER, so it falls back to the
#     one-day default -- and a source that fetched monthly and wrote monthly
#     would delete its own layer 29 days out of 30, taking the STS exclusion
#     down with it silently. A `"ports": 30 * 86400` entry there is still the
#     right thing to add (dams.py and airports.py both have one), and this tick
#     is what makes this module correct in the meantime.
#   - A failed monthly fetch must not empty a gazetteer either. Re-recording
#     what is already in hand keeps the layer alive until the next attempt.
SNAPSHOT_INTERVAL = 12 * 3600
FAILURE_RETRY_INTERVAL = 900  # scaled by consecutive failures, capped at SNAPSHOT_INTERVAL

PUBLISHER = "NGA World Port Index (Pub 150)"
LICENSE = "US Government work, public domain"
# Carried on the record rather than left to a frontend lookup, for the same
# reason dams.py carries its attribution there: a caveat that lives somewhere
# else is a caveat a new consumer forgets to apply. It gzips to nothing.
VINTAGE = "NGA publishes no date with this file; treat as ~2024 reference data"

# WPI's own legend for the two coded columns worth carrying. A bare "M" in a
# popup is not information, and the browser has no copy of this table.
HARBOR_SIZES = {"V": "Very small", "S": "Small", "M": "Medium", "L": "Large"}
HARBOR_TYPES = {
    "CN": "Coastal, natural",
    "CB": "Coastal, breakwater",
    "CT": "Coastal, tide gate",
    "LC": "Lake or canal",
    "OR": "Open roadstead",
    "RB": "River, basin",
    "RN": "River, natural",
    "RT": "River, tide gate",
    "TH": "Typhoon harbour",
}

# degrees / minutes / seconds / hemisphere, with `\D+` for every separator so
# that `30°20'00"N` and its Latin-1 mangling `30Â°20'00"N` parse identically,
# and `[\d.]+` on the seconds so the 55 rows with fractional seconds are not
# quietly dropped. See the module docstring.
_DMS_RE = re.compile(r"^\s*(\d+)\D+(\d+)\D+([\d.]+)\D*([NSEW])\s*$", re.I)


def parse_coordinate(text: str | None) -> float | None:
    """One WPI DMS string -> signed decimal degrees, or None if unreadable."""
    match = _DMS_RE.match(text or "")
    if not match:
        return None
    degrees, minutes, seconds, hemisphere = match.groups()
    try:
        value = int(degrees) + int(minutes) / 60.0 + float(seconds) / 3600.0
    except ValueError:
        return None
    return -value if hemisphere.upper() in ("S", "W") else value


def _number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _text(row: dict, key: str) -> str | None:
    value = row.get(key)
    return value.strip() or None if isinstance(value, str) else None


def _position(row: dict) -> tuple[float, float] | None:
    """The row's coordinate, publisher's numbers first, DMS strings second."""
    lat, lon = _number(row.get("ycoord")), _number(row.get("xcoord"))
    if lat is None or lon is None:
        # Both from the same representation or neither: mixing a numeric
        # latitude with a parsed longitude would hide a disagreement between
        # them rather than surface it.
        lat = parse_coordinate(row.get("latitude"))
        lon = parse_coordinate(row.get("longitude"))
    if lat is None or lon is None:
        return None
    if not -90.0 <= lat <= 90.0 or not -180.0 <= lon <= 180.0:
        return None
    return lat, lon


def _has_oil_terminal(row: dict) -> bool:
    """Whether the port has an oil terminal berth, as far as WPI says.

    `loOilTerm` -- the loading-facility flag -- is the obvious field and is
    useless on its own: it reads "U" (unknown) on 2,914 of 2,951 rows and "Y" on
    22. The recorded oil-terminal *depth* is what actually carries the signal,
    on 1,304 rows. Either one counts, which is why this is a function and not a
    column read.
    """
    if (_text(row, "loOilTerm") or "").upper() == "Y":
        return True
    depth = _number(row.get("otDepth"))
    return depth is not None and depth > 0


def _theatres() -> list[tuple[str, regions.Bounds]]:
    return [(key, entry["bounds"]) for key, entry in regions.REGIONS.items() if entry.get("bounds")]


def _in_box(lat: float, lon: float, bounds) -> bool:
    south, west, north, east = bounds
    return south <= lat <= north and west <= lon <= east


def region_for(lat: float, lon: float) -> str | None:
    """The first theatre box containing the point, or None.

    First match wins, as in dams.region_for and for the same reason: the
    theatres overlap (Taiwan Strait sits inside the South China Sea box), and a
    port in an overlap must yield one record rather than one per box.
    """
    for key, bounds in _theatres():
        if _in_box(lat, lon, bounds):
            return key
    return None


def in_ais_watch(lat: float, lon: float) -> bool:
    """Inside the water this map actually receives AIS from (config.AIS_BBOXES)."""
    return any(_in_box(lat, lon, box) for box in config.AIS_BBOXES)


def parse_ports(payload: dict) -> list[dict]:
    """The World Port Index response -> every port in it, unclipped.

    Read by key rather than by position: the response is ~112 fields wide and
    NGA has both added and renamed columns across WPI revisions. A row with no
    usable coordinate is dropped rather than placed somewhere plausible.
    """
    out: list[dict] = []
    for row in (payload or {}).get("ports") or []:
        if not isinstance(row, dict):
            continue
        port_id = _text(row, "globalId")
        name = _text(row, "portName")
        if not port_id or not name:
            continue
        placed = _position(row)
        if placed is None:
            log.debug("WPI port %r (%s) has no usable coordinate", name, port_id)
            continue
        lat, lon = placed
        harbor_size = _text(row, "harborSize")
        harbor_type = _text(row, "harborType")
        out.append(
            {
                # NGA's own key, verbatim braces and all. `portNumber` is also
                # unique and also stable, but globalId is the one WPI treats as
                # the record identity across revisions.
                "id": port_id,
                "kind": "port",
                "name": name,
                "lat": lat,
                "lon": lon,
                "country": _text(row, "countryName"),
                "country_code": _text(row, "countryCode"),
                "port_number": row.get("portNumber"),
                # UN/LOCODE. Blank on 387 rows, and the only field here another
                # dataset can be joined to without matching on a name.
                "unlo_code": _text(row, "unloCode"),
                "harbor_size": harbor_size,
                "harbor_size_label": HARBOR_SIZES.get((harbor_size or "").upper()),
                "harbor_type": harbor_type,
                "harbor_type_label": HARBOR_TYPES.get((harbor_type or "").upper()),
                # NGA navigational area (I-XXI), the same partition their
                # warnings are broadcast under.
                "nav_area": _text(row, "navArea"),
                "oil_terminal": _has_oil_terminal(row),
                "region_key": region_for(lat, lon),
                "ais_watch": in_ais_watch(lat, lon),
                "publisher": PUBLISHER,
                "license": LICENSE,
                "vintage": VINTAGE,
            }
        )
    return out


def clip_to_watched(ports: list[dict]) -> list[dict]:
    """The ports worth keeping: inside a theatre, or inside an AIS watch box.

    The second clause is the one that matters to dark_vessels.py. See the module
    docstring: 90 ports sit in watched water and in no theatre, and every one of
    them is a place two tankers can sit alongside each other for an afternoon
    without it meaning anything.
    """
    return [p for p in ports if p.get("region_key") or p.get("ais_watch")]


async def _fetch() -> list[dict]:
    # 6.3 MB and no server-side bbox filter, so the whole dump comes down and
    # the clip happens here. The timeout is generous for that reason.
    async with httpx.AsyncClient(timeout=180, follow_redirects=True) as client:
        resp = await client.get(WPI_URL)
        resp.raise_for_status()
        # .json() rather than .text: json.loads decodes the bytes as UTF-8 per
        # the JSON spec, which sidesteps the charset-header question entirely.
        # The DMS parser survives the mangling anyway; this stops it happening.
        return parse_ports(resp.json())


async def start():
    state = registry.register("ports", key_configured=True)  # no key required
    await storage.warm_points(state, "ports", "Ports")
    fetched_at = 0.0
    consecutive_failures = 0
    while True:
        ok = True
        if time.time() - fetched_at >= FETCH_INTERVAL:
            try:
                everywhere = await _fetch()
                kept = clip_to_watched(everywhere)
                state.data = kept
                state.last_success = time.time()
                state.last_error = None
                fetched_at = time.time()
                consecutive_failures = 0
                log.info(
                    "Ports: %d in the World Port Index, %d kept (%d in a theatre, "
                    "%d in AIS-watched water, %d with an oil terminal)",
                    len(everywhere),
                    len(kept),
                    sum(1 for p in kept if p["region_key"]),
                    sum(1 for p in kept if p["ais_watch"]),
                    sum(1 for p in kept if p["oil_terminal"]),
                )
                await storage.record_source_health("ports", len(kept), True)
            except Exception as exc:  # noqa: BLE001 - keep the poller alive
                ok = False
                consecutive_failures += 1
                state.last_error = str(exc)
                log.warning("World Port Index fetch failed: %s", exc)
                await storage.record_source_health("ports", None, False, str(exc))
        # Written on every tick, fetch or no fetch -- see SNAPSHOT_INTERVAL.
        if state.data:
            await storage.record_snapshot("ports", state.data, id_field="id")
        await asyncio.sleep(
            SNAPSHOT_INTERVAL
            if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, SNAPSHOT_INTERVAL)
        )
