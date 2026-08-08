"""Satellite vessel detections from Global Fishing Watch.

This is the first thing in this project's maritime domain entitled to say
**detected**. Everything else in the maritime stack is either a broadcast the
vessel chose to make (backend/sources/ais.py) or an inference drawn from the
shape of what it stopped broadcasting (backend/sources/dark_vessels.py, whose
docstring forbids itself that word). A radar or optical return is neither: it
is a measurement of a hull, made by an instrument, whether or not anyone aboard
wanted it made.

Two claims, stacked, that must not merge
----------------------------------------
Every record here carries two separate assertions, and collapsing them is the
one mistake this module exists to prevent:

  1. *A hull was at this point at this time.* A **measurement**, ours to state.
     That is `detected: True`, `lat`/`lon`, and `time`.
  2. *And it was not broadcasting AIS.* **Global Fishing Watch's inference**,
     produced by correlating the detection against AIS tracks (methodology:
     Paolo et al., "Satellite mapping reveals extensive industrial activity at
     sea", Nature 625, 2024). That is `matched` plus `match_basis`, which names
     whose inference it is. This map does not assert it; it reports that GFW
     did.

Three quarters of returns in the Strait of Hormuz are unmatched. That ratio is
the signal, and it is only worth anything if the second claim keeps its
attribution.

Absence means nothing here
--------------------------
There is no footprint or coverage dataset in the v3 API -- every candidate
dataset id 404s -- so this module cannot tell "imaged, nothing there" from "not
imaged at all". Empty water on this layer is therefore not evidence of empty
water. Every record carries `footprint_known: False` so the layer can say so
rather than let a reader infer coverage from the absence of pins, and so that
nothing downstream is tempted to treat a gap here the way dark_vessels.py
treats an AIS gap: as something that happened.

A detection is also *old*. `age_days` is on every record because the failure
mode this layer risks is a six-week-old radar return rendering like a live AIS
position. See the staleness note below -- it is measured, not assumed.

Two datasets, one implementation
--------------------------------
`public-global-sentinel2-presence` (optical) and `public-global-sar-presence`
(radar) are the same endpoint, the same record shape and the same licence, so
the dataset id is a parameter and both are configured in DATASETS. They differ
only in how far behind GFW's batch is, and that difference is *measured on
every sweep* rather than written down here: `_sweep` reports the newest `stime`
it saw and the lag that implies, and each record carries `dataset_lag_days`.
Both datasets declare `endDate: null`; on 2026-08-07 optical answered 200 with
data to 2026-08-03 and SAR answered 204 No Content for every window inside the
last six weeks. The declaration is a claim, the 204 is the fact, and only the
fact is allowed to decide what this layer shows. When GFW's SAR batch unstalls,
SAR starts producing here with no code change.

A 204 is "no data in this window", not a failure, and is never recorded as one.

Why the MVT is decoded by hand
------------------------------
Per-detection points come only from `/4wings/tile/position` -- `/4wings/report`
returns grid-cell aggregates, which is a different product. That endpoint
answers in Mapbox Vector Tiles, and requirements.txt has no geospatial library.
The alternatives were `mapbox-vector-tile` (which pulls in protobuf *and*
shapely, a compiled geometry stack, into an image that currently needs neither)
or the ~105 lines below. MVT is a small, frozen, well-specified format and this
module needs almost one shape from it -- points in one layer -- so the decoder
is here. It raises on anything it does not understand rather than resyncing,
because a protobuf decoder that guesses produces plausible coordinates in the
wrong ocean.

About a third of those lines decode the geometry, which the position does not
come from at all (see below). They are not dead weight: the geometry is the
only witness this module has to which of the id's two numbers is latitude, and
without it the layer's failure mode is silent rather than wrong.

Position comes from the id; the geometry only says which axis is which
----------------------------------------------------------------------
A feature's `id` is `{granule};{lon};{lat}` at seven decimal places, and the
tile geometry is quantised to the tile grid -- about 25 m at z8, worse at the
zoom used here. So the truth is in the id, and *tile zoom has no effect on
precision at all*: TILE_ZOOM is a request-count-versus-payload choice and
nothing else.

The id does not label its two numbers, though, and the two readings of it are a
continent apart, so the ordering above is not taken on trust -- see
`position_from`, which settles it per feature against the geometry. A feature
whose id will not parse, or agrees with neither reading, is dropped rather than
placed on its quantised geometry.

Licence
-------
CC BY-NC 4.0. Non-commercial only, and share-alike is *not* the term here --
what propagates to derived works is the NC restriction. The maintainer has
confirmed this project is non-commercial. GFW's required attribution form is
"Copyright [year], Global Fishing Watch, Inc. Accessed on [date].", which is
dated and so is built per sweep, and it travels on each record for the same
reason dams.py's does: an attribution kept in a frontend lookup table is one a
new layer can forget to join.
"""

import asyncio
import logging
import math
import struct
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.gfw_detections")

BASE_URL = "https://gateway.api.globalfishingwatch.org"
TILE_PATH = "/v3/4wings/tile/position/{z}/{x}/{y}"
# Singular `dataset=`. The plural form the tile endpoint uses answers 422 here.
IDENTITY_URL = BASE_URL + "/v3/vessels/{vessel_id}?dataset=public-global-vessel-identity:latest"

PUBLISHER = "Global Fishing Watch"
LICENSE = "CC BY-NC 4.0 (creativecommons.org/licenses/by-nc/4.0)"
# Whose inference the `matched` flag is. Carried on the record rather than
# stated in this docstring alone, because the flag is meaningless -- and, worse,
# reads as this map's own finding -- without it.
MATCH_BASIS = "GFW AIS correlation (Paolo et al. 2024, Nature)"
SOURCE_URL = "https://globalfishingwatch.org/dataset-and-code-vessel-presence/"


@dataclass(frozen=True)
class Dataset:
    sensor: str  # "optical" | "sar" -- what the record and the map key off
    dataset_id: str
    label: str


DATASETS = (
    # The live one as of 2026-08-07: newest scene 2026-08-03.
    Dataset("optical", "public-global-sentinel2-presence:latest", "Sentinel-2 optical presence"),
    # Configured and currently dry: newest scene 2026-06-29, and every window
    # inside the last six weeks answers 204. Left in on purpose -- see the
    # module docstring. Nothing here needs to change when it resumes.
    Dataset("sar", "public-global-sar-presence:latest", "SAR presence"),
)

# How far back each sweep asks. It has to clear the publisher's own batch lag or
# the request returns nothing at all: optical was four days behind when this was
# written, so a 24h window -- the interval a live layer would suggest -- would
# have made the whole layer permanently empty for a reason no log line would
# name. Seven days clears the measured optical lag with room to spare and is
# short enough that everything on the layer is still this week. SAR at 39 days
# behind stays dry against this window, which is the correct outcome: a
# six-week-old return is an archive query, not a maritime picture, and this
# layer renders beside live AIS.
LOOKBACK_DAYS = 7

# 23 tiles over the eight boxes in config.WATCHED_WATERS, computed rather than
# listed so coverage follows the watch boxes if they change. Deliberately not
# config.AIS_BBOXES, which is the whole planet since 2026-08-08: that would be
# 1,024 tiles a sweep against a record cap that keeps 12,000, so ~98% of a
# 40-fold payload increase would be downloaded and thrown away. Zoom is a pure
# request-count-versus-payload trade here (position comes from the feature id,
# not the geometry): z5 tiles are ~11 degrees wide, so a good deal of each tile
# is water this map does not watch and is discarded by the clip below -- z6
# would halve that waste at three times the requests, which is the wrong side
# of the trade when payload is the binding constraint and quota is not.
TILE_ZOOM = 5

# The one layer a 4wings position tile contains.
TILE_LAYER = "main"

# Politeness, not a quota constraint. A sweep is 23 tiles x 2 datasets = 46
# requests, and at four sweeps a day that is 0.5% of the 50,000/day the response
# headers report. Payload is what costs: roughly 5-8 MB per optical sweep.
_TILE_CONCURRENCY = 4
_TIMEOUT = 60.0

# Per dataset, keeping the newest. entity_latest is keyed by (kind, entity_id)
# and every detection is a distinct immutable entity -- unlike AIS, where a poll
# *updates* a row per MMSI -- so without a bound this kind grows monotonically
# at 10^3-10^4 rows per theatre-day. The backend's mirror reads every row of a
# kind into one Python list and serves it as one payload (see backend/mirror.py),
# which is the thing being bounded. 12,000 x 2 datasets, with ~250 bytes of
# constant provenance strings on each record, is about 6 MB of JSONB before
# gzip collapses the repeated strings; FIRMS at 175k points is the largest
# payload this app carries and this layer has no reason to approach it.
MAX_RECORDS_PER_DATASET = 12000

# What the last sweep of each dataset measured, for the log and for anything
# that wants to ask "how far behind is SAR today" without re-reading the API.
LAST_SWEEPS: dict[str, "Sweep"] = {}


# --- Mapbox Vector Tile ----------------------------------------------------
#
# Protobuf wire format, then the MVT v2 schema on top of it. See the module
# docstring for why this is here instead of a dependency.


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def _fields(buf: bytes, pos: int = 0, end: int | None = None):
    """(field number, wire type, value) for every field of a protobuf message.

    Varints yield an int, length-delimited fields yield the raw slice, and the
    fixed-width types yield their bytes for struct to unpack. Groups (wire types
    3 and 4) are deprecated, appear in no MVT, and raise -- skipping an unknown
    wire type means guessing its length, and a decoder that loses sync produces
    coordinates rather than an error.
    """
    end = len(buf) if end is None else end
    while pos < end:
        tag, pos = _varint(buf, pos)
        field, wire = tag >> 3, tag & 7
        if wire == 0:
            value, pos = _varint(buf, pos)
        elif wire == 2:
            length, pos = _varint(buf, pos)
            value, pos = buf[pos:pos + length], pos + length
        elif wire == 5:
            value, pos = buf[pos:pos + 4], pos + 4
        elif wire == 1:
            value, pos = buf[pos:pos + 8], pos + 8
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")
        yield field, wire, value


def _unzigzag(value: int) -> int:
    return (value >> 1) ^ -(value & 1)


def _packed_uint32(buf: bytes) -> list[int]:
    out, pos = [], 0
    while pos < len(buf):
        value, pos = _varint(buf, pos)
        out.append(value)
    return out


def _tile_value(buf: bytes):
    """MVT Tile.Value -- a one-of over seven scalar types."""
    for field, _wire, raw in _fields(buf):
        if field == 1:
            return raw.decode("utf-8", "replace")
        if field == 2:
            return struct.unpack("<f", raw)[0]
        if field == 3:
            return struct.unpack("<d", raw)[0]
        if field in (4, 5):
            return raw
        if field == 6:
            return _unzigzag(raw)
        if field == 7:
            return bool(raw)
    return None


def _tile_feature(buf: bytes, keys: list[str], values: list) -> tuple[dict, int, list[int]]:
    tags: list[int] = []
    geometry: list[int] = []
    geom_type = 0
    for field, _wire, raw in _fields(buf):
        if field == 2:
            tags = _packed_uint32(raw)
        elif field == 3:
            geom_type = raw
        elif field == 4:
            geometry = _packed_uint32(raw)
    props = {}
    for i in range(0, len(tags) - 1, 2):
        key_index, value_index = tags[i], tags[i + 1]
        if key_index < len(keys) and value_index < len(values):
            props[keys[key_index]] = values[value_index]
    return props, geom_type, geometry


def _first_point(geometry: list[int]) -> tuple[int, int] | None:
    """The first MoveTo of a point geometry, in tile-local units."""
    if len(geometry) < 3:
        return None
    command = geometry[0]
    if command & 7 != 1 or command >> 3 < 1:  # 1 == MoveTo, with a count
        return None
    return _unzigzag(geometry[1]), _unzigzag(geometry[2])


def _tile_to_lonlat(z: int, x: int, y: int, extent: int, px: int, py: int) -> tuple[float, float]:
    size = extent * (2 ** z)
    lon = (x * extent + px) / size * 360.0 - 180.0
    n = math.pi - 2.0 * math.pi * (y * extent + py) / size
    return lon, math.degrees(math.atan(math.sinh(n)))


def decode_tile(data: bytes, z: int, x: int, y: int, layer_name: str = TILE_LAYER) -> list[dict]:
    """One MVT -> [{"props": {...}, "geom_lonlat": (lon, lat) | None}, ...].

    `geom_lonlat` is decoded but is *not* where a record's position comes from:
    it is the quantised tile grid, and the truth is in the feature id. It is
    carried so the two can be compared, which is the only reason to look at it.
    """
    out: list[dict] = []
    for field, _wire, raw in _fields(data):
        if field != 3:  # Tile.layers
            continue
        name, extent, keys, values, features = None, 4096, [], [], []
        for lfield, _lwire, lraw in _fields(raw):
            if lfield == 1:
                name = lraw.decode("utf-8", "replace")
            elif lfield == 2:
                features.append(lraw)
            elif lfield == 3:
                keys.append(lraw.decode("utf-8", "replace"))
            elif lfield == 4:
                values.append(_tile_value(lraw))
            elif lfield == 5:
                extent = lraw
        if name != layer_name:
            continue
        for feature in features:
            props, geom_type, geometry = _tile_feature(feature, keys, values)
            point = _first_point(geometry) if geom_type == 1 else None
            out.append({
                "props": props,
                "geom_lonlat": _tile_to_lonlat(z, x, y, extent, *point) if point else None,
            })
    return out


# --- coverage --------------------------------------------------------------


def tiles_for(boxes, zoom: int) -> list[tuple[int, int, int]]:
    """Every (z, x, y) covering `boxes`, deduped -- theatres overlap tiles."""
    def tile_x(lon: float) -> int:
        return min(int((lon + 180.0) / 360.0 * (2 ** zoom)), 2 ** zoom - 1)

    def tile_y(lat: float) -> int:
        clamped = max(min(lat, 85.05112878), -85.05112878)
        radians = math.radians(clamped)
        fraction = (1.0 - math.log(math.tan(radians) + 1 / math.cos(radians)) / math.pi) / 2.0
        return min(int(fraction * (2 ** zoom)), 2 ** zoom - 1)

    tiles = set()
    for lat_min, lon_min, lat_max, lon_max in boxes:
        for x in range(tile_x(lon_min), tile_x(lon_max) + 1):
            for y in range(tile_y(lat_max), tile_y(lat_min) + 1):
                tiles.add((zoom, x, y))
    return sorted(tiles)


def in_watched_waters(lat: float, lon: float) -> bool:
    """The theatres this map claims as watched (config.WATCHED_WATERS).

    A z5 tile is ~11 degrees wide, so most of what a sweep downloads is water
    this map does not watch. Clipping is what keeps the layer's coverage a
    statement anyone can check -- "the eight watched theatres" -- rather than
    "whatever 23 arbitrary tiles happened to contain".
    """
    return any(
        lat_min <= lat <= lat_max and lon_min <= lon <= lon_max
        for lat_min, lon_min, lat_max, lon_max in config.WATCHED_WATERS
    )


# --- records ---------------------------------------------------------------


def parse_id_floats(raw) -> tuple[float, float] | None:
    """`{granule};{a};{b}` -> (a, b), at the id's seven decimal places.

    Deliberately does not decide which of the two is latitude -- see
    position_from. rsplit rather than split: a granule name containing a
    semicolon would otherwise shift the fields silently.
    """
    if not isinstance(raw, str) or ";" not in raw:
        return None
    parts = raw.rsplit(";", 2)
    if len(parts) != 3 or not parts[0]:
        return None
    try:
        first, second = float(parts[1]), float(parts[2])
    except ValueError:
        return None
    if math.isnan(first) or math.isnan(second) or math.isinf(first) or math.isinf(second):
        return None
    return first, second


# How far the id may sit from the quantised geometry and still be the same
# point. A z5 tile at the default 4096 extent quantises to ~0.003 degrees of
# longitude; 0.05 is twenty times that, and still three orders of magnitude
# below the tens of degrees a transposed pair would be out by.
_AXIS_TOLERANCE_DEG = 0.05


def position_from(raw_id, geom_lonlat) -> tuple[float, float] | None:
    """(lat, lon) from the feature id, with the axis order settled by geometry.

    The id carries the precision -- seven decimals, against a tile geometry
    quantised to the grid -- but it does not carry labels, and the two readings
    of `{granule};{a};{b}` differ by the whole width of a continent. The sample
    this was built against reads `{granule};{lon};{lat}`: its id is
    `...;56.74939600;27.0279540` and its geometry is (lon 56.749363, lat
    27.027974), which is the Strait of Hormuz. The other reading puts the same
    detection 3,000 km inland in Latvia, and would have been invisible rather
    than wrong -- the clip to watched water would have dropped every pin and
    left an empty layer with a green health light.

    So the ordering is not asserted here. The geometry is a low-precision
    witness to which field is which, and it is consulted per feature: whichever
    reading the tile agrees with wins, and a feature whose id agrees with
    neither is dropped. If GFW ever swaps the order, this follows it; if this
    module's assumption was wrong from the start, it was never used.
    """
    pair = parse_id_floats(raw_id)
    if pair is None:
        return None
    first, second = pair
    # (lat, lon) under each reading, most-likely first.
    candidates = ((second, first), (first, second))
    if geom_lonlat is not None:
        geom_lon, geom_lat = geom_lonlat
        for lat, lon in candidates:
            if (abs(lat - geom_lat) <= _AXIS_TOLERANCE_DEG
                    and abs(lon - geom_lon) <= _AXIS_TOLERANCE_DEG):
                return _valid(lat, lon)
        return None
    # No geometry to check against -- the documented-by-example ordering, which
    # is the only one this module has ever seen the API use.
    return _valid(*candidates[0])


def _valid(lat: float, lon: float) -> tuple[float, float] | None:
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None
    return lat, lon


def attribution_for(now: float) -> str:
    """GFW's required form, verbatim: it is dated, so it is built not stored."""
    accessed = datetime.fromtimestamp(now, tz=timezone.utc)
    return (
        f"Copyright {accessed.year}, Global Fishing Watch, Inc. "
        f"Accessed on {accessed.strftime('%Y-%m-%d')}."
    )


def build_record(feature: dict, dataset: Dataset, lag_days: float | None, now: float) -> dict | None:
    """One tile feature -> one record, or None if it cannot be placed or timed."""
    props = feature.get("props") or {}
    detection_id = props.get("id")
    position = position_from(detection_id, feature.get("geom_lonlat"))
    if position is None:
        return None
    lat, lon = position
    stime = props.get("stime")
    if not isinstance(stime, (int, float)) or isinstance(stime, bool) or stime <= 0:
        # No acquisition time means no age, and an undated detection rendered
        # beside live AIS is exactly the failure this layer is guarding against.
        return None
    observed = float(stime)
    vessel_id = props.get("vessel_id")
    vessel_id = vessel_id.strip() if isinstance(vessel_id, str) else ""
    return {
        # Prefixed with the sensor so a row says which instrument saw it without
        # a join, and so the two datasets can never collide on a shared granule.
        "id": f"{dataset.sensor}:{detection_id}",
        "detection_id": detection_id,
        "lat": lat,
        "lon": lon,
        # Scene acquisition, not publication: when the instrument looked.
        "time": observed,
        "age_days": round((now - observed) / 86400.0, 1),
        # The measurement. See the module docstring -- this is the one claim
        # this map makes on its own authority.
        "detected": True,
        # GFW's inference, kept separate and attributed. The popup phrases an
        # unmatched detection as "not matched to any AIS transmitter (GFW)".
        "matched": bool(vessel_id),
        "match_basis": MATCH_BASIS,
        "vessel_id": vessel_id or None,
        "sensor": dataset.sensor,
        "dataset": dataset.dataset_id,
        # Measured on the sweep this record came from, not a constant.
        "dataset_lag_days": lag_days,
        # There is no footprint dataset, so this layer cannot distinguish
        # "imaged, nothing there" from "not imaged". Absence proves nothing.
        "footprint_known": False,
        "publisher": PUBLISHER,
        "license": LICENSE,
        "attribution": attribution_for(now),
        "source_url": SOURCE_URL,
    }


def build_records(features: list[dict], dataset: Dataset, now: float) -> list[dict]:
    """Tile features -> the records worth keeping, newest first.

    Clipped to watched water, deduped by id (two theatre boxes can share a
    tile), and bounded -- see MAX_RECORDS_PER_DATASET.
    """
    lag_days = lag_for(features, now)
    by_id: dict[str, dict] = {}
    for feature in features:
        record = build_record(feature, dataset, lag_days, now)
        if record is None:
            continue
        if not in_watched_waters(record["lat"], record["lon"]):
            continue
        by_id[record["id"]] = record
    records = sorted(by_id.values(), key=lambda r: r["time"], reverse=True)
    return records[:MAX_RECORDS_PER_DATASET]


def lag_for(features: list[dict], now: float) -> float | None:
    """How far behind this dataset's newest scene is, in days -- measured.

    None when the sweep saw nothing at all, which is the honest answer for a
    dataset answering 204 across every tile: we know it published nothing in the
    window, not how far behind it is.
    """
    times = [
        float(f["props"]["stime"])
        for f in features
        if isinstance((f.get("props") or {}).get("stime"), (int, float))
        and not isinstance(f["props"]["stime"], bool)
        and f["props"]["stime"] > 0
    ]
    if not times:
        return None
    return round((now - max(times)) / 86400.0, 1)


# --- fetch -----------------------------------------------------------------


@dataclass
class Sweep:
    """What one dataset's pass over the tile set actually found."""

    dataset: Dataset
    tiles: int = 0
    tiles_with_data: int = 0
    tiles_empty: int = 0  # 204 No Content -- nothing published in the window
    tiles_failed: int = 0
    features: int = 0
    records: list[dict] = None  # type: ignore[assignment]
    lag_days: float | None = None
    first_error: str | None = None

    def __post_init__(self):
        if self.records is None:
            self.records = []


def tile_url(dataset_id: str, z: int, x: int, y: int, start: date, end: date) -> str:
    """The verified request, built as a string rather than through httpx params.

    The bracketed parameter names (`datasets[0]`, `properties[0]`) are GFW's own
    spelling and are left literal; percent-encoding them is a gamble on the
    gateway decoding them back, and this URL is one that has been checked
    against the live API. `format` is mandatory -- omitting it is a 4xx, not a
    default.
    """
    return (
        f"{BASE_URL}{TILE_PATH.format(z=z, x=x, y=y)}"
        f"?datasets[0]={quote(dataset_id, safe=':-')}"
        f"&date-range={start.isoformat()},{end.isoformat()}"
        f"&format=MVT"
        f"&properties[0]=vessel_id"
    )


async def _fetch_tile(client: httpx.AsyncClient, url: str) -> bytes | None:
    """Tile bytes, or None for 204.

    204 is "no data in this window", which is a fact about the publisher's batch
    and not about us -- it must never become a failed health row, or a dataset
    that is merely dry reads as a dataset that is broken.
    """
    response = await client.get(url)
    if response.status_code == 204:
        return None
    response.raise_for_status()
    return response.content


async def _sweep(client: httpx.AsyncClient, dataset: Dataset, tiles, start: date, end: date,
                 now: float) -> Sweep:
    sweep = Sweep(dataset=dataset, tiles=len(tiles))
    semaphore = asyncio.Semaphore(_TILE_CONCURRENCY)
    features: list[dict] = []

    async def one(z: int, x: int, y: int):
        async with semaphore:
            try:
                body = await _fetch_tile(client, tile_url(dataset.dataset_id, z, x, y, start, end))
            except Exception as exc:  # noqa: BLE001 - one bad tile is not a bad sweep
                sweep.tiles_failed += 1
                if sweep.first_error is None:
                    sweep.first_error = f"{type(exc).__name__}: {exc}"
                log.debug("GFW tile %s/%s/%s (%s) failed: %s", z, x, y, dataset.sensor, exc)
                return
        if body is None:
            sweep.tiles_empty += 1
            return
        try:
            decoded = decode_tile(body, z, x, y)
        except (ValueError, IndexError, struct.error) as exc:
            # A tile we cannot decode is dropped rather than half-read: the
            # decoder raises exactly so a desynced parse cannot become points.
            sweep.tiles_failed += 1
            if sweep.first_error is None:
                sweep.first_error = f"undecodable tile {z}/{x}/{y}: {exc}"
            log.warning("GFW tile %s/%s/%s (%s) did not decode: %s", z, x, y, dataset.sensor, exc)
            return
        sweep.tiles_with_data += 1
        features.extend(decoded)

    await asyncio.gather(*(one(z, x, y) for z, x, y in tiles))
    sweep.features = len(features)
    sweep.lag_days = lag_for(features, now)
    sweep.records = build_records(features, dataset, now)
    return sweep


# Resolved identities, keyed by vessel_id. A vessel's identity record is
# reference data that changes on a re-flagging, not on a pass overhead, so it is
# cached for the life of the process; the bound is there because the key space
# is every hull GFW has ever matched, not because entries go stale.
_IDENTITY_CACHE: dict[str, dict | None] = {}
_IDENTITY_CACHE_MAX = 5000


async def resolve_identity(client: httpx.AsyncClient, vessel_id: str) -> dict | None:
    """Identity for one matched detection. Deliberately not called in a sweep.

    One extra request per matched detection, and a sweep can hold thousands of
    them -- so this is here for a lazy lookup on the detail path (a reader
    opening one popup), not for the ingest loop. Calling it inline would turn a
    46-request sweep into a several-thousand-request one for identity nobody
    asked to see, against a token allowed one concurrent report.

    A 404 is cached as None: an unresolvable vessel_id does not become
    resolvable by being asked about again on the next popup.
    """
    if vessel_id in _IDENTITY_CACHE:
        return _IDENTITY_CACHE[vessel_id]
    response = await client.get(IDENTITY_URL.format(vessel_id=quote(vessel_id, safe="")))
    if response.status_code == 404:
        identity = None
    else:
        response.raise_for_status()
        identity = response.json()
    if len(_IDENTITY_CACHE) >= _IDENTITY_CACHE_MAX:
        _IDENTITY_CACHE.clear()  # cheaper than an LRU for a cache this cold
    _IDENTITY_CACHE[vessel_id] = identity
    return identity


async def ingest_once():
    """One sweep of every configured dataset. Runs in the ingest process.

    Nothing is warmed from storage, for the same reason as the other ingest
    jobs: this process serves no one, so there is nothing to fill (see
    backend/tests/test_persistence_coverage.py). The read that would otherwise
    be a boot warm is the backend mirror's `entity_latest("gfw_detections")`,
    and what bounds *that* is MAX_RECORDS_PER_DATASET plus this kind's eviction
    window -- every detection is a distinct immutable row, so nothing else would
    stop the table growing forever.
    """
    key_configured = bool(config.GFW_API_TOKEN)
    state = registry.ensure("gfw_detections", key_configured=key_configured)
    if not key_configured:
        # Recorded, not merely set on the state: this process serves no
        # /api/health of its own, so a missing token that never reaches
        # source_health leaves the backend reporting "waiting for the ingest
        # service to run for the first time" forever -- the wrong problem.
        state.last_error = "GFW_API_TOKEN not set in .env"
        await storage.record_source_health("gfw_detections", None, False, state.last_error)
        return

    now = time.time()
    today = datetime.fromtimestamp(now, tz=timezone.utc).date()
    start = today - timedelta(days=LOOKBACK_DAYS)
    tiles = tiles_for(config.WATCHED_WATERS, TILE_ZOOM)
    headers = {"Authorization": f"Bearer {config.GFW_API_TOKEN}"}

    try:
        sweeps: list[Sweep] = []
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
            for dataset in DATASETS:
                # Sequential across datasets: the concurrency that matters is
                # within a sweep, and GFW allows one concurrent report per token.
                sweeps.append(await _sweep(client, dataset, tiles, start, today, now))

        for sweep in sweeps:
            if sweep.tiles and sweep.tiles_failed == sweep.tiles:
                # Every tile of this dataset errored: a bad token, a wrong
                # dataset id, a dead gateway. That has to go red, and per
                # dataset rather than across the sweep -- otherwise one product
                # failing outright hides behind the other merely being empty,
                # which is the exact pair of states these two are in today. A
                # *partial* failure is not a source failure: it is thinner
                # coverage, and the log below names it.
                raise RuntimeError(f"{sweep.dataset.sensor}: {sweep.first_error}")

        records = [r for sweep in sweeps for r in sweep.records]
        for sweep in sweeps:
            LAST_SWEEPS[sweep.dataset.sensor] = sweep

        state.data = records
        state.last_success = time.time()
        state.last_error = None
        await storage.record_snapshot("gfw_detections", records, id_field="id")
        await storage.record_source_health("gfw_detections", len(records), True)

        for sweep in sweeps:
            unmatched = sum(1 for r in sweep.records if not r["matched"])
            log.info(
                "GFW %s: %d detections kept from %d features (%d unmatched), "
                "%d/%d tiles with data, %d empty, %d failed; newest scene %s",
                sweep.dataset.sensor,
                len(sweep.records),
                sweep.features,
                unmatched,
                sweep.tiles_with_data,
                sweep.tiles,
                sweep.tiles_empty,
                sweep.tiles_failed,
                # The measured staleness. "no data in window" is the whole
                # finding for a dataset whose batch has stalled.
                f"{sweep.lag_days} days behind" if sweep.lag_days is not None
                else f"no data in the last {LOOKBACK_DAYS} days",
            )
    except Exception as exc:  # noqa: BLE001 - one failed sweep is not a dead source
        state.last_error = str(exc)
        log.warning("GFW detections sweep failed: %s", exc)
        await storage.record_source_health("gfw_detections", None, False, str(exc))
