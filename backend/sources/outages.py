"""Which countries are losing the internet right now.

IODA (Internet Outage Detection and Analysis, Georgia Tech) watches three
independent signals -- BGP withdrawals, active probing of address space, and
unsolicited darknet traffic -- and reports where they disagree with normal. It
is keyless and public.

This is the one measurement on this map with genuine national significance and
no location finer than the country, and that shapes how it is served: as a
country-keyed dictionary, not as points. A national outage drawn as a pin on a
capital would claim a precision the data does not have, so it is rendered as a
country tint and a line in the country card instead.

What the score is *not*: a percentage of the country offline. `scores.overall`
is IODA's own composite, unbounded and useful only in comparison -- against the
same country's normal, and against other countries in the same window. The
frontend says so wherever it shows a number.
"""

import asyncio
import logging
import time

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.outages")

IODA_URL = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary"
REFRESH_INTERVAL = 15 * 60
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# How far back each poll asks about. A day, so a blackout that began overnight
# is still reported this morning rather than vanishing the moment it stops
# getting worse.
WINDOW_SECONDS = 24 * 3600

# IODA reports every country with any anomaly at all, and the long tail is
# routine noise. This is a floor on the composite score, chosen to keep the tail
# out of the country card without hiding anything a reader would call an outage.
MIN_SCORE = 1_000_000


def parse_outages(payload: dict, window_start: float, window_end: float) -> dict[str, dict]:
    """IODA's summary -> {ISO2: record}.

    Keyed by the two-letter country code because that is what the map's own
    country shapes are keyed by (see backend/sources/countries.py), so the tint
    can be applied without a second name-matching step -- and country name
    matching is exactly the kind of join that silently drops Cote d'Ivoire.
    """
    out: dict[str, dict] = {}
    for row in (payload or {}).get("data") or []:
        entity = row.get("entity") or {}
        code = (entity.get("code") or "").strip().upper()
        if not code or (entity.get("type") or "") != "country":
            continue
        scores = row.get("scores") or {}
        overall = scores.get("overall")
        if not isinstance(overall, (int, float)) or overall < MIN_SCORE:
            continue
        out[code] = {
            "country_code": code,
            "country": entity.get("name"),
            "score": float(overall),
            # The three signals behind the composite, kept separate: a drop
            # visible in BGP alone is a routing change, while one visible in all
            # three is the network genuinely going away.
            "signals": {
                key: value for key, value in scores.items()
                if key != "overall" and isinstance(value, (int, float))
            },
            "event_count": row.get("event_cnt"),
            "window_start": window_start,
            "window_end": window_end,
        }
    return out


async def _fetch() -> dict[str, dict]:
    end = time.time()
    start = end - WINDOW_SECONDS
    async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
        resp = await client.get(
            IODA_URL,
            params={"from": int(start), "until": int(end), "entityType": "country"},
        )
        resp.raise_for_status()
    return parse_outages(resp.json(), start, end)


async def start():
    state = registry.register("outages", key_configured=True)  # no key required
    # A dict, not a list -- same shape as hdx_conflict_stats, and read the same
    # way by the country card rather than drawn as markers.
    state.data = {}
    consecutive_failures = 0
    while True:
        ok = False
        try:
            outages = await _fetch()
            state.data = outages
            state.last_success = time.time()
            state.last_error = None
            ok = True
            worst = sorted(outages.values(), key=lambda r: r["score"], reverse=True)[:3]
            log.info(
                "Internet outages: %d countries above threshold%s",
                len(outages),
                f" (worst: {', '.join(r['country'] or r['country_code'] for r in worst)})" if worst else "",
            )
            await storage.record_reference("outages", outages)
            await storage.record_source_health("outages", len(outages), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("IODA outage fetch failed: %s", exc)
            await storage.record_source_health("outages", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
