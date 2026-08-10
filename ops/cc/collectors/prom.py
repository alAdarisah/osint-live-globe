"""The six numbers the host pane shows, read from Prometheus.

The set is fixed here rather than configurable: a dashboard whose contents come
from a config file is a worse Grafana, and Grafana is one keypress away.

Application metrics come through Prometheus rather than from the backend
directly because backend:8000/metrics is deliberately not published to the host
(see backend/app.py) -- Prometheus reaches it over the compose network, and this
tool reads what Prometheus already scraped.
"""

import asyncio
import math
import time
from dataclasses import dataclass, field

import httpx

from ops.cc.run import CollectorError

__all__ = ["CollectorError", "INSTANT", "METRIC_NAMES", "MetricSnapshot", "RANGE",
           "collect", "parse_instant", "parse_range"]

INSTANT = {
    "db_size": 'pg_database_size_bytes{datname="osint"}',
    "connections": "pg_connection_budget_used",
    "connection_limit": "pg_connection_budget_limit_ordinary",
    "oldest_transaction": "pg_long_running_max_transaction_seconds",
    "scrapes_up": "sum(up)",
    "scrapes_total": "count(up)",
    "alerts_active": "sum(osint_alerts_active)",
}

RANGE = {
    "request_rate": "sum(rate(osint_http_requests_total[5m]))",
}

# Bare metric names, for the test that proves nothing here was invented.
METRIC_NAMES = (
    "pg_database_size_bytes",
    "pg_connection_budget_used",
    "pg_connection_budget_limit_ordinary",
    "pg_long_running_max_transaction_seconds",
    "osint_alerts_active",
    "osint_http_requests_total",
)

# 15 minutes at 30s steps: 30 samples, which is more than the ~8 cells a
# sparkline occupies, so spark() downsamples rather than interpolating.
_RANGE_SECONDS = 900
_RANGE_STEP = 30


@dataclass(frozen=True)
class MetricSnapshot:
    values: dict[str, float | None] = field(default_factory=dict)
    series: dict[str, tuple[float, ...]] = field(default_factory=dict)


def _sample(raw: str) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    # Prometheus renders absent-but-defined as NaN; a NaN drawn as 0 in a
    # sparkline is a dip that never happened.
    return None if math.isnan(value) else value


def parse_instant(payload: dict) -> float | None:
    if payload.get("status") != "success":
        return None
    result = payload.get("data", {}).get("result") or []
    if not result:
        return None
    return _sample(result[0].get("value", [None, None])[1])


def parse_range(payload: dict) -> tuple[float, ...]:
    if payload.get("status") != "success":
        return ()
    result = payload.get("data", {}).get("result") or []
    if not result:
        return ()
    samples = (_sample(point[1]) for point in result[0].get("values", []))
    return tuple(value for value in samples if value is not None)


async def _get(client: httpx.AsyncClient, url: str, params: dict) -> dict | None:
    """None on anything that is not a well-formed 200. One failing query must
    not cost the other six."""
    try:
        response = await client.get(url, params=params, timeout=5.0)
    except httpx.HTTPError as exc:
        raise CollectorError(f"{type(exc).__name__}: {exc}") from exc
    if response.status_code != 200:
        return None
    try:
        return response.json()
    except ValueError:
        return None


async def collect(client: httpx.AsyncClient, base_url: str) -> MetricSnapshot:
    end = time.time()
    instant_results = await asyncio.gather(*[
        _get(client, f"{base_url}/api/v1/query", {"query": query})
        for query in INSTANT.values()
    ])
    range_results = await asyncio.gather(*[
        _get(client, f"{base_url}/api/v1/query_range",
             {"query": query, "start": end - _RANGE_SECONDS, "end": end, "step": _RANGE_STEP})
        for query in RANGE.values()
    ])

    return MetricSnapshot(
        values={
            key: (parse_instant(payload) if payload else None)
            for key, payload in zip(INSTANT, instant_results)
        },
        series={
            key: (parse_range(payload) if payload else ())
            for key, payload in zip(RANGE, range_results)
        },
    )
