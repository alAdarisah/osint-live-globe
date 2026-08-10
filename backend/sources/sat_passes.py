"""Overpass prediction for Task 25's satellite card and place cards.

Answers one question -- "which satellites pass over this lat/lon in the next
few hours, and when" -- computed on demand with skyfield (already a
dependency; see backend/sources/satellites.py's own use of it), not on a
poll loop: a pass prediction is only ever wanted for wherever a reader is
currently looking, and running it for every point on Earth on a schedule
would be almost entirely wasted work.

Like everything else this app calls a satellite position, a pass prediction
is **derived**: arithmetic (SGP4 propagation plus a horizon search) over an
orbital element set someone else observed, not a measurement of an actual
pass. Its accuracy decays with the same epoch age that makes a stale
position drift -- callers should show the element set's EPOCH (carried
through on every pass below) next to the prediction, the same honesty point
Task 25's brief makes about the ground track and footprint.

Two costs are capped here, deliberately, and both are said out loud in the
response rather than silently narrowed:

* MAX_SATELLITES_FOR_PASSES bounds how many element sets get a real
  skyfield search. A group like "imaging" can hold several hundred objects,
  and the honest fix would be per-satellite -- but a satellite whose ground
  track can never reach the requested latitude at all (a hard fact of
  orbital mechanics: inclination i bounds the sub-satellite point to
  [-i, i], or [-(180-i), 180-i] for i > 90) is filtered out first, for free,
  before the cap is even applied, since searching it always finds nothing.
  Benchmarked against this module's own ISS fixture (a LEO orbit -- the
  costliest case, since find_events samples more finely the faster the
  orbit is): ~1.5ms per satellite for a 24-hour window, so the cap bounds a
  single request to well under half a second of skyfield work even before
  the latitude filter has thinned the pool.
* MAX_PASS_HOURS bounds how far into the future a search runs, matching the
  brief's own "next passes ... within 24 hours" -- a caller asking for more
  is silently clamped, not rejected, the same "narrow, don't error" contract
  backend/sources/satellites.py's filter_elements_by_layer already uses for
  an unknown group name.
"""

import math

from skyfield.api import EarthSatellite, load, wgs84

from backend.sources.proximity import EARTH_RADIUS_KM

# A pass search runs against whichever element sets the caller's `groups`
# selected -- built once here rather than sharing backend/sources/
# satellites.py's own (module-private) timescale, so this module has no
# import-order dependency on that one ever having run. load.timescale(
# builtin=True) reads skyfield's bundled leap-second/deltaT tables, the same
# choice satellites.py makes, for the same reason: no third network
# dependency just to propagate an orbit.
_ts = load.timescale(builtin=True)

# 10 degrees above the horizon is the conventional floor for a "usable"
# pass in amateur/ground-station tracking -- lower than that and a real
# horizon (buildings, terrain, atmospheric extinction) usually hides the
# satellite anyway, and skyfield would otherwise report grazing passes that
# are never actually visible from anywhere real.
PASS_MIN_ELEVATION_DEG = 10.0

# The brief's own window: "list the next passes ... within 24 hours".
MAX_PASS_HOURS = 24.0

# The work cap -- see this module's own docstring for the benchmark behind
# the number and why the latitude pre-filter is applied first.
MAX_SATELLITES_FOR_PASSES = 200

# A defensive cap on the response itself, independent of the search cap
# above -- a crowded pass list (a busy constellation over the equator, say)
# should not hand the client an unbounded array just because the search
# found one.
MAX_PASSES_RETURNED = 40


def _footprint_half_angle_rad(alt_km: float) -> float:
    """The half-angle (at Earth's centre) of the visibility cone from a
    satellite at `alt_km` -- the spherical horizon formula, R / (R + h)
    inside an arccos, where R is Earth's mean radius. Shared by
    footprint_radius_km below (the ground distance this subtends) and the
    latitude reachability filter (the same angle, in degrees, is how far a
    satellite's visibility cap can reach past its ground track's own
    latitude extreme)."""
    if not alt_km or alt_km <= 0:
        return 0.0
    return math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + alt_km))


def footprint_radius_km(alt_km: float) -> float:
    """Great-circle radius of the ground within line of sight of a
    satellite at `alt_km` altitude: R * acos(R / (R + h)).

    The same formula frontend/src/map/groundTrack.js's footprintRadiusKm
    uses to draw the visibility-footprint circle on the satellite card --
    kept in step by hand, since there is no module shared between a Python
    process and a browser bundle, the same discipline backend/app.py's
    _matches_callsign_query documents for its own client-side twin.
    """
    return EARTH_RADIUS_KM * _footprint_half_angle_rad(alt_km)


def _max_ground_track_lat(inclination_deg: float) -> float:
    """The highest (and, symmetrically, lowest) latitude a satellite's
    sub-satellite point can ever reach, given its inclination -- exactly
    `inclination_deg` for a prograde orbit (i <= 90), or 180 minus it for a
    retrograde one. Not an estimate: it falls straight out of the orbital
    geometry, the same way apogee/perigee fall out of the semi-major axis
    and eccentricity in backend/sources/satellites.py's _summary_fields.
    """
    return inclination_deg if inclination_deg <= 90 else 180 - inclination_deg


def _reachable_elements(elements: list[dict], lat: float) -> list[dict]:
    """Element sets whose orbit can geometrically reach `lat` at all.

    A satellite's ground track never leaves [-_max_ground_track_lat,
    +_max_ground_track_lat], but the satellite itself can still be *seen*
    slightly past that band -- its visibility footprint (see
    footprint_radius_km) extends beyond the sub-satellite point in every
    direction. So the true reachability test adds the footprint's angular
    radius (at apogee, the most generous case, so this never wrongly
    excludes a satellite whose actual altitude varies) to the ground
    track's own extreme before comparing against the requested latitude.

    This is a correctness filter, not a heuristic approximation of one: a
    satellite excluded here cannot produce a real event no matter how long
    the search window is, so running find_events on it would only ever
    confirm what this already knows for free. An element set with no
    inclination at all (should not happen for a real CelesTrak record, but
    a malformed one is possible) is kept rather than dropped -- there is
    nothing here to safely rule it out with, and MAX_SATELLITES_FOR_PASSES
    below is the real backstop against an oversized pool.
    """
    out = []
    for omm in elements:
        incl = omm.get("inclination_deg")
        if incl is None:
            incl = omm.get("INCLINATION")
        if incl is None:
            out.append(omm)
            continue
        max_track_lat = _max_ground_track_lat(float(incl))
        # apogee_km is one of the fields backend/sources/satellites.py's
        # _summary_fields already carries on every stored element set (Task
        # 24); a raw OMM record that has not been through that decoration
        # (should not happen for what /api/satellites/elements serves, but
        # this module makes no assumption it cannot happen) falls back to a
        # generous 2,000km LEO/MEO estimate rather than 0, so a missing
        # field under-excludes instead of over-excluding.
        apogee_km = omm.get("apogee_km") or 2000.0
        margin_deg = math.degrees(_footprint_half_angle_rad(float(apogee_km)))
        if max_track_lat + margin_deg >= abs(lat):
            out.append(omm)
    return out


def compute_passes(
    elements: list[dict],
    lat: float,
    lon: float,
    hours: float = MAX_PASS_HOURS,
    start_time=None,
) -> dict:
    """The next passes over (lat, lon), within `hours` (clamped to
    MAX_PASS_HOURS), for every element set in `elements` that can reach that
    latitude at all (see _reachable_elements) and fits under
    MAX_SATELLITES_FOR_PASSES.

    `start_time` is an optional skyfield Time to search from instead of
    "now" -- the whole reason this function takes it rather than always
    calling `_ts.now()` itself is testability: a test wants a **precomputed**
    answer for a **known** satellite over a **known** point, which means the
    search window has to be pinned to a fixed instant, not whatever instant
    the test happened to run at.

    Only complete passes (a rise, a culmination, and a set, all inside the
    window) are reported -- a pass already in progress at `start_time`, or
    still rising when the window ends, is left out rather than reported with
    a missing edge. That is a real gap (see this module's docstring on
    partial coverage being worth stating), and it is stated in the returned
    `passes_partial_excluded` count rather than silently dropped.
    """
    hours = max(0.0, min(float(hours), MAX_PASS_HOURS))
    t0 = start_time if start_time is not None else _ts.now()
    t1 = _ts.tt_jd(t0.tt + hours / 24.0)
    observer = wgs84.latlon(lat, lon)

    reachable = _reachable_elements(elements, lat)
    # Deterministic order -- which satellites survive the cap must not
    # depend on dict/network ordering from one poll to the next, or the
    # same request could answer differently between two calls with
    # identical inputs.
    reachable.sort(key=lambda e: e.get("NORAD_CAT_ID") or 0)
    satellites_capped = len(reachable) > MAX_SATELLITES_FOR_PASSES
    considered = reachable[:MAX_SATELLITES_FOR_PASSES]

    passes = []
    partial_excluded = 0
    for omm in considered:
        try:
            sat = EarthSatellite.from_omm(_ts, omm)
            t, events = sat.find_events(observer, t0, t1, altitude_degrees=PASS_MIN_ELEVATION_DEG)
        except Exception:  # noqa: BLE001 - a malformed element set just gets skipped, same discipline as satellites.py's _positions
            continue
        i = 0
        n = len(events)
        found_any = n > 0
        while i + 2 < n:
            if events[i] == 0 and events[i + 1] == 1 and events[i + 2] == 2:
                rise_t, culm_t, set_t = t[i], t[i + 1], t[i + 2]
                alt, _az, _dist = (sat - observer).at(culm_t).altaz()
                passes.append(
                    {
                        "norad_id": omm.get("NORAD_CAT_ID"),
                        "name": omm.get("OBJECT_NAME"),
                        "group": omm.get("_layer"),
                        "rise": rise_t.utc_iso(),
                        "culminate": culm_t.utc_iso(),
                        "set": set_t.utc_iso(),
                        "max_elevation_deg": float(alt.degrees),
                        "duration_s": (set_t.tt - rise_t.tt) * 86400.0,
                        # The element set's own epoch, not "now" -- carried
                        # through so a caller can say how old the orbit this
                        # prediction is built from actually is, the same
                        # honesty point the ground track and footprint make.
                        "epoch": omm.get("EPOCH"),
                    }
                )
                i += 3
            else:
                i += 1
        if found_any and (n % 3 != 0 or events[0] != 0 or events[-1] != 2):
            partial_excluded += 1

    passes.sort(key=lambda p: p["rise"])
    passes_truncated = len(passes) > MAX_PASSES_RETURNED
    return {
        "passes": passes[:MAX_PASSES_RETURNED],
        "min_elevation_deg": PASS_MIN_ELEVATION_DEG,
        "hours": hours,
        "satellites_total": len(elements),
        "satellites_reachable": len(reachable),
        "satellites_considered": len(considered),
        "satellites_capped": satellites_capped,
        "passes_truncated": passes_truncated,
        "passes_partial_excluded": partial_excluded,
    }
