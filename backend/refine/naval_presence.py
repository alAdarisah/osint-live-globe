"""How many navy-classified AIS hulls are sitting in each conflict theatre's
waters, and near each curated port, right now -- and whether that is up or
down on a week ago.

"Water body" per the brief means one of regions.py's eleven conflict-theatre
boxes here, not a Natural Earth marine polygon: Task 6's `findWaterAt` (point-
in-polygon against the water layer's real geometry) runs client-side against
data this map already has loaded, and this module would otherwise be a second,
server-side copy of that same geometry test just to answer a coarser question.
A theatre box is a reasonable stand-in for "which sea" here -- most of them are
already named after the water they cover (Persian Gulf/Hormuz, Red Sea/Yemen,
Taiwan Strait, South China Sea) -- and reusing regions.filter_points keeps this
module's own geometry to zero, the same "no PostGIS, plain columns plus Python"
discipline backend/regions.py and backend/proximity.py already hold.

**Full 7-day window recomputed on every pass**, not a port_calls-style
incremental cursor: a trend is a comparison against the whole window, not an
append-only accumulation, so there is no meaningful "since last pass" slice to
read instead -- the same shape escalation.py's own 7-day conflict baseline
already is. Two queries, both bounded by the same `ts >= since` range scan on
entity_history's (kind, ts) index: one pulls only `ship_type = 35` ("military
ops", ITU-R M.1371 -- the same code decorators.js's isNavyVessel reads
client-side) positions, a small fraction of global AIS traffic; the other is a
bare `count(*)` with no JSONB predicate at all, kept only as the coverage
signal below. NAVAL_PRESENCE_INTERVAL (four passes a day, see config.py) is
deliberately not tighter than that cost is worth paying.

**"Coverage changed" is checked globally, not per theatre.** A per-region
daily total would need a second, *bounds*-grouped scan of the full (non-navy)
AIS log -- every position report, not just the navy ones -- which this task
chose not to pay for. The global daily report count is the cheaper proxy: if
the number of AIS positions this map recorded on a given day is far below the
window's own high day, something changed about what we were listening to, not
about how many hulls were at sea, and a trend spanning that day is reported as
not computable rather than presented as a real change. If a narrower
"coverage changed only in the Persian Gulf" signal is ever needed, this is
where the second scan would go.
"""

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from backend import config, infrastructure, regions, storage
from backend.sources.proximity import ProximityIndex

log = logging.getLogger("osint-globe.naval_presence")

WINDOW_DAYS = 7

# ITU-R M.1371's AIS "Type of ship and cargo type" code for "military
# operations" -- the same field and the same value frontend/src/map/
# decorators.js's isNavyVessel reads off the live feed, so a hull server and
# client agree is a warship is exactly the population this module counts.
MILITARY_SHIP_TYPE = "35"

# An AIS fix is a point, a port is a point, and neither is precise enough for
# an exact-match join -- a warship alongside a quay can report a position a
# few hundred metres off the harbour's own charted centre. 25km is generous
# enough to catch a hull anchored in the roads outside a port and narrow
# enough that two ports sharing one strait are not folded together; it is an
# unmeasured judgment call in the same spirit as osm_infra.py's own capacity
# ceilings, not a distance backed by a survey of this map's ports.
PORT_MATCH_RADIUS_KM = 25.0

# Below this many total AIS position reports recorded anywhere on a given day,
# that day's ship counts -- navy or otherwise -- are a fact about how much of
# the world this map's own receivers were watching, not about how many hulls
# were there. A trend spanning a day like this next to one that wasn't is
# exactly the "coverage change read as a trend" this module exists to avoid.
# Unmeasured for the same reason PORT_MATCH_RADIUS_KM is: no operator has yet
# watched a real week of AIS_BBOXES traffic to see where the honest floor
# sits, so this is a conservative starting guess to be raised or lowered once
# one has.
MIN_DAILY_AIS_REPORTS = 5000

REFERENCE_NAME = "naval_presence"

_NAVY_POSITIONS_SQL = """
SELECT date_trunc('day', ts) AS day, entity_id, lat, lon
  FROM entity_history
 WHERE kind = 'ais' AND ts >= $1
   AND payload->>'ship_type' = $2
"""

_DAILY_COVERAGE_SQL = """
SELECT date_trunc('day', ts) AS day, count(*) AS reports
  FROM entity_history
 WHERE kind = 'ais' AND ts >= $1
 GROUP BY 1
"""


def _regions_with_bounds() -> list[tuple[str, str, tuple]]:
    return [
        (key, entry["label"], entry["bounds"])
        for key, entry in regions.REGIONS.items()
        if entry.get("bounds")
    ]


def _ports() -> list[dict]:
    return [site for site in infrastructure.INFRA_SITES if site.get("type") == "port"]


def build_document(
    navy_rows: list[dict], coverage_rows: list[dict], now: datetime,
) -> dict:
    """The stored document, from plain rows (no asyncpg, no network) -- split
    out of compute() below so the trend/coverage arithmetic is testable on its
    own, the same reason osm_infra.py's parse functions take a plain payload.

    `navy_rows`: [{"day": datetime, "entity_id": str, "lat": float, "lon": float}, ...]
    `coverage_rows`: [{"day": datetime, "reports": int}, ...]
    """
    latest_day = now.date()
    oldest_day = (now - timedelta(days=WINDOW_DAYS)).date()

    coverage_by_day = {r["day"].date(): r["reports"] for r in coverage_rows}
    # Neither day's own coverage being present at all (a cold database, or a
    # window shorter than WINDOW_DAYS because this map has not been running
    # that long) is the same "cannot compare" verdict as either being thin.
    latest_coverage = coverage_by_day.get(latest_day, 0)
    oldest_coverage = coverage_by_day.get(oldest_day, 0)
    trend_computable = (
        latest_coverage >= MIN_DAILY_AIS_REPORTS and oldest_coverage >= MIN_DAILY_AIS_REPORTS
    )
    reason = None if trend_computable else (
        f"AIS coverage on {oldest_day if oldest_coverage < MIN_DAILY_AIS_REPORTS else latest_day} "
        f"is too thin to compare against the other end of the {WINDOW_DAYS}-day window"
    )

    by_day: dict = {}
    for row in navy_rows:
        by_day.setdefault(row["day"].date(), []).append(row)

    region_defs = _regions_with_bounds()
    port_index = ProximityIndex(_ports())

    def _distinct_on(day, region_key=None, bounds=None, port_id=None) -> int:
        rows = by_day.get(day, [])
        if bounds is not None:
            rows = regions.filter_points(rows, bounds)
        if port_id is not None:
            rows = [
                r for r in rows
                if (m := port_index.nearest(r["lat"], r["lon"], PORT_MATCH_RADIUS_KM)) and m["id"] == port_id
            ]
        return len({r["entity_id"] for r in rows})

    out_regions = {}
    for key, label, bounds in region_defs:
        current = _distinct_on(latest_day, bounds=bounds)
        week_ago = _distinct_on(oldest_day, bounds=bounds)
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

    # Every port a navy hull was matched to on either the current or the
    # oldest day -- not every port this app knows, most of which never see a
    # warship and would otherwise pad the document with zeros (the same
    # "carried only where there is something to carry" rule storage.
    # airfield_activity's own hourly_military applies).
    candidate_port_ids = {
        m["id"] for row in by_day.get(latest_day, []) + by_day.get(oldest_day, [])
        if (m := port_index.nearest(row["lat"], row["lon"], PORT_MATCH_RADIUS_KM))
    }
    port_by_id = {p["id"]: p for p in _ports()}
    out_ports = {}
    for port_id in candidate_port_ids:
        current = _distinct_on(latest_day, port_id=port_id)
        week_ago = _distinct_on(oldest_day, port_id=port_id)
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
        "regions": out_regions,
        "ports": out_ports,
    }


async def compute() -> dict:
    pool = storage.get_pool()
    if pool is None:
        return {}
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=WINDOW_DAYS)
    async with pool.acquire() as conn:
        navy_records = await conn.fetch(_NAVY_POSITIONS_SQL, since, MILITARY_SHIP_TYPE)
        coverage_records = await conn.fetch(_DAILY_COVERAGE_SQL, since)
    navy_rows = [
        {"day": r["day"], "entity_id": r["entity_id"], "lat": r["lat"], "lon": r["lon"]}
        for r in navy_records
    ]
    coverage_rows = [{"day": r["day"], "reports": r["reports"]} for r in coverage_records]
    return build_document(navy_rows, coverage_rows, now)


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
