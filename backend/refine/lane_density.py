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
"""

import asyncio
import logging
import math

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
    three days, so a write storage.upsert_lane_cells drops would be a
    permanently lost slice of the grid, not merely stale until the next poll.
    """
    cursor = await _load_cursor()
    rows = await storage.entity_history_since("ais", cursor, BATCH_LIMIT)
    if not rows:
        return {"read": 0, "cells": 0, "ok": True}

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
            "Lane density: read %d AIS movement rows but the write "
            "failed -- the cursor was not advanced, so the same batch "
            "is retried next pass",
            summary["read"],
        )
        await storage.record_source_health(
            HEALTH_NAME, None, False,
            "upsert_lane_cells failed to write this batch; the cursor "
            "was held back and the same rows will be retried next pass",
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
