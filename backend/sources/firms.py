import asyncio
import csv
import io
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx

from backend import config
from backend.cache import registry

log = logging.getLogger("osint-globe.firms")

AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{area}/{day_range}"
SOURCE = "VIIRS_SNPP_NRT"
WORLD_BBOX = "-180,-90,180,90"

# NOAA HMS Fire product: pre-processed, analyst-QC'd fire detections fusing
# GOES-16/18 (5-15 min geostationary cadence -- much faster than VIIRS's
# twice-daily passes), VIIRS, and MODIS. Plain ASCII text, no key needed.
# URL is date-stamped (not a "latest" alias), built fresh each poll.
HMS_URL = "https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Fire_Points/Text/{y:04d}/{m:02d}/hms_fire{y:04d}{m:02d}{d:02d}.txt"


async def _fetch_viirs() -> list[dict]:
    url = AREA_URL.format(key=config.FIRMS_MAP_KEY, source=SOURCE, area=WORLD_BBOX, day_range=1)
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        text = resp.text

    if text.lstrip().lower().startswith(("invalid", "error")):
        raise RuntimeError(f"FIRMS rejected request: {text[:200]}")

    items = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
        except (KeyError, ValueError):
            continue
        items.append(
            {
                "lat": lat,
                "lon": lon,
                "brightness": float(row.get("bright_ti4") or 0),
                "confidence": row.get("confidence"),
                "frp": row.get("frp"),
                "acq_date": row.get("acq_date"),
                "acq_time": row.get("acq_time"),
                "daynight": row.get("daynight"),
                "source": "viirs",
            }
        )
    return items


def _parse_hms_rows(text: str) -> list[dict]:
    items = []
    for row in csv.DictReader(io.StringIO(text), skipinitialspace=True):
        try:
            lat = float(row["Lat"])
            lon = float(row["Lon"])
            year_day = row["YearDay"].strip()  # "YYYYDDD"
            year, day_of_year = int(year_day[:4]), int(year_day[4:])
            date = datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=day_of_year - 1)
            time_str = row["Time"].strip().zfill(4)  # "HHMM" UTC
            frp = float(row["FRP"])
        except (KeyError, ValueError, IndexError):
            continue
        items.append(
            {
                "lat": lat,
                "lon": lon,
                "brightness": None,  # HMS doesn't report a brightness temperature
                "confidence": None,  # or a confidence value -- it's an analyst-QC'd detection instead
                "frp": frp if frp > 0 else None,  # -999 is HMS's "not available" sentinel
                "acq_date": date.strftime("%Y-%m-%d"),
                "acq_time": time_str,
                "daynight": None,
                "satellite": row.get("Satellite", "").strip() or None,
                "source": "hms",
            }
        )
    return items


async def _fetch_hms() -> list[dict]:
    now = datetime.now(timezone.utc)
    url = HMS_URL.format(y=now.year, m=now.month, d=now.day)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url)
            resp.raise_for_status()
        return _parse_hms_rows(resp.text)
    except Exception as exc:  # noqa: BLE001 - HMS is a supplementary source, don't sink the whole poll
        log.debug("HMS fetch failed: %s", exc)
        return []


async def _fetch() -> list[dict]:
    viirs_items, hms_items = await asyncio.gather(_fetch_viirs(), _fetch_hms())
    # No cross-source dedup -- VIIRS and HMS detections come from different
    # pixel footprints/satellites, same reasoning FIRMS already relies on for
    # overlapping VIIRS passes. Marker/heat density communicates overlap.
    return viirs_items + hms_items


async def start():
    key_configured = bool(config.FIRMS_MAP_KEY)
    state = registry.register("firms", key_configured=key_configured)
    while True:
        if not key_configured:
            state.last_error = "FIRMS_MAP_KEY not set in .env"
        else:
            try:
                state.data = await _fetch()
                state.last_success = time.time()
                state.last_error = None
                hms_count = sum(1 for d in state.data if d.get("source") == "hms")
                log.info("FIRMS: %d hotspots (%d from NOAA HMS)", len(state.data), hms_count)
            except Exception as exc:  # noqa: BLE001 - keep the poller alive
                state.last_error = str(exc)
                log.warning("FIRMS fetch failed: %s", exc)
        await asyncio.sleep(config.FIRMS_POLL_INTERVAL)
