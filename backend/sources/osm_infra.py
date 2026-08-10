"""Infrastructure as OpenStreetMap has it, kept separate from the curated list.

backend/infrastructure.py holds 207 sites whose coordinates a person checked,
and its docstring commits to exactly that. This module adds thousands more from
OpenStreetMap -- military airfields and installations, power plants, border
crossings -- and it is deliberately a *different layer* rather than more entries
in that one. Blending crowd-sourced geometry into a list that promises
human-checked coordinates would quietly break the promise, and every popup here
names OpenStreetMap so a reader always knows which they are looking at.

Scoped to the conflict theatres in backend/regions.py rather than to the world.
That is not a performance shortcut: Overpass is a shared public service with no
key and a real cost per query, and "every power plant on earth" is both a rude
thing to ask it for and a layer nobody can read.

The sweep is one region at a time with a long pause between, and partial results
are published as they arrive -- a full pass takes on the order of twenty minutes
and there is no reason to hold back the first ten regions while the eleventh
runs.
"""

import asyncio
import logging
import time

import httpx

from backend import regions, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.osm_infra")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# Overpass rejects the default `python-httpx/x.y` User-Agent outright with
# 406 Not Acceptable -- every region failed identically until this was set, with
# nothing in the response body to say why. Naming the caller is also simply what
# a shared public service with no key is owed.
USER_AGENT = "osint-live-globe/1.0 (+https://github.com/)"
REFRESH_INTERVAL = 24 * 3600
FAILURE_RETRY_INTERVAL = 600
# Between regions. Overpass asks callers not to run queries back to back, and a
# full sweep has all day to finish.
BETWEEN_REGIONS_SECONDS = 30
# Overpass' own server-side limit, and ours. Generous because some of these
# boxes are 20 degrees across -- and raised from 180 once the rail selectors
# were added: the count-only query for the Russia/Ukraine box already took 260s
# on the 2026-08-06 probe, and a full data query returning the geometry is
# heavier still, so 180 was guaranteeing a 504 on the largest theatres.
QUERY_TIMEOUT = 600
# Per feature class, not per region. The distinction is the whole reason the
# query below is shaped the way it is: with one shared cap over a combined
# result set, Russia/Ukraine came back as 725 border-control nodes, 58 military
# areas and 4 airfields -- one noisy class had starved every other one. A cap
# each gives 132 airfields, 285 military areas, 300 power plants and 300
# crossings from the same box.
MAX_PER_FEATURE = 300
# Rail points get their own, far higher cap. MAX_PER_FEATURE = 300 exists to
# suppress unnamed *fragments* of the noisy area classes; a railway station is a
# discrete, whole feature, not a fragment, so the same cap would silently drop
# 95% of a real layer -- 5,227 of the 5,527 stations in the Russia/Ukraine box
# alone. Thinning a dense layer is the renderer's job (declutter: thin the
# presentation, never delete the data), so the collector keeps all of them. Kept
# as a large explicit ceiling rather than truly uncapped so one pathological box
# can never make us ask a volunteer service for an unbounded result set.
MAX_RAIL_PER_FEATURE = 25000

# Task 27: mainline rail *geometry*, layered under railways.py's coarse Natural
# Earth fallback so a reader who wants named lines, operators and gauges can
# have them, without losing the global coverage OSM does not have.
#
# Queried separately from every selector above, on its own Overpass request,
# because it needs `out geom` -- every vertex of every way -- rather than
# `out center`, the one computed point per feature the rest of this sweep asks
# for. The point classes' caps bound how many *features* come back; a line's
# byte cost is dominated by how many *vertices* each one carries, which no
# feature cap controls, so RAIL_LINE_TIMEOUT and MAX_RAIL_LINE_WAYS below are
# a floor under the risk, not a promise of a small response.
#
# Restricted to railway=rail|light_rail|narrow_gauge -- the lines a train
# actually runs on -- rather than every railway=* value. Sidings, yard leads,
# platform edges and disused/abandoned/proposed/construction track all carry
# the same tag family and are exactly what made railways.py's own docstring
# reject OSM's *full* rail linework as ~300 MB per theatre-scale sweep (186.8
# MB for Russia/Ukraine alone): this selector is the running-line subset of
# that, and is expected to be a small fraction of it -- but it has not been
# measured against a live Overpass instance, so treat a slow or a failed pass
# on the largest theatres (Russia/Ukraine, the Sahel) as expected, not as a
# bug, until an operator has watched a few real sweeps complete.
RAIL_LINE_TIMEOUT = QUERY_TIMEOUT  # the same ceiling the point sweep already leans on
MAX_RAIL_LINE_WAYS = 6000  # a cap on *ways*, not vertices -- see the note above

# What is asked for, the per-record class it becomes, and its cap.
#
# Why each one carries a `["name"]` filter or does not:
#
# `military=airfield` does not: an unnamed military airfield is still an
# airfield, and there are few enough of them that noise is not the risk.
#
# The three area classes do. Without it, `landuse=military` is dominated by
# small unnamed fragments (perimeter strips, individual firing ranges, sheds
# inside a base already mapped) -- 432 of 600 results in one theatre -- and
# `barrier=border_control` by every unnamed gate post along a frontier.
#
# The four rail classes do NOT, and deliberately: a station/halt/yard is a
# discrete whole feature rather than a fragment, so there is no fragment noise
# for a name to filter out -- an unnamed station is a real station and gets the
# fallback label below. `railway=border` is the emphatic case: only 17 of 101
# such nodes in the Russia/Ukraine box carry a name, so a `["name"]` filter
# would discard 83% of them; what they do carry is a UIC or operator ref, which
# _fallback_name reads instead. (Verified zero overlap with barrier=border_control,
# so there is nothing to dedup between the two.)
#
# Bridges and tunnels are deliberately absent: they are secondary tags on rail
# *ways* (15,181 bridge + 2,384 tunnel segments in Russia/Ukraine alone), and
# forcing 40-metre culverts through `out center` would swamp the stations 3:1.
_FEATURES = (
    ('nwr["military"="airfield"]', "military_airfield", MAX_PER_FEATURE),
    ('nwr["landuse"="military"]["name"]', "military_area", MAX_PER_FEATURE),
    ('nwr["power"="plant"]["name"]', "power_plant", MAX_PER_FEATURE),
    ('nwr["barrier"="border_control"]["name"]', "border_control", MAX_PER_FEATURE),
    ('nwr["railway"="station"]', "railway_station", MAX_RAIL_PER_FEATURE),
    ('nwr["railway"="halt"]', "railway_halt", MAX_RAIL_PER_FEATURE),
    ('nwr["railway"="yard"]', "railway_yard", MAX_RAIL_PER_FEATURE),
    # Node-only: a border marker is a point on the track, never an area.
    ('node["railway"="border"]', "railway_border", MAX_RAIL_PER_FEATURE),
)

_RAILWAY_KINDS = {
    "station": "railway_station",
    "halt": "railway_halt",
    "yard": "railway_yard",
    "border": "railway_border",
}


def build_query(bounds: tuple[float, float, float, float]) -> str:
    """Overpass QL for one region box, capped per feature class.

    Each selector is bound to its own named set and given its own `out`, which
    is what makes the cap per class rather than shared -- and lets the rail
    classes carry a far higher cap than the noisy area classes (see
    MAX_RAIL_PER_FEATURE vs MAX_PER_FEATURE).

    `out center` is the other load-bearing part: an area has no coordinate of
    its own, and this asks Overpass to compute one rather than shipping every
    node of every polygon back for us to average.
    """
    south, west, north, east = bounds
    bbox = f"({south},{west},{north},{east})"
    sets = [f".s{i}" for i in range(len(_FEATURES))]
    selectors = "\n".join(
        f"{selector}{bbox}->{setname};"
        for setname, (selector, _kind, _cap) in zip(sets, _FEATURES)
    )
    outputs = "\n".join(
        f"{setname} out center tags {cap};"
        for setname, (_selector, _kind, cap) in zip(sets, _FEATURES)
    )
    return f"[out:json][timeout:{QUERY_TIMEOUT}];\n{selectors}\n{outputs}"


def _kind_of(tags: dict) -> str | None:
    if tags.get("military") == "airfield":
        return "military_airfield"
    if tags.get("landuse") == "military":
        return "military_area"
    if tags.get("power") == "plant":
        return "power_plant"
    if tags.get("barrier") == "border_control":
        return "border_control"
    railway = tags.get("railway")
    if railway in _RAILWAY_KINDS:
        return _RAILWAY_KINDS[railway]
    return None


_KIND_FALLBACK_NAME = {
    "military_airfield": "Military airfield",
    "military_area": "Military area",
    "power_plant": "Power plant",
    "border_control": "Border crossing",
    "railway_station": "Railway station",
    "railway_halt": "Railway halt",
    "railway_yard": "Railway yard",
    "railway_border": "Railway border crossing",
}


def _fallback_name(kind: str, tags: dict) -> str:
    """A label for a feature OSM left unnamed.

    A plain lookup for every class but `railway=border`, which is the one class
    here that is routinely unnamed yet still identifiable: it carries a UIC
    station reference (`uic_ref`) or an operator's own ref (`ref:RO:CFR`,
    `railway:ref`, ...). Preferring those over the generic "Railway border
    crossing" is what keeps the 83% of border nodes that have no `name` from all
    reading identically on the map.
    """
    if kind == "railway_border":
        uic = tags.get("uic_ref")
        if uic:
            return f"UIC {uic}"
        for key, value in tags.items():
            if value and (key == "ref" or key.startswith("ref:") or key.endswith(":ref")):
                return str(value)
    return _KIND_FALLBACK_NAME[kind]


def parse_overpass(payload: dict, region_key: str) -> list[dict]:
    """An Overpass response -> records.

    Nodes carry lat/lon directly; ways and relations carry a computed `center`
    (see build_query). An element with neither is dropped rather than placed.
    """
    out: list[dict] = []
    for element in (payload or {}).get("elements") or []:
        tags = element.get("tags") or {}
        kind = _kind_of(tags)
        if not kind:
            continue
        center = element.get("center") or {}
        lat = element.get("lat", center.get("lat"))
        lon = element.get("lon", center.get("lon"))
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        osm_type = element.get("type")
        osm_id = element.get("id")
        if not osm_type or osm_id is None:
            continue
        out.append({
            # Prefixed so an OSM id can never collide with a curated site's id.
            "id": f"osm:{osm_type}/{osm_id}",
            "osm_type": osm_type,
            "osm_id": osm_id,
            "kind": kind,
            "lat": float(lat),
            "lon": float(lon),
            "name": tags.get("name") or tags.get("name:en") or _fallback_name(kind, tags),
            "named": bool(tags.get("name") or tags.get("name:en")),
            "operator": tags.get("operator"),
            # power=plant carries its own detail worth keeping; the rest do not.
            "source_tag": tags.get("plant:source") or tags.get("generator:source"),
            "output_mw": _megawatts(tags.get("plant:output:electricity")),
            "region_key": region_key,
        })
    return out


def _megawatts(value: str | None) -> float | None:
    """"1200 MW" / "800000000 W" -> megawatts, or None.

    OSM writes this field freehand and most of the time it is unparseable; a
    number we cannot read is left out rather than guessed at.
    """
    if not value:
        return None
    text = value.strip().upper().replace(" ", "")
    try:
        if text.endswith("MW"):
            return float(text[:-2])
        if text.endswith("GW"):
            return float(text[:-2]) * 1000
        if text.endswith("KW"):
            return float(text[:-2]) / 1000
        if text.endswith("W"):
            return float(text[:-1]) / 1_000_000
    except ValueError:
        return None
    return None


async def _fetch_region(client: httpx.AsyncClient, key: str, bounds) -> list[dict]:
    resp = await client.post(OVERPASS_URL, content=build_query(bounds).encode("utf-8"))
    # Overpass answers "too busy" with 429 and "you exceeded the timeout" with
    # 504, and both are ordinary states on a free shared service rather than
    # faults. Either just means this region keeps whatever it had.
    if resp.status_code in (429, 504):
        raise RuntimeError(f"Overpass busy ({resp.status_code}) for region {key}")
    resp.raise_for_status()
    return parse_overpass(resp.json(), key)


def build_rail_line_query(bounds: tuple[float, float, float, float]) -> str:
    """Overpass QL for one region box's mainline rail geometry.

    One selector, one `out geom` -- unlike build_query above there is nothing
    to union, because this asks for exactly one feature class. `out geom`
    (rather than `out center`) is the point of this query: it returns every
    vertex of every matched way, which is what a polyline needs and a point
    sweep never does.
    """
    south, west, north, east = bounds
    bbox = f"({south},{west},{north},{east})"
    return (
        f"[out:json][timeout:{RAIL_LINE_TIMEOUT}];\n"
        f'way["railway"~"^(rail|light_rail|narrow_gauge)$"]{bbox};\n'
        f"out geom tags {MAX_RAIL_LINE_WAYS};"
    )


def parse_rail_lines(payload: dict, region_key: str) -> list[dict]:
    """An Overpass rail-line response -> attributed [lat, lon] line records.

    `out geom` gives each way its own list of {lat, lon} vertices -- geometry,
    not the `center` the point sweep above reads -- so this is its own parse
    rather than a branch of parse_overpass. A way with fewer than two usable
    vertices is not a line and is dropped, the same rule railways.py's own
    theatre clip applies to Natural Earth's runs. Every record is tagged
    source="osm" here, at the point of collection, so railways.py never has to
    guess provenance back out of the shape of the data -- see its own
    serialize(), which does the same for the Natural Earth half.
    """
    out: list[dict] = []
    for element in (payload or {}).get("elements") or []:
        if element.get("type") != "way":
            continue
        path = [
            [pt["lat"], pt["lon"]]
            for pt in (element.get("geometry") or [])
            if isinstance(pt, dict)
            and isinstance(pt.get("lat"), (int, float))
            and isinstance(pt.get("lon"), (int, float))
        ]
        if len(path) < 2:
            continue
        way_id = element.get("id")
        if way_id is None:
            continue
        tags = element.get("tags") or {}
        out.append({
            # Prefixed so an OSM way id can never collide with anything else
            # riding this document -- same convention parse_overpass uses.
            "id": f"osm:way/{way_id}",
            "source": "osm",
            "path": path,
            "name": tags.get("name") or tags.get("name:en"),
            "operator": tags.get("operator"),
            "gauge": tags.get("gauge"),
            "electrified": tags.get("electrified"),
            "usage": tags.get("usage"),
            "service": tags.get("service"),
            "railway": tags.get("railway"),
            "region_key": region_key,
        })
    return out


async def _fetch_rail_lines(client: httpx.AsyncClient, key: str, bounds) -> list[dict]:
    resp = await client.post(OVERPASS_URL, content=build_rail_line_query(bounds).encode("utf-8"))
    if resp.status_code in (429, 504):
        raise RuntimeError(f"Overpass busy ({resp.status_code}) for rail lines in {key}")
    resp.raise_for_status()
    return parse_rail_lines(resp.json(), key)


def flatten_rail_lines(by_region: dict[str, list[dict]]) -> list[dict]:
    """Every theatre's rail lines as one list, deduplicated by OSM way id.

    Same reasoning as flatten() above: the theatre boxes in regions.py overlap,
    so a way inside an overlap would otherwise be counted, and drawn, once per
    box that swept it.
    """
    seen: dict[str, dict] = {}
    for lines in by_region.values():
        for line in lines:
            seen.setdefault(line["id"], line)
    return list(seen.values())


def serialize_rail_lines(lines: list[dict]) -> dict:
    """The stored document railways.py reads back and merges with Natural Earth.

    Same shape discipline as railways.py's own serialize(): a provenance
    string meant for the popup, not just a bag of lines.
    """
    return {
        "attribution": "OpenStreetMap contributors",
        "provenance": "OpenStreetMap Overpass, railway=rail|light_rail|narrow_gauge, swept daily across the conflict theatres",
        "lines": lines,
    }


def flatten(by_region: dict[str, list[dict]]) -> list[dict]:
    """Every theatre's sites as one list, deduplicated by OSM id.

    The theatres in regions.py overlap -- Taiwan Strait sits inside the South
    China Sea box, Sudan inside the Sahel's eastern edge -- so a feature in an
    overlap is returned by both sweeps under two different `region_key`s. The
    map collapses them anyway (its marker map is keyed by id), but the layer's
    own count would report 529 sites where 514 are drawn, which reads as a bug
    in the renderer rather than as what it is.

    First sweep wins, so a feature keeps the theatre that found it first rather
    than flipping between them from poll to poll.
    """
    seen: dict[str, dict] = {}
    for sites in by_region.values():
        for site in sites:
            seen.setdefault(site["id"], site)
    return list(seen.values())


def _regions_to_sweep() -> list[tuple[str, tuple]]:
    return [
        (key, entry["bounds"])
        for key, entry in regions.REGIONS.items()
        if entry.get("bounds")
    ]


async def _warm(state) -> dict[str, list[dict]]:
    """Seed the per-theatre map from storage, so a sweep never shrinks the layer.

    This is the slowest source here by a wide margin -- a full pass is ~20
    minutes of rate-limited Overpass queries, refreshed daily, and Overpass
    times out often enough that a boot can leave the layer empty for the rest
    of the day. Seeding `by_region` rather than just `state.data` is what makes
    that safe: each theatre is replaced only when its own sweep succeeds, so
    publishing after the first region can't drop the other twelve.
    """
    stored = await storage.entity_latest("osm_infra")
    if not stored:
        return {}
    by_region: dict[str, list[dict]] = {}
    for site in stored:
        by_region.setdefault(site.get("region_key") or "", []).append(site)
    state.data = flatten(by_region)
    log.info(
        "OSM infrastructure: warmed %d stored sites across %d theatres while the sweep runs",
        len(state.data), len(by_region),
    )
    return by_region


async def _warm_rail_lines() -> dict[str, list[dict]]:
    """Seed the rail-line per-theatre map from storage, for the same reason
    _warm above seeds the point one: without it, publishing after the first
    region of a fresh sweep would shrink the merged railways.py document from
    however many theatres the previous sweep covered down to one, for as long
    as the rest of this (now heavier, see RAIL_LINE_TIMEOUT's note) sweep
    takes to catch back up.

    No registry state to fill here -- unlike the point sweep, nothing in this
    process serves rail lines directly; railways.py reads the stored document
    back in the backend process. So this only has to rebuild `by_region`.
    """
    stored = (await storage.reference("railways_osm")) or {}
    lines = stored.get("lines") or []
    if not lines:
        return {}
    by_region: dict[str, list[dict]] = {}
    for line in lines:
        by_region.setdefault(line.get("region_key") or "", []).append(line)
    log.info(
        "OSM rail lines: warmed %d stored ways across %d theatres while the sweep runs",
        len(lines), len(by_region),
    )
    return by_region


async def sweep_forever():
    """Overpass sweeps, for the life of the ingest process.

    Not a scheduled job like the other ingest sources, for two reasons that both
    live in the loop below: a full pass takes ~20 minutes and publishes each
    theatre as it lands rather than at the end, and a failed pass lengthens its
    own retry (FAILURE_RETRY_INTERVAL scaled by consecutive failures). A fixed
    interval would either start a second sweep on top of a running one or throw
    that adaptive retry away -- and Overpass is a volunteer service that asks
    callers not to do either.
    """
    state = registry.ensure("osm_infra", key_configured=True)  # no key required
    # Per region, so one theatre failing keeps its previous copy instead of
    # blanking while the rest of the sweep continues.
    by_region: dict[str, list[dict]] = {}
    # Task 27: the rail-line pass rides the same per-region loop below (see the
    # comment there for why), so it gets the same warm-before-first-sweep
    # treatment as the point pass, and for the identical reason.
    rail_lines_by_region: dict[str, list[dict]] = {}
    if await storage.wait_for_warm_pool():
        by_region = await _warm(state)
        rail_lines_by_region = await _warm_rail_lines()
    consecutive_failures = 0
    while True:
        swept = 0
        rail_lines_swept = 0
        started = time.time()
        try:
            async with httpx.AsyncClient(
                timeout=QUERY_TIMEOUT + 30, follow_redirects=True, headers={"User-Agent": USER_AGENT}
            ) as client:
                for i, (key, bounds) in enumerate(_regions_to_sweep()):
                    if i:
                        await asyncio.sleep(BETWEEN_REGIONS_SECONDS)
                    try:
                        by_region[key] = await _fetch_region(client, key, bounds)
                        swept += 1
                    except Exception as exc:  # noqa: BLE001 - one region is not the sweep
                        log.warning("OSM infrastructure fetch failed for %s: %s", key, exc)
                        continue
                    # Published as the sweep goes rather than at the end: a full
                    # pass takes ~20 minutes and there is no reason to withhold
                    # the first ten theatres while the eleventh runs.
                    state.data = flatten(by_region)
                    state.last_success = time.time()
                    state.last_error = None

                    # The rail-line pass for the same region, right after its
                    # point pass and before the next region's pause -- one more
                    # Overpass request per theatre rather than a second sweep
                    # pacing itself independently against the same server. Its
                    # own try/except: a rail-line timeout on a hard theatre
                    # (see RAIL_LINE_TIMEOUT's note) must cost that region only
                    # its lines, never its points, and must not stop the sweep
                    # moving on to the next theatre.
                    try:
                        rail_lines_by_region[key] = await _fetch_rail_lines(client, key, bounds)
                        rail_lines_swept += 1
                    except Exception as exc:  # noqa: BLE001 - one theatre's lines are not the sweep
                        log.warning("OSM rail lines fetch failed for %s: %s", key, exc)
                        continue
                    # Published per region like the points above. railways.py
                    # (a different process) reads this document back on its own
                    # clock and merges it with Natural Earth -- there is no
                    # registry state to update here, only the stored copy.
                    await storage.record_reference(
                        "railways_osm", serialize_rail_lines(flatten_rail_lines(rail_lines_by_region))
                    )
            if swept:
                log.info(
                    "OSM infrastructure: %d sites across %d/%d theatres in %ds",
                    len(state.data), swept, len(_regions_to_sweep()), round(time.time() - started),
                )
                await storage.record_snapshot("osm_infra", state.data, id_field="id")
                await storage.record_source_health("osm_infra", len(state.data), True)
            else:
                raise RuntimeError("no theatre returned data")
            # Rail lines are additive to the point sweep's own pass/fail verdict
            # above, deliberately: a hard theatre timing out on the (heavier,
            # unbounded-by-vertex-count) line query must not turn a healthy
            # point sweep red. A systemic line failure is still visible -- just
            # as a falling item_count on railways.py's own "railways" health
            # row in the backend, once the merged document stops growing --
            # rather than as a second health row here. See this function's own
            # module-level note on RAIL_LINE_TIMEOUT for why that trade was made.
            if rail_lines_swept:
                log.info(
                    "OSM rail lines: %d ways across %d/%d theatres in %ds",
                    len(flatten_rail_lines(rail_lines_by_region)), rail_lines_swept,
                    len(_regions_to_sweep()), round(time.time() - started),
                )
            else:
                log.warning("OSM rail lines: no theatre returned any this pass")
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("OSM infrastructure sweep failed: %s", exc)
            await storage.record_source_health("osm_infra", None, False, str(exc))
        consecutive_failures = 0 if swept else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if swept
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
