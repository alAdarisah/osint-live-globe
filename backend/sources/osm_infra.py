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
# boxes are 20 degrees across.
QUERY_TIMEOUT = 180
# Per feature class, not per region. The distinction is the whole reason the
# query below is shaped the way it is: with one shared cap over a combined
# result set, Russia/Ukraine came back as 725 border-control nodes, 58 military
# areas and 4 airfields -- one noisy class had starved every other one. A cap
# each gives 132 airfields, 285 military areas, 300 power plants and 300
# crossings from the same box.
MAX_PER_FEATURE = 300

# What is asked for, and why each one carries a `["name"]` filter or does not.
#
# `military=airfield` does not: an unnamed military airfield is still an
# airfield, and there are few enough of them that noise is not the risk.
#
# The other three do. Without it, `landuse=military` is dominated by small
# unnamed fragments (perimeter strips, individual firing ranges, sheds inside a
# base already mapped) -- 432 of 600 results in one theatre -- and
# `barrier=border_control` by every unnamed gate post along a frontier.
_FEATURES = (
    ('nwr["military"="airfield"]', "military_airfield"),
    ('nwr["landuse"="military"]["name"]', "military_area"),
    ('nwr["power"="plant"]["name"]', "power_plant"),
    ('nwr["barrier"="border_control"]["name"]', "border_control"),
)


def build_query(bounds: tuple[float, float, float, float]) -> str:
    """Overpass QL for one region box, capped per feature class.

    Each selector is bound to its own named set and given its own `out`, which
    is what makes the cap per class rather than shared -- see MAX_PER_FEATURE.

    `out center` is the other load-bearing part: an area has no coordinate of
    its own, and this asks Overpass to compute one rather than shipping every
    node of every polygon back for us to average.
    """
    south, west, north, east = bounds
    bbox = f"({south},{west},{north},{east})"
    sets = [f".s{i}" for i in range(len(_FEATURES))]
    selectors = "\n".join(
        f"{selector}{bbox}->{name};" for name, (selector, _kind) in zip(sets, _FEATURES)
    )
    outputs = "\n".join(f"{name} out center tags {MAX_PER_FEATURE};" for name in sets)
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
    return None


_KIND_FALLBACK_NAME = {
    "military_airfield": "Military airfield",
    "military_area": "Military area",
    "power_plant": "Power plant",
    "border_control": "Border crossing",
}


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
            "name": tags.get("name") or tags.get("name:en") or _KIND_FALLBACK_NAME[kind],
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
    if await storage.wait_for_warm_pool():
        by_region = await _warm(state)
    consecutive_failures = 0
    while True:
        swept = 0
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
            if swept:
                log.info(
                    "OSM infrastructure: %d sites across %d/%d theatres in %ds",
                    len(state.data), swept, len(_regions_to_sweep()), round(time.time() - started),
                )
                await storage.record_snapshot("osm_infra", state.data, id_field="id")
                await storage.record_source_health("osm_infra", len(state.data), True)
            else:
                raise RuntimeError("no theatre returned data")
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("OSM infrastructure sweep failed: %s", exc)
            await storage.record_source_health("osm_infra", None, False, str(exc))
        consecutive_failures = 0 if swept else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if swept
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
