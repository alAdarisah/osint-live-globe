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
"""

import asyncio
import copy
import logging
import re

from backend import config, storage
from backend.sources.proximity import haversine_km

log = logging.getLogger("osint-globe.flight_legs")

CURSOR_NAME = "flight_legs_cursor"
STATE_NAME = "flight_legs_state"
HEALTH_NAME = "flight_legs"

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
    }


def _accumulate(leg: dict, lat: float, lon: float, payload: dict) -> None:
    """Folds one more recorded position into an open leg's running totals.
    Called for every row seen while a leg is open, including the row that
    closes it, so distance_km and max_alt_ft reflect the whole recorded
    track rather than only its first and last fixes."""
    leg["distance_km"] = leg.get("distance_km", 0.0) + haversine_km(leg["last_lat"], leg["last_lon"], lat, lon)
    leg["last_lat"], leg["last_lon"] = lat, lon
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

        prior_on_ground = last.get("on_ground") if last else None
        prior_altitude = last.get("altitude") if last else None

        departure = arrival = False
        if isinstance(prior_on_ground, bool) and isinstance(on_ground, bool):
            if prior_on_ground and not on_ground:
                departure = True
            elif not prior_on_ground and on_ground:
                arrival = True
        if not departure and not arrival and prior_altitude is not None and altitude is not None:
            if _airfield_within(payload, ALTITUDE_AIRFIELD_RADIUS_KM) is not None:
                if prior_altitude < ALTITUDE_TRANSITION_FT <= altitude:
                    departure = True
                elif prior_altitude >= ALTITUDE_TRANSITION_FT > altitude:
                    arrival = True

        if leg is None:
            if departure:
                leg = _open_leg(ts, lat, lon, payload, departure_observed=True)
                leg_dirty = True
            elif last is None and on_ground is False:
                # The first row this job has ever read for this airframe, and
                # it is already airborne -- see the module docstring's
                # "inferred" case. Nothing was observed departing; departed_at
                # is bounded by how far back this job's own cursor happens to
                # reach, not by a takeoff this job actually saw.
                leg = _open_leg(ts, lat, lon, payload, departure_observed=False)
                leg_dirty = True
        else:
            _accumulate(leg, lat, lon, payload)
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

        last = {"on_ground": on_ground, "altitude": altitude, "ts": ts}

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

    Pure and DB-free: `state` is a plain dict shaped like the
    "flight_legs_state" reference document, not a live connection -- see
    backend/tests/test_flight_legs.py. The input `state` is never mutated:
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


async def _load_cursor() -> int:
    doc = await storage.reference(CURSOR_NAME)
    return int(doc["last_id"]) if isinstance(doc, dict) and isinstance(doc.get("last_id"), (int, float)) else 0


async def _load_state() -> dict:
    doc = await storage.reference(STATE_NAME)
    return doc if isinstance(doc, dict) else {}


async def run_once() -> dict:
    """One incremental pass. Returns a small summary for logging and health.

    Same cursor discipline as port_calls.run_once -- see that function's
    docstring for the full reasoning. record_flight_legs returns whether the
    batch is durably written; on False, the cursor and state document are
    both left exactly where they were, so the same batch is read again next
    pass rather than silently dropped (entity_history has its own retention,
    so a row once passed here is never offered again).
    """
    cursor = await _load_cursor()
    rows = await storage.entity_history_since("adsb", cursor, BATCH_LIMIT)
    if not rows:
        return {"read": 0, "legs": 0, "ok": True}

    state = await _load_state()
    upserts, new_state = apply_positions(rows, state)

    wrote = await storage.record_flight_legs(upserts)
    if not wrote:
        return {"read": len(rows), "legs": 0, "ok": False}

    await storage.record_reference(STATE_NAME, _prune_state(new_state, rows[-1]["ts"]))
    await storage.record_reference(CURSOR_NAME, {"last_id": rows[-1]["id"]})

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
