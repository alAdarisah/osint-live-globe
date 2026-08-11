"""A vessel sat still near a port for an hour, then left: a port call.

The inverse of dark_vessels.py's ship-to-ship exclusion (see
backend/sources/dark_vessels.py:328). That detector excludes a candidate
because it is near a port; this one exists *because* a vessel is near a port,
and reuses the same port index (curated infrastructure sites plus the NGA
World Port Index, see dark_vessels.port_index) rather than building a second
one.

**Why this reads entity_history incrementally.** That table is ~11 GB and
grows with global AIS (see the project-wide rule that it is never read on a
request path -- this is a scheduled refine job, so it may read it, but a full
scan every PORT_CALL_INTERVAL would still be a defect). A high-water mark --
the id of the newest entity_history row this job has already looked at -- is
kept in reference_snapshots under "port_calls_cursor", so every pass asks
Postgres for "everything past id N", bounded by BATCH_LIMIT, rather than
"everything". The first run ever, with no cursor stored, starts at id 0 and
therefore does see three days of pre-existing history -- but BATCH_LIMIT still
caps what any single pass reads, so that backlog is drained over a handful of
cycles rather than in one query that blocks the job for however long a cold
11 GB scan takes. See entity_history_since in backend/storage.py.

**Why per-vessel detection state is also persisted, not held in memory.** A
dwell has to last an hour and a departure has to sustain 30 minutes, both far
longer than the 15-minute interval between passes, so "is this hull mid-dwell"
has to survive across passes -- and across a restart of this container, which
happens for reasons that have nothing to do with any ship. It is kept
alongside the cursor, under "port_calls_state": one entry per mmsi currently
being tracked, pruned once it goes quiet (see _prune_state).

**Confidence, honestly.** AIS gives a position and a speed, never a berth.
`exact` / `proximity` / `inferred` is how far that honestly reaches -- see
_classify -- and a vessel sitting in a designated anchorage a few kilometres
off a port's charted point looks identical, from here, to one alongside a
quay. The tier is the whole claim; nothing downstream should read `exact` as
"confirmed berthed".
"""

import asyncio
import copy
import logging

from backend import config, storage
from backend.refine.port_call_thresholds import (
    PORT_EXACT_RADIUS_KM, PORT_PROXIMITY_RADIUS_KM, PORT_SEARCH_RADIUS_KM,
)
from backend.sources import dark_vessels
from backend.sources.proximity import ProximityIndex, haversine_km

log = logging.getLogger("osint-globe.port_calls")

CURSOR_NAME = "port_calls_cursor"
STATE_NAME = "port_calls_state"
HEALTH_NAME = "port_calls"

# Rows read from entity_history per pass. Bounded so that a job which has
# fallen behind -- a container restart after a day down, or the very first run
# against three days of pre-existing history -- catches up over several
# PORT_CALL_INTERVAL cycles instead of turning one pass into a scan of
# whatever backlog has piled up. 200k rows is comfortably inside a few
# seconds of index-scan work against idx_history_kind_id.
BATCH_LIMIT = 200_000

# Speed ≤ 0.5kn sustained for ≥ 1 hour is a dwell; the brief's own numbers.
DWELL_MAX_SPEED_KN = 0.5
DWELL_MIN_SECONDS = 3600

# Speed > 1.0kn sustained for ≥ 30 minutes is a departure. Deliberately a
# different (higher) speed than the dwell threshold and a shorter window than
# the dwell one: getting under way is a more decisive signal than coming to
# rest -- a ship swinging at anchor drifts across 0.5kn constantly, but rarely
# holds above 1.0kn without actually moving off.
DEPART_MIN_SPEED_KN = 1.0
DEPART_MIN_SECONDS = 1800

# PORT_EXACT_RADIUS_KM / PORT_PROXIMITY_RADIUS_KM / PORT_SEARCH_RADIUS_KM used
# to live here; they moved to backend/refine/port_call_thresholds.py (a leaf
# module with no other imports) so backend/app.py could read the same three
# numbers -- to tell a card what a stored `confidence` tier means in
# kilometres -- without importing this module's dark_vessels/ProximityIndex
# dependencies into the request-serving process. See that module's docstring
# for the full reasoning behind each threshold, including why "inferred" gets
# a ceiling at all.

# How long a per-vessel state entry with no active dwell/departure run is kept
# before a pass drops it. It exists only to answer "what was this hull doing
# just before it went slow", for draught_in -- and a reading that old is not
# worth carrying forever in a document every pass rewrites. A vessel that goes
# quiet for longer than this and later arrives somewhere just gets
# draught_in from its own arrival row instead of the one before it (see
# _advance), which is a smaller claim, not a wrong one.
STATE_PRUNE_SECONDS = 6 * 3600


def _speed_kn(payload: dict) -> float | None:
    speed = payload.get("speed")
    return float(speed) if isinstance(speed, (int, float)) and not isinstance(speed, bool) else None


def _draught_m(payload: dict) -> float | None:
    draught = payload.get("draught")
    return float(draught) if isinstance(draught, (int, float)) and not isinstance(draught, bool) else None


def _port_id(port: dict) -> str:
    return str(port.get("id") or port.get("name") or "unknown-port")


def _classify(lat: float, lon: float, ports: ProximityIndex) -> tuple[dict, str, float] | None:
    """The port this dwell belongs to, and how sure that attribution is.

    None means no port is close enough to attribute this to at all -- see
    PORT_SEARCH_RADIUS_KM -- which is the honest answer for a vessel anchored
    in open water rather than calling anywhere.
    """
    port = ports.nearest(lat, lon, PORT_SEARCH_RADIUS_KM)
    if port is None:
        return None
    distance_km = haversine_km(lat, lon, port["lat"], port["lon"])
    if distance_km <= PORT_EXACT_RADIUS_KM:
        confidence = "exact"
    elif distance_km <= PORT_PROXIMITY_RADIUS_KM:
        confidence = "proximity"
    else:
        confidence = "inferred"
    return port, confidence, distance_km


def _call_row(mmsi: str, run: dict, departed_at: float | None, draught_out: float | None) -> dict:
    """One call as storage.record_port_calls expects (see _port_call_row in
    backend/storage.py, which reads exactly these keys and nothing else)."""
    return {
        "mmsi": mmsi,
        "port_id": run["port_id"],
        "arrived_at": run["since"],
        "departed_at": departed_at,
        "draught_in": run.get("draught_in"),
        "draught_out": draught_out,
        "confidence": run["confidence"],
    }


def _advance(
    mmsi: str, rows: list[dict], ports: ProximityIndex, entry: dict
) -> tuple[dict | None, list[dict], int]:
    """Walks one vessel's new positions in order, carrying `entry` (this
    hull's state from the previous pass, or {} the first time it is seen)
    forward. Returns the updated entry (None if there is nothing left worth
    keeping), any calls to upsert, and how many dwells this vessel completed
    that could not be attributed to any port at all (see PORT_SEARCH_RADIUS_KM).

    `entry` holds two independent things:
      "last": the most recent row seen for this hull, of any speed -- used as
        draught_in when a *new* dwell run starts, because that is the vessel's
        state while still under way, not its state after it had already
        stopped (see the brief: "record draught_in from the last position
        before arrival").
      "run": the in-progress dwell ("candidate", not yet a call) or departure
        ("open", a call already exists and is waiting to close) accumulator,
        absent when this hull is neither dwelling nor mid-departure.
    """
    upserts: list[dict] = []
    rejected = 0
    run = entry.get("run")

    for row in rows:
        payload = row.get("payload") or {}
        speed = _speed_kn(payload)
        draught = _draught_m(payload)
        ts, lat, lon = row["ts"], row["lat"], row["lon"]

        prior_last = entry.get("last")
        entry["last"] = {"ts": ts, "draught": draught}

        if run is None or run["phase"] == "candidate":
            slow = speed is not None and speed <= DWELL_MAX_SPEED_KN
            if not slow:
                # Either genuinely moving, or a report with no speed we can
                # trust -- either way, no dwell is in progress at this row.
                run = None
                continue
            if run is None:
                run = {
                    "phase": "candidate",
                    "since": ts,
                    "lat": lat, "lon": lon,
                    "draught_in": prior_last["draught"] if prior_last else draught,
                }
            run["last_slow_draught"] = draught
            if ts - run["since"] >= DWELL_MIN_SECONDS:
                found = _classify(run["lat"], run["lon"], ports)
                if found is None:
                    # An hour stationary, but no indexed port within
                    # PORT_SEARCH_RADIUS_KM -- not attributable, whatever else
                    # it is (see that constant's comment on why this is a
                    # ruling, not an oversight). Counted so the job's own
                    # health row can say a dwell was seen and dropped, rather
                    # than reporting the same silence as "no dwell at all".
                    # Drop the run; if the vessel is still there next pass
                    # this simply tries again from that later row.
                    run = None
                    rejected += 1
                    continue
                port, confidence, _distance_km = found
                run["phase"] = "open"
                run["port_id"] = _port_id(port)
                run["confidence"] = confidence
                upserts.append(_call_row(mmsi, run, departed_at=None, draught_out=None))
        else:  # run["phase"] == "open": a call exists, watching for departure
            fast = speed is not None and speed > DEPART_MIN_SPEED_KN
            if not fast:
                # A blip above 0.5kn that never reached departure speed, or a
                # drop back to genuinely slow -- either way the ship has not
                # left. Reset any in-progress departure clock, but the call
                # stays open: this must never spawn a second one (see the
                # module's re-entry test).
                run.pop("moving_since", None)
                if speed is not None and speed <= DWELL_MAX_SPEED_KN:
                    run["last_slow_draught"] = draught
                continue
            if "moving_since" not in run:
                run["moving_since"] = ts
            if ts - run["moving_since"] >= DEPART_MIN_SECONDS:
                upserts.append(_call_row(
                    mmsi, run,
                    departed_at=run["moving_since"],
                    draught_out=run.get("last_slow_draught"),
                ))
                run = None  # closed; a fresh dwell can now open a new call

    entry.pop("run", None)
    if run is not None:
        entry["run"] = run
    return (entry if entry else None), upserts, rejected


def apply_positions(rows: list[dict], ports: ProximityIndex, state: dict) -> tuple[list[dict], dict, int]:
    """One batch of entity_history rows (oldest first, as entity_history_since
    returns them) -> (calls to upsert, the state to persist for next time,
    how many completed dwells could not be attributed to any port at all).

    Pure and DB-free: `state` is a plain dict shaped like the "port_calls_state"
    reference document, not a live connection, which is what makes this
    testable without a database (see backend/tests/test_port_calls.py). The
    input `state` is never mutated -- _advance is handed a deep copy of each
    vessel's entry, not a reference into the caller's dict, so a caller that
    retries a batch on `state` it already holds (see run_once) gets back a
    second, independent result rather than one built on an entry the first
    attempt already mutated in place.
    """
    by_vessel: dict[str, list[dict]] = {}
    for row in rows:
        by_vessel.setdefault(str(row["entity_id"]), []).append(row)

    upserts: list[dict] = []
    rejected = 0
    new_state = dict(state)
    for mmsi, vessel_rows in by_vessel.items():
        prior_entry = copy.deepcopy(state.get(mmsi)) if state.get(mmsi) else {}
        entry, vessel_upserts, vessel_rejected = _advance(mmsi, vessel_rows, ports, prior_entry)
        if entry:
            new_state[mmsi] = entry
        else:
            new_state.pop(mmsi, None)
        upserts.extend(vessel_upserts)
        rejected += vessel_rejected
    return upserts, new_state, rejected


def _prune_state(state: dict, now_ts: float) -> dict:
    """Drops per-vessel entries that are neither an active run nor recent.

    Without this the state document only grows: every hull AIS has ever
    reported through leaves a "last" entry behind. Pruning trades a small,
    honestly-labelled loss (a future dwell for that hull starts with
    draught_in from its own arrival row rather than the one before it,
    see _advance) for a document that stays proportional to how many hulls are
    actually near a port right now, not to how many have ever existed.
    """
    kept = {}
    for mmsi, entry in state.items():
        if entry.get("run") is not None:
            kept[mmsi] = entry
            continue
        last = entry.get("last") or {}
        if now_ts - last.get("ts", 0) <= STATE_PRUNE_SECONDS:
            kept[mmsi] = entry
    return kept


async def _load_cursor() -> int:
    doc = await storage.reference(CURSOR_NAME)
    return int(doc["last_id"]) if isinstance(doc, dict) and isinstance(doc.get("last_id"), (int, float)) else 0


async def _load_state() -> dict:
    doc = await storage.reference(STATE_NAME)
    return doc if isinstance(doc, dict) else {}


async def _load_ports() -> ProximityIndex:
    # entity_latest("ports"), not a fetch: backend/sources/ports.py already
    # collects the World Port Index, and dark_vessels.port_index combines it
    # with the curated harbours in backend/infrastructure.py into the one
    # index this job reuses rather than building a second one (see the module
    # docstring). An empty list here -- before ports.py has landed its first
    # snapshot -- degrades to the curated-only index, same as dark_vessels.
    wpi_ports = await storage.entity_latest("ports")
    return dark_vessels.port_index(wpi_ports)


async def run_once() -> dict:
    """One incremental pass. Returns a small summary for logging and health.

    The cursor is only ever advanced past rows this pass actually finished
    writing. storage.record_port_calls follows this codebase's rule that a
    write never raises -- a Postgres hiccup is logged and the poller carries
    on (see the module docstring on backend/storage.py) -- but that rule's own
    justification is that the *next poll* re-supplies the same live state.
    This job has no next poll for a given row: it consumes entity_history
    exactly once through an ever-advancing id cursor, and entity_history is
    pruned at three days, so an id once passed is never read again. "Logged
    and moved on" would therefore mean "logged and lost" here, not "stale
    until the next refresh" -- which is why record_port_calls also returns
    whether the batch is durably written, and this function reads that
    return value rather than treating "did not raise" as "succeeded".

    On a failed write, the state document and cursor are both left exactly
    where they were, so the same (idempotent, upsert-keyed) batch is read
    again next pass rather than silently skipped.

    **Write order, and why the state write's own result has to gate the
    cursor (pre-merge review, Critical).** This used to write the state
    document and then the cursor unconditionally, discarding both bools --
    which meant a state write dropped by a Postgres hiccup left the cursor
    advancing anyway. The failing sequence: this pass opens a dwell (the call
    row lands via the durably-verified record_port_calls above), the state
    write then fails, and the cursor write still lands. The rows that opened
    that dwell are now behind the cursor -- entity_history is pruned at three
    days, so this job never reads them again -- but the "run": {"phase":
    "open"} that record_port_calls' row depends on for its eventual departure
    was never durably saved. The call is stuck open forever, and the next
    dwell this hull has at the same port opens a second, unrelated call under
    a new arrived_at, because the state that would have recognised "this
    hull already has an open call here" was never written.
    record_port_calls is upsert-keyed on (mmsi, port_id, arrived_at), so
    retrying it on the very same `upserts` is safe -- that write can run
    first, unconditionally, matching backend/refine/lane_density.py's own
    "idempotent write first" ordering. The state write is not safe to retry
    blind, though: apply_positions above was handed whatever `state` was
    still durably on disk, so a retry that starts from that same untouched
    document reproduces an identical `new_state`; only once *that* write is
    confirmed durable is it safe to move the cursor past these rows -- moving
    it any earlier would let a state write that silently failed be
    permanently skipped, invisible until this vessel's next dwell quietly
    doubles up. See test_a_failed_state_write_holds_the_cursor_back_and_does_
    not_double_the_open_call in backend/tests/test_port_calls.py.
    """
    cursor = await _load_cursor()
    rows = await storage.entity_history_since("ais", cursor, BATCH_LIMIT)
    if not rows:
        return {"read": 0, "calls": 0, "rejected": 0, "ok": True}

    state = await _load_state()
    ports = await _load_ports()
    upserts, new_state, rejected = apply_positions(rows, ports, state)

    wrote = await storage.record_port_calls(upserts)
    if not wrote:
        return {"read": len(rows), "calls": 0, "rejected": rejected, "ok": False}

    state_ok = await storage.record_reference(STATE_NAME, _prune_state(new_state, rows[-1]["ts"]))
    if not state_ok:
        return {"read": len(rows), "calls": 0, "rejected": rejected, "ok": False}

    cursor_ok = await storage.record_reference(CURSOR_NAME, {"last_id": rows[-1]["id"]})
    if not cursor_ok:
        return {"read": len(rows), "calls": 0, "rejected": rejected, "ok": False}

    return {"read": len(rows), "calls": len(upserts), "rejected": rejected, "ok": True}


async def derive_forever():
    """The port-call derivation, for the life of the refine process.

    A plain interval, unlike dark_vessels' self-paced retry: a dwell has to
    run for an hour before it is even a candidate, so nothing here is made
    more correct by a faster retry after a failure. It still logs and moves on
    rather than raising -- see run_job in backend/refine/__init__.py, which is
    what actually catches a crash of this loop and turns the health row red.

    That leaves this function itself as the one place a *failed write*
    (run_once's "ok": False, as opposed to an exception) has to be turned into
    a red health row rather than a quietly-successful one -- run_once did not
    raise, so nothing upstream of here would otherwise know.
    """
    while True:
        try:
            summary = await run_once()
            rejected_note = (
                f"{summary['rejected']} dwell(s) this pass had no indexed port "
                f"within {PORT_SEARCH_RADIUS_KM:g}km and were not recorded"
                if summary["rejected"]
                else None
            )
            if summary["ok"]:
                log.info(
                    "Port calls: read %d AIS movement rows, %d calls opened or "
                    "closed, %d dwell(s) unattributable",
                    summary["read"], summary["calls"], summary["rejected"],
                )
                # rejected_note travels in the health row even when ok=True --
                # it is not a failure, but it is the one place a caller polling
                # source_health (rather than this container's own logs) can see
                # that some dwells went unrecorded rather than not happening.
                await storage.record_source_health(HEALTH_NAME, summary["calls"], True, rejected_note)
            else:
                log.warning(
                    "Port calls: read %d AIS movement rows but the write "
                    "failed -- the cursor was not advanced, so the same batch "
                    "is retried next pass",
                    summary["read"],
                )
                await storage.record_source_health(
                    HEALTH_NAME, None, False,
                    "record_port_calls failed to write this batch; the cursor "
                    "was held back and the same rows will be retried next pass",
                )
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Port call derivation failed: %s", exc)
            await storage.record_source_health(HEALTH_NAME, None, False, str(exc))
        await asyncio.sleep(config.PORT_CALL_INTERVAL)
