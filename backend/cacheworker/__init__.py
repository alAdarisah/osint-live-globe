"""What the cache worker considers wrong, as a pure function over one probe.

**This package never writes a cache key, and never repopulates one.** It watches
and it reports; that is the entire contract. The reason is that a monitor which
also repairs cannot tell you the difference between "healthy" and "broken but
being patched every 60 seconds" -- the symptom disappears and the cause does
not. Repopulating is the backend's job, on the read path, where a miss is
already handled correctly.

evaluate() is pure so that every condition below can be tested without a Redis,
a Postgres or a clock. The probing that feeds it lives in __main__.py.
"""

import logging
from dataclasses import dataclass

from backend import config

log = logging.getLogger("osint-globe.cacheworker")

# The subject used for conditions about the cache server itself, as opposed to
# one cached kind. Kept distinct so /api/health can separate "Redis is unwell"
# from "the ships layer is unwell".
SERVER = "cache"


@dataclass(frozen=True)
class Alert:
    subject: str
    condition: str
    severity: str  # "warning" | "critical"
    detail: str

    def key(self) -> tuple[str, str]:
        return (self.subject, self.condition)


@dataclass
class Probe:
    """One observation of the whole system. Every field may be absent."""

    # Redis INFO
    reachable: bool = True
    hits: int | None = None
    misses: int | None = None
    evicted_keys: int | None = None
    used_memory: int | None = None
    maxmemory: int | None = None
    # Per kind: kind -> (cached watermark or None, Postgres watermark or None)
    watermarks: dict | None = None
    # Per source name: the (last_success, last_error) the backend's mirror would
    # compute from source_health, already reduced by mirror.health_verdict.
    producers: dict | None = None
    # evicted_keys at the previous probe, for a delta rather than a lifetime
    # total -- Redis never resets these counters, so the absolute number says
    # only "this server has evicted at some point since it started".
    previous_evicted: int | None = None
    # kind -> how many consecutive probes it has had rows in Postgres and
    # nothing cached. An empty cache is the *normal* state after any Redis
    # restart, because the backend fills it on the read path and only reads on a
    # change: osm_infra changes once a day, so it is legitimately uncached for
    # hours. Reported only once it has persisted long enough to mean something.
    uncached_streak: dict | None = None


def evaluate(probe: Probe) -> list[Alert]:
    alerts: list[Alert] = []

    if not probe.reachable:
        # Critical, but explicitly not an outage: the map still works, served
        # straight from Postgres (see backend/cachestore.py). The message says
        # so, because "cache down" reads as "site down" to anyone woken by it.
        return [
            Alert(
                SERVER, "unreachable", "critical",
                "Redis is not answering. The map is unaffected -- the backend is "
                "reading Postgres directly -- but every payload is being rebuilt "
                "from the database on each change.",
            )
        ]

    if probe.maxmemory and probe.used_memory:
        used_fraction = probe.used_memory / probe.maxmemory
        if used_fraction >= config.CACHE_MEMORY_WARN_FRACTION:
            alerts.append(Alert(
                SERVER, "memory", "warning",
                f"Redis is at {used_fraction:.0%} of its {probe.maxmemory // (1024 * 1024)}MB "
                f"limit. With allkeys-lru that means it is about to start evicting "
                f"payloads it will then have to rebuild.",
            ))

    if probe.previous_evicted is not None and probe.evicted_keys is not None:
        evicted = probe.evicted_keys - probe.previous_evicted
        if evicted > 0:
            alerts.append(Alert(
                SERVER, "evicting", "warning",
                f"{evicted} keys evicted since the last check. Every eviction is a "
                f"payload that has to be read back out of Postgres in full.",
            ))

    total = (probe.hits or 0) + (probe.misses or 0)
    if total >= config.CACHE_MIN_SAMPLES_FOR_RATIO:
        ratio = (probe.hits or 0) / total
        if ratio < config.CACHE_HIT_RATIO_WARN:
            alerts.append(Alert(
                SERVER, "low_hit_ratio", "warning",
                f"Hit ratio is {ratio:.0%} over {total} lookups. Expected to be high: "
                f"entries are invalidated by watermark, not by expiry, so a low ratio "
                f"means keys are disappearing rather than being superseded.",
            ))

    for kind, (cached, stored) in sorted((probe.watermarks or {}).items()):
        if stored is None:
            # Nothing in Postgres for this kind either, so an empty cache is the
            # correct state, not a fault.
            continue
        if cached is None:
            streak = (probe.uncached_streak or {}).get(kind, 0)
            if streak < config.CACHE_UNCACHED_PROBES:
                # Still inside the grace window. Saying nothing here is the whole
                # difference between an alert channel that gets read and one that
                # fires seven times on every deploy.
                continue
            minutes = streak * config.CACHE_WORKER_INTERVAL // 60
            alerts.append(Alert(
                kind, "not_cached", "warning",
                f"{kind} has rows in Postgres and nothing cached, for {minutes} minutes "
                f"now. Expected briefly after a Redis restart; this long means either "
                f"the backend is not reaching Redis, or this kind has not changed since "
                f"the cache came up.",
            ))
        elif cached != stored:
            # Not a staleness bug on its own -- the backend caches on the read
            # path, so between a write and the next mirror pass these disagree
            # by design. It is worth reporting only because a *persistent*
            # disagreement means the backend has stopped following.
            alerts.append(Alert(
                kind, "cache_behind", "warning",
                f"{kind}'s cached copy is older than Postgres ({cached} vs {stored}). "
                f"Normal for one mirror interval; persistent means the backend has "
                f"stopped following this kind.",
            ))

    for source, error in sorted((probe.producers or {}).items()):
        if error:
            alerts.append(Alert(source, "producer", "critical", error))

    return alerts
