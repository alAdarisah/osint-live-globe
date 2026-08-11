"""Where we have seen ships -- never where shipping lanes are.

This grid is built the same way port_calls.py and vessel_profile.py build
theirs: entity_history read incrementally through an ever-advancing id cursor
("lane_density_cursor" in reference_snapshots), bounded per pass by
BATCH_LIMIT so a job that has fallen behind -- a restart, or the very first
run against three days of pre-existing history -- catches up over several
LANE_DENSITY_INTERVAL cycles instead of one pass turning into a scan of
whatever backlog piled up. See entity_history_since in backend/storage.py and
the same reasoning written out at more length in backend/refine/port_calls.py.

Unlike those two, this job keeps no per-entity state document across passes:
a cell's `transits` is "distinct MMSI seen in this run" (see compute_cells),
so one pass needs nothing from the last one beyond the cursor itself --
storage.upsert_lane_cells is what carries a cell's history forward, by
summing this pass's small delta into the row already on disk.

**What `transits` actually accumulates to, honestly.** Within one pass it is
a true distinct-hull count, per the brief. Across passes it is not: a hull
that sits in the same cell for a month is present in that cell's distinct-MMSI
set on every pass that finds it there, so storage.upsert_lane_cells adds 1 to
`transits` on every one of those passes -- about 720 over 30 days at the
default hourly cadence, the same number a strait that saw 720 different ships
pass through once each would produce. Deduplicating that would need a second
persisted state document (which cell each hull was last seen in, so a
loiterer counts once and only a genuine re-entry counts again) -- a real
option, not built here because it is more machinery than the brief asked for
and a straightforward thing to add later without touching the schema. Instead
this is named for what it is: GET /api/lanes exposes the field as
`sightings`, not `transits` (see backend/app.py's lanes_endpoint), and
test_lane_density.py pins the behaviour with a hull sitting still across
several passes.

**The grid, not the lanes.** A cell with traffic in it is a fact: this map's
own AIS coverage placed a ship there. A cell with *no* traffic in it is not
the absence of a lane -- it is the absence of an observation, which could
mean genuinely empty water, a hull broadcasting outside this map's coverage,
or simply nowhere this pass has looked yet. Nothing here, and nothing GET
/api/lanes returns (see NOTE below, reused verbatim by backend/app.py so the
wording can't drift between the two), may be read as a claim about shipping
lanes in general.

**Resolution.** 0.05deg globally, 0.02deg inside config.WATCHED_WATERS -- the
same boxes dark_vessels/gfw_detections/ports.py already spend their own finer
attention on, so "interesting water" is one notion across the codebase
rather than a second one invented here. cell_key carries the resolution as
its own leading field (see _cell), which is what the brief calls for and what
keeps a 0.05deg bin and a 0.02deg bin from ever colliding even where their
bin indices happen to agree -- lane_cells is keyed on cell_key alone.

**Courses.** Summed as a unit vector (mean_sin/mean_cos), never averaged as
degrees -- see the schema comment on lane_cells in backend/storage.py for why
averaging bearings across the 0/360 seam gives nonsense. A course of exactly
360.0 is AIS's own "not available" sentinel (ITU-R M.1371's raw COG=3600 in
0.1deg units), not a genuine due-north reading, and is dropped rather than
folded into the vector -- see _course_deg.

**Decay.** decay_lane_cells ages every cell down on every tick, whatever
happened to that tick's own ingest pass -- a failed write, or an outright
exception (see _tick) -- because decay represents wall-clock time passing at
LANE_DENSITY_INTERVAL, not "time since the grid last definitely changed".
DECAY_FACTOR is derived from that same interval so a cell's contribution
halves in about 30 days regardless of what cadence is configured; see the
constant's own comment for the arithmetic.

**Task 36: chokepoint transit counters ride this same pass.** compute_cells
answers "where"; compute_chokepoints answers "how many distinct hulls, per
watched box, per day" -- a different question that needs a different shape of
answer, because a cell's `transits` is honest about being a per-pass count
that storage.upsert_lane_cells adds onto a running total (see above), and a
day's distinct-hull count cannot be built the same way: adding "3 distinct
hulls this pass" to "5 distinct hulls last pass" is not "8 distinct hulls
today" unless the two passes happened to see disjoint hulls, which nothing
guarantees. So this keeps its own accumulator ("chokepoint_state" in
reference_snapshots) carrying real MMSI membership for the handful of days
still open to correction, and collapses a day to a plain count -- see
compute_chokepoints and its own docstring -- the moment it is old enough that
no more of this job's own catch-up backlog could still land in it. The
publicly-served document ("chokepoint_transits", GET /api/chokepoints) is
rebuilt from that accumulator every pass, the same "cheap to redo, no reason
to diff" choice vessel_profile.py's own profiles document makes.

Distinct from lane_cells in one more way worth naming: a hull that sits still
in one grid cell for a month is exactly the case lane_density's own
`transits` cannot tell apart from a month of different ships (see above) --
but a hull that sits still *inside a watched box* for a month is not that
problem here, because chokepoint membership is bucketed by calendar day, not
accumulated across passes the way a cell is. The hull is one of that day's
distinct members regardless of how many of this job's hourly passes find it
still there, and it becomes one member of the *next* day's set too if it is
still there at UTC midnight -- correctly counted once per day it was
present, never once per pass.
"""

import asyncio
import copy
import logging
import math
from datetime import date, datetime, timedelta, timezone

from backend import config, storage
from backend.refine.vessel_profile import cargo_class

log = logging.getLogger("osint-globe.lane_density")

CURSOR_NAME = "lane_density_cursor"
HEALTH_NAME = "lane_density"

# Rows read from entity_history per pass. Same figure and the same reasoning
# as port_calls.BATCH_LIMIT/vessel_profile.BATCH_LIMIT: bounded so a job that
# has fallen behind catches up over several passes instead of one pass
# becoming a scan of whatever backlog piled up.
BATCH_LIMIT = 200_000

GLOBAL_RES = 0.05   # degrees, everywhere outside config.WATCHED_WATERS
WATCHED_RES = 0.02  # degrees, inside it -- ~2x-2.5x finer at these latitudes

# Below one transit a cell is a rounding artifact of decay, not traffic --
# decay_lane_cells drops it rather than let the grid accumulate cells nobody
# would recognize as ever having actually carried a ship.
DECAY_FLOOR = 1

# How many derive_forever ticks fit in 30 days at the configured cadence.
# Applying (0.5 ** (1/n)) once per tick, n times, multiplies a cell's
# contribution by (0.5 ** (1/n)) ** n == 0.5 exactly -- so the factor below is
# derived from the cadence rather than a number picked to look right for
# whatever LANE_DENSITY_INTERVAL happens to be configured. At the 3600s
# default that is 720 ticks (30 * 86400 / 3600) and a per-tick factor of
# 0.5 ** (1/720) ~= 0.999037 -- a small correction every hour rather than a
# swing decay_lane_cells has to claw back all at once.
_TICKS_PER_HALF_LIFE = (30 * 86400) / config.LANE_DENSITY_INTERVAL
DECAY_FACTOR = 0.5 ** (1.0 / _TICKS_PER_HALF_LIFE)

# The literal words GET /api/lanes attaches to every response (see
# backend/app.py). Kept here, next to the code that builds the grid, rather
# than duplicated at the call site -- the one sentence that has to stay
# honest about what this data is should not live in two files that could
# drift apart.
NOTE = (
    "Grid of AIS positions this map has actually recorded, not a map of "
    "shipping lanes. An empty cell means no ship was observed there by this "
    "map's own AIS coverage -- never that no traffic exists. Each cell's "
    "sightings count is how many times a hull was seen there, not how many "
    "distinct ships -- a vessel that stays put keeps adding to it."
)


def _resolution(lat: float, lon: float) -> float:
    for lat_min, lon_min, lat_max, lon_max in config.WATCHED_WATERS:
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return WATCHED_RES
    return GLOBAL_RES


def _cell(lat: float, lon: float, res: float) -> tuple[str, float, float]:
    """A stable (cell_key, cell_lat, cell_lon) for one position report.

    Binned by floor division rather than round(), so a report anywhere in
    [n*res, (n+1)*res) always lands in the same cell regardless of which side
    of its own center it fell on. The 1e-9 nudge only guards against a bin
    edge floating point placed a hair below its true value (e.g. 0.15 / 0.05
    landing at 2.9999999999996 instead of 3); it cannot move a position that
    is genuinely near, but not at, an edge into the wrong cell.

    The cell's own reference point is its lower-left corner scaled back up
    from the bin index, not the reporting position itself -- two ships
    crossing the same cell a kilometre apart still have to land on one point
    for the map to draw, and the corner is cheaper to recover than carrying a
    running centroid nobody asked for.
    """
    lat_bin = math.floor(lat / res + 1e-9)
    lon_bin = math.floor(lon / res + 1e-9)
    # res leads the key text (not just implied by the numeric value) so a
    # 0.05deg bin and a 0.02deg bin can never collide even where their bin
    # indices happen to agree -- see the module docstring.
    key = f"{res:g}:{lat_bin}:{lon_bin}"
    return key, lat_bin * res, lon_bin * res


def _ship_type(payload: dict) -> int | None:
    value = payload.get("ship_type")
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else None


def _course_deg(payload: dict) -> float | None:
    """AIS's own course-over-ground, or None if it was never decoded or was
    broadcast as the network's "not available" sentinel (360.0 -- ITU-R
    M.1371's raw COG=3600 in 0.1deg units). A vessel that never reports a
    usable course only ever contributes to positions/transits, never to the
    cell's course vector -- see the module docstring."""
    value = payload.get("course")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    value = float(value)
    return value if 0.0 <= value < 360.0 else None


def compute_cells(rows: list[dict]) -> list[dict]:
    """One batch of entity_history rows -> lane_cells rows ready for
    storage.upsert_lane_cells.

    Pure and DB-free, like apply_positions/apply_history in
    port_calls.py/vessel_profile.py, and for the same reason: this is the
    part a swallowed storage exception would otherwise hide, so it is tested
    without a database (see backend/tests/test_lane_density.py).

    `transits` is the count of distinct MMSI this batch itself saw in a
    cell -- "in the run", the brief's own wording -- not a running total;
    storage.upsert_lane_cells is what adds this batch's count onto whatever
    the cell already held. `by_class` tallies each distinct MMSI once, under
    the most recently decoded cargo class this batch saw for it, so it never
    out-counts `transits` the way tallying every position report would (a
    hull reporting fifty times in one cell must not look like fifty ships of
    its class).
    """
    cells: dict[str, dict] = {}
    for row in rows:
        lat, lon = row.get("lat"), row.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        mmsi = str(row.get("entity_id"))
        payload = row.get("payload") or {}
        res = _resolution(lat, lon)
        key, cell_lat, cell_lon = _cell(lat, lon, res)
        cell = cells.setdefault(key, {
            "cell_key": key, "lat": cell_lat, "lon": cell_lon, "res": res,
            "positions": 0, "mmsis": set(), "classes": {},
            "mean_sin": 0.0, "mean_cos": 0.0,
        })
        cell["positions"] += 1
        cell["mmsis"].add(mmsi)
        cls = cargo_class(_ship_type(payload))
        if cls is not None:
            cell["classes"][mmsi] = cls
        course = _course_deg(payload)
        if course is not None:
            rad = math.radians(course)
            cell["mean_sin"] += math.sin(rad)
            cell["mean_cos"] += math.cos(rad)

    out = []
    for cell in cells.values():
        by_class: dict[str, int] = {}
        for cls in cell["classes"].values():
            by_class[cls] = by_class.get(cls, 0) + 1
        out.append({
            "cell_key": cell["cell_key"], "lat": cell["lat"], "lon": cell["lon"],
            "res": cell["res"],
            "transits": len(cell["mmsis"]), "positions": cell["positions"],
            "by_class": by_class,
            "mean_sin": cell["mean_sin"], "mean_cos": cell["mean_cos"],
        })
    return out


# --- Task 36: chokepoint transit counters -----------------------------------
#
# See the module docstring's own paragraph on why this needs a different
# accumulator shape from lane_cells' per-pass-count-that-gets-summed.

CHOKEPOINT_STATE_NAME = "chokepoint_state"
# The brief's own name -- this is what GET /api/chokepoints reads.
CHOKEPOINT_DOC_NAME = "chokepoint_transits"

# How many trailing calendar days the served document covers. Also the bound
# on how many day-entries this job keeps per box once a day is old enough to
# have collapsed to a plain count -- see _finalize_and_prune.
CHOKEPOINT_TREND_DAYS = 30

# A day stays open to further membership writes until this job has seen a day
# this many calendar days newer than it -- one, meaning "yesterday" (relative
# to whatever the newest processed row calls "today") stays open alongside
# today itself, and only the day before that closes. entity_history_since
# returns rows in `id` order, which tracks arrival order closely but not
# perfectly (concurrent writers, a batch straddling UTC midnight), so a day
# closed the instant a newer one is seen would risk quietly dropping a
# handful of stragglers that arrive a few rows late. This is the same
# "generous enough to not need retuning without being unbounded" judgment
# call other constants in this codebase make (see e.g. naval_presence.py's
# PORT_MATCH_RADIUS_KM) -- not the product of a measured study of how out of
# order this feed actually runs.
CHOKEPOINT_OPEN_GRACE_DAYS = 1

# The words attached to every GET /api/chokepoints response and to the water
# card's own fold -- kept here, next to the accumulation code, for the same
# reason NOTE above is: the one sentence that has to stay honest about what
# this data is should not be free to drift between the two places that state
# it. "derived" (not "measured"): a distinct-hull count is arithmetic
# (set membership) over measured AIS positions, not a reading off an
# instrument, and it inherits every gap in this map's own AIS reach -- an
# empty box on a quiet day is not the same claim as an empty box on a day
# this job never got to look at, which is exactly what the trend's `status`
# field exists to keep apart. See build_chokepoint_document.
CHOKEPOINT_NOTE = (
    "Distinct hulls this map's own AIS coverage has recorded crossing each "
    "watched chokepoint box, per day -- derived by counting distinct MMSIs, "
    "never a traffic census. AIS reception is not uniform: a quiet day can "
    "mean genuinely little traffic, or it can mean this map's own receivers "
    "simply heard less that day. A day whose status is \"missing\" is not a "
    "zero -- it is this job reporting it never looked, and must never be "
    "read as though nothing crossed."
)

# (label, box) pairs, zipped once at import time rather than on every call --
# WATCHED_WATERS/WATCHED_WATERS_LABELS are both fixed for the life of the
# process (read from the environment once, at backend/config.py import time).
# zip() truncates to the shorter of the two lists rather than raising; see
# WATCHED_WATERS_LABELS' own comment in config.py for why that is the
# accepted degradation for a mismatched override, not a crash.
_LABELED_WATERS = list(zip(config.WATCHED_WATERS_LABELS, config.WATCHED_WATERS))


def _day_key(ts: float) -> str:
    """The UTC calendar day a row's timestamp falls on, as an ISO date
    string -- sortable and comparable as plain text, and directly usable with
    date.fromisoformat wherever arithmetic on the day itself is needed."""
    return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()


def _boxes_hit(lat: float, lon: float) -> list[str]:
    """Every watched-water label whose box contains (lat, lon) -- can be more
    than one label, on purpose: Red Sea and the Gulf of Aden approach overlap
    (see config.WATCHED_WATERS), and a hull sitting in that overlap
    legitimately counts toward both boxes' distinct-hull totals, the same way
    it would if the two boxes had no reason to ever share water."""
    return [
        label for label, (lat_min, lon_min, lat_max, lon_max) in _LABELED_WATERS
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max
    ]


def _finalize_and_prune(state: dict) -> None:
    """Mutates `state` in place: closes any box-day still open more than
    CHOKEPOINT_OPEN_GRACE_DAYS behind the newest day this job has processed
    (replacing its raw MMSI membership with a plain total/by_class count),
    then drops any box-day entry -- open or already closed -- older than
    CHOKEPOINT_TREND_DAYS. That second step is the entire bound on this
    document's size: once a day scrolls out of the trend window, this job
    stops carrying it at all, open or closed, and it is gone from
    chokepoint_state, not just from what chokepoint_transits happens to
    display. See the task report for the worst-case size that leaves.
    """
    latest_day = state.get("latest_day")
    if not latest_day:
        return
    latest = date.fromisoformat(latest_day)
    keep_from = latest - timedelta(days=CHOKEPOINT_TREND_DAYS - 1)
    for box in state.get("boxes", {}).values():
        days = box.get("days", {})
        for day_str in list(days.keys()):
            day = date.fromisoformat(day_str)
            entry = days[day_str]
            if entry.get("status") == "open" and (latest - day).days > CHOKEPOINT_OPEN_GRACE_DAYS:
                mmsis = entry.pop("mmsis", {})
                by_class: dict[str, int] = {}
                for cls in mmsis.values():
                    if cls is not None:
                        by_class[cls] = by_class.get(cls, 0) + 1
                entry["total"] = len(mmsis)
                entry["by_class"] = by_class
                entry["status"] = "counted"
            if day < keep_from:
                del days[day_str]
    state["days_seen"] = [d for d in state.get("days_seen", []) if date.fromisoformat(d) >= keep_from]


def compute_chokepoints(rows: list[dict], state: dict) -> dict:
    """One batch of entity_history rows, plus the accumulator persisted from
    the last pass -> the accumulator to persist for this one.

    Pure and DB-free, like compute_cells, and for the same reason (tested
    without a database -- see backend/tests/test_chokepoints.py). Unlike
    compute_cells this one is also deliberately idempotent under replay of
    the *same* (rows, state) pair: every write into a box-day's membership is
    a dict/set write keyed on the hull's own MMSI, so applying the same batch
    twice against the same starting state leaves it exactly as it was after
    the first application. See run_once for why that property is what makes
    it safe to write this ahead of storage.upsert_lane_cells rather than
    after it -- upsert_lane_cells has no such property (its own docstring:
    "transits" accumulates every call), so it has to be the one write in this
    pass that only ever gets attempted once a batch has durably succeeded
    everywhere else.

    `state` is never mutated -- a deep copy up front, matching apply_history
    in vessel_profile.py and for the same reason: a caller retrying a batch
    against `state` it still holds must get an independent result.

    A row outside every watched box still marks its own day as "seen" (see
    `days_seen`) -- that is the signal build_chokepoint_document uses to draw
    the line between "this job looked at this day and found nothing in this
    box" (a real zero) and "this job never looked at this day at all" (which
    is not a zero and must never render as one). A row whose lat/lon do not
    parse contributes to neither and is silently skipped, the same guard
    compute_cells applies.
    """
    new_state = copy.deepcopy(state) if state else {}
    boxes = new_state.setdefault("boxes", {})
    days_seen = set(new_state.get("days_seen", []))
    latest_day = new_state.get("latest_day")

    for row in rows:
        lat, lon = row.get("lat"), row.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        day = _day_key(row["ts"])
        days_seen.add(day)
        if latest_day is None or day > latest_day:
            latest_day = day

        hits = _boxes_hit(lat, lon)
        if not hits:
            continue
        mmsi = str(row.get("entity_id"))
        cls = cargo_class(_ship_type(row.get("payload") or {}))
        for label in hits:
            box = boxes.setdefault(label, {"days": {}})
            day_entry = box["days"].get(day)
            if day_entry is None:
                day_entry = {"status": "open", "mmsis": {}}
                box["days"][day] = day_entry
            if day_entry["status"] != "open":
                # This day already closed under an earlier pass's grace
                # window (see _finalize_and_prune) -- a straggler arriving
                # this late is not folded back in. Documented rather than
                # silently perfect: entity_history is pruned at three days,
                # so nothing this far behind is coming from anywhere else
                # either.
                continue
            if cls is not None:
                day_entry["mmsis"][mmsi] = cls
            else:
                day_entry["mmsis"].setdefault(mmsi, None)

    new_state["days_seen"] = sorted(days_seen)
    new_state["latest_day"] = latest_day
    _finalize_and_prune(new_state)
    return new_state


def _trend_window(latest_day: str | None) -> list[str]:
    """The CHOKEPOINT_TREND_DAYS calendar days ending at `latest_day`,
    oldest first -- empty if this job has never processed a row."""
    if not latest_day:
        return []
    end = date.fromisoformat(latest_day)
    return [(end - timedelta(days=n)).isoformat() for n in range(CHOKEPOINT_TREND_DAYS - 1, -1, -1)]


def _trend_entry(day: str, stored: dict | None, was_seen: bool, is_current: bool) -> dict:
    """One day of one box's trend, in the three states the brief requires
    kept apart all the way to the reader:

      counted  -- this job watched this day, it is fully behind the grace
                  window, and this box saw exactly `total` distinct hulls
                  (which may honestly be 0). Final -- nothing will change it.
      partial  -- this day is still inside the grace window (see
                  CHOKEPOINT_OPEN_GRACE_DAYS): either it is the day this job
                  is currently accumulating, or it is recent enough that a
                  late straggler could still land in it. `total` is real, not
                  a placeholder, but it could still grow -- including a box
                  that has seen nothing *yet* today, which is "partial: 0",
                  never "counted: 0" (the day is not over).
      missing  -- this job never processed any entity_history row for this
                  calendar day at all, in this box or any other. `total` and
                  `by_class` are None, not 0, so nothing downstream can
                  mistake absence-of-observation for observed absence.

    `is_current` (day is within CHOKEPOINT_OPEN_GRACE_DAYS of the newest day
    this job has processed, computed once in build_chokepoint_document) is
    what a box with literally no stored entry for `day` uses to tell "still
    open, zero so far" apart from "closed, zero total" -- a box's own
    per-day entry only exists in `state` when at least one hull was actually
    seen there, so a quiet box has nothing else to check.
    """
    if stored is not None:
        mmsis = stored.get("mmsis")
        if stored.get("status") == "open" and mmsis is not None:
            by_class: dict[str, int] = {}
            for cls in mmsis.values():
                if cls is not None:
                    by_class[cls] = by_class.get(cls, 0) + 1
            return {"date": day, "status": "partial", "total": len(mmsis), "by_class": by_class}
        return {
            "date": day, "status": "counted",
            "total": stored.get("total", 0), "by_class": stored.get("by_class", {}),
        }
    if was_seen:
        # This job watched this day (some row, somewhere, fell on it) and
        # this particular box has no entry -- either a real, finished zero,
        # or a still-open "zero so far" -- see `is_current` above.
        return {"date": day, "status": "partial" if is_current else "counted", "total": 0, "by_class": {}}
    return {"date": day, "status": "missing", "total": None, "by_class": None}


def build_chokepoint_document(state: dict) -> dict:
    """chokepoint_state -> the compact document GET /api/chokepoints serves
    (reference_snapshots name CHOKEPOINT_DOC_NAME/"chokepoint_transits").

    Rebuilt whole from `state` on every pass, the same "cheap to redo, no
    reason to diff" choice vessel_profile.py's own profiles document makes --
    this is pure in-memory work over an accumulator already bounded to
    CHOKEPOINT_TREND_DAYS, not a second pass over entity_history.

    Every one of the eight configured boxes gets an entry, in
    config.WATCHED_WATERS' own order, even one this job has never recorded a
    single hull for -- a box with no traffic is still a watched box, and the
    water card's fold (Task 36's frontend half) needs a real "counted zero"
    or "missing" answer for it, not silence, regardless of whether the reader
    happens to open a card sitting on a quiet box.
    """
    latest_day = state.get("latest_day")
    latest = date.fromisoformat(latest_day) if latest_day else None
    boxes_state = state.get("boxes", {})
    days_seen = set(state.get("days_seen", []))
    trend_days = _trend_window(latest_day)
    out_boxes = {}
    for label, box in _LABELED_WATERS:
        entries = boxes_state.get(label, {}).get("days", {})
        trend = []
        for day in trend_days:
            is_current = latest is not None and (latest - date.fromisoformat(day)).days <= CHOKEPOINT_OPEN_GRACE_DAYS
            trend.append(_trend_entry(day, entries.get(day), day in days_seen, is_current))
        out_boxes[label] = {
            "label": label,
            "bounds": list(box),
            "trend": trend,
            "today": trend[-1] if trend else None,
        }
    return {
        "as_of_day": latest_day,
        "window_days": CHOKEPOINT_TREND_DAYS,
        "note": CHOKEPOINT_NOTE,
        "provenance": "derived",
        "boxes": out_boxes,
    }


async def _load_cursor() -> int:
    doc = await storage.reference(CURSOR_NAME)
    return int(doc["last_id"]) if isinstance(doc, dict) and isinstance(doc.get("last_id"), (int, float)) else 0


async def run_once() -> dict:
    """One incremental pass over new AIS positions. Returns a small summary
    for logging and health.

    The cursor only advances past rows this pass actually finished writing --
    the same discipline backend/refine/port_calls.py's run_once already gives
    record_port_calls, and for the same reason: entity_history is read
    exactly once through an ever-advancing id cursor over a table pruned at
    three days, so a write this pass drops would be a permanently lost slice
    of the grid or the chokepoint counts, not merely stale until the next
    poll.

    Two writes now share that one cursor, and the order they run in is not
    the order they were introduced in. Chokepoint accounting runs and is
    durably written *before* upsert_lane_cells is even attempted, deliberately:

      - compute_chokepoints is idempotent under replay of the same batch
        against the same starting state (see its own docstring) -- so if its
        write fails, holding the cursor back and retrying the whole batch
        next pass costs nothing extra: the retry reproduces exactly the state
        a successful write would have produced.
      - storage.upsert_lane_cells is *not* idempotent -- it adds this batch's
        own distinct-MMSI count onto whatever a cell already holds, every
        time it is called (see its own docstring and the module docstring's
        "Decay" section on why `transits` accumulates like that). Calling it
        twice for the same batch double-counts every cell that batch touched.

    Putting the non-idempotent write last, and only ever attempting it once
    the idempotent one has durably succeeded, is what keeps a chokepoint
    write failure from ever forcing a retried lane-cell write on a batch that
    already landed. The reverse order -- lane cells first, chokepoints second
    -- would not have this property: a chokepoint failure after a successful
    lane-cell write would still hold the cursor back, and the retry would
    call upsert_lane_cells a second time on a batch it had already durably
    applied.
    """
    cursor = await _load_cursor()
    rows = await storage.entity_history_since("ais", cursor, BATCH_LIMIT)
    if not rows:
        return {"read": 0, "cells": 0, "ok": True}

    old_choke_state = await storage.reference(CHOKEPOINT_STATE_NAME)
    new_choke_state = compute_chokepoints(rows, old_choke_state if isinstance(old_choke_state, dict) else {})
    choke_doc = build_chokepoint_document(new_choke_state)
    choke_state_ok = await storage.record_reference(CHOKEPOINT_STATE_NAME, new_choke_state)
    choke_doc_ok = choke_state_ok and await storage.record_reference(CHOKEPOINT_DOC_NAME, choke_doc)
    if not choke_doc_ok:
        return {"read": len(rows), "cells": 0, "ok": False}

    cells = compute_cells(rows)
    wrote = await storage.upsert_lane_cells(cells)
    if not wrote:
        return {"read": len(rows), "cells": 0, "ok": False}

    await storage.record_reference(CURSOR_NAME, {"last_id": rows[-1]["id"]})
    return {"read": len(rows), "cells": len(cells), "ok": True}


async def _tick() -> None:
    """One pass: read/write, then decay, then report health.

    Split out from derive_forever so this ordering can be exercised directly
    by a test without unrolling an infinite loop -- see
    backend/tests/test_lane_density.py.

    Decay lives in a `finally`, not after run_once's own happy path (Task 19
    review, Minor 1): entity_history_since/reference/upsert_lane_cells can all
    raise before run_once ever gets to return, and a decay that only ran on
    the paths that didn't raise would quietly skip a tick every time the
    database hiccupped -- a small drift on its own, but one that makes the
    "halves in about 30 days" claim a little less true every time it happens.
    Unconditional costs nothing: storage.decay_lane_cells already fails safely
    (logs and returns 0) if the database itself is the problem.
    """
    summary = None
    try:
        summary = await run_once()
    except Exception as exc:  # noqa: BLE001 - keep the loop alive
        log.warning("Lane density derivation failed: %s", exc)
        await storage.record_source_health(HEALTH_NAME, None, False, str(exc))
    finally:
        deleted = await storage.decay_lane_cells(DECAY_FACTOR, DECAY_FLOOR)

    if summary is None:
        return
    if summary["ok"]:
        log.info(
            "Lane density: read %d AIS movement rows, %d cell(s) touched, "
            "%d cell(s) decayed below the floor and dropped",
            summary["read"], summary["cells"], deleted,
        )
        await storage.record_source_health(HEALTH_NAME, summary["cells"], True)
    else:
        log.warning(
            "Lane density: read %d AIS movement rows but a write for this "
            "batch failed -- the cursor was not advanced, so the same batch "
            "is retried next pass",
            summary["read"],
        )
        await storage.record_source_health(
            HEALTH_NAME, None, False,
            "a write for this batch failed (lane cells and/or chokepoint "
            "counts); the cursor was held back and the same rows will be "
            "retried next pass",
        )


async def derive_forever():
    """The lane-density derivation, for the life of the refine process.

    A plain interval, like port_calls'/vessel_profile's own: nothing about a
    traffic grid is made more correct by retrying faster after a failure. See
    _tick for what happens on any one pass.
    """
    while True:
        await _tick()
        await asyncio.sleep(config.LANE_DENSITY_INTERVAL)
