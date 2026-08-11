import asyncio
import logging
import math
import time

import httpx
from skyfield.api import EarthSatellite, load

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.satellites")

# CelesTrak's GP (General Perturbations) API: real, keyless, documented --
# confirmed live against the actual endpoint. "stations" (ISS, Tiangong, ...)
# and "military" (CelesTrak's own curated "Miscellaneous Military" group,
# e.g. SAR-Lupe reconnaissance satellites) are both real, publicly
# maintained CelesTrak groups, not a guess.
GP_URL = "https://celestrak.org/NORAD/elements/gp.php"

# Server-propagated groups: SGP4'd here, every ten seconds, exactly as
# before this task. Kept deliberately small -- see ELEMENT_LAYER_GROUPS
# below for everything else this module now also tracks.
GROUPS = ["stations", "military"]
ELEMENTS_REFRESH_INTERVAL = 6 * 3600  # orbital elements barely change this often

# Everything else this module tracks: stored OMM element sets only, never
# propagated here. The browser propagates them with satellite.js (see
# frontend/src/map/satPropagate.js) -- the server cannot SGP4 eight thousand
# objects every ten seconds, and the browser only ever has to compute the
# handful actually on screen, once, inside its own frame budget.
#
# Keyed by the control panel's layer toggle, not by CelesTrak's own group
# name: one toggle ("navigation") can span several CelesTrak groups, and a
# reader turning it on should get all of them from the one request
# /api/satellites/elements serves, not four separate ones. `active`
# (11,000 objects) is deliberately not offered under any toggle -- there is
# no view of this map it would improve, and a reader who wants literally
# everything CelesTrak tracks already has celestrak.org.
#
# Checked live against gp.php, not copied from the task brief that named
# them: CelesTrak has no "noaa" group (GROUP=noaa 404s -- "GROUP=noaa not
# found"), unlike every other group named below, which all resolved to real
# data. NOAA's own weather satellites already sit inside the "weather"
# group, so nothing this map draws is missing for it -- the weather toggle
# is "weather" + "goes" only.
ELEMENT_LAYER_GROUPS = {
    "navigation": ["gps-ops", "galileo", "glo-ops", "beidou"],
    "weather": ["weather", "goes"],
    "imaging": ["resource", "sarsat", "spire", "planet"],
    "science": ["science"],
    "geo": ["geo"],
    "starlink": ["starlink"],
    "oneweb": ["oneweb"],
}

# CelesTrak group name -> our layer key, built once so the fetch loop below
# is one flat pass over real CelesTrak groups rather than a nested loop, and
# so a group can never end up double-counted under two toggles.
_CELESTRAK_GROUP_TO_LAYER = {
    ct_group: layer_key
    for layer_key, ct_groups in ELEMENT_LAYER_GROUPS.items()
    for ct_group in ct_groups
}

# How often the browser re-runs SGP4 for a layer's objects -- not how often
# it fetches them (elements barely change; see ELEMENTS_REFRESH_INTERVAL
# above, which governs every group here). A few dozen to a couple hundred
# navigation/weather/science satellites is cheap to recompute every ten
# seconds, the same cadence the server-side stations/military groups already
# use. Several hundred to several thousand (imaging, geo, and especially the
# two mega-constellations) is not a cost a single frame budget should carry
# every ten seconds, so those layers recompute a true SGP4 fix once a minute
# and the browser interpolates the drawn position between fixes in between
# -- see satPropagate.js's interpolate().
_LARGE_LAYER_GROUPS = {"imaging", "geo", "starlink", "oneweb"}
SMALL_CADENCE_SECONDS = 10
LARGE_CADENCE_SECONDS = 60


def cadence_seconds(layer_key: str) -> int:
    """How often the browser should recompute (not re-fetch) `layer_key`'s positions.

    A key this table has never heard of gets the conservative (large)
    cadence rather than the cheap one -- a typo here should never end up
    quietly asking a browser to SGP4 thousands of objects six times as often
    as intended.
    """
    is_known_small = layer_key in ELEMENT_LAYER_GROUPS and layer_key not in _LARGE_LAYER_GROUPS
    return SMALL_CADENCE_SECONDS if is_known_small else LARGE_CADENCE_SECONDS


# builtin=True uses skyfield's bundled leap-second/deltaT tables instead of
# reaching out to a third (unverified) network source just to propagate an
# orbit -- this feature's only external dependency stays the CelesTrak URL
# above.
_ts = load.timescale(builtin=True)


async def _fetch_group(client: httpx.AsyncClient, group: str) -> list[dict]:
    resp = await client.get(GP_URL, params={"GROUP": group, "FORMAT": "json"})
    resp.raise_for_status()
    records = resp.json()
    for r in records:
        r["_group"] = group
    return records


async def _fetch_elements() -> list[dict]:
    async with httpx.AsyncClient(timeout=20) as client:
        out = []
        for group in GROUPS:
            try:
                out.extend(await _fetch_group(client, group))
            except Exception as exc:  # noqa: BLE001 - one bad group shouldn't sink the rest
                log.warning("CelesTrak group fetch failed (%s): %s", group, exc)
        return out


def _summary_fields(omm: dict, sat: EarthSatellite) -> dict:
    """The CelesTrak GP fields this collector used to just discard, plus the
    handful of numbers that are honest arithmetic over them.

    `intl_designator` and `epoch` are CelesTrak's own reported fields
    (OMM's OBJECT_ID and EPOCH), passed through exactly as CelesTrak sent
    them rather than round-tripped through sgp4's own `intldesg` -- that
    field exists to reproduce a TLE's abbreviated line-1 form (2-digit year,
    no dash, e.g. "98067A") and is not the string CelesTrak actually
    reported ("1998-067A"); using it here would have quietly changed what
    this field says without CelesTrak ever having said anything new.
    `period_min`/`apogee_km`/`perigee_km` are derived -- not from a
    hand-rolled Earth radius/GM constant, but read straight off the parsed
    sgp4 model skyfield just built to propagate this object (`sat.model`),
    so these numbers are guaranteed to agree with the position this module
    (or the browser's satellite.js, propagating the same elements) actually
    computes, rather than coming from a second formula that could quietly
    drift from it. `launch_year` is derived too, and only a year: the
    international designator's first four digits name the launch year, not
    a day, so a full calendar launch date is not something this data can
    honestly state.
    """
    m = sat.model
    intl_designator = (omm.get("OBJECT_ID") or "").strip() or None
    launch_year = int(intl_designator[:4]) if intl_designator and intl_designator[:4].isdigit() else None
    period_min = (2 * math.pi / m.no_kozai) if m.no_kozai else None
    return {
        "intl_designator": intl_designator,
        "launch_year": launch_year,
        "inclination_deg": omm.get("INCLINATION"),
        "period_min": period_min,
        "apogee_km": m.alta * m.radiusearthkm,
        "perigee_km": m.altp * m.radiusearthkm,
        "epoch": omm.get("EPOCH"),
    }


def _positions(elements: list[dict]) -> list[dict]:
    now = _ts.now()
    out = []
    for omm in elements:
        try:
            sat = EarthSatellite.from_omm(_ts, omm)
            geocentric = sat.at(now)
            geo = geocentric.subpoint()
        except Exception:  # noqa: BLE001 - a malformed element set just gets skipped
            continue
        # Speed, not a velocity vector: Task 25's card wants one number, and
        # the vector's three ECI components would mean nothing to a reader
        # on their own. Read off the same `sat.at(now)` call already made
        # for the position above rather than a second propagation -- SGP4
        # already produced the velocity vector alongside the position, it
        # was just never read before now.
        vx, vy, vz = geocentric.velocity.km_per_s
        out.append(
            {
                "norad_id": omm.get("NORAD_CAT_ID"),
                "name": omm.get("OBJECT_NAME"),
                "group": omm.get("_group"),
                # skyfield/numpy return np.float64 -- plain json.dumps (what
                # FastAPI's default JSONResponse uses) can't serialize that.
                "lat": float(geo.latitude.degrees),
                "lon": float(geo.longitude.degrees),
                "alt_km": float(geo.elevation.km),
                "velocity_km_s": float((vx**2 + vy**2 + vz**2) ** 0.5),
                **_summary_fields(omm, sat),
            }
        )
    return out


def _decorate_element(omm: dict) -> dict:
    """The raw OMM element set -- what satellite.js needs to propagate it in
    the browser -- plus its summary fields -- what a card wants to show,
    e.g. Task 25's. Computed once here, at the six-hourly element refresh,
    rather than per request or in the browser: the browser's job is running
    SGP4 for the objects currently on screen, not re-deriving apogee/perigee
    for however many thousand a layer holds.

    An element set skyfield's own build cannot parse is passed through
    unsummarized rather than dropped -- that is not proof satellite.js can't
    parse it either, and the browser gets its own chance at it.
    """
    try:
        sat = EarthSatellite.from_omm(_ts, omm)
    except Exception:  # noqa: BLE001
        return {**omm, "_layer": _CELESTRAK_GROUP_TO_LAYER.get(omm.get("_group"))}
    return {
        **omm,
        "_layer": _CELESTRAK_GROUP_TO_LAYER.get(omm.get("_group")),
        **_summary_fields(omm, sat),
    }


async def _fetch_extra_elements() -> list[dict]:
    """One HTTP GET per CelesTrak group behind the client-propagated layers.

    Returned as one flat list rather than grouped by layer key: the grouping
    happens at read time in filter_elements_by_layer, the same "store once,
    narrow per request" split _cached_source_response already uses for
    region/bbox elsewhere in this app. Same per-group failure discipline as
    _fetch_elements above -- one bad group does not sink the rest.
    """
    async with httpx.AsyncClient(timeout=20) as client:
        out = []
        for ct_group in _CELESTRAK_GROUP_TO_LAYER:
            try:
                records = await _fetch_group(client, ct_group)
            except Exception as exc:  # noqa: BLE001 - one bad group shouldn't sink the rest
                log.warning("CelesTrak group fetch failed (%s): %s", ct_group, exc)
                continue
            out.extend(_decorate_element(r) for r in records)
        return out


def filter_elements_by_layer(elements: list[dict], layer_keys) -> list[dict]:
    """The elements endpoint's group filter: only the records whose toggle is
    in `layer_keys`.

    An empty or entirely-unknown set answers empty rather than "everything"
    -- a reader who has not asked for imaging/starlink/etc. should never
    pull thousands of element sets by omission, only by actually turning the
    layer on. Unknown keys are silently dropped from the request rather than
    rejected, same "narrowing, not erroring" contract
    _matches_callsign_query documents in backend/app.py for a bad callsign.
    """
    wanted = set(layer_keys) & set(ELEMENT_LAYER_GROUPS)
    if not wanted:
        return []
    return [e for e in elements if e.get("_layer") in wanted]


async def start():
    state = registry.register("satellites", key_configured=True)  # no key required
    # Registered from this same module/task as "satellites" above -- one
    # background loop, two registry entries, the same pattern
    # digitraffic_rail.py (rail_live/rail_stations) and gdelt.py use for more
    # than one related feed. Positions are never computed for this one; see
    # filter_elements_by_layer and frontend/src/map/satPropagate.js.
    elements_state = registry.register("satellite_elements", key_configured=True)
    elements: list[dict] = []
    extra_elements: list[dict] = []
    last_elements_fetch = 0.0
    # The element sets are the collected data here; the positions below are
    # arithmetic over them, recomputed every ten seconds. So the elements are
    # what gets stored and restored, and the positions never are -- a stored
    # position is a claim about where a satellite was, which is wrong within
    # the minute and must not be drawn as if it were current.
    #
    # Orbital elements decay slowly enough that yesterday's set still
    # propagates usefully, so a boot with Celestrak unreachable keeps tracking
    # instead of showing nothing.
    if await storage.wait_for_warm_pool():
        stored = await storage.reference("satellite_elements")
        if stored:
            elements = stored
            log.info("Satellites: warmed %d stored element sets while the fetch runs", len(elements))
        stored_extra = await storage.reference("satellite_elements_extra")
        if stored_extra:
            extra_elements = stored_extra
            elements_state.data = extra_elements
            elements_state.last_success = time.time()
            log.info(
                "Satellites: warmed %d stored client-propagated element sets while the fetch runs",
                len(extra_elements),
            )
    while True:
        try:
            if time.time() - last_elements_fetch >= ELEMENTS_REFRESH_INTERVAL or not elements:
                try:
                    elements = await _fetch_elements()
                    extra_elements = await _fetch_extra_elements()
                    last_elements_fetch = time.time()
                    await storage.record_reference("satellite_elements", elements)
                    await storage.record_reference("satellite_elements_extra", extra_elements)
                    elements_state.data = extra_elements
                    elements_state.last_success = time.time()
                    elements_state.last_error = None
                except Exception as exc:  # noqa: BLE001 - the sets in hand still propagate/serve
                    # Only fatal when there is nothing to propagate at all.
                    # Otherwise keep computing from the elements we have: they
                    # decay slowly, and a blank sky is a worse answer than a
                    # slightly stale one. Same discipline as hazards.py's
                    # weekly volcano report inside its 5-minute quake loop.
                    if not elements:
                        raise
                    log.warning(
                        "Satellite element refresh failed; propagating the %d sets in hand: %s",
                        len(elements), exc,
                    )
                    elements_state.last_error = str(exc)
            state.data = _positions(elements)
            state.last_success = time.time()
            state.last_error = None
            log.info(
                "Satellites: %d tracked (%d element sets), %d client-propagated across %d groups",
                len(state.data), len(elements), len(extra_elements), len(ELEMENT_LAYER_GROUPS),
            )
            # Deliberately no record_snapshot here. The elements above are what
            # was collected; these positions are arithmetic over them, recomputed
            # every 10s, and storing them wrote 471k history rows (77 MB inside
            # the 3-day window) that nothing ever read -- /api/replay carries no
            # satellite layer, and this source warms from the elements, never
            # from stored positions. A replay of the sky, if it is ever wanted,
            # propagates the stored elements to the scrubbed moment; it does not
            # need a log of answers we can recompute exactly. Same reasoning
            # covers the extra_elements groups above -- satellite.js propagates
            # those client-side, and nothing here ever computes a position for
            # them to begin with.
            await storage.record_source_health("satellites", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Satellite propagation failed: %s", exc)
            await storage.record_source_health("satellites", None, False, str(exc))
        await asyncio.sleep(10)
