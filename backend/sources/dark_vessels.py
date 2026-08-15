"""Two things AIS shows by *not* showing them.

Every other source in this package fetches something. This one fetches nothing:
it reads the position history this backend has already recorded (see
backend/storage.py) and looks for two patterns that only exist in the gaps.

**Going dark.** A vessel stops transmitting for hours and reappears somewhere
else. Switching a transponder off is a deliberate act and the classic
sanctions-evasion signature, and the implied speed across the gap is the tell:
if the reappearance implies 40 knots, the track that came back is not the track
that left.

**Ship-to-ship transfer.** Two vessels sitting alongside each other at almost
zero speed, well away from any port. That is how cargo changes hulls without
either one visiting a terminal.

Both are *inferences*, and neither is safe to present as a detection:

- An AIS receiver outage looks exactly like a transponder switched off. That is
  guarded against explicitly below (see `_feed_was_healthy`) by checking whether
  the whole feed was quiet over the same window -- but coverage is thin far
  from shore and no guard fixes that.
- Two ships close together may be passing, rafted for a pilot transfer, or
  sitting in an anchorage. Ports are excluded (see `port_index`); anchorages
  are not a port index's business, and no list here holds them.

So every record carries `inferred: True`, states its own evidence, and the
layer renders with the dashed treatment the map already uses for anything whose
position or meaning is uncertain. This module is allowed to say "worth a look".
It is not allowed to say "detected".

**Someone else's record of the same hull.** Records also carry `gfw_prior`,
which is what Global Fishing Watch has logged about that MMSI (see
backend/sources/gfw_gaps.py). It is a prior and not a corroboration, and the
distinction is forced by arithmetic rather than caution: GFW's batch runs five
or more days behind and the history this module reads is three days deep, so
the two cannot be describing the same event. A prior answers "has this hull
gone dark deliberately before", which is worth knowing and is not evidence
about tonight. Nothing here upgrades an inference on the strength of one.

**Reachability: where the vessel could be, not just where it went quiet.**

`position_gaps` (see backend/storage.py) only ever returns a *closed* gap --
a row on both sides of the silence -- so by the time an `ais_gap` record
exists here, the resumption point is already known. That is what makes a
reachability region worth adding even though the answer is sitting right
there on the same record: it turns two bare pins into a claim a reader can
check by eye ("the ship reappeared inside/outside the region the model would
have drawn"), and it is what makes the model self-scoring (`prediction_error_km`
below), which is the only honest way this project ships an inference like
this at all -- a model that never states its own error is not one a reader
can decide to trust.

The model, stated in full so a reader can disagree with one specific number
rather than reverse-engineer the code:

  1. **Dead reckoning** (`dr_lat`/`dr_lon`). The last known position, carried
     forward at the last known course and speed (both read off the AIS fix
     immediately *before* the gap started -- see `last_known_speed_kn` /
     `last_known_course_deg` -- never off the hull's current state, which by
     construction already reflects whatever happened after it reappeared) for
     exactly the gap's own duration. Missing course or a stationary hull means
     no forward displacement is assumed; the point stays at the last fix
     rather than guessing a heading. This is the single best-guess point, not
     the region, and it is deliberately never land-masked (see point 4) --
     `prediction_error_km` measures the model's own raw answer against
     reality, and masking it first would be scoring a corrected answer
     instead.
  2. **Outer reach**, `reach_radius_km` = v_max x t. v_max is this hull's own
     95th-percentile speed over its retained AIS history immediately before
     it went dark (REACH_MIN_SPEED_SAMPLES readings or more required),
     falling back to a per-cargo-class ceiling (CLASS_MAX_SPEED_KN, sorted by
     backend.refine.vessel_profile.cargo_class) when there are too few. Which
     one was used travels on the record as `speed_basis`.
  3. **Contour shape.** Three nested ellipses (50/80/95%), centred on the
     dead-reckoned point and oriented along the last known course:
       - *Along-track* half-width grows *linearly* with elapsed time, scaled
         by this hull's own observed speed *variance* over the same window
         v_max came from. The assumption: distance uncertainty compounds the
         way distance itself does (distance = speed x time, so
         stdev(distance) ~ stdev(speed) x t), not that the vessel is assumed
         to have sped up or slowed down in any particular way.
       - *Cross-track* half-width grows as k*sqrt(t) -- a random-walk
         (diffusion) assumption for heading drift, deliberately not a
         constant turning rate: a vessel evading tracking is modelled as
         wandering off its own course rather than committing to a new one, so
         uncertainty compounds sublinearly, the way a random walk's variance
         does. k is REACH_CROSS_TRACK_FRACTION (0.3) times the hull's own
         v_max -- a judgement call with no external source behind it, not a
         measurement, and the one number in this model most worth arguing
         with (see that constant's own comment). REACH_CROSS_TRACK_FRACTION
         is the knob to move.
       - Both axes are scaled by the *same* two-sided normal quantile per
         band (CONTOUR_BANDS: 0.6745/1.2816/1.9600 for 50/80/95%), which is
         *why* the bands nest by construction: multiplying both axes of one
         ellipse by a larger number can only enclose the smaller ellipse,
         never cross it.
       - **The reach_radius_km bound is enforced globally, not per band, and
         not measured from the dead-reckoned centre.** An earlier version of
         this module capped each band's own along/cross half-width at
         `reach_radius_km`, which bounds distance *from the dead-reckoned
         point* -- and the dead-reckoned point already sits `travel_km` away
         from the last known fix, so a vertex could land at
         `travel_km + reach_radius_km` from where the vessel actually went
         dark, past the ceiling the model claims never to cross. The fix:
         `travel_km` itself is capped at `reach_radius_km` (a single
         last-known-speed reading cannot imply more distance than the hull's
         own top-speed ceiling allows), and the raw ellipse's *base* axes are
         scaled by one shared factor, derived from the triangle inequality
         (`distance(origin, vertex) <= travel_km + distance(centre, vertex)`,
         and the farthest any point on an ellipse can sit from its own centre
         is its semi-major axis), so that the 95% band's own worst-case
         vertex cannot exceed `reach_radius_km` from the last known fix
         before land masking is even applied. One shared factor for all three
         bands, not a per-vertex clamp after the fact: shrinking the same
         shape uniformly cannot change which band nests inside which, where
         clamping each of three already-built vertices independently could
         (and very nearly did -- see the land-masking note below for the
         mechanism, and test_dark_reach.py for a coastline that forces both
         corrections and asserts nesting survives them).
  4. **Land masking.** A contour vertex the ellipse math places on dry land is
     walked back toward the dead-reckoned centre until it first crosses into
     a Task 4 water polygon (water_marine, water_lakes; water_rivers is
     linework, not area, and is not consulted). A cheap correction toward one
     interior point, not a real nearest-shore search -- a contour that is
     mostly on land and only clips a strait is pulled in from every direction
     toward the same centre rather than modelled specially.

     **The search runs once per bearing, against the 95% band's own vertex,
     never once per band.** All three bands' vertices at a given angle are
     collinear with the dead-reckoned centre (same direction, different
     radius, because all three are the same base ellipse scaled by the
     band's own quantile) -- so walking that one shared ray and capping every
     band's own raw radius at whatever water boundary the walk finds
     (`min(band's own radius, the shared boundary)`) can only ever preserve
     the three bands' original order, never invert it. Searching once per
     band instead -- the first version of this code did -- samples the
     *same* physical ray at three different step sizes (each band's search
     divides its own, differently-sized segment into LAND_MASK_STEPS equal
     pieces), which can and did produce a narrower band landing on a
     *different* water crossing than a wider one at the same bearing,
     putting the 50% ring outside the 80% ring on an ordinary strait shape.

     **The walk samples every step from the centre outward, not only the
     endpoint.** Testing only the 95% band's own vertex -- an earlier version
     of this fix did exactly that -- missed an island sitting *between* the
     centre and that vertex on the same bearing: open water on both sides of
     it passes an endpoint-only check, and the search that would have found
     it never runs. `_ray_water_bound` now walks from the centre outward in
     LAND_MASK_STEPS (12) equal steps and stops at the first non-water
     sample, so land nearer than the outer vertex on the same ray is caught
     regardless of what the vertex itself sits on. `masked_by_land` is set
     whenever that walk stopped short of the full ray, which is also exactly
     when any band's vertex could have been pulled in. If neither water
     document has landed yet (a fresh deployment, before
     backend/sources/water_bodies.py's first sweep), masking is skipped
     rather than run against an empty mask -- an empty WaterMask would
     otherwise read as "the whole world is land" and pull every vertex down
     to a single point.

     **What this still does not claim.** LAND_MASK_STEPS samples per bearing
     means a coastline feature narrower than roughly `outer_km / 12` along
     one ray can fall between two samples and go undetected -- the same
     coarse-sampling limitation that already applies *between* the
     CONTOUR_VERTICES (48) bearings themselves, now also true *within* one.
     This is a per-bearing walk toward one interior point, not a true
     shoreline search or a polygon clip of the ellipse against the water
     mask; a coastline with detail finer than either sampling grid can still
     produce a locally jagged edge no per-vertex correction catches.
  5. **Destination prior.** When the hull's own declared destination -- as
     broadcast before it went dark, never whatever it has since retyped --
     resolves to an indexed port (see `destination_index`) by an exact,
     normalised match, the ellipse's own bearing is nudged toward the great
     circle from the dead-reckoned point to that port, blended in at
     DESTINATION_PRIOR_WEIGHT (0.15, hard-capped at
     MAX_DESTINATION_PRIOR_WEIGHT). Low and capped on purpose: a destination
     string is a plan a crew typed in before departure, not a live track, and
     a hull that has gone dark is exactly the hull most likely to be doing
     something other than what it declared. `destination_prior_used` carries
     the port and the weight actually applied, or None.
  6. **Self-scoring.** Because the record already carries where the vessel
     actually resumed (point 1's whole premise), `prediction_error_km` is the
     great-circle distance between the unmasked dead-reckoned point and the
     real resumption point, computed the moment this record is built;
     `prediction_scored_at` is when that happened. Nothing here waits for a
     future event, because there is not one left to wait for.

**Why `gfw_gaps`' ais_disabling records get the went-dark -> resumed line on
the map (see the frontend's uncertaintyPane rendering) but never a contour of
their own.** The line only needs two points GFW's own record already
carries. A contour needs this module's own machinery -- a course, a speed
history, a v_max -- and GFW's gap events carry none of that; building one
would mean reaching back into *our* AIS history for the same hull and
pretending the result describes GFW's event, when the two are not
describing the same moment at all (see the module docstring above on the
five-or-more-day publication lag between GFW's batch and the three days of
history this module can even see). A contour built that way would look just
as confident as one built from this module's own gap and be answering a
different question -- which is exactly the kind of confident-looking wrong
answer this module exists to avoid producing.

`inferred: True` covers every field this section adds, the same as it already
covers the gap itself: none of it is a detection, a forecast in the ordinary
sense, or a claim that the vessel actually took any particular path through
the drawn region.
"""

import asyncio
import logging
import math
import re
import statistics
import time

from backend import config, infrastructure, storage
from backend.cache import registry
from backend.refine.vessel_profile import cargo_class
from backend.sources.proximity import ProximityIndex, destination_point, haversine_km, initial_bearing

log = logging.getLogger("osint-globe.dark_vessels")

REFRESH_INTERVAL = 15 * 60
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# How far back to look. Bounded by HISTORY_RETENTION_SECONDS anyway -- asking
# for more would silently return less -- so it is read from there rather than
# restated, and a change to the retention window cannot leave this asking for
# history that was already deleted.
LOOKBACK_SECONDS = config.HISTORY_RETENTION_SECONDS

# --- going dark ---

# Below this, a gap is ordinary. AIS coverage is patchy offshore and a ship can
# easily drop out for an hour or two with nothing behind it; four hours in a
# monitored chokepoint is not routine.
GAP_MIN_HOURS = 4.0
# Above this, the "gap" is really "we lost coverage of this region for a day",
# which says nothing about the vessel.
GAP_MAX_HOURS = 36.0
# A gap only counts inside the waters this map actually watches (see
# config.WATCHED_WATERS): elsewhere our own coverage is too thin for absence to
# mean anything at all.
#
# The AIS subscription went global on 2026-08-08 and this deliberately did not
# follow it. Receiving a position from mid-Pacific is not the same as being able
# to say a hull that stopped reporting there went dark: aisstream's coverage far
# from shore is satellite-assisted and sparse, so out there the ordinary reason
# for a four-hour gap is that nobody was listening. Widen this only with evidence
# about reception density, not because collection got wider.
REQUIRE_CHOKEPOINT = True
MAX_GAP_RECORDS = 120

# --- ship-to-ship transfer ---

STS_MAX_SEPARATION_KM = 0.5
STS_MAX_SPEED_KN = 1.0
STS_MIN_DURATION_HOURS = 1.0
# Anywhere within this of a charted port is a port call, not a transfer at sea.
#
# Two lists feed it (see `port_index`): the 40 curated harbours in
# backend/infrastructure.py, and every port the NGA World Port Index places
# inside this map's theatres or AIS watch boxes -- 393 of them, of which 263 sit
# in watched water against the curated list's 12. That is the difference between
# one excluded port in the whole Persian Gulf and fifty-two of them.
#
# It is still not a zero-false-positive exclusion, and the popup must not say it
# is. WPI is an index of *ports*; a designated anchorage, a lightering area or a
# stretch of sheltered water where tankers habitually wait appears in neither
# list, and two hulls sitting in one will still surface here. Each record
# carries `ports_checked` so the popup can state what was actually applied
# rather than describing a list it cannot see.
STS_PORT_EXCLUSION_KM = 25.0
MAX_STS_RECORDS = 80

# AIS navigational status 5 is "moored". A moored vessel is alongside something,
# which is the ordinary explanation for sitting still, so it is excluded outright
# rather than reported and explained away.
NAV_STATUS_MOORED = 5

# If the AIS feed's own item count collapsed to this fraction of its typical
# level during a gap, the gap is about us, not about the ship.
FEED_HEALTH_MIN_RATIO = 0.5

# --- dark-ship reachability (see the module docstring's "Reachability" section
# for the model these constants feed) ---

KN_TO_KMH = 1.852

# How many retained speed samples a hull needs before its own 95th percentile
# is trusted over the class default below. Below this the "observed maximum"
# is just whatever this hull happened to report once or twice -- the same
# reasoning backend/refine/vessel_profile.py's VESSEL_DRAUGHT_MIN_SAMPLES
# applies to a draught series, at a higher bar because a speed percentile
# needs more of the distribution's tail to mean anything, where a draught
# verdict only needs to see the two extremes.
REACH_MIN_SPEED_SAMPLES = 20
REACH_SPEED_PERCENTILE = 0.95

# Class ceilings used when a hull's own speed history is too thin to trust
# (see REACH_MIN_SPEED_SAMPLES), sorted by
# backend.refine.vessel_profile.cargo_class. Deliberately generous -- a cruising
# speed near the top of what the class is capable of, not a typical one --
# because this number sets how *wide* the reachability region is drawn, and
# the one failure mode that matters here is a region too small to contain
# where the hull actually turned up. A generous fallback only ever costs a
# bigger, vaguer region; a stingy one would silently understate reach for
# every hull whose own history the model could not trust.
CLASS_MAX_SPEED_KN = {
    "tanker": 16.0, "cargo": 22.0, "fishing": 14.0, "passenger": 26.0,
    "tug": 14.0, "naval": 32.0, "other": 18.0,
}
# cargo_class returned None: the AIS static block was never decoded for this
# hull at all, so there is no class to look up. Between the fishing and cargo
# figures above rather than at either extreme.
DEFAULT_MAX_SPEED_KN = 18.0

# k in the module docstring's k*sqrt(t) cross-track term, as a fraction of the
# hull's own v_max. No external source behind this number -- it is a
# judgement call about how far a vessel evading tracking might plausibly drift
# off its own course, not a measurement of anything, and it is the single
# number in this model most worth a reader's disagreement.
REACH_CROSS_TRACK_FRACTION = 0.3

# Two-sided normal quantiles for the 50/80/95% contour bands, in the order the
# `contours` field is built and returned. Both the along-track and cross-track
# half-widths are scaled by the same z per band, which is what makes the three
# nest by construction -- see the module docstring, point 3.
CONTOUR_BANDS = ((50, 0.6745), (80, 1.2816), (95, 1.9600))

# Vertices per contour ring (closed, so one more point is actually emitted).
# Coarse enough to be cheap across MAX_GAP_RECORDS x 3 land-mask passes, fine
# enough that the ellipse does not read as a polygon at any zoom this map
# draws it at.
CONTOUR_VERTICES = 48

# How many evenly-spaced samples a land search walks, from the ellipse's own
# centre out toward the 95% band's own vertex, before treating a bearing with
# no land found as clear -- see _ray_water_bound, which walks every one of
# these rather than testing only the endpoint (an earlier version of this
# fix did, and missed an island sitting between the centre and the vertex).
# Run once per bearing, shared by all three bands, not once per band; see the
# module docstring's "Land masking" point for why searching per band instead
# breaks contour nesting, and for the coarse-sampling limitation this number
# still leaves -- a feature wider than a bearing's own current spread but
# narrower than outer_km / LAND_MASK_STEPS can sit between two samples.
LAND_MASK_STEPS = 12

# Blend weight for the destination-bearing nudge described in the module
# docstring's point 5. Low on purpose: a declared destination is a plan typed
# in before departure, not a live track. MAX_DESTINATION_PRIOR_WEIGHT is a
# real clamp in _blend_bearing, not just a comment -- it exists so a future
# caller cannot accidentally let a typed string out-vote a hull's own recent
# heading.
DESTINATION_PRIOR_WEIGHT = 0.15
MAX_DESTINATION_PRIOR_WEIGHT = 0.3

# AIS's own "not available" sentinels: SOG's raw all-ones value (102.3 kn) and
# COG's raw 3600 (360.0 degrees in 0.1-degree units). Neither is a real
# reading, and folding either into the dead-reckoning inputs would either
# invent an impossible speed or an arbitrary due-north course.
AIS_SPEED_UNAVAILABLE_KN = 102.3


def _in_watched_waters(lat: float, lon: float) -> bool:
    return any(
        lat_min <= lat <= lat_max and lon_min <= lon <= lon_max
        for lat_min, lon_min, lat_max, lon_max in config.WATCHED_WATERS
    )


def port_index(wpi_ports: list[dict] | None = None) -> ProximityIndex:
    """Every port this map knows of, as one exclusion index.

    Both lists, not one. The curated entries in backend/infrastructure.py are
    hand-checked and carry notes a bulk file cannot ("de facto wartime
    capital"), and several of them -- offshore loading platforms, naval
    terminals -- are not ports in NGA's sense at all and appear nowhere in WPI.
    The World Port Index supplies the coverage: 2,951 real harbours, of which
    the ports source stores the 393 inside this map's theatres and AIS boxes.
    Dropping either list would lose something the other does not have.

    `wpi_ports` comes from entity_latest (see `_compute`). An empty list is a
    working state, not an error -- it is what the first minutes after a fresh
    deployment look like, before backend/sources/ports.py has landed its first
    snapshot -- and it degrades to exactly the curated-only behaviour this
    module had before.
    """
    curated = [s for s in infrastructure.INFRA_SITES if s.get("type") == "port"]
    return ProximityIndex(curated + list(wpi_ports or []), cell_deg=0.5)


_PORT_KEY_RE = re.compile(r"[^A-Z0-9]")


def _normalize_port_text(text: str | None) -> str:
    """Uppercase, alphanumerics only. Used on both sides of a destination
    match (see resolve_destination) so "Rotterdam", "ROTTERDAM" and, if WPI
    ever carries it with a hyphen, "Port-Rotterdam" all collapse to one key."""
    return _PORT_KEY_RE.sub("", (text or "").upper())


def destination_index(wpi_ports: list[dict] | None = None) -> dict[str, dict]:
    """Every indexed port (the same curated + WPI union `port_index` builds),
    keyed for an exact, normalised match against an AIS destination string.

    Deliberately exact rather than fuzzy or substring. AIS's destination field
    is free text a crew typed in before departure -- "FOR ORDERS", a routing
    chain like "USNYC>NLRTM", a slang abbreviation -- and a substring match
    would let a routing chain match whichever port's name happened to appear
    inside it. A destination this cannot match exactly resolves to nothing,
    which is the honest failure mode for text nobody standardised.
    """
    curated = [s for s in infrastructure.INFRA_SITES if s.get("type") == "port"]
    index: dict[str, dict] = {}
    for port in curated + list(wpi_ports or []):
        for key in (_normalize_port_text(port.get("name")), _normalize_port_text(port.get("unlo_code"))):
            if key:
                index.setdefault(key, port)
    return index


def resolve_destination(destination: str | None, index: dict[str, dict]) -> dict | None:
    key = _normalize_port_text(destination)
    if not key:
        return None
    return index.get(key)


def feed_health_baseline(series: list[tuple[float, int | None, bool]]) -> float | None:
    """The AIS feed's typical item count over the window, or None if unknowable."""
    counts = [count for _ts, count, ok in series if ok and isinstance(count, int) and count > 0]
    if len(counts) < 3:
        return None
    return float(statistics.median(counts))


def feed_was_healthy(
    series: list[tuple[float, int | None, bool]], start: float, end: float, baseline: float | None
) -> bool:
    """Was our own AIS feed working across this window?

    Answers the objection that sinks this whole detection if left unanswered: a
    receiver or upstream outage makes every ship in a region appear to go dark
    at once. With no health record at all the answer is "assume yes" -- refusing
    to report anything would be the wrong failure mode for a signal whose whole
    value is that it is rare -- but a measured collapse suppresses the gap.
    """
    window = [(ts, count, ok) for ts, count, ok in series if start <= ts <= end]
    if any(not ok for _ts, _count, ok in window):
        # Checked before the baseline, not after. A recorded failure across the
        # gap is direct evidence about our own feed and needs no comparison to
        # interpret -- and requiring a baseline first is what made this guard
        # inert exactly when it mattered most: through a total outage the feed
        # recorded nothing but failures, so there was no successful count to
        # take a median of, so every vessel in every watched box read as having
        # gone dark at the same moment.
        return False
    if baseline is None:
        return True
    if not window:
        # No polls recorded across the gap at all: the snapshot loop itself was
        # not running, which is exactly the case this guard exists for.
        return False
    counts = [count for _ts, count, _ok in window if isinstance(count, int)]
    if not counts:
        return False
    return min(counts) >= baseline * FEED_HEALTH_MIN_RATIO


def _numeric(value) -> float | None:
    """A figure that should be a plain number, leniently -- matching
    gfw_gaps._number's reasoning: a payload field this module did not write
    itself is read defensively rather than trusted to always be the type it
    usually is."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _speed_or_none(value) -> float | None:
    v = _numeric(value)
    if v is None:
        return None
    return v if v < AIS_SPEED_UNAVAILABLE_KN else None


def _course_or_none(value) -> float | None:
    v = _numeric(value)
    if v is None:
        return None
    return v if 0.0 <= v < 360.0 else None


def build_gap_records(
    gaps: list[dict],
    ships_by_mmsi: dict[str, dict],
    health: list[tuple[float, int | None, bool]],
    priors: dict[str, dict] | None = None,
) -> list[dict]:
    """Position gaps -> the ones worth showing, with their own evidence attached.

    `priors` is what Global Fishing Watch has recorded about each *hull* (see
    backend/sources/gfw_gaps.py), keyed by MMSI. It is not corroboration of the
    gap being built here and must never be rendered as such: GFW's batch runs
    five or more days behind and our AIS history is three days deep, so the two
    cannot describe the same event. What it answers is the prior question --
    has this hull done this before, and did GFW call it deliberate.
    """
    baseline = feed_health_baseline(health)
    priors = priors or {}
    out: list[dict] = []
    for gap in gaps:
        hours = gap["gap_seconds"] / 3600.0
        if hours > GAP_MAX_HOURS:
            continue
        if REQUIRE_CHOKEPOINT and not (
            _in_watched_waters(gap["from_lat"], gap["from_lon"])
            and _in_watched_waters(gap["to_lat"], gap["to_lon"])
        ):
            continue
        if not feed_was_healthy(health, gap["from_ts"], gap["to_ts"], baseline):
            continue
        distance_km = haversine_km(gap["from_lat"], gap["from_lon"], gap["to_lat"], gap["to_lon"])
        # Nautical miles per hour, from the straight-line distance. A number
        # above ~25 kn for a merchant vessel means the reappearance cannot be
        # the same continuous voyage -- which is the interesting case, not a
        # reason to discard the record.
        implied_speed_kn = (distance_km / 1.852) / hours if hours > 0 else 0.0
        ship = ships_by_mmsi.get(gap["entity_id"]) or {}
        from_payload = gap.get("from_payload") or {}
        out.append({
            "id": f"gap:{gap['entity_id']}:{int(gap['from_ts'])}",
            "kind": "ais_gap",
            # Drawn where it went quiet, not where it came back: the last known
            # position is the fact, the reappearance is the consequence.
            "lat": gap["from_lat"],
            "lon": gap["from_lon"],
            "mmsi": gap["entity_id"],
            "name": ship.get("name"),
            "imo": ship.get("imo"),
            "sanctions": ship.get("sanctions"),
            "ship_type": ship.get("ship_type"),
            "went_dark_at": gap["from_ts"],
            "resumed_at": gap["to_ts"],
            "resumed_lat": gap["to_lat"],
            "resumed_lon": gap["to_lon"],
            "gap_hours": round(hours, 1),
            "resumed_km_away": round(distance_km, 1),
            "implied_speed_kn": round(implied_speed_kn, 1),
            # Someone else's record of this hull, or None. Named `prior` rather
            # than anything resembling `corroborated` on purpose -- see the
            # docstring above and gfw_gaps.py's.
            "gfw_prior": priors.get(str(gap["entity_id"])),
            # What the reachability model (see the module docstring and
            # add_reachability below) treats as "the last thing we knew about
            # this hull before it went quiet" -- read off the AIS fix
            # immediately before the gap, not off `ship`/entity_latest above,
            # which by the time this record exists already reflects whatever
            # happened after the hull reappeared.
            "last_known_speed_kn": _speed_or_none(from_payload.get("speed")),
            "last_known_course_deg": _course_or_none(from_payload.get("course")),
            "last_known_ship_type": (
                from_payload.get("ship_type")
                if isinstance(from_payload.get("ship_type"), int)
                and not isinstance(from_payload.get("ship_type"), bool)
                else None
            ),
            "declared_destination": (
                from_payload.get("destination") if isinstance(from_payload.get("destination"), str) else None
            ),
            "inferred": True,
        })
    # This order decides what survives the cap below, and nothing else. It is
    # explicitly *not* a reading order: the backend serves these from Postgres
    # (see storage.entity_latest, ORDER BY entity_id) so by the time a reader
    # sees them they are in MMSI order and this sort is gone. Measured, not
    # assumed -- the served payload came back 207828770, 210888000, 219407000
    # while this function had ordered them by duration.
    #
    # What it does do matters at the margin the cap creates: a pass with 123
    # candidates and MAX_GAP_RECORDS at 120 discards three, and a hull carrying
    # an OFAC designation or a GFW record of deliberate disabling should not be
    # one of them. The gap itself is no better evidenced for either flag, and
    # nothing downstream reads position in this list as confidence.
    out.sort(
        key=lambda r: (
            r.get("sanctions") is not None,
            bool((r.get("gfw_prior") or {}).get("intentional_events")),
            r["gap_hours"],
        ),
        reverse=True,
    )
    return out[:MAX_GAP_RECORDS]


def build_sts_records(
    ships: list[dict],
    ports: ProximityIndex,
    now: float | None = None,
    priors: dict[str, dict] | None = None,
) -> list[dict]:
    """Pairs of vessels sitting alongside each other, away from any port.

    `priors` is the same per-hull GFW record `build_gap_records` takes, attached
    per vessel rather than per pair -- a transfer is between two hulls and only
    one of them may have the history. It is not corroboration of the transfer:
    GFW's encounters product was measured against this inference and does not
    cover it at all (see gfw_gaps.py), so nothing here has a second opinion on
    the pairing itself. What a prior says is that one of these two has been
    recorded going dark deliberately before.
    """
    now = time.time() if now is None else now
    priors = priors or {}
    candidates = []
    for ship in ships:
        lat, lon = ship.get("lat"), ship.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        speed = ship.get("speed")
        if not isinstance(speed, (int, float)) or speed > STS_MAX_SPEED_KN:
            continue
        if ship.get("nav_status") == NAV_STATUS_MOORED:
            continue
        still_hours = (now - (ship.get("_last_moved_at") or now)) / 3600.0
        if still_hours < STS_MIN_DURATION_HOURS:
            continue
        if ports.nearest(lat, lon, STS_PORT_EXCLUSION_KM):
            continue
        candidates.append({**ship, "_still_hours": still_hours})

    # Pairwise, and deliberately not indexed. ProximityIndex answers "the single
    # closest point", which is the wrong question here -- three tankers rafted
    # together is one of the shapes worth seeing -- and by this point the
    # candidate set is only the vessels that are stationary, not moored, offshore
    # and have been so for an hour, which in practice is dozens. An index over
    # that would be machinery standing in for a loop that is already fast and
    # obviously correct.
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for i, ship in enumerate(candidates):
        for other in candidates[i + 1:]:
            # Cheap degree pre-filter before the trigonometry: 0.5 km is well
            # under 0.02 degrees of latitude anywhere on earth.
            if abs(other["lat"] - ship["lat"]) > 0.02:
                continue
            separation = haversine_km(ship["lat"], ship["lon"], other["lat"], other["lon"])
            if separation > STS_MAX_SEPARATION_KM:
                continue
            key = tuple(sorted((str(ship["mmsi"]), str(other["mmsi"]))))
            if key in seen:
                continue
            seen.add(key)
            together_hours = min(ship["_still_hours"], other["_still_hours"])
            designated = [s for s in (ship.get("sanctions"), other.get("sanctions")) if s]
            out.append({
                "id": f"sts:{key[0]}:{key[1]}",
                "kind": "sts_pair",
                "lat": (ship["lat"] + other["lat"]) / 2,
                "lon": (ship["lon"] + other["lon"]) / 2,
                "vessels": [
                    {"mmsi": s.get("mmsi"), "name": s.get("name"), "imo": s.get("imo"),
                     "ship_type": s.get("ship_type"), "sanctions": s.get("sanctions"),
                     "gfw_prior": priors.get(str(s.get("mmsi")))}
                    for s in (ship, other)
                ],
                "separation_m": round(separation * 1000),
                "together_hours": round(together_hours, 1),
                # The exclusion this pair survived, in its own words. Carried on
                # the record because the size of the port index is the whole
                # difference between "away from any port" as a claim and as a
                # check -- and because it is not constant: it is curated-only
                # until the ports source has written its first snapshot.
                "ports_checked": len(ports),
                "port_exclusion_km": STS_PORT_EXCLUSION_KM,
                "sanctions": designated[0] if designated else None,
                "designated_count": len(designated),
                "inferred": True,
            })
    out.sort(key=lambda r: (r["designated_count"], r["together_hours"]), reverse=True)
    return out[:MAX_STS_RECORDS]


# --- dark-ship reachability: land mask, ellipse, dead reckoning, scoring ---


def _bbox_hits(bbox, antimeridian, lat: float, lon: float) -> bool:
    """Cheap pre-check before the real ring test below: does this feature's
    stored bbox even cover the point. [south, west, north, east], per Task 4
    (see backend/sources/water_bodies.py's `_bbox`) -- west > east (or the
    `antimeridian` flag, checked either way in case a feature sets one but not
    the other) means the box wraps the seam and is tested as two ranges."""
    if not bbox or len(bbox) != 4:
        return False
    south, west, north, east = bbox
    if not (south <= lat <= north):
        return False
    if antimeridian or west > east:
        return lon >= west or lon <= east
    return west <= lon <= east


def _ring_contains(ring: list, lat: float, lon: float) -> bool:
    """Ray casting over one GeoJSON ring ([lon, lat] pairs). Standard
    even-odd-crossings test; used both for a polygon's outer ring and,
    negated, for its holes -- see _geometry_contains."""
    if not ring or len(ring) < 4:
        return False
    inside = False
    x, y = lon, lat
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            x_intersect = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_intersect:
                inside = not inside
        j = i
    return inside


def _geometry_contains(geometry: dict | None, lat: float, lon: float) -> bool:
    """Polygon/MultiPolygon point containment, holes honoured. LineString and
    MultiLineString (water_rivers, not consulted by WaterMask at all, but kept
    here as a defined "no area" rather than an exception) return False."""
    if not geometry:
        return False
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "Polygon":
        polygons = [coords] if coords else []
    elif gtype == "MultiPolygon":
        polygons = coords or []
    else:
        return False
    for polygon in polygons:
        if not polygon or not _ring_contains(polygon[0], lat, lon):
            continue
        if any(_ring_contains(hole, lat, lon) for hole in polygon[1:]):
            continue
        return True
    return False


class WaterMask:
    """Whether a point is water, per the Task 4 sea/lake polygons -- this
    module's land mask (see the module docstring's "Land masking" point).
    Built once per _compute() pass from two whole-document reference_snapshots
    (water_marine, water_lakes -- water_rivers is linework, not area, and is
    never consulted here) and reused across every gap record's contours,
    rather than re-fetched or rebuilt per record.

    `covers` does a cheap bbox pre-check (see _bbox_hits) before the real ring
    walk, not a spatial index: a reachability region spans at most a few
    hundred kilometres, so for any one query point almost every one of the
    ~1,660 marine/lake features fails the bbox check on a handful of float
    comparisons, and the expensive ring walk only ever runs for the one or two
    features that could plausibly contain the point.
    """

    __slots__ = ("_features",)

    def __init__(self, *documents):
        features: list[dict] = []
        for doc in documents:
            if isinstance(doc, dict):
                features.extend(doc.get("features") or [])
        self._features = features

    def __len__(self) -> int:
        return len(self._features)

    def covers(self, lat: float, lon: float) -> bool:
        for feature in self._features:
            props = feature.get("properties") or {}
            if not _bbox_hits(props.get("bbox"), props.get("antimeridian"), lat, lon):
                continue
            if _geometry_contains(feature.get("geometry"), lat, lon):
                return True
        return False


def _ray_water_bound(
    center_lat: float, center_lon: float, outer_lat: float, outer_lon: float,
    outer_km: float, water_mask: WaterMask,
) -> tuple[float, bool]:
    """How far along the ray from `center` toward `outer` a vertex may sit and
    still count as water, in km from `center` (never more than `outer_km`).

    Run **once per bearing**, against the outermost (95%) band's own raw
    vertex -- never once per band. That is the fix for contour nesting
    surviving land masking (see the module docstring's "Land masking" point,
    and the review that caught the earlier per-band version breaking it on an
    ordinary strait): every band's own vertex at this bearing is collinear
    with `center` and `outer`, so build_reachability later caps each band's
    own raw radius at `min(that band's own radius, this one shared bound)` --
    and capping three different numbers against one shared ceiling can only
    ever preserve their original order, never invert it. Sharing the search
    is what makes that true; three independent searches at three different
    step sizes along the same physical ray is what did not.

    **Walks outward from `center`, testing every sample, not just `outer`.**
    A first version of this function tested only `outer` and, if that alone
    was water, returned immediately -- cheap, but wrong: an island sitting
    between `center` and `outer` on the same bearing (open water on both
    sides of it) went undetected, because nothing closer in was ever
    checked. `masked_by_land` could then read False for a record whose
    inner band's own vertex sat squarely on that island. Walking from the
    centre outward and stopping at the *first* non-water sample -- the
    bound is the last sample that was still water -- catches that: land
    nearer than `outer` on the same ray is exactly what this now looks for
    on every bearing, not only the ones where the 95% band's own vertex
    itself happens to land on it.

    Resolution and cost, stated rather than left implicit: LAND_MASK_STEPS
    (12) samples per bearing, evenly spaced from the centre to `outer`, so a
    feature narrower than `outer_km / 12` along this one ray can still fall
    between two samples and go undetected -- the same coarse-sampling
    admission the module docstring's "what is not claimed" paragraph already
    makes for coastlines varying *between* bearings, now also true *within*
    one. Unlike the single-sample version this replaced, the common case (no
    land anywhere near this bearing) now costs the full 12 `covers()` calls
    rather than 1, because nothing shy of reaching `outer` can prove the
    whole ray is clear. Bounded regardless: MAX_GAP_RECORDS (120) x
    CONTOUR_VERTICES (48) x LAND_MASK_STEPS (12) is 69,120 `covers()` calls
    per refine pass at the absolute worst, each one a bbox pre-check over at
    most a couple of thousand water features before the rare expensive ring
    walk (see WaterMask.covers) -- seconds, not minutes, against a
    REFRESH_INTERVAL of 15 minutes, so the accuracy this buys is not fighting
    the loop for time.

    If nothing along the line is water at all (the centre itself sits on
    land, or the whole segment does), the bound collapses to 0 -- every
    band's vertex at this bearing lands on the centre itself, which is safe
    only because dr_lat/dr_lon is never itself masked (see the module
    docstring's point 1), so "the centre" is never a guess this function
    invented.

    Returns (bound_km, moved) -- `moved` is what feeds a record's
    `masked_by_land` flag.
    """
    if outer_km <= 0:
        return 0.0, False
    for step in range(1, LAND_MASK_STEPS + 1):
        frac = step / LAND_MASK_STEPS
        test_lat = center_lat + (outer_lat - center_lat) * frac
        test_lon = center_lon + (outer_lon - center_lon) * frac
        if not water_mask.covers(test_lat, test_lon):
            return outer_km * (step - 1) / LAND_MASK_STEPS, True
    return outer_km, False


def _ellipse_offset(along_km: float, cross_km: float, theta: float, bearing_rad: float) -> tuple[float, float]:
    """The (north_km, east_km) offset from an ellipse's own centre at
    parameter `theta` (radians): semi-major `along_km` oriented along
    `bearing_rad`, semi-minor `cross_km` perpendicular to it.

    Factored out on its own, rather than folded into a function that also
    walks every `theta` and returns a whole ring the way an earlier version
    of this module did, because build_reachability needs the *same* `theta`
    evaluated at several different (along_km, cross_km) pairs -- one per
    contour band, all sharing one centre and one bearing -- and comparing
    those offsets directly (they are collinear for a fixed theta; see
    _ray_water_bound) is what both the reach-radius cap and the land mask
    now lean on to keep the three bands nested.
    """
    x_along = along_km * math.cos(theta)
    y_cross = cross_km * math.sin(theta)
    north_km = x_along * math.cos(bearing_rad) - y_cross * math.sin(bearing_rad)
    east_km = x_along * math.sin(bearing_rad) + y_cross * math.cos(bearing_rad)
    return north_km, east_km


def _blend_bearing(course_deg: float, dest_bearing_deg: float, weight: float) -> float:
    """A weighted vector average of two bearings, wrapping correctly through
    0/360 the way an arithmetic average of the two numbers would not (a
    naive (350 + 10) / 2 gives 180, the opposite direction from either input).
    `weight` is clamped to MAX_DESTINATION_PRIOR_WEIGHT regardless of what is
    passed in -- a real clamp, not just DESTINATION_PRIOR_WEIGHT's own
    comment, so a future caller cannot let a typed destination string out-vote
    a hull's own recent heading."""
    w = max(0.0, min(weight, MAX_DESTINATION_PRIOR_WEIGHT))
    cx = (1 - w) * math.cos(math.radians(course_deg)) + w * math.cos(math.radians(dest_bearing_deg))
    cy = (1 - w) * math.sin(math.radians(course_deg)) + w * math.sin(math.radians(dest_bearing_deg))
    if cx == 0.0 and cy == 0.0:
        # Only reachable at w == 0.5 with the two bearings exactly opposed --
        # never true at this module's own weight, but a real case for a
        # future caller, and course_deg (the un-nudged heading) is the
        # honest thing to fall back to rather than an arbitrary due-north.
        return course_deg % 360.0
    return math.degrees(math.atan2(cy, cx)) % 360.0


def _class_default_speed_kn(ship_type) -> float:
    return CLASS_MAX_SPEED_KN.get(cargo_class(ship_type), DEFAULT_MAX_SPEED_KN)


def _vmax_and_basis(ship_type, speed_stats: dict | None) -> tuple[float, str, float]:
    """(v_max_kn, speed_basis, stdev_kn) for one hull. stdev_kn is 0.0, not
    None, when the class-default fallback fires -- the along-track term
    downstream floors against the cross-track one for exactly this case (see
    build_reachability), rather than needing a None check of its own.

    speed_basis is "own_history" or "class_default" -- deliberately neither
    word from this project's four-word provenance vocabulary
    (measured/reported/derived/inferred, see the global constraints). Both
    branches are already arithmetic over AIS's own measured speed reports (a
    percentile in one case, a fixed lookup table in the other), so the
    record's own `inferred: True` is what states the provenance; this field
    answers a narrower question -- whose numbers, this hull's or the class's
    -- not a second, competing provenance claim.
    """
    if (
        speed_stats
        and speed_stats.get("sample_count", 0) >= REACH_MIN_SPEED_SAMPLES
        and speed_stats.get("p_kn") is not None
    ):
        stdev = speed_stats.get("stdev_kn")
        return float(speed_stats["p_kn"]), "own_history", float(stdev) if stdev is not None else 0.0
    return _class_default_speed_kn(ship_type), "class_default", 0.0


def build_reachability(
    record: dict,
    speed_stats: dict | None,
    water_mask: WaterMask,
    destination_port: dict | None,
    now: float,
) -> dict:
    """One ais_gap record's reach_* fields (see the module docstring's
    "Reachability" section for the model in full). Pure -- every input is
    already resolved by the caller (speed_stats from one row of
    storage.speed_stats_before, water_mask built once per pass, the
    destination lookup done ahead of time) rather than fetched here, which is
    what makes the model itself -- dead reckoning, the ellipse, land masking,
    the destination bias, the self-score -- testable without a database; see
    backend/tests/test_dark_reach.py. `record` must already carry the fields
    build_gap_records puts on every ais_gap record: last_known_speed_kn,
    last_known_course_deg, last_known_ship_type, gap_hours, lat/lon and
    resumed_lat/resumed_lon.
    """
    hours = record["gap_hours"]
    from_lat, from_lon = record["lat"], record["lon"]
    ship_type = record.get("last_known_ship_type")
    if ship_type is None:
        ship_type = record.get("ship_type")

    v_max_kn, speed_basis, stdev_kn = _vmax_and_basis(ship_type, speed_stats)
    reach_radius_km = v_max_kn * KN_TO_KMH * hours

    last_speed_kn = record.get("last_known_speed_kn")
    travel_speed_kn = max(last_speed_kn, 0.0) if isinstance(last_speed_kn, (int, float)) else 0.0
    # Capped at reach_radius_km: a single last-known-speed reading is one
    # real number, not a guess, but if it alone implies more distance than
    # the hull's *own* top-speed ceiling allows, the dead-reckoned point
    # would already sit outside the region this module promises never to
    # exceed (see the module docstring's point 3) -- and no amount of
    # scaling the *spread* around it, below, could fix that on its own.
    travel_km = min(travel_speed_kn * KN_TO_KMH * hours, reach_radius_km)
    last_course_deg = record.get("last_known_course_deg")
    base_bearing = last_course_deg if isinstance(last_course_deg, (int, float)) else 0.0
    dr_lat, dr_lon = destination_point(from_lat, from_lon, base_bearing, travel_km)

    destination_prior_used = None
    lobe_bearing = base_bearing
    if destination_port is not None:
        dest_bearing = initial_bearing(dr_lat, dr_lon, destination_port["lat"], destination_port["lon"])
        lobe_bearing = _blend_bearing(base_bearing, dest_bearing, DESTINATION_PRIOR_WEIGHT)
        destination_prior_used = {
            "port": destination_port.get("name") or destination_port.get("id"),
            "weight": min(DESTINATION_PRIOR_WEIGHT, MAX_DESTINATION_PRIOR_WEIGHT),
        }

    along_base_km = stdev_kn * KN_TO_KMH * hours
    cross_base_km = REACH_CROSS_TRACK_FRACTION * v_max_kn * KN_TO_KMH * math.sqrt(hours)
    # A hull with no speed-variance evidence at all (the class-default
    # fallback, or a flat reported speed) would otherwise draw an along-track
    # sliver with no width in the direction it is actually travelling --
    # floored at a fraction of the cross-track term so a contour is never
    # narrower along its own axis of travel than across it.
    along_base_km = max(along_base_km, 0.5 * cross_base_km)

    # One shared scale factor, applied to both base axes before any per-band
    # vertex is built -- not a per-vertex clamp against reach_radius_km after
    # the fact, which is what the earlier version of this code did and which
    # bounded distance from the *dead-reckoned centre* rather than from the
    # last known fix (see the module docstring's point 3 for the full
    # reasoning and the numbers that exposed it).
    #
    # The bound is the triangle inequality, not an exact fit:
    # distance(origin, vertex) <= travel_km + distance(centre, vertex), and
    # the farthest any point on an ellipse can sit from its own centre is its
    # semi-major axis -- so scaling the *raw* 95% band's semi-major down
    # until travel_km plus it no longer exceeds reach_radius_km bounds every
    # vertex of every band before land masking is even considered (masking
    # only ever pulls a vertex closer to the centre afterwards, which cannot
    # increase that distance -- see _ray_water_bound). One factor for both
    # axes and all three bands is also what keeps this from disturbing
    # nesting: shrinking one shape uniformly cannot change which band ends up
    # inside which.
    outer_z = CONTOUR_BANDS[-1][1]
    raw_outer_radius_km = outer_z * max(along_base_km, cross_base_km)
    budget_km = max(reach_radius_km - travel_km, 0.0)
    if raw_outer_radius_km > budget_km:
        scale = (budget_km / raw_outer_radius_km) if raw_outer_radius_km > 0 else 1.0
        along_base_km *= scale
        cross_base_km *= scale

    apply_mask = len(water_mask) > 0
    masked_by_land = False
    km_per_deg_lat = 111.32
    km_per_deg_lon = max(111.32 * math.cos(math.radians(dr_lat)), 1.0)
    bearing_rad = math.radians(lobe_bearing)
    band_rings: list[list[list[float]]] = [[] for _ in CONTOUR_BANDS]
    for i in range(CONTOUR_VERTICES):
        theta = 2 * math.pi * i / CONTOUR_VERTICES
        # z == 1 offset; every band's own offset at this theta is this one
        # times its own z (see _ellipse_offset's docstring), which is what
        # keeps all three collinear with the centre and lets one shared land
        # search (below) bound every one of them without breaking their
        # order.
        base_north, base_east = _ellipse_offset(along_base_km, cross_base_km, theta, bearing_rad)
        base_radius_km = math.hypot(base_north, base_east)
        outer_radius_km = outer_z * base_radius_km

        if apply_mask and outer_radius_km > 0:
            outer_lat = dr_lat + (outer_z * base_north) / km_per_deg_lat
            outer_lon = dr_lon + (outer_z * base_east) / km_per_deg_lon
            water_bound_km, moved = _ray_water_bound(
                dr_lat, dr_lon, outer_lat, outer_lon, outer_radius_km, water_mask
            )
            masked_by_land = masked_by_land or moved
        else:
            water_bound_km = outer_radius_km

        for band_index, (_percentile, z) in enumerate(CONTOUR_BANDS):
            band_radius_km = z * base_radius_km
            final_radius_km = min(band_radius_km, water_bound_km)
            ratio = (final_radius_km / band_radius_km) if band_radius_km > 0 else 0.0
            lat = dr_lat + (z * base_north * ratio) / km_per_deg_lat
            lon = dr_lon + (z * base_east * ratio) / km_per_deg_lon
            band_rings[band_index].append([lon, lat])

    contours = []
    for (percentile, _z), ring in zip(CONTOUR_BANDS, band_rings):
        ring.append(ring[0])  # closed, matching every other GeoJSON ring this module writes
        contours.append({
            "type": "Feature",
            "properties": {"percentile": percentile},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })

    resumed_lat, resumed_lon = record.get("resumed_lat"), record.get("resumed_lon")
    prediction_error_km = None
    prediction_scored_at = None
    if isinstance(resumed_lat, (int, float)) and isinstance(resumed_lon, (int, float)):
        # Against the unmasked dead-reckoned point, deliberately -- see the
        # module docstring's point 1 on why dr_lat/dr_lon is never itself
        # land-masked: scoring the corrected point would be scoring a
        # different, easier answer than the one the model actually gave.
        prediction_error_km = round(haversine_km(dr_lat, dr_lon, resumed_lat, resumed_lon), 1)
        prediction_scored_at = now

    return {
        "reach_radius_km": round(reach_radius_km, 1),
        "speed_basis": speed_basis,
        "dr_lat": dr_lat,
        "dr_lon": dr_lon,
        "contours": contours,
        "masked_by_land": masked_by_land,
        "destination_prior_used": destination_prior_used,
        "prediction_error_km": prediction_error_km,
        "prediction_scored_at": prediction_scored_at,
    }


def add_reachability(
    records: list[dict],
    speed_stats_list: list[dict | None],
    water_mask: WaterMask,
    destination_index_: dict[str, dict],
    now: float,
) -> list[dict]:
    """build_reachability, applied across a capped batch of ais_gap records
    with each one's own DB-derived inputs already zipped on (see
    storage.speed_stats_before, which returns one entry per input target in
    the same order it was given). Returns a new list -- records themselves are
    never mutated -- matching the no-mutation discipline
    backend/refine/port_calls.py's apply_positions documents for the same
    reason: a caller holding the original list must not see it change under
    it.
    """
    out = []
    for record, stats in zip(records, speed_stats_list):
        destination_port = resolve_destination(record.get("declared_destination"), destination_index_)
        out.append({**record, **build_reachability(record, stats, water_mask, destination_port, now)})
    return out


async def _compute() -> list[dict]:
    since = time.time() - LOOKBACK_SECONDS
    # The first three read AIS that other processes wrote (never this detector's
    # own output) and run against hours-long windows, so they tolerate a lagging
    # replica and are routed there to keep the 15M-row position-gap scan off the
    # write-heavy primary. prefer_replica falls back to the primary whenever no
    # replica is configured or open, so this is a no-op without one (Phase 2/3 of
    # docs/plans/2026-08-09-read-replica.md).
    gaps, ships, health, priors, wpi_ports, water_marine, water_lakes = await asyncio.gather(
        storage.position_gaps("ais", since, GAP_MIN_HOURS * 3600, prefer_replica=True),
        storage.entity_latest_with_times("ais", prefer_replica=True),
        storage.source_health_series("ais", since, prefer_replica=True),
        # Written by the ingest process (see backend/sources/gfw_gaps.py) and
        # read here rather than fetched, which is what keeps this module inside
        # the refine tier's rule that nothing in it makes an outbound call.
        # Absent -- no token, or a first run that has not landed yet -- is a
        # normal state and degrades to no prior on any vessel, not an error.
        storage.reference("gfw_vessel_priors"),
        # The same World Port Index rows port_index/destination_index combine
        # with the curated list -- fetched once here rather than inside each
        # of them, and now actually threaded into port_index below, which used
        # to be called with no argument at all and so ran the STS exclusion
        # against the 40 curated harbours only, never the 393 WPI ports its own
        # docstring describes it combining. See Task 21's reachability model
        # for what pulled this fetch in; fixing the STS side is one line once
        # the data is already on hand.
        storage.entity_latest("ports"),
        storage.reference("water_marine"),
        storage.reference("water_lakes"),
    )
    ships_by_mmsi = {str(s.get("mmsi")): s for s in ships if s.get("mmsi") is not None}
    priors = priors if isinstance(priors, dict) else {}
    ports = port_index(wpi_ports)

    gap_records = build_gap_records(gaps, ships_by_mmsi, health, priors)
    now = time.time()
    targets = [(r["mmsi"], r["went_dark_at"]) for r in gap_records]
    speed_stats_list = await storage.speed_stats_before("ais", targets, LOOKBACK_SECONDS, REACH_SPEED_PERCENTILE)
    water_mask = WaterMask(water_marine, water_lakes)
    dest_index = destination_index(wpi_ports)
    gap_records = add_reachability(gap_records, speed_stats_list, water_mask, dest_index, now)

    return gap_records + build_sts_records(ships, ports, priors=priors)


async def derive_forever():
    """The gap/STS derivation, for the life of the refine process.

    Self-paced rather than scheduled: the loop below retries after 60s and backs
    off from there when a pass fails, rather than waiting out the full 15
    minutes. A fixed schedule would throw that away, and this derivation runs
    three aggregate queries over the AIS movement log -- the case where retrying
    sooner matters is exactly the case where the database was busy.
    """
    state = registry.ensure("dark_vessels", key_configured=True)  # derives from our own history
    # Derived rather than fetched, but still worth storing and restoring: the
    # derivation reads AIS history that the pool has to be up to serve, so at
    # boot this source produces nothing until Postgres is connected *and* a
    # 15-minute cycle has run. Storing it also puts gaps and STS pairs on the
    # replay timeline alongside the positions they were derived from.
    await storage.warm_points(state, "dark_vessels", "Dark vessels")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            records = await _compute()
            state.data = records
            state.last_success = time.time()
            state.last_error = None
            ok = True
            gaps = sum(1 for r in records if r["kind"] == "ais_gap")
            log.info(
                "Dark vessels: %d AIS gaps, %d possible STS pairs (%d involving a designated hull)",
                gaps,
                len(records) - gaps,
                sum(1 for r in records if r.get("sanctions")),
            )
            await storage.record_snapshot("dark_vessels", records, id_field="id")
            await storage.record_source_health("dark_vessels", len(records), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Dark vessel derivation failed: %s", exc)
            await storage.record_source_health("dark_vessels", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
