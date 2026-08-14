"""A departure or an arrival, inferred from the one thing ADS-B actually
broadcasts: a transponder's own on_ground flag and altitude, at a lat/lon.

The aviation twin of backend/refine/port_calls.py, and worth reading that
module's docstring first -- the incremental-cursor-plus-persisted-state shape
below is copied from it wholesale, not reinvented. What differs is what
counts as evidence.

**Why this reads entity_history incrementally, and where the airfield comes
from.** Same reasoning as port_calls: entity_history is ~11 GB and grows with
every polled position, so this reads it through an ever-advancing id cursor
(kept in reference_snapshots under "flight_legs_cursor"), bounded per pass by
BATCH_LIMIT. Unlike port_calls, this module never builds an airfield index of
its own: backend/sources/adsb.py already attaches `nearest_airfield`
(name/code/km) to every position it records below
NEAREST_AIRFIELD_MAX_ALT_FT or on the ground, so this just reads that field
back off the stored payload rather than rebuilding the same OurAirports
lookup a second time.

**Open and close.** A leg opens the moment `on_ground` is seen to go from
true to false -- an observed takeoff -- or the moment recorded altitude
climbs through ALTITUDE_TRANSITION_FT while within
ALTITUDE_AIRFIELD_RADIUS_KM of a known field, which catches an airframe whose
on_ground flag never reliably reads true near a runway (gliders, some GA
transponders) but is plainly climbing away from an airfield. It closes on the
mirror image of either condition. Both origin_code and dest_code come from
the very `nearest_airfield` reading attached to the row that triggered the
transition -- a proximity read, exactly as honestly labelled on the live
layer, never a filed arrival.

**Confidence, honestly -- the whole point of this module.** ADS-B broadcasts
no flight plan. `observed_both` means this job watched the airframe leave the
ground and later watched it return to it (or the altitude-threshold
equivalent of either). `observed_one` means one end was watched and the other
was not -- either a leg still open, waiting on an arrival this job hasn't
seen yet, or a leg whose *arrival* was watched but whose departure was not.
`inferred` is the one case where neither end was watched at all: the very
first entity_history row this job has ever read for an airframe already
shows it airborne, with no earlier row to compare against, so there is no
transition to detect at all. The honest answer to "when did this aircraft
leave the ground" is bounded by how far back entity_history's own retention
(and this job's own cursor) happen to reach, not by anything observed -- so
`departed_at` is set to that first sighting and the leg opens `inferred`
rather than implying a takeoff this job never saw. If such a leg is later
watched to land, that landing *is* a real observation and the leg is written
`observed_one` from then on (one end watched, not two) -- it never becomes
`observed_both`, because the departure genuinely never was.

**max_alt_ft and distance_km are recomputed on every pass that touches an
open leg, not written once at open and once at close.** A card reading an
in-progress leg (see GET /api/aircraft/{icao24}) would otherwise show the
departure's own altitude and a zero distance until the aircraft happened to
land -- an honest number that is also a stale and useless one for a flight
that has been airborne for hours. Both accumulate in the per-airframe state
persisted across passes, and each write to storage carries the running
total, matching record_flight_legs' own note that distance_km is overwritten
wholesale on every write, never summed by Postgres.

**A coverage gap is not evidence of anything.** `last` (this airframe's most
recent processed row) is compared against every new row to detect a
transition, but a stale `last` is not "the state immediately before this
one" -- it is just the last thing this job happened to see, arbitrarily long
ago. Task 23 review, Critical: without a bound, an airframe that departs,
goes dark for weeks (out of range, transponder off, deregistered), and later
resurfaces on the ground somewhere else had that entire blackout compared as
an ordinary two-poll gap -- the resumption read as a genuine, continuously
observed arrival (`observed_both`), and the single straight-line hop across
the whole gap was folded into `distance_km` as though it were recorded
track. COVERAGE_GAP_SECONDS bounds this: a row more than that long after
`last` resets the comparison to "unknown" (the same state a genuinely
first-ever sighting starts from -- see `continuous` in `_advance`), and any
leg still open across the gap is abandoned rather than closed, so its last
honestly-written state (already durably stored from before the gap) stands
as the record rather than being overwritten with a fabricated arrival.

**last_seen_at is the field that makes an abandoned leg legible.** Task 23
review, Important 1: `observed_one` alone does not distinguish "departed ten
minutes ago, still climbing" from "we stopped hearing from this airframe
eleven weeks ago" -- both are an open leg with one end watched. last_seen_at
is the ts of the most recent row that actually touched the leg (open or
still accumulating), so a reader -- and GET /api/aircraft/{icao24} -- can
compare it against now and say which one this is, rather than the record
looking equally fresh either way.

**The altitude threshold has hysteresis.** Task 23 review, Minor: a reading
oscillating in barometric noise (or a circuit aircraft genuinely levelling)
around the plain 1,500 ft line would otherwise flip departure/arrival on
every crossing, spawning a near-zero-duration leg per wobble.
ALTITUDE_HYSTERESIS_FT means a state, once established, only flips on a
reading that clears the *far* side of the band -- see `_altitude_state`.
"""

import asyncio
import copy
import logging
import re

from backend import config, storage
from backend.refine import _cursor
from backend.sources.proximity import haversine_km

log = logging.getLogger("osint-globe.flight_legs")

CURSOR_NAME = "flight_legs_cursor"
STATE_NAME = "flight_legs_state"
HEALTH_NAME = "flight_legs"

# Bump this whenever flight_legs_state's own on-disk shape changes -- see
# backend/refine/_cursor.py's load_state and port_calls.py's own identical
# comment (Task 52), which this mirrors exactly: every flight_legs_state
# document on disk before this change is a bare {icao24: entry} map with no
# "schema_version" key, which _cursor.load_state treats as version 1 by
# default. This change wraps that map under its own "entities" key alongside
# the version stamp -- a bare top-level "schema_version" key would otherwise
# collide with a real icao24, since every other top-level key in this
# document is read as one (see _prune_state). Version 2 is deliberately the
# *first* version this deploy expects, so that wrapping change is itself what
# this guard visibly (logged, not silent) recovers from on rollout. Bump
# again, past 2, whenever a *later* shape change happens to the per-airframe
# entry shape inside "entities".
STATE_SCHEMA_VERSION = 2

# Rows read from entity_history per pass -- see port_calls.BATCH_LIMIT for the
# full reasoning. Kept at the same figure: the cost is an index-scan against
# idx_history_kind_id, which is no cheaper per row for "adsb" than "ais".
BATCH_LIMIT = 200_000

# The altitude-threshold open/close path exists for airframes whose on_ground
# flag never reliably reads true near a runway (gliders, some GA
# transponders) -- see backend/sources/adsb.py's own NEAREST_AIRFIELD_MAX_ALT_FT
# for the same "below this, proximity means something" reasoning at a coarser
# threshold. 1,500 ft is the brief's own number: comfortably inside a normal
# traffic-pattern altitude, well clear of cruise.
ALTITUDE_TRANSITION_FT = 1500
# Hysteresis half-band around ALTITUDE_TRANSITION_FT -- see _altitude_state
# and the module docstring's "The altitude threshold has hysteresis" section
# (Task 23 review, Minor). 150 ft is the same order of magnitude as
# decorators.js's VERTICAL_TREND_THRESHOLD_M (~200 ft): comfortably above
# barometric quantisation and fix-to-fix jitter at a level altitude, without
# being so wide that a genuine, tight circuit never clears it.
ALTITUDE_HYSTERESIS_FT = 150
# Tighter than adsb.py's own 40 km NEAREST_RADIUS_KM on purpose: a threshold
# crossing 35 km from the nearest field is not evidence of a departure or
# arrival there -- only that the aircraft happened to pass beneath 1,500 ft
# somewhere along a route that field is nowhere near.
ALTITUDE_AIRFIELD_RADIUS_KM = 10.0

# How long a per-airframe state entry with no open leg is kept before a pass
# drops it -- see port_calls.STATE_PRUNE_SECONDS, same reasoning, same
# figure. It exists only to detect the *next* on_ground/altitude transition,
# and a reading this old is not worth carrying forever in a document every
# pass rewrites. An airframe that goes quiet longer than this and later
# reappears already airborne just opens an `inferred` leg from that later
# row, the same as any airframe this job has never seen before.
STATE_PRUNE_SECONDS = 6 * 3600

# How many per-airframe entries with no currently open leg this state
# document keeps before the oldest of them are evicted on append -- a bound
# STATE_PRUNE_SECONDS alone does not provide, because it only ages an entry
# out once it personally goes quiet for six hours; it does nothing to limit
# how many *distinct* airframes can pile up inside that same six-hour window
# in the first place. Postgres is unreachable from this environment, so this
# is not a fresh live measurement of flight_legs_state itself -- it is a
# judgment call, sized from the closest citable analogue this codebase has:
# jam_crosscheck_state's own per-airframe "last" bridge, the same shape
# (on_ground/altitude bookkeeping, keyed by icao24, read off the same "adsb"
# entity_history rows, pruned by this module's own STATE_PRUNE_SECONDS
# figure), measured live in review at 9,928 entries (889 KB of a 910 KB
# document) against ~26,873 distinct airframes seen in that six-hour window
# -- a real ceiling near 2.4 MB for a document this job, like that one, deep-
# copies and re-serialises on every pass. FLIGHT_LEGS_STATE_CAP is set with
# headroom above that measured population (roughly 1.5x) rather than at it,
# so an ordinary busy day is never the thing doing the evicting -- only a
# population genuinely larger than any day this map has actually measured
# (a flood of spoofed or transient ICAO24 addresses, for instance) is.
# Worst case: at most FLIGHT_LEGS_STATE_CAP entries with no open leg
# (on_ground, altitude_state, ts -- on the order of 100 bytes each, smaller
# than jam_crosscheck's own per-entry figure above) plus every entry that
# does have one, which this cap never evicts -- see _evict_state below for
# why, and backend/app.py's own /api/aircraft docstring ("~17,000 aircraft
# ... at once") for why that second population does not need a cap of its
# own: this map cannot simultaneously track more open legs than it is
# simultaneously tracking airframes in the air.
FLIGHT_LEGS_STATE_CAP = 40_000

# How much wall-clock time may separate two consecutive entity_history rows
# before this job stops trusting the earlier one as "this airframe's own
# immediately preceding state" -- see the module docstring's "A coverage gap
# is not evidence of anything" section (Task 23 review, Critical).
# entity_history only gains a row when the entity actually moved (see
# backend/storage.py), and an airborne aircraft is essentially always
# moving, so under genuinely continuous coverage consecutive rows track the
# poll cadence closely. Set to twice the slowest cadence this source runs at
# (config.ADSB_POLL_INTERVAL_ANON, unauthenticated OpenSky, 900s) -- headroom
# for one missed poll, without being anywhere close to wide enough to mistake
# a real, multi-day blackout for a normal gap.
COVERAGE_GAP_SECONDS = 2 * config.ADSB_POLL_INTERVAL_ANON


def _altitude(payload: dict) -> float | None:
    alt = payload.get("altitude")
    return float(alt) if isinstance(alt, (int, float)) and not isinstance(alt, bool) else None


def _nearest_airfield(payload: dict) -> dict | None:
    field = payload.get("nearest_airfield")
    return field if isinstance(field, dict) else None


def _airfield_within(payload: dict, radius_km: float) -> dict | None:
    """The nearest_airfield reading backend/sources/adsb.py already attached
    to this row, if it is within `radius_km` -- None otherwise, including when
    no airfield was close enough for adsb.py to attach one at all."""
    field = _nearest_airfield(payload)
    km = field.get("km") if field else None
    return field if isinstance(km, (int, float)) and km <= radius_km else None


def _airfield_code(field: dict | None) -> str | None:
    return field.get("code") if field else None


def _altitude_state(altitude: float | None, prior_state: str | None) -> str | None:
    """Which side of ALTITUDE_TRANSITION_FT this reading sits on, with
    hysteresis: once a state is established, only a reading that clears the
    *far* side of the ALTITUDE_HYSTERESIS_FT band flips it back (see the
    module docstring's "The altitude threshold has hysteresis" section), so
    an altitude oscillating in barometric noise near the plain threshold
    stops toggling departure/arrival on every crossing. A reading of None
    leaves whatever state was already established alone rather than
    resetting it -- a single unreadable altitude is not evidence the
    airframe moved to the other side. `prior_state=None` (no state
    established yet -- a fresh airframe, or a comparison reset by a coverage
    gap) classifies directly against the plain midpoint, since there is
    nothing yet to apply hysteresis relative to."""
    if altitude is None:
        return prior_state
    if prior_state == "above":
        return "below" if altitude < ALTITUDE_TRANSITION_FT - ALTITUDE_HYSTERESIS_FT else "above"
    if prior_state == "below":
        return "above" if altitude > ALTITUDE_TRANSITION_FT + ALTITUDE_HYSTERESIS_FT else "below"
    return "above" if altitude >= ALTITUDE_TRANSITION_FT else "below"


def _open_leg(ts: float, lat: float, lon: float, payload: dict, departure_observed: bool) -> dict:
    return {
        "departed_at": ts,
        "departure_observed": departure_observed,
        "origin_code": _airfield_code(_nearest_airfield(payload)),
        "callsign": (payload.get("callsign") or "").strip() or None,
        "max_alt_ft": _altitude(payload),
        "distance_km": 0.0,
        "last_lat": lat,
        "last_lon": lon,
        "arrived_at": None,
        "dest_code": None,
        "arrival_observed": False,
        # The ts of the row that opened it, updated on every row that
        # touches this leg thereafter (see _accumulate) -- see the module
        # docstring's "last_seen_at is the field..." section.
        "last_seen_at": ts,
    }


def _accumulate(leg: dict, ts: float, lat: float, lon: float, payload: dict) -> None:
    """Folds one more recorded position into an open leg's running totals.
    Called for every row seen while a leg is open, including the row that
    closes it, so distance_km and max_alt_ft reflect the whole recorded
    track rather than only its first and last fixes. `ts` is only ever this
    row's own timestamp -- see the caller in _advance, which never reaches
    here across a coverage gap (the leg is abandoned first)."""
    leg["distance_km"] = leg.get("distance_km", 0.0) + haversine_km(leg["last_lat"], leg["last_lon"], lat, lon)
    leg["last_lat"], leg["last_lon"] = lat, lon
    leg["last_seen_at"] = ts
    altitude = _altitude(payload)
    if altitude is not None:
        leg["max_alt_ft"] = max(leg.get("max_alt_ft") or altitude, altitude)
    # Opportunistic backfill, never overwrite: an airframe can take a few
    # seconds after wheels-up to broadcast a callsign, so the row that opened
    # the leg is not always the first row that carries one.
    if not leg.get("callsign"):
        callsign = (payload.get("callsign") or "").strip() or None
        if callsign:
            leg["callsign"] = callsign


def _confidence(leg: dict) -> str:
    departed, arrived = leg["departure_observed"], leg.get("arrival_observed", False)
    if departed and arrived:
        return "observed_both"
    if departed or arrived:
        return "observed_one"
    return "inferred"


def _leg_row(icao24: str, leg: dict) -> dict:
    """One leg's current state, as storage.record_flight_legs expects (see
    _flight_leg_row in backend/storage.py, which reads exactly these keys)."""
    return {
        "icao24": icao24,
        "departed_at": leg["departed_at"],
        "arrived_at": leg.get("arrived_at"),
        "origin_code": leg.get("origin_code"),
        "dest_code": leg.get("dest_code"),
        "callsign": leg.get("callsign"),
        "max_alt_ft": int(round(leg["max_alt_ft"])) if leg.get("max_alt_ft") is not None else None,
        "distance_km": round(leg.get("distance_km", 0.0), 1),
        "confidence": _confidence(leg),
        "last_seen_at": leg.get("last_seen_at"),
    }


def _advance(icao24: str, rows: list[dict], entry: dict) -> tuple[dict | None, list[dict]]:
    """Walks one airframe's new positions in order, carrying `entry` (this
    icao24's state from the previous pass, or {} the first time it is seen)
    forward. Returns the updated entry (None if there is nothing left worth
    keeping) and any legs to upsert -- at most one per leg actually opened,
    updated or closed while walking this batch, never one row per position.
    """
    leg = entry.get("leg")
    last = entry.get("last")
    upserts: list[dict] = []
    leg_dirty = False  # whether `leg` changed since the last time it was upserted

    for row in rows:
        payload = row.get("payload") or {}
        ts, lat, lon = row["ts"], row["lat"], row["lon"]
        on_ground = payload.get("on_ground")
        altitude = _altitude(payload)

        # `continuous` is the coverage-gap bound (Task 23 review, Critical --
        # see COVERAGE_GAP_SECONDS and the module docstring): False for a
        # genuinely first-ever row (`last` absent) exactly as before, but now
        # also False when `last` exists but is too old to trust as this
        # airframe's own immediately preceding state. Either way, the prior
        # reading is treated as unknown rather than compared against.
        continuous = last is not None and (ts - last.get("ts", ts)) <= COVERAGE_GAP_SECONDS
        prior_on_ground = last.get("on_ground") if continuous else None
        prior_altitude_state = last.get("altitude_state") if continuous else None
        altitude_state = _altitude_state(altitude, prior_altitude_state)

        if leg is not None and not continuous:
            # Coverage broke while this leg was open. Abandon it rather than
            # let this row's on_ground/altitude masquerade as an arrival this
            # job never actually watched -- whatever was last durably written
            # for it (open, unresolved, with the last_seen_at that write
            # carried) already stands as the honest record of how far this
            # job actually saw it. This row may still open a brand new leg
            # below, entirely independent of the abandoned one.
            leg = None

        departure = arrival = False
        if isinstance(prior_on_ground, bool) and isinstance(on_ground, bool):
            if prior_on_ground and not on_ground:
                departure = True
            elif not prior_on_ground and on_ground:
                arrival = True
        if not departure and not arrival and prior_altitude_state is not None:
            if _airfield_within(payload, ALTITUDE_AIRFIELD_RADIUS_KM) is not None:
                if prior_altitude_state == "below" and altitude_state == "above":
                    departure = True
                elif prior_altitude_state == "above" and altitude_state == "below":
                    arrival = True

        if leg is None:
            if departure:
                leg = _open_leg(ts, lat, lon, payload, departure_observed=True)
                leg_dirty = True
            elif not continuous and on_ground is False:
                # Either a genuinely first-ever row, or a row resuming after
                # a gap too long to trust -- either way there is no prior
                # reading to compare against, so nothing was observed
                # departing. See the module docstring's "inferred" case.
                # departed_at is bounded by how far back this job can
                # actually see, not by a takeoff this job witnessed.
                leg = _open_leg(ts, lat, lon, payload, departure_observed=False)
                leg_dirty = True
        else:
            _accumulate(leg, ts, lat, lon, payload)
            leg_dirty = True
            if arrival:
                leg["arrived_at"] = ts
                leg["dest_code"] = _airfield_code(_nearest_airfield(payload))
                leg["arrival_observed"] = True
                # Write the closed leg now rather than waiting for the batch
                # to end: a quick turnaround (or a catch-up pass spanning
                # days of backlog) can open a fresh leg for the same
                # airframe later in this same batch, and that must not
                # silently overwrite this one in `leg` before it was ever
                # recorded.
                upserts.append(_leg_row(icao24, leg))
                leg = None
                leg_dirty = False

        last = {"on_ground": on_ground, "altitude_state": altitude_state, "ts": ts}

    if leg is not None and leg_dirty:
        upserts.append(_leg_row(icao24, leg))

    new_entry: dict = {}
    if last is not None:
        new_entry["last"] = last
    if leg is not None:
        new_entry["leg"] = leg
    return (new_entry if new_entry else None), upserts


def apply_positions(rows: list[dict], state: dict) -> tuple[list[dict], dict]:
    """One batch of entity_history rows (oldest first, as entity_history_since
    returns them) -> (legs to upsert, the state to persist for next time).

    Pure and DB-free: `state` is a plain {icao24: entry} dict, not a live
    connection -- see backend/tests/test_flight_legs.py. This is the
    unwrapped shape "flight_legs_state" actually persists under its own
    "entities" key alongside a "schema_version" stamp -- see _load_state and
    STATE_SCHEMA_VERSION's own comment -- so apply_positions itself, and
    every existing test of it, never has to know that wrapper exists. The
    input `state` is never mutated:
    _advance is handed a deep copy of each airframe's entry, matching
    port_calls.apply_positions' own reasoning (a caller that retries a batch
    on `state` it already holds must get a second, independent result rather
    than one built on an entry the first attempt already mutated in place).
    """
    by_aircraft: dict[str, list[dict]] = {}
    for row in rows:
        by_aircraft.setdefault(str(row["entity_id"]), []).append(row)

    upserts: list[dict] = []
    new_state = dict(state)
    for icao24, aircraft_rows in by_aircraft.items():
        prior_entry = copy.deepcopy(state.get(icao24)) if state.get(icao24) else {}
        entry, aircraft_upserts = _advance(icao24, aircraft_rows, prior_entry)
        if entry:
            new_state[icao24] = entry
        else:
            new_state.pop(icao24, None)
        upserts.extend(aircraft_upserts)
    return upserts, new_state


def _prune_state(state: dict, now_ts: float) -> dict:
    """Drops per-airframe entries that are neither an open leg nor recent --
    see STATE_PRUNE_SECONDS. Mirrors port_calls._prune_state exactly."""
    kept = {}
    for icao24, entry in state.items():
        if entry.get("leg") is not None:
            kept[icao24] = entry
            continue
        last = entry.get("last") or {}
        if now_ts - last.get("ts", 0) <= STATE_PRUNE_SECONDS:
            kept[icao24] = entry
    return kept


def _evict_state(state: dict, cap: int) -> dict:
    """Bounds `state`'s population at `cap`, on top of (not instead of)
    _prune_state's own time-based pruning -- see FLIGHT_LEGS_STATE_CAP's own
    comment on why a time bound alone is not a population bound.

    An entry with a currently open leg (`entry.get("leg") is not None`) is
    never evicted here, no matter how far over `cap` the state has grown.
    That asymmetry is deliberate, and mirrors vessel_profile.HULL_CAP's own
    "evicted by staleness" ruling exactly for the entries this *does* evict:
    an entry with no open leg exists only to bridge to the next
    on_ground/altitude transition, so dropping the oldest of those first
    keeps this job watching the present, the same trade-off HULL_CAP makes
    for a hull profile nobody has heard from in weeks. But an *open* leg is
    not a bridge to a future observation waiting to happen -- it is itself
    unwritten data, a departure this job already watched, still waiting on
    an arrival. Evicting it would not merely lose a stale bridge worth
    rebuilding; the leg itself would cease to exist, unclosed, forever --
    the exact failure this module's own "A coverage gap is not evidence of
    anything" docstring section already names as a Task 23 review Critical,
    reached here by a different door (a population cap instead of a stale
    comparison). So open legs are excluded from both the count against
    `cap` and the eviction candidates entirely: this only ever trims entries
    that exist purely to watch for a transition that has not happened yet.

    If open legs alone already meet or exceed `cap` -- which would mean this
    map is simultaneously tracking as many in-flight departures as
    FLIGHT_LEGS_STATE_CAP itself, well past the ~17,000-aircraft figure
    FLIGHT_LEGS_STATE_CAP's own comment cites -- every closable entry is
    evicted and the state is still left over `cap`. That is not a promise
    this function breaks; it never promised to bound entries it will not
    touch, only the ones it is safe to."""
    open_legs = {icao24: entry for icao24, entry in state.items() if entry.get("leg") is not None}
    closable = {icao24: entry for icao24, entry in state.items() if entry.get("leg") is None}
    if len(open_legs) + len(closable) <= cap:
        return state
    keep_count = max(cap - len(open_legs), 0)
    ranked = sorted(closable.items(), key=lambda kv: (kv[1].get("last") or {}).get("ts", 0.0), reverse=True)
    return {**open_legs, **dict(ranked[:keep_count])}


async def _load_state() -> dict:
    """flight_legs_state's own {icao24: entry} map, or {} if there is none
    yet or the stored shape does not match STATE_SCHEMA_VERSION -- see
    _cursor.load_state and this module's own STATE_SCHEMA_VERSION comment.
    The document on disk wraps that flat map under its own "entities" key,
    alongside the version stamp; unwrapped back here so apply_positions/
    _prune_state (and every existing test of them) keep operating on the
    same plain {icao24: entry} dict they always have."""
    doc = await _cursor.load_state(storage, STATE_NAME, STATE_SCHEMA_VERSION, job_name="flight_legs")
    entities = doc.get("entities")
    return entities if isinstance(entities, dict) else {}


async def run_once() -> dict:
    """One incremental pass. Returns a small summary for logging and health.

    Same cursor discipline as port_calls.run_once -- see that function's
    docstring for the full reasoning. record_flight_legs returns whether the
    batch is durably written; on False, the cursor and state document are
    both left exactly where they were, so the same batch is read again next
    pass rather than silently dropped (entity_history has its own retention,
    so a row once passed here is never offered again).

    **Write order, and why the state write's own result has to gate the
    cursor (pre-merge review, Critical).** Mirrors port_calls.run_once's own
    fix exactly, and for the identical reason: this used to write the state
    document and then the cursor unconditionally, discarding both bools. The
    failing sequence is the aviation twin of port_calls' own: a leg opens (the
    row lands via the durably-verified record_flight_legs above), the state
    write fails, the cursor write still lands regardless -- so the rows that
    opened this leg fall behind the cursor and are pruned from entity_history
    at three days, taking the only durable record of "leg": {"arrived_at":
    None, ...} with them. The leg never closes, and the next transition this
    airframe makes opens a second, unrelated leg, because the state that
    would have recognised "this icao24 already has an open leg" was never
    written. record_flight_legs is upsert-keyed (see storage.py), so it can
    run first, unconditionally -- but the state write can only be retried
    blind because apply_positions above was handed whatever `state` was still
    durably on disk; only once that write is itself confirmed durable is it
    safe to move the cursor past these rows. See test_a_failed_state_write_
    holds_the_cursor_back_and_does_not_double_the_open_leg in
    backend/tests/test_flight_legs.py.
    """
    cursor = await _cursor.load_cursor(storage, CURSOR_NAME)
    rows = await storage.entity_history_since("adsb", cursor, BATCH_LIMIT)
    if not rows:
        return {"read": 0, "legs": 0, "ok": True}

    state = await _load_state()
    upserts, new_state = apply_positions(rows, state)

    wrote = await storage.record_flight_legs(upserts)
    if not wrote:
        return {"read": len(rows), "legs": 0, "ok": False}

    pruned_state = _prune_state(new_state, rows[-1]["ts"])
    pruned_state = _evict_state(pruned_state, FLIGHT_LEGS_STATE_CAP)
    state_ok = await storage.record_reference(
        STATE_NAME, {"schema_version": STATE_SCHEMA_VERSION, "entities": pruned_state},
    )
    if not state_ok:
        return {"read": len(rows), "legs": 0, "ok": False}

    cursor_ok = await _cursor.advance_cursor(storage, CURSOR_NAME, rows[-1]["id"])
    if not cursor_ok:
        return {"read": len(rows), "legs": 0, "ok": False}

    return {"read": len(rows), "legs": len(upserts), "ok": True}


async def derive_forever():
    """The flight-leg derivation, for the life of the refine process.

    A plain interval, the same reasoning as port_calls.derive_forever: no
    transition detected here gets more correct from a tighter retry after a
    failure, so there is nothing to gain from anything but FLIGHT_LEG_INTERVAL.
    """
    while True:
        try:
            summary = await run_once()
            if summary["ok"]:
                log.info(
                    "Flight legs: read %d ADS-B movement rows, %d leg(s) opened, updated or closed",
                    summary["read"], summary["legs"],
                )
                await storage.record_source_health(HEALTH_NAME, summary["legs"], True)
            else:
                log.warning(
                    "Flight legs: read %d ADS-B movement rows but the write failed -- "
                    "the cursor was not advanced, so the same batch is retried next pass",
                    summary["read"],
                )
                await storage.record_source_health(
                    HEALTH_NAME, None, False,
                    "record_flight_legs failed to write this batch; the cursor was held "
                    "back and the same rows will be retried next pass",
                )
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Flight leg derivation failed: %s", exc)
            await storage.record_source_health(HEALTH_NAME, None, False, str(exc))
        await asyncio.sleep(config.FLIGHT_LEG_INTERVAL)


# ---------- aircraft cargo, honestly -----------------------------------------
#
# ADS-B carries no manifest and no cargo field -- the same honesty line as
# vessel_profile.py's implied_trade_sentence, see that function's own
# docstring. type_desc is only ever populated for airframes airplanes.live has
# reference data for (see backend/sources/adsb.py's normalize functions); the
# common freighter markers in that text are a trailing "F"/"PF"/"BCF"/"BDSF"/
# "SF" suffix (Freighter / Package Freighter / Boeing or Bedek Converted
# Freighter / Special Freighter) or the word itself -- the same kind of
# name-based heuristic airports.py's is_military_name already uses, and just
# as honest about missing a variant it doesn't recognise or over-matching one
# it does.
_FREIGHTER_RE = re.compile(
    r"\bfreighter\b|\((?:F|PF|BCF|BDSF|SF)\)|-\d{1,4}(?:F|PF|BCF|BDSF|SF)\b", re.I
)


def aircraft_cargo_hint(
    type_code: str | None,
    type_desc: str | None,
    operator: str | None,
    origin_code: str | None,
    dest_code: str | None,
) -> str | None:
    """"Aircraft class suggests freight" and nothing stronger -- never a
    commodity, never a manifest.

    None when nothing about the airframe's own type designator reads as a
    freighter variant. There is no signal here for anything short of that --
    this never guesses freight from operator or route alone, both of which
    fly plenty of passenger aircraft too.
    """
    label = (type_desc or "").strip() or (type_code or "").strip()
    if not label or not _FREIGHTER_RE.search(label):
        return None
    parts = [label]
    if operator:
        parts.append(f"operated by {operator}")
    if origin_code and dest_code:
        parts.append(f"tracked {origin_code} to {dest_code}")
    elif origin_code or dest_code:
        parts.append(f"tracked via {origin_code or dest_code}")
    return f"{', '.join(parts)} -- aircraft class suggests freight. No cargo or commodity is asserted."
