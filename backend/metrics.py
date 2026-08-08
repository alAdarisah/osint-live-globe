"""Prometheus metrics for the backend process, served on /metrics.

This is deliberately a *different* view from the two that already exist:

  /api/health    per-source truth for the frontend's status panel, read live
                 from the in-memory registry and shaped for humans.
  postgres-exporter  what the database is doing, from Postgres' own statistics
                 views, with no idea an application exists.

Neither answers "is this process healthy and is it serving requests quickly".
That is what this adds: request rate and latency by route, how full the local
caches and rate-limit buckets are, how many pooled connections are checked out,
and the same per-source freshness numbers /api/health returns -- but as time
series, so "this source stopped four hours ago" is visible without anyone
having been watching at the time.

Two rules shape everything below.

**A scrape must not do I/O.** Prometheus scrapes on a fixed interval whether or
not the process is healthy, so a /metrics that queries Postgres turns a slow
database into a scrape timeout -- losing exactly the metrics that would explain
it. Every gauge here is read from memory at collection time. The one number
that genuinely lives in the database (open alerts) is refreshed by
`refresh_loop()` in the background and merely *read* during a scrape.

**Labels stay bounded.** Route labels come from the registered path template
(`/api/track/{kind}/{entity_id}`), never the request path, and anything that
matches no route collapses to a single `unmatched` label -- otherwise a crawler
hitting random URLs would mint a new time series per URL and the cost of that
lands on Prometheus, permanently.
"""

import asyncio
import logging
import time

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from prometheus_client.core import CounterMetricFamily, GaugeMetricFamily
from prometheus_client.registry import REGISTRY, Collector

from backend import storage
from backend.cache import registry as source_registry

log = logging.getLogger("osint-globe.metrics")

CONTENT_TYPE = CONTENT_TYPE_LATEST


# --- Request instrumentation ------------------------------------------------
#
# Buckets are chosen for what this API actually does rather than the library
# default: nearly every response is either a 304 or a filter over an in-memory
# list (sub-millisecond to a few ms), while the replay and history endpoints
# reach Postgres and run into seconds. The default buckets start at 5ms and so
# put the entire normal case in one bucket, which makes a p50 meaningless.

http_requests = Counter(
    "osint_http_requests",
    "Requests served, by route template, method and response status.",
    ["method", "route", "status"],
)

http_request_duration = Histogram(
    "osint_http_request_duration_seconds",
    "Wall-clock time to produce a response, by route template.",
    ["method", "route"],
    buckets=(0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, float("inf")),
)

http_requests_in_flight = Gauge(
    "osint_http_requests_in_flight",
    "Requests currently being served. Sustained above a handful on a single "
    "event loop means something is blocking it.",
)


# --- Outbound and cache counters --------------------------------------------

upstream_requests = Counter(
    "osint_upstream_requests",
    "On-demand upstream calls made by the tile and wind proxies. `result` is "
    "one of hit (served from the local cache, no upstream call), success, "
    "error, or rate_limited (declined by the token bucket before any call).",
    ["upstream", "result"],
)

cache_operations = Counter(
    "osint_cache_operations",
    "Redis payload-cache operations (see backend/cachestore.py). A miss and an "
    "error mean the same thing to the caller -- read Postgres -- but not to "
    "whoever is reading this: errors mean Redis is unreachable.",
    ["operation", "result"],
)


# --- Refreshed off the scrape path ------------------------------------------

alerts_active = Gauge(
    "osint_alerts_active",
    "Open rows in the alerts table, by severity -- what the cache worker is "
    "currently reporting. Refreshed on a timer, not on scrape.",
    ["severity"],
)
# Pre-seeded so a healthy stack publishes an explicit zero. Without this the
# series simply does not exist until the first alert fires, and "no data" is
# indistinguishable from "not scraping".
for _severity in ("warning", "critical"):
    alerts_active.labels(severity=_severity)


# --- Things read straight out of process memory at scrape time --------------

_local_caches: dict[str, object] = {}
_token_buckets: dict[str, object] = {}
_process_token = ""


def track_local_cache(name: str, cache) -> None:
    """Publish an LruTtlCache's occupancy as a gauge.

    These are bounded caches that evict silently, so the useful signal is how
    close to the cap they run: a tile cache pinned at maxsize is evicting
    entries that are still being asked for, which shows up as upstream calls
    rather than as any kind of error.
    """
    _local_caches[name] = cache


def track_token_bucket(name: str, bucket) -> None:
    """Publish a TokenBucket's remaining allowance.

    Reading the bucket does not take from it (see TokenBucket.available), so a
    scrape can never cause the rate limiting it is measuring.
    """
    _token_buckets[name] = bucket


def set_process_token(token: str) -> None:
    """Record app.py's per-process ETag token as an info label.

    It changes on every restart, which makes `changes(...)` over this series a
    direct count of how many times the process came back -- something no
    counter can show, since a counter's own reset is the thing being counted.
    """
    global _process_token
    _process_token = token


class _AppStateCollector(Collector):
    """Derives gauges from live objects at collection time.

    A collector rather than a set of module-level Gauges that something has to
    remember to update: the values already exist on the registry, the caches
    and the pool, and copying them on a timer would only add a way for the copy
    to be wrong.
    """

    def collect(self):
        now = time.time()

        yield self._info()

        source_up = GaugeMetricFamily(
            "osint_source_up",
            "1 when the source's last poll left no outstanding error.",
            labels=["source"],
        )
        source_items = GaugeMetricFamily(
            "osint_source_items",
            "Items the source is currently serving.",
            labels=["source"],
        )
        source_age = GaugeMetricFamily(
            "osint_source_seconds_since_success",
            "Seconds since this source last polled successfully. Absent until "
            "the first success, which is deliberately not the same as 0.",
            labels=["source"],
        )
        source_keyed = GaugeMetricFamily(
            "osint_source_key_configured",
            "1 when the credential this source needs is present. Always 1 for "
            "the keyless sources.",
            labels=["source"],
        )
        source_refresh = CounterMetricFamily(
            "osint_source_refresh",
            "Times the source has replaced its payload since this process "
            "started -- the same counter the HTTP ETags are built from.",
            labels=["source"],
        )

        for name, state in source_registry.health().items():
            source_up.add_metric([name], 0.0 if state["last_error"] else 1.0)
            source_items.add_metric([name], state["item_count"])
            source_keyed.add_metric([name], 1.0 if state["key_configured"] else 0.0)
            source_refresh.add_metric([name], state["version"])
            if state["last_success"]:
                source_age.add_metric([name], now - state["last_success"])

        yield from (source_up, source_items, source_age, source_keyed, source_refresh)

        cache_entries = GaugeMetricFamily(
            "osint_local_cache_entries",
            "Entries held in an in-process LruTtlCache.",
            labels=["cache"],
        )
        for name, cache in _local_caches.items():
            try:
                cache_entries.add_metric([name], len(cache))
            except TypeError:
                continue
        yield cache_entries

        tokens = GaugeMetricFamily(
            "osint_ratelimit_tokens_available",
            "Tokens a rate-limit bucket would grant right now. Zero means the "
            "next cache miss is refused rather than sent upstream.",
            labels=["bucket"],
        )
        capacity = GaugeMetricFamily(
            "osint_ratelimit_tokens_capacity",
            "The bucket's burst size, for reading the gauge above as a ratio.",
            labels=["bucket"],
        )
        for name, bucket in _token_buckets.items():
            tokens.add_metric([name], bucket.available)
            capacity.add_metric([name], bucket.capacity)
        yield from (tokens, capacity)

        yield from self._pool_metrics()

    def _info(self):
        family = GaugeMetricFamily(
            "osint_backend_info",
            "Always 1. The process_token label changes on every restart.",
            labels=["process_token"],
        )
        family.add_metric([_process_token], 1.0)
        return family

    def _pool_metrics(self):
        """asyncpg pool occupancy, without touching the database.

        get_size()/get_idle_size() report the pool's own bookkeeping, so this
        stays honest -- and stays fast -- while Postgres is unreachable, which
        is when it matters.
        """
        up = GaugeMetricFamily(
            "osint_storage_up",
            "1 when the asyncpg pool exists. 0 means every write is being "
            "dropped and every read is answering empty (see backend/storage.py).",
        )
        pool = storage.get_pool()
        up.add_metric([], 0.0 if pool is None else 1.0)
        yield up

        if pool is None:
            return

        connections = GaugeMetricFamily(
            "osint_db_pool_connections",
            "Connections the pool holds, split by whether they are checked out.",
            labels=["state"],
        )
        try:
            size = pool.get_size()
            idle = pool.get_idle_size()
            maximum = pool.get_max_size()
        except Exception:  # noqa: BLE001 - a scrape must never raise
            return
        connections.add_metric(["idle"], idle)
        connections.add_metric(["in_use"], max(size - idle, 0))
        yield connections

        limit = GaugeMetricFamily(
            "osint_db_pool_max_connections",
            "The pool's max_size. in_use pinned here is the queue-for-a-"
            "connection case, and shows up as latency on every DB-backed route.",
        )
        limit.add_metric([], maximum)
        yield limit


REGISTRY.register(_AppStateCollector())


# --- Route labelling --------------------------------------------------------
#
# Starlette does not put the matched route on the request scope (only the
# endpoint function), so the template is recovered by mapping endpoint back to
# path once, on first use. The alternative -- re-matching the request against
# every route inside the middleware -- costs ~45 regex matches per request to
# learn something the router already knew.

_route_paths: dict[int, str] = {}


def _build_route_paths(app) -> None:
    for route in app.routes:
        endpoint = getattr(route, "endpoint", None) or getattr(route, "app", None)
        path = getattr(route, "path", None)
        if endpoint is not None and path:
            _route_paths[id(endpoint)] = path


def route_label(request) -> str:
    """The registered path template for a request, or 'unmatched'.

    Never the raw path: /api/track/{kind}/{entity_id} is one series, and the
    404s a scanner generates are one more, rather than one per URL tried.
    """
    endpoint = request.scope.get("endpoint")
    if endpoint is None:
        return "unmatched"
    if not _route_paths:
        _build_route_paths(request.app)
    return _route_paths.get(id(endpoint), "unmatched")


def observe_request(method: str, route: str, status: int, seconds: float) -> None:
    http_requests.labels(method=method, route=route, status=str(status)).inc()
    http_request_duration.labels(method=method, route=route).observe(seconds)


# --- The alerts refresher ---------------------------------------------------


async def refresh_alerts() -> None:
    """Read the alerts table once and publish the counts.

    Both severities are always written, including as zero: a gauge that simply
    stops being exported when the last alert clears is indistinguishable, on a
    dashboard, from one that stopped being scraped.
    """
    counts = {"warning": 0, "critical": 0}
    for alert in await storage.active_alerts():
        severity = alert.get("severity") or "unknown"
        counts[severity] = counts.get(severity, 0) + 1
    for severity, count in counts.items():
        alerts_active.labels(severity=severity).set(count)


async def refresh_loop(interval: float = 30.0) -> None:
    """Keep `osint_alerts_active` current without putting a query on the scrape path.

    30s against a 15s scrape interval means the gauge can be one scrape stale.
    That is the right trade for a signal whose own detection loop
    (CACHE_WORKER_INTERVAL) runs at 60s: refreshing faster than the producer
    only adds database round trips.

    Failures are swallowed rather than retried or raised. This task lives for
    the whole process alongside the source pollers, and a database blip should
    cost one stale gauge -- not the loop, which would take every later refresh
    with it and leave the gauge frozen at a value that still looks current.
    """
    while True:
        try:
            await refresh_alerts()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a metric refresh must never take the process down
            log.debug("Could not refresh the alert gauge", exc_info=True)
        await asyncio.sleep(interval)


def render() -> bytes:
    """The exposition payload. Synchronous and I/O-free by construction."""
    return generate_latest(REGISTRY)
