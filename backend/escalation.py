"""Escalation detection: which conflict zones are unusually active *for
themselves* right now.

The map answers "what exists". This answers "what is changing", which is the
question an OSINT tool is actually for. A region with 40 events/day isn't
newsworthy if it always has 40; a region that normally sees 2 and just saw 9
is. So every region is compared against its own recent baseline rather than
against other regions -- Sahel and the Taiwan Strait are not comparable in
absolute counts, but each is comparable to its own last week.

Reads conflict_events (see backend/storage.py), which event_fusion.py has
been writing since Piece 1, including the severity score. Returns nothing at
all when there isn't enough history to make an honest claim -- a cold
database should produce silence, not a fabricated spike.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from backend import config, regions, storage

log = logging.getLogger("osint-globe.escalation")

# The window treated as "now". A day rather than an hour: conflict reporting
# is lumpy, and an hourly window mostly measures news-cycle timing rather
# than events on the ground.
CURRENT_WINDOW_HOURS = 24

# How much history the current window is judged against.
BASELINE_DAYS = 7

# Additive smoothing on the baseline. Without it a region going 0 -> 2 reads
# as an infinite spike, which would put every quiet corner of the world at
# the top of the list the first time anything happened there.
_SMOOTHING = 1.0

# Below this, a "ratio" is arithmetic noise rather than a signal -- two
# events against a baseline of one is not an escalation worth surfacing.
MIN_CURRENT_EVENTS = 3

# How far above baseline counts as escalating. 1.5x is deliberately modest;
# the list is ranked, so the threshold only decides what's worth mentioning
# at all.
MIN_RATIO = 1.5

# Refuse to report on a database that hasn't observed a full baseline yet:
# comparing today against two hours of history is meaningless, and the
# resulting numbers would look authoritative anyway.
MIN_BASELINE_COVERAGE_HOURS = 36


# Every window is scoped to one pipeline version. A change that makes the
# pipeline see more events -- which is a change in us, not in the world --
# would otherwise land as a simultaneous multi-fold "escalation" in every
# region at once. Scoping means a version bump resets the observed history, so
# MIN_BASELINE_COVERAGE_HOURS below takes over and this stays quiet until it
# has a comparable baseline again. Silence is the correct output there.
_SQL = """
WITH windows AS (
  SELECT
    id, lat, lon, severity, event_type, country, notes, first_seen,
    (first_seen >= $1) AS is_current,
    (first_seen >= $2 AND first_seen < $1) AS is_baseline
  FROM conflict_events
  WHERE first_seen >= $2 AND pipeline_version = $7
)
SELECT
  count(*) FILTER (WHERE is_current)  AS current_count,
  count(*) FILTER (WHERE is_baseline) AS baseline_count,
  coalesce(sum(severity) FILTER (WHERE is_current), 0) AS current_severity,
  min(first_seen) AS oldest_seen
FROM windows
WHERE lat BETWEEN $3 AND $4 AND lon BETWEEN $5 AND $6
"""

_TOP_EVENTS_SQL = """
SELECT event_type, country, notes, severity, lat, lon
  FROM conflict_events
 WHERE first_seen >= $1
   AND lat BETWEEN $2 AND $3 AND lon BETWEEN $4 AND $5
   AND pipeline_version = $6
 ORDER BY severity DESC NULLS LAST, first_seen DESC
 LIMIT 3
"""

# Minimum successful `events` polls inside the current window for its counts to
# mean anything. At GDELT_POLL_INTERVAL=900s a healthy 24 hours is ~96 polls;
# below a quarter of that, a low current count says more about our own downtime
# than about the world, and reporting either the quiet or the catch-up spike
# would be a claim about the world made from a fact about our uptime.
MIN_POLLS_IN_WINDOW = 24

_POLL_COUNT_SQL = """
SELECT count(*) FROM source_health
 WHERE source = 'events' AND ok AND ts >= $1
"""


async def compute() -> list[dict]:
    """Ranked escalating regions, most escalated first. Empty when the
    database lacks the history to say anything defensible."""
    # The read replica when one is open, the primary otherwise (get_read_pool
    # falls back, and returns None only when the primary is down too, so the
    # check below keeps its original meaning). Safe to route: this scans
    # conflict_events and source_health over a 24-hour window against a
    # multi-day baseline, once per region, and writes nothing -- seconds of
    # replication lag cannot move a ratio measured in days.
    pool = storage.get_read_pool()
    if pool is None:
        return []

    now = datetime.now(timezone.utc)
    current_from = now - timedelta(hours=CURRENT_WINDOW_HOURS)
    baseline_from = now - timedelta(days=BASELINE_DAYS)

    results = []
    version = config.CONFLICT_PIPELINE_VERSION
    try:
        async with pool.acquire() as conn:
            # Were we actually watching? A gap in our own polling looks
            # identical to a quiet 24 hours in the data, and the two must not
            # be reported the same way.
            polls = await conn.fetchval(_POLL_COUNT_SQL, current_from)
            if (polls or 0) < MIN_POLLS_IN_WINDOW:
                log.info(
                    "Escalation suppressed: only %s successful event polls in the last %dh "
                    "(need %d) -- our own coverage is too thin to call this",
                    polls, CURRENT_WINDOW_HOURS, MIN_POLLS_IN_WINDOW,
                )
                return []

            for key, entry in regions.REGIONS.items():
                bounds = entry.get("bounds")
                if not bounds:
                    continue  # "world" has no bounds -- not a rankable zone
                south, west, north, east = bounds

                row = await conn.fetchrow(_SQL, current_from, baseline_from, south, north, west, east, version)
                if row is None:
                    continue

                current = row["current_count"] or 0
                baseline_total = row["baseline_count"] or 0
                oldest = row["oldest_seen"]

                # Not enough observed history for the comparison to mean
                # anything -- stay silent rather than dividing by a baseline
                # that simply hasn't been collected yet.
                if oldest is None:
                    continue
                coverage_hours = (now - oldest).total_seconds() / 3600
                if coverage_hours < MIN_BASELINE_COVERAGE_HOURS:
                    continue

                if current < MIN_CURRENT_EVENTS:
                    continue

                # Baseline is a *daily* rate, so the current 24h window is
                # compared like with like.
                baseline_days = max((BASELINE_DAYS * 24 - CURRENT_WINDOW_HOURS) / 24, 1e-9)
                baseline_rate = baseline_total / baseline_days
                ratio = (current + _SMOOTHING) / (baseline_rate + _SMOOTHING)
                if ratio < MIN_RATIO:
                    continue

                top = await conn.fetch(_TOP_EVENTS_SQL, current_from, south, north, west, east, version)
                results.append({
                    "region": key,
                    "label": entry["label"],
                    "bounds": list(bounds),
                    "current": current,
                    "baseline_per_day": round(baseline_rate, 2),
                    "ratio": round(ratio, 2),
                    "severity_sum": int(row["current_severity"] or 0),
                    "top_events": [
                        {
                            "event_type": e["event_type"],
                            "country": e["country"],
                            "notes": e["notes"],
                            "severity": e["severity"],
                            "lat": e["lat"],
                            "lon": e["lon"],
                        }
                        for e in top
                    ],
                })
    except Exception:  # noqa: BLE001 - an aggregate query failing must not 500 the app
        log.exception("Escalation computation failed")
        return []

    # Ratio first, then absolute severity as the tiebreak: a 3x spike in a
    # region seeing real casualties outranks a 3x spike of minor incidents.
    results.sort(key=lambda r: (r["ratio"], r["severity_sum"]), reverse=True)
    return results


# The stored name compute()'s result is published under, and the one
# /api/escalation reads back. Whole-document, so reference_snapshots rather than
# a table of its own: the ranking is one ordered list that is replaced wholesale
# every pass, which is exactly the shape that table exists for.
REFERENCE_NAME = "escalation"


async def rank_forever():
    """Recompute the ranking on a loop, in the refine process.

    This used to run inside the request for /api/escalation, behind a 2-minute
    cache -- so every couple of minutes one unlucky client paid for a week of
    conflict_events aggregated across every region, and did so on the same event
    loop serving the rest of the map. Precomputing it costs nothing in
    freshness: the only input is what event_fusion writes, and this runs on the
    same cadence.

    An empty result is written, not skipped. "No region is escalating" and "we
    have not computed this yet" are different answers, and the second one is
    what a stale stored ranking would keep implying.
    """
    while True:
        try:
            results = await compute()
            await storage.record_reference(REFERENCE_NAME, results)
            await storage.record_source_health(REFERENCE_NAME, len(results), True)
            log.info("Escalation: %d regions above baseline", len(results))
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Escalation ranking failed: %s", exc)
            await storage.record_source_health(REFERENCE_NAME, None, False, str(exc))
        await asyncio.sleep(config.ESCALATION_REFRESH_INTERVAL)
