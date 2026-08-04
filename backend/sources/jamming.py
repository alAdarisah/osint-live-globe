import asyncio
import csv
import io
import logging
import time

import h3
import httpx

from backend.cache import registry

log = logging.getLogger("osint-globe.jamming")

# gpsjam.org publishes a plain, keyless, no-auth daily dataset derived from
# ADS-B Exchange aircraft GPS-quality reports, aggregated into H3 (resolution
# 4) hex cells. Confirmed live (not guessed) by reading the site's own
# network requests: manifest.csv lists available dates, and each date's own
# CSV carries per-hex good/bad aircraft counts for that day.
MANIFEST_URL = "https://gpsjam.org/data/manifest.csv"
DAY_URL_TEMPLATE = "https://gpsjam.org/data/{date}-h3_4.csv"
REFRESH_INTERVAL = 6 * 3600  # the underlying data itself only updates once/day

# Drop single-aircraft noise -- require at least this many total ADS-B
# reports (good+bad) in a cell before trusting its jam ratio.
MIN_TRAFFIC = 2

# Below this fraction of affected reports, a cell reads as background noise
# rather than real interference -- gpsjam's raw daily dataset can carry
# hundreds of barely-affected hexes worldwide, which buried the genuinely
# jammed regions under map clutter. Only cells at/above this ratio are kept.
MIN_JAM_RATIO = 0.25

# Even after the ratio cutoff above, a bad day can still leave hundreds of
# qualifying cells -- cap to the worst-affected ones so the map only ever
# shows a manageable, most-severe slice, not every hex gpsjam reports.
MAX_CELLS = 100


async def _latest_date(client: httpx.AsyncClient) -> str:
    resp = await client.get(MANIFEST_URL)
    resp.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(resp.text)))
    if not rows:
        raise RuntimeError("gpsjam manifest.csv contains no dates")
    return rows[-1]["date"]


def _parse_day(text: str) -> list[dict]:
    points = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            good = int(row["count_good_aircraft"])
            bad = int(row["count_bad_aircraft"])
        except (KeyError, ValueError):
            continue
        total = good + bad
        if bad <= 0 or total < MIN_TRAFFIC:
            continue
        jam_ratio = bad / total
        if jam_ratio < MIN_JAM_RATIO:
            continue
        try:
            lat, lon = h3.cell_to_latlng(row["hex"])
        except Exception:  # noqa: BLE001 - a malformed hex just gets skipped
            continue
        points.append(
            {
                "lat": lat,
                "lon": lon,
                "jam_ratio": jam_ratio,
                "bad": bad,
                "good": good,
            }
        )
    points.sort(key=lambda p: p["jam_ratio"], reverse=True)
    return points[:MAX_CELLS]


async def _fetch() -> tuple[list[dict], str]:
    async with httpx.AsyncClient(timeout=30) as client:
        date = await _latest_date(client)
        resp = await client.get(DAY_URL_TEMPLATE.format(date=date))
        resp.raise_for_status()
    return _parse_day(resp.text), date


async def start():
    state = registry.register("jamming", key_configured=True)  # no key required
    while True:
        try:
            points, date = await _fetch()
            for p in points:
                p["date"] = date
            state.data = points
            state.last_success = time.time()
            state.last_error = None
            log.info("GPS jamming: %d hot cells for %s", len(points), date)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("GPS jamming fetch failed: %s", exc)
        await asyncio.sleep(REFRESH_INTERVAL)
