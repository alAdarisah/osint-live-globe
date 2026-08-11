"""Task 39: does an aircraft's own reported track do something physically
implausible while it happens to sit inside one of gpsjam.org's currently
worst-affected cells -- independent corroboration of a layer
(backend/sources/jamming.py) that otherwise stands alone.

**Read jamming.py's own module docstring first.** Two things about that
source matter enormously here and are easy to miss reading only this module:
it keeps only the worst MAX_CELLS (100) hexes worldwide, and the feed is
daily -- one row per hex per day. So "inside a jamming cell" here never means
"inside a jammed area"; it means "inside one of the hundred worst cells
gpsjam scored on the date attached to that cell's own record". An anomaly
over a genuinely jammed area that did not make the top hundred is invisible
to this module, and that absence is not evidence of anything -- see NOTE.

**What counts as implausible, and where the numbers come from.** Two shapes,
matching the brief: an implied ground speed above
config.JAM_CROSSCHECK_MAX_SPEED_KMH, or a displacement whose own bearing
disagrees with the airframe's reported heading by more than
config.JAM_CROSSCHECK_MAX_HEADING_DEVIATION_DEG (only evaluated past
config.JAM_CROSSCHECK_MIN_REVERSAL_KM of movement -- below that, ordinary GPS
jitter dominates the bearing calculation and it means nothing). All four
thresholds, plus the coverage-gap bound below, are read off this map's own
live entity_history rather than an airframe performance figure carried from
memory -- see each constant's own comment in backend/config.py for the exact
measurement. Deliberately not grounded in the ADS-B payload's own "velocity"
field: backend/sources/adsb.py stores that field in knots when it comes from
airplanes.live but in OpenSky's own raw units (metres/second) when it comes
from OpenSky, with no conversion between the two -- a pre-existing mismatch
nothing here is positioned to fix, and not something to build a hard
threshold on.

**The sampling-artefact problem, and why this module is not a coverage-gap
detector wearing a jamming hat.** A position jump implying an impossible
speed is far more often a dropped intermediate sample, a duplicate message or
a receiver-coverage handoff than it is jamming. config.JAM_CROSSCHECK_
MAX_GAP_SECONDS (twice the slowest ADS-B poll cadence, the same reasoning
backend/refine/flight_legs.py's own COVERAGE_GAP_SECONDS uses) is the first
guard: two fixes further apart than that are never compared at all, the same
"unknown, not continuous" treatment flight_legs gives a stale `last`. That
alone does not make every remaining flagged jump real corroboration, though
-- measured against this map's own live database (2026-08-11, gap-bounded
consecutive-fix pairs for an airborne airframe, n=12,364,411), 4,739 pairs
(0.038%) cleared the speed threshold and 15,223 (0.123%) cleared the heading
one, and of those, only 77 speed flags and 30 heading flags -- under 2% of
either raw count -- landed inside a cell gpsjam was reporting as jammed at
the time. That is the honest shape of this signal: the overwhelming majority
of raw flags are ordinary tracking noise with nothing to do with jamming at
all (receiver multipath, multilateration error, an ICAO24 briefly reused),
spread across thousands of distinct airframes rather than concentrated in a
handful of broken transponders -- and this module only ever reports the
small remainder that also happens to coincide with a reported cell. A flag
outside every currently-tracked cell is not recorded here at all (see
apply_batch below) -- required by Task 39's own test list, and the only way
to guarantee a reader can never read this product as "N aircraft in the
world showed anomalies", only "N aircraft showed one here".

**Provenance, exactly.** A cell's own (lat, lon, jam_ratio, date) are
`reported` -- gpsjam's own words, passed through unchanged. That an
airframe's position jumped or reversed is `measured` -- arithmetic
(haversine distance, bearing) over two reported ADS-B fixes. That the jump
happened inside a reported cell is `derived` -- set arithmetic, nothing more.
That jamming *explains* the jump is `inferred`, and NOTE below is the one
sentence every reader of this document gets that inference from, in place of
ever seeing it printed as an observation.

**"Found nothing" vs "did not look", four ways apart, matching the brief's
own list.** A cell with `status: "no_traffic"` (aircraft_observed == 0) is
not the same fact as one with `status: "clean"` (aircraft observed, none
flagged) -- the first is an absence of ADS-B coverage or traffic, the second
is coverage that found nothing wrong. `tracked_seconds` on every cell is
this module's own honesty check on either verdict: gpsjam's top-100 turns
over daily, so a cell that only entered it a few minutes before this pass
would read as "no_traffic" for a reason that has nothing to do with real
traffic -- this job simply has not watched it long enough yet. A whole
missing document (GET /api/jam-crosscheck's own "{}" before this job's first
pass) is the fourth: this map has not computed anything at all, never a
zero. And on the aircraft side, `insufficient_samples` (fewer than
config.JAM_CROSSCHECK_MIN_SAMPLES qualifying position-delta pairs recorded
for this airframe while it sat inside a tracked cell) is kept apart from
`checked_clean` (enough samples, none flagged) for the same reason
port_calls.py's PORT_SEARCH_RADIUS_KM rejection is counted rather than
silently dropped: a `0` standing in for "did not look" is the one class of
defect this whole plan keeps re-finding.

**Why this only tracks aircraft that have actually touched a tracked cell.**
This map's own ADS-B coverage runs to roughly seventeen thousand airframes at
once (see backend/app.py's own /api/aircraft docstring); the hundred worst
gpsjam cells cover a vanishingly small fraction of the globe. Carrying
sample/flag state for every airframe this map has ever seen, on the chance
it might one day cross one of those hundred cells, would be state that grows
with global ADS-B traffic rather than with anything this feature actually
measures. Instead, per-cell state (STATE_NAME's "cells" key) is the only
thing persisted across passes for the aircraft-level product, keyed by
whichever cells are in gpsjam's *current* top hundred -- a cell that drops
out of that list has its own state dropped too (see apply_batch), because
continuing to report old activity under a cell gpsjam no longer calls jammed
would misattribute it. GET /api/aircraft/{icao24} (backend/app.py) inverts
that per-cell state to answer one airframe's own question; an airframe that
has never sat inside a tracked cell simply has no entry, which the endpoint
and the card both render as its own honest state, never a silent omission
(see backend/app.py's aircraft_detail).

**Cursor discipline.** Same rule as every other refine job walking
entity_history through its own ever-advancing id cursor (see
backend/refine/port_calls.py's own docstring for the fullest statement of
why): the cursor only advances past a batch this pass actually finished
writing. entity_history is pruned at three days, so a write this pass drops
is a permanently lost slice of the record, not merely stale until the next
poll -- see run_once.
"""

import asyncio
import copy
import logging
import time

import h3

from backend import config, storage
from backend.sources.proximity import haversine_km, initial_bearing

log = logging.getLogger("osint-globe.jam_crosscheck")

CURSOR_NAME = "jam_crosscheck_cursor"
STATE_NAME = "jam_crosscheck_state"
REFERENCE_NAME = "jam_crosscheck"
HEALTH_NAME = "jam_crosscheck"

# Rows read from entity_history per pass. Same figure and the same reasoning
# as every other refine job walking this table (see port_calls.BATCH_LIMIT):
# bounded so a job that has fallen behind catches up over several passes
# instead of one pass becoming a scan of whatever backlog piled up.
BATCH_LIMIT = 200_000

# Must match jamming.py's own H3 resolution -- gpsjam publishes resolution-4
# cells, and containment only means anything if both sides agree what
# resolution "the cell" is at.
H3_RES = 4

# How long a per-airframe "last row" state entry with no bearing on any
# currently-tracked cell is kept before a pass drops it. Exists only to
# bridge a delta across passes/batches for whichever airframe reports next --
# see STATE_PRUNE_SECONDS' siblings in port_calls.py/flight_legs.py for the
# same reasoning at the same figure.
STATE_PRUNE_SECONDS = 6 * 3600

# How many of an airframe's own flags are kept, most recent first -- same
# "shortlist, not a re-listing of everything" bound cable_outage.py's own
# EVENTS_PER_COINCIDENCE uses.
FLAGS_PER_AIRCRAFT = 20

NOTE = (
    "This is corroboration, not detection. GPS jamming cells: gpsjam.org's own "
    "worst hundred H3 cells worldwide, reported once a day -- not a live map of "
    "where jamming is, and a cell falling out of that list is not evidence it "
    "stopped. Aircraft anomalies: this map's own ADS-B history, measured -- a "
    "position delta implying an implausible speed or a reversal inconsistent "
    "with the reported heading. That the two coincide, inside a cell gpsjam is "
    "currently reporting, is derived arithmetic; that jamming explains it is "
    "an inference, never an observation, and most flagged jumps never coincide "
    "with a tracked cell at all -- see this module's own docstring for the "
    "measured rate."
)

STATUS_FLAGGED = "flagged"
STATUS_CLEAN = "clean"
STATUS_NO_TRAFFIC = "no_traffic"

AIRCRAFT_FLAGGED = "flagged"
AIRCRAFT_CHECKED_CLEAN = "checked_clean"
AIRCRAFT_INSUFFICIENT = "insufficient_samples"


def _ang_diff(a: float, b: float) -> float:
    """Smallest angle between two compass bearings, [0, 180]."""
    d = abs(a - b) % 360.0
    return d if d <= 180.0 else 360.0 - d


def _heading(payload: dict):
    value = payload.get("heading")
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _cell_for(lat: float, lon: float) -> str | None:
    try:
        return h3.latlng_to_cell(lat, lon, H3_RES)
    except Exception:  # noqa: BLE001 - a bad coordinate just has no cell
        return None


def _classify_delta(last: dict, ts: float, lat: float, lon: float, heading) -> tuple[float, dict | None]:
    """One qualifying (continuous, both-airborne) consecutive pair -> its
    distance in km and either a flag dict or None.

    Distance is always returned (needed by the caller regardless of whether
    this pair flags, to decide if the displacement even clears
    JAM_CROSSCHECK_MIN_REVERSAL_KM for the heading check) -- see
    _advance_aircraft.
    """
    dt = ts - last["ts"]
    dist_km = haversine_km(last["lat"], last["lon"], lat, lon)
    speed_kmh = dist_km / (dt / 3600.0)
    if speed_kmh > config.JAM_CROSSCHECK_MAX_SPEED_KMH:
        return dist_km, {
            "type": "speed", "ts": ts, "lat": lat, "lon": lon,
            "speed_kmh": round(speed_kmh, 1), "distance_km": round(dist_km, 1), "seconds": round(dt, 1),
        }
    if dist_km >= config.JAM_CROSSCHECK_MIN_REVERSAL_KM and heading is not None:
        bearing = initial_bearing(last["lat"], last["lon"], lat, lon)
        deviation = _ang_diff(bearing, heading)
        if deviation > config.JAM_CROSSCHECK_MAX_HEADING_DEVIATION_DEG:
            return dist_km, {
                "type": "heading_reversal", "ts": ts, "lat": lat, "lon": lon,
                "heading_deg": round(heading, 1), "track_deg": round(bearing, 1),
                "deviation_deg": round(deviation, 1), "distance_km": round(dist_km, 1),
            }
    return dist_km, None


def apply_batch(rows: list[dict], jam_cells: dict[str, dict], state: dict, now: float) -> dict:
    """One batch of entity_history rows (kind="adsb", oldest first, as
    entity_history_since returns them), plus this pass's live read of
    gpsjam's current top hundred (`jam_cells`, {hex: {"lat","lon",
    "jam_ratio","date"}}) -> the state to persist for next time.

    Pure and DB-free, like every other refine job's own apply_* function
    (see port_calls.apply_positions) -- what a swallowed storage exception
    would otherwise hide, tested without a database. `state` is never
    mutated: a caller retrying a batch on `state` it still holds (see
    run_once) must get an independent result, not one built on an entry an
    earlier attempt already changed in place -- same reasoning port_calls'
    own apply_positions gives for its per-vessel deep copy.

    A flagged or merely-sampled pair is only ever recorded against a cell
    when the *anomalous* (later) fix's own position sits inside a hex
    `jam_cells` currently carries -- a jump whose later fix falls outside
    every currently-tracked cell contributes nothing to `state` at all, per
    Task 39's own required test case, and per the module docstring's own
    reasoning on why that has to be an omission rather than a label.
    """
    new_state = copy.deepcopy(state) if state else {}
    last_map: dict = new_state.setdefault("last", {})
    cells_state: dict = new_state.setdefault("cells", {})

    # A cell no longer in gpsjam's current top hundred is no longer a jammed
    # cell by this map's own reported source -- carrying its old aircraft
    # activity forward would misattribute it to a cell nothing currently
    # calls jammed. See the module docstring's own paragraph on this.
    for hex_id in list(cells_state.keys()):
        if hex_id not in jam_cells:
            del cells_state[hex_id]
    for hex_id in jam_cells:
        if hex_id not in cells_state:
            cells_state[hex_id] = {"tracked_since": now, "aircraft": {}}

    by_aircraft: dict[str, list[dict]] = {}
    for row in rows:
        by_aircraft.setdefault(str(row["entity_id"]), []).append(row)

    for icao, aircraft_rows in by_aircraft.items():
        last = last_map.get(icao)
        for row in aircraft_rows:
            payload = row.get("payload") or {}
            ts, lat, lon = row["ts"], row["lat"], row["lon"]
            on_ground = payload.get("on_ground")
            heading = _heading(payload)

            if (
                last is not None
                and 0 < (ts - last["ts"]) <= config.JAM_CROSSCHECK_MAX_GAP_SECONDS
                and last.get("on_ground") is not True
                and on_ground is not True
            ):
                _dist_km, flag = _classify_delta(last, ts, lat, lon, heading)
                cell_hex = _cell_for(lat, lon)
                cell_entry = cells_state.get(cell_hex) if cell_hex else None
                if cell_entry is not None:
                    aircraft_entry = cell_entry["aircraft"].setdefault(
                        icao, {"count": 0, "flag_count": 0, "last_ts": ts, "flags": []}
                    )
                    aircraft_entry["count"] += 1
                    aircraft_entry["last_ts"] = ts
                    if flag is not None:
                        flag["jam_cell"] = cell_hex
                        aircraft_entry["flag_count"] += 1
                        aircraft_entry["flags"] = (aircraft_entry["flags"] + [flag])[-FLAGS_PER_AIRCRAFT:]
                # cell_entry is None (no cell currently tracks this fix) ->
                # deliberately nothing recorded, flagged or not; see the
                # docstring above.

            last = {"ts": ts, "lat": lat, "lon": lon, "on_ground": on_ground}
        last_map[icao] = last

    cutoff_prune = now - STATE_PRUNE_SECONDS
    for icao in list(last_map.keys()):
        if last_map[icao]["ts"] < cutoff_prune:
            del last_map[icao]

    cutoff_window = now - config.JAM_CROSSCHECK_WINDOW_SECONDS
    for cell_entry in cells_state.values():
        aircraft = cell_entry["aircraft"]
        for icao in list(aircraft.keys()):
            if aircraft[icao]["last_ts"] < cutoff_window:
                del aircraft[icao]

    return new_state


def build_document(state: dict, jam_cells: dict[str, dict], now: float) -> dict:
    """`state` (jam_crosscheck_state, as apply_batch leaves it) plus this
    pass's live jam_cells read -> the document GET /api/jam-crosscheck serves
    and GET /api/aircraft/{icao24} reads a slice of.

    Rebuilt whole from `state` on every pass -- cheap, in-memory work over an
    accumulator already bounded to gpsjam's own hundred cells, the same
    "cheap to redo, no reason to diff" choice cable_outage.py's own
    build_document makes.
    """
    cells_state = state.get("cells", {})
    out_cells: dict[str, dict] = {}
    aircraft_index: dict[str, dict] = {}

    for hex_id, meta in jam_cells.items():
        entry = cells_state.get(hex_id, {"tracked_since": now, "aircraft": {}})
        aircraft = entry.get("aircraft", {})
        flagged_count = sum(1 for a in aircraft.values() if a.get("flag_count"))
        if flagged_count:
            status = STATUS_FLAGGED
        elif aircraft:
            status = STATUS_CLEAN
        else:
            status = STATUS_NO_TRAFFIC
        out_cells[hex_id] = {
            "hex": hex_id,
            "lat": meta.get("lat"),
            "lon": meta.get("lon"),
            "jam_ratio": meta.get("jam_ratio"),
            "date": meta.get("date"),
            "aircraft_observed": len(aircraft),
            "aircraft_flagged": flagged_count,
            "status": status,
            "tracked_seconds": max(0, round(now - entry.get("tracked_since", now))),
        }
        for icao, a in aircraft.items():
            idx = aircraft_index.setdefault(icao, {"sample_count": 0, "flag_count": 0, "cells": [], "flags": []})
            idx["sample_count"] += a.get("count", 0)
            idx["flag_count"] += a.get("flag_count", 0)
            idx["cells"].append(hex_id)
            idx["flags"].extend(a.get("flags", []))

    out_aircraft: dict[str, dict] = {}
    for icao, idx in aircraft_index.items():
        if idx["flag_count"]:
            status = AIRCRAFT_FLAGGED
        elif idx["sample_count"] >= config.JAM_CROSSCHECK_MIN_SAMPLES:
            status = AIRCRAFT_CHECKED_CLEAN
        else:
            status = AIRCRAFT_INSUFFICIENT
        flags = sorted(idx["flags"], key=lambda f: f.get("ts") or 0, reverse=True)[:FLAGS_PER_AIRCRAFT]
        out_aircraft[icao] = {
            "sample_count": idx["sample_count"],
            "flag_count": idx["flag_count"],
            "cells": idx["cells"],
            "flags": flags,
            "status": status,
        }

    return {
        "as_of": now,
        "window_seconds": config.JAM_CROSSCHECK_WINDOW_SECONDS,
        "min_samples": config.JAM_CROSSCHECK_MIN_SAMPLES,
        "provenance": "derived",
        "note": NOTE,
        "cells": out_cells,
        "aircraft": out_aircraft,
    }


async def _load_cursor() -> int:
    doc = await storage.reference(CURSOR_NAME)
    return int(doc["last_id"]) if isinstance(doc, dict) and isinstance(doc.get("last_id"), (int, float)) else 0


async def _load_state() -> dict:
    doc = await storage.reference(STATE_NAME)
    return doc if isinstance(doc, dict) else {}


async def _load_jam_cells() -> dict[str, dict]:
    """gpsjam's current top hundred, keyed by their own H3 hex id.

    Reads storage.entity_latest("jamming") -- the same table
    backend/sources/jamming.py's own poller writes via record_snapshot, and
    the same one backend/refine's own INPUTS mirror into event_fusion's
    registry -- never a second fetch of gpsjam.org (see the global rule that
    nothing in backend/refine makes an outbound call; test_refine_jobs.py's
    own test_no_refine_job_makes_an_outbound_call enforces it).

    `hex` falls back to a fresh h3.latlng_to_cell of the point's own stored
    centroid for a snapshot recorded before Task 39 started asking
    jamming.py to carry the id itself -- see that module's own comment on
    why the id is carried directly now rather than only ever rebuilt from
    the centroid. cell_to_latlng's own centroid maps back into the same cell
    it came from, so the fallback recovers the identical id; it exists only
    for a snapshot written by an older backend process during a rolling
    deploy, not as the normal path.
    """
    points = await storage.entity_latest("jamming")
    out: dict[str, dict] = {}
    for p in points or ():
        lat, lon = p.get("lat"), p.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        hex_id = p.get("hex") or _cell_for(lat, lon)
        if hex_id is None:
            continue
        out[hex_id] = {"lat": lat, "lon": lon, "jam_ratio": p.get("jam_ratio"), "date": p.get("date")}
    return out


async def run_once() -> dict:
    """One incremental pass. Returns a small summary for logging and health.

    Same cursor discipline as every other refine job reading entity_history
    through its own ever-advancing id cursor (see port_calls.run_once's own
    docstring for the fullest statement): the cursor is only advanced past a
    batch this pass actually finished writing durably. entity_history is
    pruned at three days, so a dropped write here is a permanently lost
    slice of the record, not merely stale until the next poll.

    Runs the state/document rebuild even when there are no new ADS-B rows to
    read: gpsjam's own top hundred can change (a cell drops out, or
    `tracked_seconds` simply keeps advancing for the rest) between passes
    with nothing new from ADS-B at all, and a reader should see that
    reflected rather than a document frozen at whichever pass last happened
    to see a new row. `now` falls back to wall-clock time in that case --
    there is no row timestamp to anchor pruning to instead.
    """
    cursor = await _load_cursor()
    rows = await storage.entity_history_since("adsb", cursor, BATCH_LIMIT)
    jam_cells = await _load_jam_cells()
    state = await _load_state()
    now = rows[-1]["ts"] if rows else time.time()

    new_state = apply_batch(rows, jam_cells, state, now)
    doc = build_document(new_state, jam_cells, now)

    state_ok = await storage.record_reference(STATE_NAME, new_state)
    doc_ok = state_ok and await storage.record_reference(REFERENCE_NAME, doc)
    if not doc_ok:
        return {"read": len(rows), "cells": len(jam_cells), "flags": 0, "ok": False}

    if rows:
        # Nothing to advance past when this pass read no rows at all -- the
        # cursor already sits at the right place, and a write here would
        # just be a no-op record of the same last_id.
        await storage.record_reference(CURSOR_NAME, {"last_id": rows[-1]["id"]})
    return {"read": len(rows), "cells": len(jam_cells), "flags": _count_flags(doc), "ok": True}


def _count_flags(doc: dict) -> int:
    return sum(c.get("aircraft_flagged", 0) for c in doc.get("cells", {}).values())


async def derive_forever():
    """The jamming/ADS-B cross-check derivation, for the life of the refine
    process.

    A plain interval, the same reasoning as flight_legs'/port_calls' own: an
    implausible jump is not detected any more correctly by retrying sooner
    after a failure, so nothing here is made more correct by a tighter loop.
    """
    while True:
        try:
            summary = await run_once()
            if summary["ok"]:
                log.info(
                    "Jam crosscheck: read %d ADS-B movement rows, %d tracked cell(s), %d flagged",
                    summary["read"], summary["cells"], summary["flags"],
                )
                await storage.record_source_health(HEALTH_NAME, summary["flags"], True)
            else:
                log.warning(
                    "Jam crosscheck: read %d ADS-B movement rows but the write failed -- "
                    "the cursor was not advanced, so the same batch is retried next pass",
                    summary["read"],
                )
                await storage.record_source_health(
                    HEALTH_NAME, None, False,
                    "a write for this pass failed; the cursor was held back and the same "
                    "rows will be retried next pass",
                )
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Jam crosscheck derivation failed: %s", exc)
            await storage.record_source_health(HEALTH_NAME, None, False, str(exc))
        await asyncio.sleep(config.JAM_CROSSCHECK_INTERVAL)
