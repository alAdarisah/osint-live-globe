"""How many navy-classified AIS hulls are sitting in each conflict theatre's
waters, and near each curated port, right now -- and whether that is up or
down on the day before.

"Water body" per the brief means one of regions.py's eleven conflict-theatre
boxes here, not a Natural Earth marine polygon: Task 6's `findWaterAt` (point-
in-polygon against the water layer's real geometry) runs client-side against
data this map already has loaded, and this module would otherwise be a second,
server-side copy of that same geometry test just to answer a coarser question.
A theatre box is a reasonable stand-in for "which sea" here -- most of them are
already named after the water they cover (Persian Gulf/Hormuz, Red Sea/Yemen,
Taiwan Strait, South China Sea) -- and reusing regions.filter_points keeps this
module's own geometry to zero, the same "no PostGIS, plain columns plus Python"
discipline backend/regions.py and backend/proximity.py already hold. The
frontend states the same substitution as a caveat next to every sentence this
document produces (NAVAL_PRESENCE_THEATRE_CAVEAT in map/popups.js) -- the
boxes are large enough (south_china_sea alone reaches the Gulf of Thailand and
the Sulu Sea) that saying so once, quietly, in this docstring would not be
enough.

**"Right now" is a rolling 24 hours, not a UTC calendar day.** Task 29 review
(Important 3) caught the earlier version of this: it bucketed by
`date_trunc('day', ts)`, so a pass shortly after 00:00 UTC computed "current"
from only the handful of hours since midnight while still labelling it
"right now" -- correct at 23:00 UTC and badly wrong at 00:30. CURRENT_START/
BASELINE_START below are trailing windows measured from the moment this pass
actually runs, so the figure means the same thing at every hour of the day.

**The baseline compares against the day before, not a week before (pre-merge
review, Critical).** This module originally compared "right now" against a
window ending WINDOW_DAYS=7 days before this pass -- but entity_history, the
only table navy positions are ever read from, is pruned at
config.HISTORY_RETENTION_SECONDS (3 days; see backend/config.py), and a
baseline window that starts at (now - WINDOW_DAYS - CURRENT_WINDOW_HOURS) =
now minus 8 days reaches for rows that have never once existed by the time
this job could read them. Verified live against the real database
(2026-08-11): the oldest row in entity_history was exactly 72h old, i.e. the
retention sweep's own cutoff, not a coincidence of quiet traffic. That made
`baseline_rows` empty on every single pass, `trend_computable` False always,
every `trend` field permanently None -- while still paying for both range
scans on every pass to produce nothing. WINDOW_DAYS is now 1: the baseline
window is the 24h immediately preceding the current one (contiguous, no
gap), reaching back 48h at its farthest edge -- 24h of margin inside the 72h
retention window, comfortably clear of the retention sweep's own 10-minute
granularity and this job's own NAVAL_PRESENCE_INTERVAL. This is a judgment
call, not a further-measured figure: shrinking the comparison to
"day-over-day" is what retention actually allows this module to compute
honestly; there was no operational reason to prefer some other split of that
48h budget between the two windows over an even, contiguous one. `week_ago`
is kept as this document's own field name (backend/app.py's naval_presence_
endpoint and the frontend both read it) even though the period it now covers
is a day, not a week -- see this fix's own report for the follow-up needed
on the frontend copy that still says "last week"/"7-day window" in plain
words (frontend/src/map/popups.js), which is out of this module's own scope
to correct.

**Full window recomputed on every pass**, not a port_calls-style incremental
cursor: a trend is a comparison between two fixed windows, not an append-only
accumulation, so there is no meaningful "since last pass" slice to read
instead -- the same shape escalation.py's own 7-day conflict baseline already
is. Two queries, both bounded by the same `ts >= since` range scan on
entity_history's (kind, ts) index: one pulls only `ship_type = 35` ("military
ops", ITU-R M.1371 -- the same code decorators.js's isNavyVessel reads
client-side) positions, a small fraction of global AIS traffic; the other is a
single aggregate row with no JSONB predicate at all, kept only as the coverage
signal below. NAVAL_PRESENCE_INTERVAL (four passes a day, see config.py) is
deliberately not tighter than that cost is worth paying.

**"Coverage changed" is checked globally, not per theatre.** A per-region
total would need a second, *bounds*-grouped scan of the full (non-navy) AIS
log -- every position report, not just the navy ones -- which this task chose
not to pay for. The global report count over each window is the cheaper
proxy: if the number of AIS positions this map recorded in one window is far
below the other, something changed about what we were listening to, not about
how many hulls were at sea, and the trend is reported as not computable
rather than presented as a real change. If a narrower "coverage changed only
in the Persian Gulf" signal is ever needed, this is where the second scan
would go.
"""

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from backend import config, infrastructure, regions, storage
from backend.sources.proximity import haversine_km

log = logging.getLogger("osint-globe.naval_presence")

# How many days before "now" the baseline window ends -- see the module
# docstring's "The baseline compares against the day before, not a week
# before" section. Bound above by config.HISTORY_RETENTION_SECONDS (3 days):
# the baseline window's own farthest edge sits at
# (WINDOW_DAYS days + CURRENT_WINDOW_HOURS) before now, and that has to stay
# comfortably inside what entity_history can actually still hold or
# baseline_rows is permanently empty. At 1 it reaches 48h back, leaving 24h
# of margin inside the 72h retention window.
WINDOW_DAYS = 1

# How wide each of the two compared windows is. A day, not an hour: AIS
# coverage and naval movement both have real diurnal rhythm (a port empties
# and fills with the tide and the working day), and a window narrower than a
# full day would measure the time of day this pass happened to run at more
# than it measures anything about ships.
CURRENT_WINDOW_HOURS = 24

# ITU-R M.1371's AIS "Type of ship and cargo type" code for "military
# operations" -- the same field and the same value frontend/src/map/
# decorators.js's isNavyVessel reads off the live feed, so a hull server and
# client agree is a warship is exactly the population this module counts.
MILITARY_SHIP_TYPE = "35"

# An AIS fix is a point, a port is a point, and neither is precise enough for
# an exact-match join -- a warship alongside a quay can report a position a
# few hundred metres off the harbour's own charted centre. 25km is generous
# enough to catch a hull anchored in the roads outside a port.
#
# Task 29 review (Minor 1): it is not narrow enough to rule out every case of
# attribution noise -- Tokyo and Yokohama are 22.77km apart, under twice this
# radius, so a hull sitting near the midpoint between them can nearest()-match
# to either depending on which side of the line a few hundred metres of GPS
# jitter puts it on. `nearest()` always resolves to exactly one port (nothing
# folds, and BASE_MATCH_RADIUS_KM's own ambiguity refusal in infrastructure.py
# does not apply here -- ports are looked up per snapshot, not paired against
# a second independent source), so this is not the false-corroboration class
# of bug that constant's own review finding was. It is smaller: a hull that
# happens to reposition across that line between the current and baseline
# window can flip which port's `current`/`week_ago` it counts toward, adding
# a small amount of trend noise unrelated to any real naval movement. Left as
# a documented limitation rather than tightened -- shrinking the radius meant
# missing real hulls anchored in the outer roads of a busier port, a worse
# trade for a busy-strait pair than the noise this leaves in. Still an
# unmeasured judgment call in the same spirit as osm_infra.py's own capacity
# ceilings, not a distance backed by a survey of this map's ports.
PORT_MATCH_RADIUS_KM = 25.0

# Below this many total AIS position reports recorded anywhere over one of
# the two compared windows, that window's ship counts -- navy or otherwise --
# are a fact about how much of the world this map's own receivers were
# watching, not about how many hulls were there. A trend spanning a window
# like this next to one that wasn't is exactly the "coverage change read as a
# trend" this module exists to avoid. Unmeasured for the same reason
# PORT_MATCH_RADIUS_KM is: no operator has yet watched a real week of
# AIS_BBOXES traffic to see where the honest floor sits, so this is a
# conservative starting guess to be raised or lowered once one has.
MIN_WINDOW_AIS_REPORTS = 5000

REFERENCE_NAME = "naval_presence"

_NAVY_POSITIONS_SQL = """
SELECT ts, entity_id, lat, lon
  FROM entity_history
 WHERE kind = 'ais' AND ts >= $1
   AND payload->>'ship_type' = $2
"""

# One aggregate row rather than a per-day grouping -- there are only ever two
# windows to count, both known up front, so FILTER is cheaper than grouping
# and then re-summing in Python.
_COVERAGE_SQL = """
SELECT
  count(*) FILTER (WHERE ts >= $2)                  AS current_reports,
  count(*) FILTER (WHERE ts >= $3 AND ts < $4)       AS baseline_reports
  FROM entity_history
 WHERE kind = 'ais' AND ts >= $1
"""


def _regions_with_bounds() -> list[tuple[str, str, tuple]]:
    return [
        (key, entry["label"], entry["bounds"])
        for key, entry in regions.REGIONS.items()
        if entry.get("bounds")
    ]


def _ports() -> list[dict]:
    return [site for site in infrastructure.INFRA_SITES if site.get("type") == "port"]


def _nearest_port_id(lat: float, lon: float, ports: list[dict]) -> str | None:
    """The closest curated port within PORT_MATCH_RADIUS_KM, or None.

    A plain scan, not a spatial index: the curated port list is small enough
    (~100 entries) that building one would cost more than it saves, the same
    reasoning infrastructure.py's own _closest_curated_match gives for the
    even smaller MILITARY_BASES list. Unlike that function, this does not
    refuse an ambiguous match -- see PORT_MATCH_RADIUS_KM's own note on why
    the failure mode here (attribution noise between two close ports) is a
    smaller problem than the one that fix was for (false corroboration
    against a *different, independent* source).
    """
    best_id, best_km = None, PORT_MATCH_RADIUS_KM
    for port in ports:
        km = haversine_km(lat, lon, port["lat"], port["lon"])
        if km <= best_km:
            best_id, best_km = port["id"], km
    return best_id


def build_document(navy_rows: list[dict], coverage: dict, now: datetime) -> dict:
    """The stored document, from plain rows (no asyncpg, no network) -- split
    out of compute() below so the trend/coverage arithmetic is testable on its
    own, the same reason osm_infra.py's parse functions take a plain payload.

    `navy_rows`: [{"ts": datetime, "entity_id": str, "lat": float, "lon": float}, ...]
    `coverage`: {"current_reports": int, "baseline_reports": int}

    Two fixed 24h windows, not two calendar days -- see the module docstring's
    own note on why "right now" has to mean the same thing regardless of what
    hour this pass happens to run at.
    """
    current_start = now - timedelta(hours=CURRENT_WINDOW_HOURS)
    baseline_end = now - timedelta(days=WINDOW_DAYS)
    baseline_start = baseline_end - timedelta(hours=CURRENT_WINDOW_HOURS)

    current_reports = coverage.get("current_reports") or 0
    baseline_reports = coverage.get("baseline_reports") or 0
    trend_computable = (
        current_reports >= MIN_WINDOW_AIS_REPORTS and baseline_reports >= MIN_WINDOW_AIS_REPORTS
    )
    _day_word = "day" if WINDOW_DAYS == 1 else "days"
    reason = None if trend_computable else (
        "AIS coverage in the "
        + ("last 24h" if current_reports < MIN_WINDOW_AIS_REPORTS
           else f"24h window {WINDOW_DAYS} {_day_word} ago")
        + " is too thin to compare against the other end of the window"
    )

    current_rows = [r for r in navy_rows if r["ts"] >= current_start]
    baseline_rows = [r for r in navy_rows if baseline_start <= r["ts"] < baseline_end]

    region_defs = _regions_with_bounds()
    ports = _ports()

    def _distinct(rows: list[dict], bounds=None, port_id=None) -> int:
        if bounds is not None:
            rows = regions.filter_points(rows, bounds)
        if port_id is not None:
            rows = [r for r in rows if _nearest_port_id(r["lat"], r["lon"], ports) == port_id]
        return len({r["entity_id"] for r in rows})

    out_regions = {}
    for key, label, bounds in region_defs:
        current = _distinct(current_rows, bounds=bounds)
        week_ago = _distinct(baseline_rows, bounds=bounds)
        out_regions[key] = {
            "label": label,
            # Carried through so the frontend can match a country card to the
            # theatre it sits inside, the same bounds-containment test
            # escalation.py's own document is already read by (see
            # countryCardSections' escalationZone in map/popups.js).
            "bounds": list(bounds),
            "current": current,
            "week_ago": week_ago,
            "trend": current - week_ago if trend_computable else None,
            "trend_computable": trend_computable,
            "reason": reason,
        }

    # Every port a navy hull was matched to in either window -- not every
    # port this app knows, most of which never see a warship and would
    # otherwise pad the document with zeros (the same "carried only where
    # there is something to carry" rule storage.airfield_activity's own
    # hourly_military applies).
    candidate_port_ids = {
        pid for row in current_rows + baseline_rows
        if (pid := _nearest_port_id(row["lat"], row["lon"], ports))
    }
    port_by_id = {p["id"]: p for p in ports}
    out_ports = {}
    for port_id in candidate_port_ids:
        current = _distinct(current_rows, port_id=port_id)
        week_ago = _distinct(baseline_rows, port_id=port_id)
        if not current and not week_ago:
            continue
        out_ports[port_id] = {
            "name": port_by_id[port_id]["name"],
            "current": current,
            "week_ago": week_ago,
            "trend": current - week_ago if trend_computable else None,
            "trend_computable": trend_computable,
            "reason": reason,
        }

    return {
        "as_of": time.time(),
        "window_days": WINDOW_DAYS,
        "current_window_hours": CURRENT_WINDOW_HOURS,
        "regions": out_regions,
        "ports": out_ports,
    }


async def compute() -> dict:
    pool = storage.get_pool()
    if pool is None:
        return {}
    now = datetime.now(timezone.utc)
    current_start = now - timedelta(hours=CURRENT_WINDOW_HOURS)
    baseline_end = now - timedelta(days=WINDOW_DAYS)
    baseline_start = baseline_end - timedelta(hours=CURRENT_WINDOW_HOURS)
    async with pool.acquire() as conn:
        navy_records = await conn.fetch(_NAVY_POSITIONS_SQL, baseline_start, MILITARY_SHIP_TYPE)
        coverage_record = await conn.fetchrow(
            _COVERAGE_SQL, baseline_start, current_start, baseline_start, baseline_end
        )
    navy_rows = [
        {"ts": r["ts"], "entity_id": r["entity_id"], "lat": r["lat"], "lon": r["lon"]}
        for r in navy_records
    ]
    coverage = dict(coverage_record) if coverage_record else {}
    return build_document(navy_rows, coverage, now)


async def derive_forever():
    """Recompute the ranking on a loop, in the refine process.

    Same "publish an empty document rather than skip" discipline escalation.py
    and airfield_activity.py both already follow: "no naval presence anywhere"
    and "not computed yet" are different answers, and a stale document quietly
    kept from a previous pass would collapse that distinction back into one.
    """
    while True:
        try:
            doc = await compute()
            await storage.record_reference(REFERENCE_NAME, doc)
            regions_up = sum(1 for r in doc.get("regions", {}).values() if r["current"])
            await storage.record_source_health(REFERENCE_NAME, len(doc.get("ports", {})), True)
            log.info(
                "Naval presence: %d theatres with a navy contact, %d ports matched",
                regions_up, len(doc.get("ports", {})),
            )
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Naval presence computation failed: %s", exc)
            await storage.record_source_health(REFERENCE_NAME, None, False, str(exc))
        await asyncio.sleep(config.NAVAL_PRESENCE_INTERVAL)
