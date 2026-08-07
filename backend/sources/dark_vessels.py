"""Two things AIS shows by *not* showing them.

Every other source in this package fetches something. This one fetches nothing:
it reads the position history this backend has already recorded (see
backend/storage.py) and looks for two patterns that only exist in the gaps.

**Going dark.** A vessel stops transmitting for hours and reappears somewhere
else. Switching a transponder off is a deliberate act and the classic
sanctions-evasion signature, and the implied speed across the gap is the tell:
if the reappearance implies 40 knots, the track that came back is not the track
that left.

**Ship-to-ship transfer.** Two vessels sitting alongside each other at almost
zero speed, well away from any port. That is how cargo changes hulls without
either one visiting a terminal.

Both are *inferences*, and neither is safe to present as a detection:

- An AIS receiver outage looks exactly like a transponder switched off. That is
  guarded against explicitly below (see `_feed_was_healthy`) by checking whether
  the whole feed was quiet over the same window -- but coverage is thin far
  from shore and no guard fixes that.
- Two ships close together may be passing, rafted for a pilot transfer, or
  sitting in an anchorage. Ports are excluded (see `_port_index`); anchorages
  are not a port index's business, and no list here holds them.

So every record carries `inferred: True`, states its own evidence, and the
layer renders with the dashed treatment the map already uses for anything whose
position or meaning is uncertain. This module is allowed to say "worth a look".
It is not allowed to say "detected".
"""

import asyncio
import logging
import statistics
import time

from backend import config, infrastructure, storage
from backend.cache import registry
from backend.sources.proximity import ProximityIndex, haversine_km

log = logging.getLogger("osint-globe.dark_vessels")

REFRESH_INTERVAL = 15 * 60
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# How far back to look. Bounded by HISTORY_RETENTION_SECONDS anyway -- asking
# for more would silently return less -- so it is read from there rather than
# restated, and a change to the retention window cannot leave this asking for
# history that was already deleted.
LOOKBACK_SECONDS = config.HISTORY_RETENTION_SECONDS

# --- going dark ---

# Below this, a gap is ordinary. AIS coverage is patchy offshore and a ship can
# easily drop out for an hour or two with nothing behind it; four hours in a
# monitored chokepoint is not routine.
GAP_MIN_HOURS = 4.0
# Above this, the "gap" is really "we lost coverage of this region for a day",
# which says nothing about the vessel.
GAP_MAX_HOURS = 36.0
# A gap only counts inside the waters this map actually watches (see
# config.AIS_BBOXES): elsewhere our own coverage is too thin for absence to mean
# anything at all.
REQUIRE_CHOKEPOINT = True
MAX_GAP_RECORDS = 120

# --- ship-to-ship transfer ---

STS_MAX_SEPARATION_KM = 0.5
STS_MAX_SPEED_KN = 1.0
STS_MIN_DURATION_HOURS = 1.0
# Anywhere within this of a charted port is a port call, not a transfer at sea.
#
# Two lists feed it (see `_port_index`): the 40 curated harbours in
# backend/infrastructure.py, and every port the NGA World Port Index places
# inside this map's theatres or AIS watch boxes -- 393 of them, of which 263 sit
# in watched water against the curated list's 12. That is the difference between
# one excluded port in the whole Persian Gulf and fifty-two of them.
#
# It is still not a zero-false-positive exclusion, and the popup must not say it
# is. WPI is an index of *ports*; a designated anchorage, a lightering area or a
# stretch of sheltered water where tankers habitually wait appears in neither
# list, and two hulls sitting in one will still surface here. Each record
# carries `ports_checked` so the popup can state what was actually applied
# rather than describing a list it cannot see.
STS_PORT_EXCLUSION_KM = 25.0
MAX_STS_RECORDS = 80

# AIS navigational status 5 is "moored". A moored vessel is alongside something,
# which is the ordinary explanation for sitting still, so it is excluded outright
# rather than reported and explained away.
NAV_STATUS_MOORED = 5

# If the AIS feed's own item count collapsed to this fraction of its typical
# level during a gap, the gap is about us, not about the ship.
FEED_HEALTH_MIN_RATIO = 0.5


def _in_watched_waters(lat: float, lon: float) -> bool:
    return any(
        lat_min <= lat <= lat_max and lon_min <= lon <= lon_max
        for lat_min, lon_min, lat_max, lon_max in config.AIS_BBOXES
    )


def _port_index(wpi_ports: list[dict] | None = None) -> ProximityIndex:
    """Every port this map knows of, as one exclusion index.

    Both lists, not one. The curated entries in backend/infrastructure.py are
    hand-checked and carry notes a bulk file cannot ("de facto wartime
    capital"), and several of them -- offshore loading platforms, naval
    terminals -- are not ports in NGA's sense at all and appear nowhere in WPI.
    The World Port Index supplies the coverage: 2,951 real harbours, of which
    the ports source stores the 393 inside this map's theatres and AIS boxes.
    Dropping either list would lose something the other does not have.

    `wpi_ports` comes from entity_latest (see `_compute`). An empty list is a
    working state, not an error -- it is what the first minutes after a fresh
    deployment look like, before backend/sources/ports.py has landed its first
    snapshot -- and it degrades to exactly the curated-only behaviour this
    module had before.
    """
    curated = [s for s in infrastructure.INFRA_SITES if s.get("type") == "port"]
    return ProximityIndex(curated + list(wpi_ports or []), cell_deg=0.5)


def feed_health_baseline(series: list[tuple[float, int | None, bool]]) -> float | None:
    """The AIS feed's typical item count over the window, or None if unknowable."""
    counts = [count for _ts, count, ok in series if ok and isinstance(count, int) and count > 0]
    if len(counts) < 3:
        return None
    return float(statistics.median(counts))


def feed_was_healthy(
    series: list[tuple[float, int | None, bool]], start: float, end: float, baseline: float | None
) -> bool:
    """Was our own AIS feed working across this window?

    Answers the objection that sinks this whole detection if left unanswered: a
    receiver or upstream outage makes every ship in a region appear to go dark
    at once. With no health record at all the answer is "assume yes" -- refusing
    to report anything would be the wrong failure mode for a signal whose whole
    value is that it is rare -- but a measured collapse suppresses the gap.
    """
    window = [(ts, count, ok) for ts, count, ok in series if start <= ts <= end]
    if any(not ok for _ts, _count, ok in window):
        # Checked before the baseline, not after. A recorded failure across the
        # gap is direct evidence about our own feed and needs no comparison to
        # interpret -- and requiring a baseline first is what made this guard
        # inert exactly when it mattered most: through a total outage the feed
        # recorded nothing but failures, so there was no successful count to
        # take a median of, so every vessel in every watched box read as having
        # gone dark at the same moment.
        return False
    if baseline is None:
        return True
    if not window:
        # No polls recorded across the gap at all: the snapshot loop itself was
        # not running, which is exactly the case this guard exists for.
        return False
    counts = [count for _ts, count, _ok in window if isinstance(count, int)]
    if not counts:
        return False
    return min(counts) >= baseline * FEED_HEALTH_MIN_RATIO


def build_gap_records(
    gaps: list[dict],
    ships_by_mmsi: dict[str, dict],
    health: list[tuple[float, int | None, bool]],
) -> list[dict]:
    """Position gaps -> the ones worth showing, with their own evidence attached."""
    baseline = feed_health_baseline(health)
    out: list[dict] = []
    for gap in gaps:
        hours = gap["gap_seconds"] / 3600.0
        if hours > GAP_MAX_HOURS:
            continue
        if REQUIRE_CHOKEPOINT and not (
            _in_watched_waters(gap["from_lat"], gap["from_lon"])
            and _in_watched_waters(gap["to_lat"], gap["to_lon"])
        ):
            continue
        if not feed_was_healthy(health, gap["from_ts"], gap["to_ts"], baseline):
            continue
        distance_km = haversine_km(gap["from_lat"], gap["from_lon"], gap["to_lat"], gap["to_lon"])
        # Nautical miles per hour, from the straight-line distance. A number
        # above ~25 kn for a merchant vessel means the reappearance cannot be
        # the same continuous voyage -- which is the interesting case, not a
        # reason to discard the record.
        implied_speed_kn = (distance_km / 1.852) / hours if hours > 0 else 0.0
        ship = ships_by_mmsi.get(gap["entity_id"]) or {}
        out.append({
            "id": f"gap:{gap['entity_id']}:{int(gap['from_ts'])}",
            "kind": "ais_gap",
            # Drawn where it went quiet, not where it came back: the last known
            # position is the fact, the reappearance is the consequence.
            "lat": gap["from_lat"],
            "lon": gap["from_lon"],
            "mmsi": gap["entity_id"],
            "name": ship.get("name"),
            "imo": ship.get("imo"),
            "sanctions": ship.get("sanctions"),
            "ship_type": ship.get("ship_type"),
            "went_dark_at": gap["from_ts"],
            "resumed_at": gap["to_ts"],
            "resumed_lat": gap["to_lat"],
            "resumed_lon": gap["to_lon"],
            "gap_hours": round(hours, 1),
            "resumed_km_away": round(distance_km, 1),
            "implied_speed_kn": round(implied_speed_kn, 1),
            "inferred": True,
        })
    out.sort(key=lambda r: (r.get("sanctions") is not None, r["gap_hours"]), reverse=True)
    return out[:MAX_GAP_RECORDS]


def build_sts_records(ships: list[dict], ports: ProximityIndex, now: float | None = None) -> list[dict]:
    """Pairs of vessels sitting alongside each other, away from any port."""
    now = time.time() if now is None else now
    candidates = []
    for ship in ships:
        lat, lon = ship.get("lat"), ship.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        speed = ship.get("speed")
        if not isinstance(speed, (int, float)) or speed > STS_MAX_SPEED_KN:
            continue
        if ship.get("nav_status") == NAV_STATUS_MOORED:
            continue
        still_hours = (now - (ship.get("_last_moved_at") or now)) / 3600.0
        if still_hours < STS_MIN_DURATION_HOURS:
            continue
        if ports.nearest(lat, lon, STS_PORT_EXCLUSION_KM):
            continue
        candidates.append({**ship, "_still_hours": still_hours})

    # Pairwise, and deliberately not indexed. ProximityIndex answers "the single
    # closest point", which is the wrong question here -- three tankers rafted
    # together is one of the shapes worth seeing -- and by this point the
    # candidate set is only the vessels that are stationary, not moored, offshore
    # and have been so for an hour, which in practice is dozens. An index over
    # that would be machinery standing in for a loop that is already fast and
    # obviously correct.
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for i, ship in enumerate(candidates):
        for other in candidates[i + 1:]:
            # Cheap degree pre-filter before the trigonometry: 0.5 km is well
            # under 0.02 degrees of latitude anywhere on earth.
            if abs(other["lat"] - ship["lat"]) > 0.02:
                continue
            separation = haversine_km(ship["lat"], ship["lon"], other["lat"], other["lon"])
            if separation > STS_MAX_SEPARATION_KM:
                continue
            key = tuple(sorted((str(ship["mmsi"]), str(other["mmsi"]))))
            if key in seen:
                continue
            seen.add(key)
            together_hours = min(ship["_still_hours"], other["_still_hours"])
            designated = [s for s in (ship.get("sanctions"), other.get("sanctions")) if s]
            out.append({
                "id": f"sts:{key[0]}:{key[1]}",
                "kind": "sts_pair",
                "lat": (ship["lat"] + other["lat"]) / 2,
                "lon": (ship["lon"] + other["lon"]) / 2,
                "vessels": [
                    {"mmsi": s.get("mmsi"), "name": s.get("name"), "imo": s.get("imo"),
                     "ship_type": s.get("ship_type"), "sanctions": s.get("sanctions")}
                    for s in (ship, other)
                ],
                "separation_m": round(separation * 1000),
                "together_hours": round(together_hours, 1),
                # The exclusion this pair survived, in its own words. Carried on
                # the record because the size of the port index is the whole
                # difference between "away from any port" as a claim and as a
                # check -- and because it is not constant: it is curated-only
                # until the ports source has written its first snapshot.
                "ports_checked": len(ports),
                "port_exclusion_km": STS_PORT_EXCLUSION_KM,
                "sanctions": designated[0] if designated else None,
                "designated_count": len(designated),
                "inferred": True,
            })
    out.sort(key=lambda r: (r["designated_count"], r["together_hours"]), reverse=True)
    return out[:MAX_STS_RECORDS]


async def _compute() -> list[dict]:
    since = time.time() - LOOKBACK_SECONDS
    gaps, ships, health = await asyncio.gather(
        storage.position_gaps("ais", since, GAP_MIN_HOURS * 3600),
        storage.entity_latest_with_times("ais"),
        storage.source_health_series("ais", since),
    )
    ships_by_mmsi = {str(s.get("mmsi")): s for s in ships if s.get("mmsi") is not None}
    return build_gap_records(gaps, ships_by_mmsi, health) + build_sts_records(ships, _port_index())


async def derive_forever():
    """The gap/STS derivation, for the life of the refine process.

    Self-paced rather than scheduled: the loop below retries after 60s and backs
    off from there when a pass fails, rather than waiting out the full 15
    minutes. A fixed schedule would throw that away, and this derivation runs
    three aggregate queries over the AIS movement log -- the case where retrying
    sooner matters is exactly the case where the database was busy.
    """
    state = registry.ensure("dark_vessels", key_configured=True)  # derives from our own history
    # Derived rather than fetched, but still worth storing and restoring: the
    # derivation reads AIS history that the pool has to be up to serve, so at
    # boot this source produces nothing until Postgres is connected *and* a
    # 15-minute cycle has run. Storing it also puts gaps and STS pairs on the
    # replay timeline alongside the positions they were derived from.
    await storage.warm_points(state, "dark_vessels", "Dark vessels")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            records = await _compute()
            state.data = records
            state.last_success = time.time()
            state.last_error = None
            ok = True
            gaps = sum(1 for r in records if r["kind"] == "ais_gap")
            log.info(
                "Dark vessels: %d AIS gaps, %d possible STS pairs (%d involving a designated hull)",
                gaps,
                len(records) - gaps,
                sum(1 for r in records if r.get("sanctions")),
            )
            await storage.record_snapshot("dark_vessels", records, id_field="id")
            await storage.record_source_health("dark_vessels", len(records), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Dark vessel derivation failed: %s", exc)
            await storage.record_source_health("dark_vessels", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
