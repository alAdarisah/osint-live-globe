"""Dams, and how much water is standing behind them.

A dam is infrastructure whose failure is catastrophic downstream and whose
deliberate targeting is a war crime. The Kakhovka breach in June 2023 is the
whole argument for this layer: the useful record is not "a dam is here", it is
"a dam is here, it holds 18,180 million cubic metres, and this is what sits
below it". So the field this module cares most about is CAP_MCM (present on
85.9% of rows), not POWER_MW (0.6%) -- capacity is the consequence, generation
is a footnote.

Global Dam Watch v1.0 is the successor to GRanD, GOODD, GROD and FHReD, all of
which it absorbed and all of which it credits per row in ORIG_SRC. It is keyless
and CC BY 4.0, and the figshare article has exactly one version -- published
2024-07-25, last touched 2024-08-28 and not since. That last fact is what shapes
the fetch: a weekly unconditional re-download of a 70 MB zip that never changes
is ~3.6 GB/year of someone else's bandwidth for nothing, so every poll asks the
figshare API for `modified_date` first and only pulls the zip when it moved.

**No geospatial dependency.** The shapefile zip ships a plain comma-delimited
attribute table (GDW_barriers_v1_0.txt, 71 columns, 41,145 rows) beside the
.shp. Its point geometry was checked against that table: 41,145 points, 41,145
rows, one disagreement beyond 1e-6. The CSV alone is sufficient, so this reads
it with `zipfile` + `csv` from the standard library. requirements.txt has no
geospatial library in it and this is not the change that adds one.

The reservoir *polygons* are deliberately not parsed. "What area floods if this
fails" is the natural next question and the answer is in
GDW_reservoirs_v1_0.shp (94 MB of polygon geometry), which needs a real
shapefile reader. That is a separate piece of work, not a line in this one.

Scoped to the eleven conflict theatres in backend/regions.py rather than to the
world, for the same reason osm_infra.py is: 41,145 dams is ~21 MB of JSON and a
carpet nobody can read, while the clipped set is 3,555 records / 1.8 MB, 447 of
them holding 100 million m³ or more.

No severity is assigned. Every other layer's severity comes from something the
publisher measured -- a PAGER alert, a fatality count, a report type. GDW
publishes nothing of the kind, and deriving "how dangerous is this dam" from its
capacity would be our claim dressed up as theirs. The capacity is carried
instead, and the reader draws the conclusion.
"""

import asyncio
import csv
import io
import logging
import os
import tempfile
import time
import zipfile
from datetime import datetime, timezone

import httpx

from backend import regions, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.dams")

# The article metadata, which is cheap (9 KB) and carries `modified_date`.
ARTICLE_URL = "https://api.figshare.com/v2/articles/25988293"
# GDW_v1_0_shp.zip, 69,745,749 bytes, behind a redirect to a signed S3 URL.
DOWNLOAD_URL = "https://ndownloader.figshare.com/files/47913754"
# Matched by suffix rather than by this exact path, in case the zip is ever
# repackaged with a different directory prefix.
CSV_MEMBER_SUFFIX = "GDW_barriers_v1_0.txt"

# The stored release stamp, so a process restart does not re-download 70 MB to
# rediscover that a dataset frozen since August 2024 is still frozen.
RELEASE_REF = "dams_release"

REFRESH_INTERVAL = 7 * 86400  # a static dataset; this poll is a change *check*
FAILURE_RETRY_INTERVAL = 900  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# The real file is 66.5 MB. This is not a tuning knob -- it is a floor under the
# failure where figshare answers a download with an HTML error page or a
# redirect loop, so a bad response is refused before it fills a disk.
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
DOWNLOAD_CHUNK = 1 << 20

# CC BY 4.0 obliges attribution, so the string travels on the record itself
# rather than living in a frontend lookup table that a new layer can forget to
# join. Copied verbatim from the figshare article's own `citation` field.
#
# It is the same string 3,555 times, which looks wasteful and measurably is not:
# app.py gzips every payload over 1 KB, and the whole layer goes from 158.5 KB
# to 169.6 KB on the wire with the attribution attached. Eleven kilobytes to
# make it impossible to draw an unattributed dam.
ATTRIBUTION = (
    "Lehner, Bernhard; Beames, Penny; Mulligan, Mark; Zarfl, Christiane; "
    "De Felice, Luca; van Soesbergen, Arnout; et al. (2024). Global Dam Watch "
    "database version 1.0. figshare. Dataset. "
    "https://doi.org/10.6084/m9.figshare.25988293.v1"
)
PUBLISHER = "Global Dam Watch (GDW v1.0)"
LICENSE = "CC BY 4.0 (creativecommons.org/licenses/by/4.0)"

# GDW writes no-data as -99 in its numeric columns, not as an empty cell. Taking
# the cells at face value puts "built in -99, 99 m tall" in the popup for the
# 63% of rows with no year, which is worse than saying nothing.
#
# Applied only to the measure columns below. It is deliberately NOT applied to
# coordinates: LONG_DAM = -99.331 is the Notigi Control Structure in Manitoba,
# a real longitude that a sentinel rule would quietly delete. GDW leaves a
# missing coordinate as an empty cell, so coordinates need no sentinel at all.
NO_DATA = -99.0

# "3: Fair" -> 3. The label is kept verbatim as well; this is only so the value
# can be sorted and filtered on without re-parsing a string in the browser.
_QUALITY_RANKS = {"1": 1, "2": 2, "3": 3, "4": 4, "5": 5}


def _text(row: dict, key: str) -> str | None:
    value = (row.get(key) or "").strip()
    return value or None


def _number(row: dict, key: str) -> float | None:
    """A measure column, with GDW's -99 no-data sentinel removed.

    Safe for every column this module carries: none of them (year, height,
    capacity, area, catchment, power) can legitimately be -99. It would not be
    safe for e.g. ELEV_MASL, which is genuinely negative around the Dead Sea --
    hence a helper used by name rather than a blanket rule over the row.
    """
    raw = (row.get(key) or "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return None if value == NO_DATA else value


def _year(row: dict, key: str) -> int | None:
    value = _number(row, key)
    return int(value) if value is not None else None


def _link_id(row: dict, key: str) -> int | None:
    """GRAND_ID / HYLAK_ID, which use 0 rather than -99 for "no link".

    33,721 rows carry GRAND_ID 0 (they came from GOODD/GROD, not GRanD) and
    9,881 carry HYLAK_ID 0. Reporting those as the integer zero would make
    every one of them look like a cross-reference to record number zero.
    """
    value = _number(row, key)
    if value is None or value == 0:
        return None
    return int(value)


def _quality_rank(quality: str | None) -> int | None:
    if not quality:
        return None
    return _QUALITY_RANKS.get(quality.strip()[:1])


def _coordinate(row: dict) -> tuple[float, float, str] | None:
    """(lat, lon, coord_source), preferring the published dam location.

    GDW ships two coordinate pairs and they are not the same claim:

      LAT_DAM/LONG_DAM  the structure's published location.  6,113 / 41,145 (14.9%)
      LAT_RIV/LONG_RIV  snapped onto the HydroRIVERS network. 41,145 / 41,145 (100%)

    Measured over the 6,113 rows carrying both: median 0.000 km, p90 0.352 km,
    p99 1.32 km, max 91.8 km. The tail is real -- the worst case is a control
    structure sitting 92 km from the river reach it regulates -- so which pair
    produced the pin travels with the record as `coord_source` instead of being
    flattened away. A reader who cares can see that a marker is a river snap.
    """
    lat = _text(row, "LAT_DAM")
    lon = _text(row, "LONG_DAM")
    source = "dam"
    if lat is None or lon is None:
        lat, lon = _text(row, "LAT_RIV"), _text(row, "LONG_RIV")
        source = "river_snap"
    if lat is None or lon is None:
        return None
    try:
        return float(lat), float(lon), source
    except ValueError:
        return None


def _capacity_phrase(mcm: float | None) -> str | None:
    if mcm is None:
        return None
    if mcm >= 10:
        return f"{mcm:,.0f} Mm³"
    if mcm >= 1:
        return f"{mcm:.1f} Mm³"
    return f"{mcm:.2f} Mm³"


def display_name(row: dict, capacity_mcm: float | None) -> str:
    """A label for a dataset where three quarters of the dams have no name.

    DAM_NAME covers 24.5% globally and 18.8% of the clipped set; RES_NAME adds
    almost nothing (5.1%). The obvious fallback -- name it by its river -- does
    not survive contact with the data: of the 2,885 clipped records with neither
    a dam nor a reservoir name, *none* has a RIVER either, and across the whole
    global file only two rows do. River and name go missing together.

    What is actually available on an unnamed row is DAM_TYPE (100%) and CAP_MCM
    (85.9%), which is also the pair a reader most needs, so that is what the
    fallback says: "Unnamed dam, 85 Mm³". `named` is carried alongside so the
    map can style a generated label differently from a real one.
    """
    dam_name = _text(row, "DAM_NAME")
    if dam_name:
        return dam_name
    reservoir = _text(row, "RES_NAME")
    if reservoir:
        # Not "<reservoir> Dam" -- that would assert a name for the structure
        # that GDW has not published. This asserts only the relationship.
        return f"Dam at {reservoir}"
    noun = (_text(row, "DAM_TYPE") or "barrier").lower()
    capacity = _capacity_phrase(capacity_mcm)
    return f"Unnamed {noun}, {capacity}" if capacity else f"Unnamed {noun}"


def _theatres() -> list[tuple[str, regions.Bounds]]:
    return [
        (key, entry["bounds"])
        for key, entry in regions.REGIONS.items()
        if entry.get("bounds")
    ]


def region_for(lat: float, lon: float) -> str | None:
    """The first theatre box containing the point, or None.

    First match wins, exactly as osm_infra.flatten's first-sweep-wins rule does
    and for the same reason: the theatres overlap (Taiwan Strait sits inside the
    South China Sea box, Sudan inside the Sahel's eastern edge), and a dam in an
    overlap must yield one record rather than one per box -- otherwise the
    layer's own count reports more dams than the map draws, which reads as a
    renderer bug. Iteration order is regions.REGIONS' declaration order, so a
    dam keeps the same theatre from refresh to refresh.
    """
    for key, (south, west, north, east) in _theatres():
        if south <= lat <= north and west <= lon <= east:
            return key
    return None


def parse_barriers(text: str, released: float | None = None) -> list[dict]:
    """GDW's barrier attribute table -> records, clipped to the theatres.

    Read by header name rather than by position -- 71 columns is far too many to
    index into by hand, and GDW's own technical documentation reserves the right
    to add more.

    `released` is when GDW last touched the dataset, not when we downloaded it.
    A dam surveyed in 2024 and fetched today is evidence about 2024, and stamping
    it with the poll time would make a two-year-old file look live.
    """
    out: list[dict] = []
    for row in csv.DictReader(io.StringIO(text)):
        gdw_id = _text(row, "GDW_ID")
        if not gdw_id:
            continue
        placed = _coordinate(row)
        if placed is None:
            continue
        lat, lon, coord_source = placed
        region_key = region_for(lat, lon)
        if region_key is None:
            continue
        capacity_mcm = _number(row, "CAP_MCM")
        quality = _text(row, "QUALITY")
        out.append(
            {
                # Namespaced like osm_infra's `osm:` ids, so a GDW id can never
                # collide with a curated site's or an OSM feature's.
                "id": f"gdw:{gdw_id}",
                "kind": "dam",
                "lat": lat,
                "lon": lon,
                "coord_source": coord_source,
                # Defensible at p99 = 1.3 km between the published dam location
                # and the river snap (see _coordinate): a pin is on the right
                # structure, not necessarily on the right abutment of it. It is
                # not "exact", and `coord_source` says which of the two claims
                # this particular pin rests on.
                "geo_precision": "locality",
                "name": display_name(row, capacity_mcm),
                "named": bool(_text(row, "DAM_NAME") or _text(row, "RES_NAME")),
                "dam_name": _text(row, "DAM_NAME"),
                "reservoir": _text(row, "RES_NAME"),
                "dam_type": _text(row, "DAM_TYPE"),
                "river": _text(row, "RIVER"),
                "country": _text(row, "COUNTRY"),
                "year": _year(row, "YEAR_DAM"),
                "height_m": _number(row, "DAM_HGT_M"),
                # The reason this layer exists: how much water is standing
                # behind the structure, in millions of cubic metres.
                "capacity_mcm": capacity_mcm,
                "area_skm": _number(row, "AREA_SKM"),
                "catchment_skm": _number(row, "CATCH_SKM"),
                "power_mw": _number(row, "POWER_MW"),
                "main_use": _text(row, "MAIN_USE"),
                # GDW's own confidence in the record, kept in its own words
                # ("1: Verified" ... "5: Unreliable"). A publisher that grades
                # its own rows has said something worth passing on.
                "quality": quality,
                "quality_rank": _quality_rank(quality),
                # Provenance back to the datasets GDW absorbed. ORIG_SRC names
                # which one; GRAND_ID answers "is this a GRanD dam" specifically,
                # which is the question anyone with older tooling will ask.
                "orig_src": _text(row, "ORIG_SRC"),
                "grand_id": _link_id(row, "GRAND_ID"),
                "hylak_id": _link_id(row, "HYLAK_ID"),
                "url": _text(row, "URL"),
                "region_key": region_key,
                "time": released,
                "publisher": PUBLISHER,
                "license": LICENSE,
                "attribution": ATTRIBUTION,
            }
        )
    return out


def _iso_to_unix(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


async def _release() -> dict:
    """The article's own account of itself: version, dates, licence, citation.

    Nine kilobytes, and the whole point of fetching it is the `modified_date` it
    carries -- see the change check in start().
    """
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(ARTICLE_URL)
        resp.raise_for_status()
        payload = resp.json()
    return {
        "modified_date": payload.get("modified_date"),
        "published_date": payload.get("published_date"),
        "version": payload.get("version"),
        "doi": payload.get("doi"),
        "title": payload.get("title"),
        "license": (payload.get("license") or {}).get("name"),
        "citation": payload.get("citation"),
    }


async def _download(path: str) -> int:
    """Stream the zip to disk. Never hold it and the CSV in memory at once.

    70 MB of compressed archive plus a 21 MB decompressed table is not a
    catastrophic amount of memory, but this process also holds every other
    layer's live data, and there is no reason to spike it once a week for a file
    that is being read strictly sequentially.
    """
    written = 0
    async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
        async with client.stream("GET", DOWNLOAD_URL) as resp:
            resp.raise_for_status()
            with open(path, "wb") as handle:
                async for chunk in resp.aiter_bytes(DOWNLOAD_CHUNK):
                    written += len(chunk)
                    if written > MAX_DOWNLOAD_BYTES:
                        raise RuntimeError(
                            f"GDW download exceeded {MAX_DOWNLOAD_BYTES} bytes; refusing it"
                        )
                    handle.write(chunk)
    return written


def _read_member(path: str) -> str:
    """The attribute table out of the shapefile zip, as text.

    Blocking: ~21 MB of inflate. Called through asyncio.to_thread so it does not
    stall every other source's polling. ZipFile.read verifies the member's CRC,
    which is the integrity check for a truncated or corrupted download.
    """
    with zipfile.ZipFile(path) as archive:
        names = [n for n in archive.namelist() if n.endswith(CSV_MEMBER_SUFFIX)]
        if not names:
            raise RuntimeError(f"no {CSV_MEMBER_SUFFIX} in the GDW archive")
        raw = archive.read(names[0])
    # The file is valid UTF-8 today (checked: zero replacement characters in
    # 41,145 rows). `replace` is there so that if it ever stops being, one
    # mangled character in one dam name costs that character rather than the
    # whole layer.
    return raw.decode("utf-8-sig", "replace")


def _read_and_parse(path: str, released: float | None) -> list[dict]:
    return parse_barriers(_read_member(path), released)


async def _fetch(released: float | None) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="gdw-") as workdir:
        path = os.path.join(workdir, "GDW_v1_0_shp.zip")
        size = await _download(path)
        log.info("Dams: downloaded %.1f MB from figshare", size / 1e6)
        # Inflate plus parse is ~0.5s of straight CPU over 41,145 rows. Off the
        # event loop, so it does not stall every other source's polling -- and
        # the TemporaryDirectory outlives the await, so the zip is still on disk
        # when the thread reads it and gone by the time this returns.
        return await asyncio.to_thread(_read_and_parse, path, released)


async def start():
    state = registry.register("dams", key_configured=True)  # no key required
    await storage.warm_points(state, "dams", "Dams")
    # What the last successful build was built from. Paired with the warmed
    # rows above this is what lets a restart cost 9 KB instead of 70 MB.
    stored = await storage.reference(RELEASE_REF) or {}
    known = stored.get("modified_date")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            release = await _release()
            if known and release.get("modified_date") == known and state.data:
                # The expected outcome of almost every poll: v1.0 has not moved
                # since 2024-08-28. Still a success, and still recorded as one --
                # a source that goes quiet without a health row shows a green
                # light over frozen data. `state.data` is deliberately not
                # reassigned: the setter bumps the version counter that backs
                # every client's ETag (backend/cache.py), and re-serving
                # identical bytes under a new ETag would make every browser
                # re-download the layer once a week for nothing.
                log.info(
                    "Dams: GDW unchanged since %s, keeping %d records (zip not refetched)",
                    known, len(state.data),
                )
                state.last_success = time.time()
                state.last_error = None
                ok = True
                await storage.record_source_health("dams", len(state.data), True)
            else:
                dams = await _fetch(_iso_to_unix(release.get("modified_date")))
                if not dams:
                    raise RuntimeError("GDW parsed to no records in any theatre")
                state.data = dams
                state.last_success = time.time()
                state.last_error = None
                ok = True
                known = release.get("modified_date")
                log.info(
                    "Dams: %d in the theatres (%d with a published dam location, "
                    "%d named, %d holding 100 Mm3 or more)",
                    len(dams),
                    sum(1 for d in dams if d["coord_source"] == "dam"),
                    sum(1 for d in dams if d["named"]),
                    sum(1 for d in dams if (d["capacity_mcm"] or 0) >= 100),
                )
                await storage.record_snapshot("dams", dams, id_field="id")
                await storage.record_reference(RELEASE_REF, release)
                await storage.record_source_health("dams", len(dams), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Dams fetch failed: %s", exc)
            await storage.record_source_health("dams", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
