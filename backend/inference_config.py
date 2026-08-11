"""Read-only description of the thresholds behind this map's inferred products.

Task 31 (admin mode catch-up) wants an "Inference" section that shows the
draught percentages, gap hours, dwell speed, port radii and so on that turn
raw AIS/ADS-B history into a laden/ballast verdict, a dark-ship contour, a
port call or a flight leg. The brief that specified it assumed every one of
these numbers already lived in backend/config.py as an env-overridable
constant, "put there specifically so this task could expose them" -- true of
exactly four of them: VESSEL_DRAUGHT_LADEN_RATIO/BALLAST_RATIO/MIN_SAMPLES,
and LANE_DENSITY_INTERVAL (the job interval lane_density's own fields report
alongside its decay factor below -- see that field's own note on why the two
travel together). Task 39's six (JAM_CROSSCHECK_MAX_SPEED_KMH/MIN_REVERSAL_
KM/MAX_HEADING_DEVIATION_DEG/MIN_SAMPLES/WINDOW_SECONDS/MIN_FLAG_RATIO) live
in config.py too, by that same task's own brief -- see
backend/refine/jam_crosscheck.py's own docstring for why each one is a
measured figure, not a remembered airframe spec. Every other threshold here
is a plain module-level
constant inside the refine job (or the source module) that actually applies
it: backend/sources/dark_vessels.py's GAP_MIN_HOURS/GAP_MAX_HOURS/
REACH_CROSS_TRACK_FRACTION, backend/refine/port_calls.py's
DWELL_MAX_SPEED_KN/DWELL_MIN_SECONDS, backend/refine/port_call_thresholds.py's
three radii (already a leaf module for the reason its own docstring gives --
both port_calls.py and this endpoint need the same three numbers without
either becoming the other's dependency), backend/refine/lane_density.py's own
DECAY_FACTOR, backend/refine/flight_legs.py's COVERAGE_GAP_SECONDS, and
backend/infrastructure.py's BASE_MATCH_RADIUS_KM. That is not a gap this
module papers over by copying the numbers into a second table -- every value
below is read straight off the constant that actually governs the job, so a
threshold changed in its own module (or, for the four above, in the
environment) is a threshold changed here too, with nothing to keep in step
by hand.

**Why this is read-only.** Admin Mode's settings are a frontend document PUT
to /api/admin-config and read once by the browser (see backend/admin_config.py
and frontend/src/hooks/useAppSettings.js) -- nothing about that path reaches
into backend/refine, which is a separate long-running process that imported
these constants at start-up and has no channel on which to be told they
changed. Building one (a config-reload signal into three independent refine
jobs, each already mid-loop against a live AIS/ADS-B history read) is real
new plumbing, out of scope for a task whose brief is "give admin mode a
dial", not "add hot-reload to the refine tier". So this endpoint is the
honest middle: it names every threshold, its current value, its unit and
what it governs, and the admin panel renders it as a read-only field with
that explanation attached -- a dial that cannot move anything is worse than
no dial, and this is not a dial.
"""

# Modules, not names, imported throughout -- `from x import Y` copies Y's
# value at this module's own import time, and while none of these constants
# are env-overridable (they are true constants, not config.py's kind), reading
# them as `module.CONSTANT` inside describe() is what makes "reads straight
# off the constant that actually governs the job" true rather than aspirational,
# and what lets a test monkeypatch the owning module's attribute and see it here.
from backend import config, infrastructure
from backend.refine import flight_legs, jam_crosscheck, lane_density, port_call_thresholds, port_calls
from backend.sources import dark_vessels


def _field(key: str, label: str, value, unit: str, note: str) -> dict:
    return {"key": key, "label": label, "value": value, "unit": unit, "note": note}


def describe() -> dict:
    """One document per inferred product, each a list of read-only fields.

    Grouped the way the admin panel's three-state switch (hide/show
    labelled/show -- a genuine frontend setting, unlike anything here) groups
    them: laden/ballast, dark-ship reachability, port calls, lane density,
    flight legs. Cargo class carries no numeric threshold of its own -- it is
    a lookup table keyed by AIS ship-type code (see
    backend.refine.vessel_profile.cargo_class), not a percentage or a radius
    -- so it is named for context but given no fields.
    """
    return {
        "laden_ballast": {
            "label": "Laden / ballast draught",
            "governs": "backend.refine.vessel_profile.laden_state",
            "fields": [
                _field(
                    "laden_ratio", "Laden threshold", config.VESSEL_DRAUGHT_LADEN_RATIO, "fraction of observed max",
                    "A hull's current draught above this fraction of its own observed maximum is called laden.",
                ),
                _field(
                    "ballast_ratio", "Ballast threshold", config.VESSEL_DRAUGHT_BALLAST_RATIO, "fraction of observed max",
                    "Below this fraction is called ballast. The gap between the two is deliberately wide and"
                    " reports as unknown rather than guessing which side of a load a partial cargo falls on.",
                ),
                _field(
                    "min_samples", "Minimum draught readings", config.VESSEL_DRAUGHT_MIN_SAMPLES, "readings",
                    "Fewer distinct draught readings than this over the retained window and the observed"
                    " maximum is just whatever this hull happened to report once or twice.",
                ),
            ],
        },
        "cargo_class": {
            "label": "Cargo class",
            "governs": "backend.refine.vessel_profile.cargo_class",
            "fields": [],
        },
        "dark_ship": {
            "label": "Dark-ship gaps, ship-to-ship transfers and reachability",
            "governs": "backend.sources.dark_vessels",
            "fields": [
                _field(
                    "gap_min_hours", "Minimum gap", dark_vessels.GAP_MIN_HOURS, "hours",
                    "Below this, a gap is ordinary -- AIS coverage is patchy offshore and a ship can drop"
                    " out for an hour or two with nothing behind it.",
                ),
                _field(
                    "gap_max_hours", "Maximum gap", dark_vessels.GAP_MAX_HOURS, "hours",
                    "Above this, the gap is really \"we lost coverage of this region for a day\", which"
                    " says nothing about the vessel.",
                ),
                _field(
                    "sts_max_separation_km", "Ship-to-ship max separation", dark_vessels.STS_MAX_SEPARATION_KM, "km",
                    "How close two hulls must sit, at almost zero speed, to be reported as a possible transfer.",
                ),
                _field(
                    "sts_max_speed_kn", "Ship-to-ship max speed", dark_vessels.STS_MAX_SPEED_KN, "knots",
                    "Above this speed, two nearby hulls are passing, not rafted.",
                ),
                _field(
                    "sts_min_duration_hours", "Ship-to-ship minimum duration", dark_vessels.STS_MIN_DURATION_HOURS,
                    "hours",
                    "How long two hulls have to sit together before it counts as a transfer rather than a"
                    " momentary pass.",
                ),
                _field(
                    "sts_port_exclusion_km", "Ship-to-ship port exclusion", dark_vessels.STS_PORT_EXCLUSION_KM, "km",
                    "Anywhere within this of a charted port is a port call, not a transfer at sea.",
                ),
                _field(
                    "cross_track_fraction", "Reachability cross-track fraction",
                    dark_vessels.REACH_CROSS_TRACK_FRACTION, "fraction of a hull's own top speed",
                    "How far a vessel evading tracking might plausibly drift off its own course, as a"
                    " fraction of its own v_max -- a judgement call with no external source behind it, the"
                    " single number in the reachability model most worth a reader's disagreement.",
                ),
            ],
        },
        "port_calls": {
            "label": "Port calls",
            "governs": "backend.refine.port_calls",
            "fields": [
                _field(
                    "dwell_max_speed_kn", "Dwell max speed", port_calls.DWELL_MAX_SPEED_KN, "knots",
                    "A hull has to stay under this speed to count as dwelling rather than transiting.",
                ),
                _field(
                    "dwell_min_seconds", "Dwell minimum duration", port_calls.DWELL_MIN_SECONDS, "seconds",
                    "How long a hull has to stay under the speed floor before a dwell is even a candidate.",
                ),
                _field(
                    "depart_min_speed_kn", "Departure min speed", port_calls.DEPART_MIN_SPEED_KN, "knots",
                    "The speed a hull has to clear to be considered under way again, closing the call.",
                ),
                _field(
                    "depart_min_seconds", "Departure minimum duration", port_calls.DEPART_MIN_SECONDS, "seconds",
                    "How long a hull has to hold that speed before the departure is trusted rather than a"
                    " momentary surge inside the anchorage.",
                ),
                _field(
                    "exact_radius_km", "Exact-match radius", port_call_thresholds.PORT_EXACT_RADIUS_KM, "km",
                    "Inside this of a charted port point, the attribution is as good as AIS gets.",
                ),
                _field(
                    "proximity_radius_km", "Proximity radius", port_call_thresholds.PORT_PROXIMITY_RADIUS_KM, "km",
                    "Out to here still counts as \"in port\" -- an outer anchorage, an approach channel, a"
                    " lightering area -- but the charted point is no longer where the dwell actually is.",
                ),
                _field(
                    "search_radius_km", "Search radius", port_call_thresholds.PORT_SEARCH_RADIUS_KM, "km",
                    "Past the proximity radius, a dwell is still attributed to whichever port is nearest,"
                    " confidence \"inferred\", but only out to here.",
                ),
            ],
        },
        "lane_density": {
            "label": "AIS traffic density",
            "governs": "backend.refine.lane_density",
            "fields": [
                _field(
                    "decay_factor", "Per-tick decay factor", round(lane_density.DECAY_FACTOR, 6), "multiplier",
                    "How much a grid cell's accumulated traffic is discounted on every pass -- derived from"
                    " LANE_DENSITY_INTERVAL so a cell's contribution has a 30-day half-life regardless of how"
                    " often the job actually ticks.",
                ),
                _field(
                    "interval_seconds", "Job interval", config.LANE_DENSITY_INTERVAL, "seconds",
                    "How often the job reads the next slice of AIS history into the grid and ages the whole"
                    " grid down. The decay factor above is derived from this number.",
                ),
            ],
        },
        "flight_legs": {
            "label": "Flight legs",
            "governs": "backend.refine.flight_legs",
            "fields": [
                _field(
                    "coverage_gap_seconds", "Coverage gap", flight_legs.COVERAGE_GAP_SECONDS, "seconds",
                    "How long an aircraft can go unseen before a leg is closed as \"coverage lost\" rather"
                    " than assumed still in progress -- twice the anonymous ADS-B poll interval.",
                ),
            ],
        },
        "jam_crosscheck": {
            "label": "Jamming / ADS-B cross-check",
            "governs": "backend.refine.jam_crosscheck",
            "fields": [
                _field(
                    "max_speed_kmh", "Max plausible speed", config.JAM_CROSSCHECK_MAX_SPEED_KMH, "km/h",
                    "A position delta between two consecutive ADS-B fixes implying a ground speed above"
                    " this is called implausible. Measured against this map's own live entity_history, not"
                    " an airframe spec -- see the constant's own comment in backend/config.py.",
                ),
                _field(
                    "min_reversal_km", "Min displacement for a heading check", config.JAM_CROSSCHECK_MIN_REVERSAL_KM,
                    "km",
                    "Below this much movement between two fixes, ordinary GPS jitter dominates the implied"
                    " bearing and it is not compared against the reported heading at all.",
                ),
                _field(
                    "max_heading_deviation_deg", "Max heading deviation", config.JAM_CROSSCHECK_MAX_HEADING_DEVIATION_DEG,
                    "degrees",
                    "Past JAM_CROSSCHECK_MIN_REVERSAL_KM of movement, a displacement whose own bearing"
                    " disagrees with the reported heading by more than this is called a reversal.",
                ),
                _field(
                    "min_samples", "Minimum samples for a clean verdict", config.JAM_CROSSCHECK_MIN_SAMPLES, "samples",
                    "Fewer qualifying position-delta pairs than this for one airframe, while it sat inside"
                    " a currently-tracked jam cell, and \"no anomaly found\" is not yet a real \"checked,"
                    " clean\" verdict.",
                ),
                _field(
                    "window_seconds", "Rolling window", config.JAM_CROSSCHECK_WINDOW_SECONDS, "seconds",
                    "How long a sampled or flagged aircraft stays counted against a jam cell in the served"
                    " document -- a true rolling window (old samples age out, not merely an idle aircraft's"
                    " own state entry) -- what \"N aircraft showed a position anomaly here\" actually covers.",
                ),
                _field(
                    "min_flag_ratio", "Minimum flagged fraction for a cell", config.JAM_CROSSCHECK_MIN_FLAG_RATIO,
                    "fraction of observed aircraft",
                    "A cell's own status only reads \"flagged\" once at least this fraction of its observed"
                    " aircraft are flagged, not merely one -- a busier cell has proportionally more chances"
                    " to produce a single noisy flag by chance alone.",
                ),
            ],
        },
        "military_bases": {
            "label": "OSM-to-curated military base matching",
            "governs": "backend.infrastructure._closest_curated_match",
            "fields": [
                _field(
                    "base_match_radius_km", "Match radius", infrastructure.BASE_MATCH_RADIUS_KM, "km",
                    "An OpenStreetMap military site is matched to a curated installation only when exactly"
                    " one curated site falls within this radius -- two or more within it refuses the match"
                    " rather than guessing which one it is.",
                ),
            ],
        },
    }
