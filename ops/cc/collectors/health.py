"""What each source is producing, and what the cache worker is complaining about.

Both come from one call to /api/health (see backend/app.py), which merges the
source registry with the open rows of the alerts table into a single object --
hence the explicit exclusion of the "alerts" key below.

Staleness is not decided here. backend/mirror.py already decides it per source,
from that job's expected_every and INGEST_STALE_MULTIPLIER, and publishes the
verdict as last_error -- the same fact osint_source_up is built from. A second
threshold in this file would disagree with the map and the alerts table the
first time a six-hourly source polled exactly on schedule.
"""

from dataclasses import dataclass

import httpx

from ops.cc.run import CollectorError

__all__ = ["Alert", "CollectorError", "SourceState", "SourcesSnapshot", "collect",
           "parse_health"]

_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}


@dataclass(frozen=True)
class SourceState:
    name: str
    item_count: int
    seconds_since_success: int | None
    last_error: str | None
    key_configured: bool

    @property
    def severity(self) -> str:
        if self.last_error:
            # Still serving rows means degraded, not dead: the map still shows
            # this layer, it is simply no longer being refreshed.
            return "warn" if self.item_count > 0 else "down"
        if self.seconds_since_success is None:
            # Registered but never polled. Normal for the first minute after a
            # cold start, which is exactly when this dashboard is being watched.
            return "starting"
        return "ok"


@dataclass(frozen=True)
class Alert:
    subject: str
    condition: str
    severity: str
    detail: str
    occurrences: int
    last_seen: float


@dataclass(frozen=True)
class SourcesSnapshot:
    sources: tuple[SourceState, ...] = ()
    alerts: tuple[Alert, ...] = ()

    @property
    def worst_alert_severity(self) -> str | None:
        if not self.alerts:
            return None
        return min(self.alerts, key=lambda a: _SEVERITY_ORDER.get(a.severity, 9)).severity


def parse_health(payload: dict) -> SourcesSnapshot:
    sources = tuple(
        SourceState(
            name=name,
            item_count=int(body.get("item_count") or 0),
            seconds_since_success=body.get("seconds_since_success"),
            last_error=body.get("last_error") or None,
            key_configured=bool(body.get("key_configured")),
        )
        for name, body in payload.items()
        if name != "alerts" and isinstance(body, dict)
    )
    alerts = tuple(
        Alert(
            subject=row.get("subject", "?"),
            condition=row.get("condition", "?"),
            severity=row.get("severity", "info"),
            detail=row.get("detail") or "",
            occurrences=int(row.get("occurrences") or 0),
            last_seen=float(row.get("last_seen") or 0.0),
        )
        for row in payload.get("alerts", [])
        if isinstance(row, dict)
    )
    # The API already orders alerts worst-first; sorting again keeps that true
    # if it ever stops being.
    alerts = tuple(sorted(alerts, key=lambda a: _SEVERITY_ORDER.get(a.severity, 9)))
    return SourcesSnapshot(sources=sources, alerts=alerts)


async def collect(client: httpx.AsyncClient, base_url: str) -> SourcesSnapshot:
    try:
        response = await client.get(f"{base_url}/api/health", timeout=5.0)
    except httpx.HTTPError as exc:
        raise CollectorError(f"{type(exc).__name__}: {exc}") from exc
    if response.status_code != 200:
        raise CollectorError(f"HTTP {response.status_code} from /api/health")
    return parse_health(response.json())
