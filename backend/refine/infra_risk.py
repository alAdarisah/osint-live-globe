"""Task 37: infrastructure at risk.

For every conflict event that carries a real uncertainty radius
(`geo_radius_km` on conflict_events -- see backend/storage.py's schema
comment), which dams, power plants, submarine cable landings, airfields and
ports fall inside that radius, and, ranked, which of those sites has the
most such events near it in this map's active window.

**Proximity is not causation.** A dam turning up inside an event's
uncertainty circle means the dam sits inside the *radius of doubt about
where the event happened* -- not that the event targeted, damaged, struck
near, or was in any way related to the dam. A country-centroid placement is
a 400km circle (see storage.py); the whole width of a small country can
share one event's circle without anything in it being touched. Every
document this module produces, and every place it is read, repeats that: a
ranked list is exactly the format that invites the shortcut this sentence
exists to block.

**Why this runs in the refine process, not inside the request.**
escalation.py already made this trade once, for the same table: aggregating
a window of conflict_events used to run inside GET /api/escalation, so every
couple of minutes one unlucky client paid for the whole scan. This module
does the same aggregation (a window of conflict_events, each row checked
against a spatial index of five infrastructure categories) and would be the
same mistake repeated if it ran per-request. Precomputed here on a slow
clock (config.INFRA_RISK_INTERVAL) and served from the stored document by
GET /api/infra-risk, the same shape naval_presence.py and lane_density's
chokepoint accounting already use.

**Why this reads entity_latest, not the in-process registries.** dams.py,
ports.py, cables.py and airports.py are backend-process pollers; osm_infra.py
(the source of `power_plant` records) is an ingest-process poller. This
module runs in a third process (refine) that never ran any of those pollers,
so their in-memory SourceState.data is never populated here -- only what
each of them wrote to Postgres is. All five already persist to entity_latest
(record_snapshot, see each module's own start()), which is a small, indexed
table this project's global constraint explicitly allows a request or a
refine pass to read (unlike entity_history, the 11GB raw movement log this
module never touches).

**"Found nothing" vs "did not look" vs "not collected here."** Three
different states, all real, and this module keeps them apart rather than
collapsing them into one count:

  - An event with no `geo_radius_km` (nullable, genuinely absent on many
    rows) was never searched at all -- counted under `events_without_radius`,
    never folded into `events_searched`.
  - An event that *was* searched and had nothing within its radius
    contributed zero sites to `top` -- it is counted in `events_searched`,
    it just never appears as a hit.
  - A category with zero indexed sites (`category_counts`) was not
    collected in the theatres this event's window touches at all -- no
    number of events searched against it could ever turn up a match, which
    is a different fact from "we searched and this category was clear."
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from backend import config, storage
from backend.sources.proximity import ProximityIndex

log = logging.getLogger("osint-globe.infra_risk")

# What "active window" means for this document: conflict_events whose
# first_seen (when this map first heard about the incident, not when it
# happened -- see storage.py's own comment on why escalation.py's baseline
# query leads with the same column) falls in the last WINDOW_DAYS. 30 days,
# the same order of magnitude as lane_density's own CHOKEPOINT_TREND_DAYS:
# long enough that a ranked "most at-risk infrastructure" list is not
# reshuffled by a single quiet or busy day, short enough that it still
# describes the map's current picture rather than its entire archive.
WINDOW_DAYS = 30

# How many ranked sites the document carries. The universe underneath it can
# be large (dams.py alone holds ~3,555 records in the eleven theatres), and a
# "most at risk" panel is a shortlist, not a re-listing of everything this
# map has ever indexed.
TOP_N = 30

REFERENCE_NAME = "infra_risk"

# Scoped to the current pipeline version, same as escalation.py's own query
# and for the same reason: a pipeline change that alters how many events are
# fused is a change in us, not in the world, and must not read as every
# infrastructure site suddenly acquiring a burst of new risk.
_EVENTS_SQL = """
SELECT id, lat, lon, geo_radius_km
  FROM conflict_events
 WHERE first_seen >= $1 AND pipeline_version = $2
"""

CATEGORY_LABEL = {
    "dam": "Dam / reservoir",
    "power_plant": "Power plant",
    "cable_landing": "Submarine cable landing",
    "airfield": "Airfield",
    "port": "Port",
}


def _site_id(category: str, raw_id) -> str:
    # Namespaced so a dam's GDW id (already prefixed "gdw:...") and an OSM
    # power plant's "osm:way/123" can never collide with each other or with a
    # bare NGA port globalId, the same reasoning osm_infra.py's own `osm:`
    # prefix gives.
    return f"{category}:{raw_id}"


def _points_for(category: str, rows: list[dict]) -> list[dict]:
    """`rows` (an entity_latest kind's payloads) -> ProximityIndex points for
    one Nearby category. A row with no usable id or coordinate is dropped
    rather than indexed under a guessed key or position."""
    out = []
    for row in rows or ():
        lat, lon = row.get("lat"), row.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        raw_id = row.get("id")
        if raw_id is None:
            continue
        out.append({
            "lat": lat,
            "lon": lon,
            "site_id": _site_id(category, raw_id),
            "category": category,
            "name": row.get("name") or CATEGORY_LABEL[category],
        })
    return out


def build_index(dams, osm_infra, cable_landings, airfields, ports) -> tuple[ProximityIndex, dict]:
    """The five categories -> one spatial index plus how many sites of each
    category actually made it in (usable id and coordinate).

    `osm_infra` is the raw kind (military airfields, border posts, power
    plants and more, all sharing one entity_latest kind -- see
    backend/sources/osm_infra.py); only its `kind == "power_plant"` rows are
    a Nearby category here, the same filter map/eventDetail.js applies
    client-side to raw.powerPlants (itself split out of raw.osmInfra by
    Task 28's createMapController.js change).

    Returned as one combined index rather than five separate ones: an
    event's search is "everything within this radius, whichever category it
    belongs to", not five separate radius queries, and ProximityIndex.within
    does not care what a point's own fields mean beyond lat/lon.
    """
    power_plants = [row for row in (osm_infra or ()) if row.get("kind") == "power_plant"]
    points_by_category = {
        "dam": _points_for("dam", dams),
        "power_plant": _points_for("power_plant", power_plants),
        "cable_landing": _points_for("cable_landing", cable_landings),
        "airfield": _points_for("airfield", airfields),
        "port": _points_for("port", ports),
    }
    all_points = [p for points in points_by_category.values() for p in points]
    category_counts = {category: len(points) for category, points in points_by_category.items()}
    return ProximityIndex(all_points, cell_deg=0.5), category_counts


def build_document(events: list[dict], index: ProximityIndex, category_counts: dict, now: float) -> dict:
    """The stored document, from plain event rows and an already-built index
    -- no asyncpg, no network -- split out of compute() so the radius-filter
    and ranking arithmetic is directly testable, the same shape
    naval_presence.build_document takes.

    `events`: [{"id": str, "lat": float, "lon": float, "geo_radius_km": float | None}, ...]
    """
    searched = 0
    without_radius = 0
    sites: dict[str, dict] = {}

    for event in events:
        lat, lon = event.get("lat"), event.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        radius = event.get("geo_radius_km")
        # A missing or non-positive radius is not searchable at all -- see
        # the module docstring's "found nothing vs did not look" section.
        # This is counted separately and never folded into `searched`.
        if not isinstance(radius, (int, float)) or radius <= 0:
            without_radius += 1
            continue
        searched += 1
        for point in index.within(lat, lon, radius):
            entry = sites.setdefault(point["site_id"], {
                "site_id": point["site_id"],
                "category": point["category"],
                "name": point["name"],
                "lat": point["lat"],
                "lon": point["lon"],
                "event_count": 0,
            })
            entry["event_count"] += 1

    # Ranked by event_count descending. Ties are broken on site_id ascending
    # -- not left to whatever order dict-of-sets insertion happened to
    # produce, which is the order events were scanned in and would silently
    # reorder tied sites from one refine pass to the next as new events land
    # without anything about the sites themselves changing. site_id is
    # stable (it is derived from the site's own persistent id) and unique
    # (namespaced per category, see _site_id), so this is a total order: two
    # sites can never compare equal and swap places between passes.
    ranked = sorted(sites.values(), key=lambda entry: (-entry["event_count"], entry["site_id"]))

    return {
        "as_of": now,
        "window_days": WINDOW_DAYS,
        "events_searched": searched,
        "events_without_radius": without_radius,
        "category_counts": category_counts,
        "top": ranked[:TOP_N],
        "note": (
            "Proximity is not causation. A site listed here sits inside one or more events' own "
            "uncertainty radius -- the area of doubt about where the event happened -- not evidence "
            "it was targeted, struck, or otherwise involved. A country-centroid event is placed to a "
            "400km radius; the whole width of a small country can share one such circle."
        ),
    }


async def compute() -> dict:
    pool = storage.get_pool()
    if pool is None:
        return {}
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=WINDOW_DAYS)

    dams, osm_infra, cable_landings, airfields, ports = await asyncio.gather(
        storage.entity_latest("dams"),
        storage.entity_latest("osm_infra"),
        storage.entity_latest("cable_landings"),
        storage.entity_latest("airports"),
        storage.entity_latest("ports"),
    )
    index, category_counts = build_index(dams, osm_infra, cable_landings, airfields, ports)

    async with pool.acquire() as conn:
        rows = await conn.fetch(_EVENTS_SQL, since, config.CONFLICT_PIPELINE_VERSION)
    events = [
        {"id": r["id"], "lat": r["lat"], "lon": r["lon"], "geo_radius_km": r["geo_radius_km"]}
        for r in rows
    ]
    return build_document(events, index, category_counts, now.timestamp())


async def derive_forever():
    """Recompute the ranking on a loop, in the refine process.

    Same "publish an empty-but-real document rather than skip a pass"
    discipline escalation.py, naval_presence.py and lane_density's chokepoint
    accounting all already follow: "nothing ranked yet" (an empty `top`) and
    "not computed at all" (no document written) are different answers, and
    skipping a failed pass would leave a stale document quietly implying the
    first when the truth is closer to the second.
    """
    while True:
        try:
            doc = await compute()
            await storage.record_reference(REFERENCE_NAME, doc)
            await storage.record_source_health(REFERENCE_NAME, len(doc.get("top", [])), True)
            log.info(
                "Infra risk: %d events searched, %d without a radius, %d sites ranked",
                doc.get("events_searched", 0), doc.get("events_without_radius", 0), len(doc.get("top", [])),
            )
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Infra risk computation failed: %s", exc)
            await storage.record_source_health(REFERENCE_NAME, None, False, str(exc))
        await asyncio.sleep(config.INFRA_RISK_INTERVAL)
