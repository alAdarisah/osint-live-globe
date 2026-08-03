import asyncio
import csv
import html
import io
import logging
import re
import time
import zipfile
from datetime import datetime, timedelta, timezone

import httpx

from backend import config
from backend.cache import registry

log = logging.getLogger("osint-globe.gdelt")

LASTUPDATE_URL = "http://data.gdeltproject.org/gdeltv2/lastupdate.txt"
GDELT_BASE_URL = "http://data.gdeltproject.org/gdeltv2/"

# GDELT publishes a new export file every 15 minutes. Fetching only the
# latest one (the old behavior) meant a quiet 15-minute window could leave
# the news layer nearly empty, and every poll wholesale-replaced the list so
# still-relevant items vanished the moment the next poll landed. Instead we
# roll up a trailing window of files into a persistent accumulator (see
# _ACCUMULATED below) that items age out of gradually.
WINDOW_MINUTES = 120  # roughly 2 hours of rolling history
FILE_STEP_MINUTES = 15  # GDELT's export cadence

# Served/returned count. Raised from the old 150 (tuned for a single 15-min
# file) since the rolling window can surface several times that many
# candidates, and title-scraping is no longer on the blocking serve path
# (see _backfill_titles) so a larger cap doesn't cost first-paint latency.
MAX_ITEMS = 400
_ACCUMULATED_HARD_CAP = MAX_ITEMS * 4  # safety valve for an unusually newsy window

# Column indices in the GDELT 2.0 Event export CSV (tab-separated, no header).
COL_GLOBAL_EVENT_ID = 0
COL_ACTOR1_NAME = 6
COL_ACTOR2_NAME = 16
COL_EVENT_CODE = 26
COL_EVENT_ROOT_CODE = 28
COL_QUAD_CLASS = 29
COL_GOLDSTEIN = 30
COL_NUM_MENTIONS = 31
COL_AVG_TONE = 34
COL_ACTION_GEO_FULLNAME = 52
COL_ACTION_GEO_LAT = 56
COL_ACTION_GEO_LONG = 57
COL_DATE_ADDED = 59
COL_SOURCE_URL = 60

_TS_RE = re.compile(r"(\d{14})\.export\.CSV\.zip")


async def _latest_export_url(client: httpx.AsyncClient) -> str:
    resp = await client.get(LASTUPDATE_URL)
    resp.raise_for_status()
    for line in resp.text.splitlines():
        if "export.CSV.zip" in line:
            return line.strip().split(" ")[-1]
    raise RuntimeError("Could not find export.CSV.zip in GDELT lastupdate.txt")


def _parse_latest_ts(export_url: str) -> datetime:
    match = _TS_RE.search(export_url)
    if not match:
        raise RuntimeError(f"Unexpected GDELT lastupdate URL format: {export_url}")
    return datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def _window_urls(latest_dt: datetime) -> list[str]:
    n_files = WINDOW_MINUTES // FILE_STEP_MINUTES
    return [
        f"{GDELT_BASE_URL}{(latest_dt - timedelta(minutes=FILE_STEP_MINUTES * k)).strftime('%Y%m%d%H%M%S')}.export.CSV.zip"
        for k in range(n_files)
    ]


def _parse_events(text: str) -> list[dict]:
    candidates = []
    for row in csv.reader(io.StringIO(text), delimiter="\t"):
        if len(row) <= COL_SOURCE_URL:
            continue
        try:
            quad_class = int(row[COL_QUAD_CLASS])
            lat = float(row[COL_ACTION_GEO_LAT])
            lon = float(row[COL_ACTION_GEO_LONG])
            mentions = int(row[COL_NUM_MENTIONS])
        except (ValueError, IndexError):
            continue
        if quad_class not in (3, 4):  # verbal/material conflict events only
            continue
        try:
            event_root_code = int(row[COL_EVENT_ROOT_CODE])
        except (ValueError, IndexError):
            event_root_code = None
        candidates.append(
            {
                "event_id": row[COL_GLOBAL_EVENT_ID],
                "lat": lat,
                "lon": lon,
                "location": row[COL_ACTION_GEO_FULLNAME],
                "actor1": row[COL_ACTOR1_NAME] or None,
                "actor2": row[COL_ACTOR2_NAME] or None,
                "event_code": row[COL_EVENT_CODE],
                "event_root_code": event_root_code,
                "quad_class": quad_class,
                "goldstein": float(row[COL_GOLDSTEIN]) if row[COL_GOLDSTEIN] else None,
                "mentions": mentions,
                "avg_tone": float(row[COL_AVG_TONE]) if row[COL_AVG_TONE] else None,
                "date_added": row[COL_DATE_ADDED],
                "source_url": row[COL_SOURCE_URL],
            }
        )
    return candidates


# --- real article titles -----------------------------------------------
#
# GDELT's own event/GKG exports never include headline text -- only CAMEO
# codes and actor names, which is why the old auto-generated sentences
# ("X engaged in fighting with Y") were frequently a poor match for what an
# article actually said. Fetching each source_url's own <title>/og:title is
# the only way to show the real headline, so that's what this does, with a
# small persistent cache since the same big stories tend to reappear across
# consecutive 15-minute polls.
#
# This used to run synchronously inside the poll before state.data was set,
# which meant the news layer (and first page load generally) waited on up to
# ~MAX_ITEMS sequential-ish HTTP scrapes. It's now kicked off as a detached
# background task from start() so events appear immediately with the CAMEO
# fallback sentence and get their real headline filled in moments later.

_TITLE_CACHE: dict[str, str | None] = {}
_TITLE_FETCH_SEM = asyncio.Semaphore(15)
_OGTITLE_RE = re.compile(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']*)["\']', re.IGNORECASE)
_TITLE_TAG_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}


def _clean_title(raw: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(raw)).strip()


async def _fetch_title(client: httpx.AsyncClient, url: str) -> str | None:
    if url in _TITLE_CACHE:
        return _TITLE_CACHE[url]
    title = None
    async with _TITLE_FETCH_SEM:
        try:
            resp = await client.get(url, headers=_FETCH_HEADERS, timeout=6, follow_redirects=True)
            if resp.status_code == 200:
                head = resp.text[:30000]  # title tags are always near the top of <head>
                match = _OGTITLE_RE.search(head) or _TITLE_TAG_RE.search(head)
                if match and match.group(1).strip():
                    title = _clean_title(match.group(1))
        except Exception:  # noqa: BLE001 - a slow/broken site just means no title
            pass
    _TITLE_CACHE[url] = title
    if len(_TITLE_CACHE) > 20000:  # crude cap for a long-running session
        _TITLE_CACHE.clear()
    return title


async def _attach_titles(candidates: list[dict]) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        titles = await asyncio.gather(
            *(_fetch_title(client, c["source_url"]) for c in candidates)
        )
    for candidate, title in zip(candidates, titles):
        candidate["real_title"] = title


async def _backfill_titles(candidates: list[dict]) -> None:
    try:
        await _attach_titles(candidates)
    except Exception as exc:  # noqa: BLE001 - keep the poller alive
        log.warning("GDELT title backfill failed: %s", exc)


# --- rolling multi-file window -------------------------------------------


async def _fetch_one_export(client: httpx.AsyncClient, url: str) -> list[dict]:
    try:
        resp = await client.get(url)
        if resp.status_code == 404:
            return []  # slot not published / skipped -- not fatal
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            text = zf.read(zf.namelist()[0]).decode("utf-8", errors="replace")
        return _parse_events(text)
    except Exception as exc:  # noqa: BLE001 - one bad file shouldn't sink the whole window
        log.debug("GDELT window file fetch failed (%s): %s", url, exc)
        return []


def _dedup_key(ev: dict) -> str:
    # Two GDELT rows citing the same article (different actor pairs/CAMEO
    # codes) collapse to one marker, keeping the higher-mention row -- an
    # intentional declutter trade-off. Rows without a source_url fall back
    # to their own event id so they aren't accidentally merged together.
    return ev.get("source_url") or f"evt:{ev.get('event_id')}"


async def _fetch_window() -> list[dict]:
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        latest_url = await _latest_export_url(client)
        latest_dt = _parse_latest_ts(latest_url)
        results = await asyncio.gather(*(_fetch_one_export(client, u) for u in _window_urls(latest_dt)))
    merged: dict[str, dict] = {}
    for file_events in results:
        for ev in file_events:
            key = _dedup_key(ev)
            existing = merged.get(key)
            if not existing or ev["mentions"] > existing["mentions"]:
                merged[key] = ev
    return list(merged.values())


def _parse_date_added(s: str | None) -> datetime | None:
    try:
        return datetime.strptime(s, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


# Persists across polls so items accumulate instead of being wholesale-
# replaced every 15 minutes; pruned by age (below) and by a hard cap so a
# very newsy window can't grow this unboundedly.
_ACCUMULATED: dict[str, dict] = {}


async def _fetch() -> list[dict]:
    new_items = await _fetch_window()
    for ev in new_items:
        key = _dedup_key(ev)
        prior = _ACCUMULATED.get(key)
        if prior and prior.get("real_title") and not ev.get("real_title"):
            ev["real_title"] = prior["real_title"]  # carry an already-backfilled title forward
        _ACCUMULATED[key] = ev

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=WINDOW_MINUTES + FILE_STEP_MINUTES)
    for key in list(_ACCUMULATED):
        added = _parse_date_added(_ACCUMULATED[key].get("date_added"))
        if added and added < cutoff:
            del _ACCUMULATED[key]

    if len(_ACCUMULATED) > _ACCUMULATED_HARD_CAP:
        overflow = sorted(_ACCUMULATED.items(), key=lambda kv: kv[1]["mentions"])[: len(_ACCUMULATED) - _ACCUMULATED_HARD_CAP]
        for key, _ in overflow:
            del _ACCUMULATED[key]

    return sorted(_ACCUMULATED.values(), key=lambda d: d["mentions"], reverse=True)[:MAX_ITEMS]


async def start():
    state = registry.register("gdelt", key_configured=True)  # no key required
    while True:
        try:
            candidates = await _fetch()
            state.data = candidates
            state.last_success = time.time()
            state.last_error = None
            with_titles = sum(1 for d in candidates if d.get("real_title"))
            log.info("GDELT: %d events (%d with a real title, rest backfilling)", len(candidates), with_titles)
            to_fetch = [c for c in candidates if "real_title" not in c]
            if to_fetch:
                asyncio.create_task(_backfill_titles(to_fetch))
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("GDELT fetch failed: %s", exc)
        await asyncio.sleep(config.GDELT_POLL_INTERVAL)
