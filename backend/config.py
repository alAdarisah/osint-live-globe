import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

FIRMS_MAP_KEY = os.getenv("FIRMS_MAP_KEY", "").strip()
AISSTREAM_API_KEY = os.getenv("AISSTREAM_API_KEY", "").strip()
OPENSKY_CLIENT_ID = os.getenv("OPENSKY_CLIENT_ID", "").strip()
OPENSKY_CLIENT_SECRET = os.getenv("OPENSKY_CLIENT_SECRET", "").strip()
ACLED_EMAIL = os.getenv("ACLED_EMAIL", "").strip()
ACLED_PASSWORD = os.getenv("ACLED_PASSWORD", "").strip()
OWM_API_KEY = os.getenv("OWM_API_KEY", "").strip()

# Poll intervals, in seconds. Tuned to each source's data freshness and rate limits.
FIRMS_POLL_INTERVAL = int(os.getenv("FIRMS_POLL_INTERVAL", "900"))       # FIRMS updates a few times/day
GDELT_POLL_INTERVAL = int(os.getenv("GDELT_POLL_INTERVAL", "900"))        # GDELT updates every 15 min
ADSB_POLL_INTERVAL_ANON = int(os.getenv("ADSB_POLL_INTERVAL_ANON", "900"))    # 100 calls/day anonymous limit
ADSB_POLL_INTERVAL_AUTH = int(os.getenv("ADSB_POLL_INTERVAL_AUTH", "60"))     # 4000 calls/day authenticated
ACLED_POLL_INTERVAL = int(os.getenv("ACLED_POLL_INTERVAL", "1800"))
UCDP_POLL_INTERVAL = int(os.getenv("UCDP_POLL_INTERVAL", "21600"))  # UCDP's candidate file only updates monthly

# event_fusion.py doesn't fetch anything itself -- it re-derives from
# acled.py's (ACLED + UCDP rows) and gdelt.py's already-fetched state.data,
# so it has no interval of its own to configure, only how long its local
# SQLite archive of fused events keeps rows. Long relative to
# HISTORY_RETENTION_SECONDS since this table is meant to be the durable
# "personal daily archive", not a short replay buffer.
CONFLICT_WATCH_RETENTION_DAYS = int(os.getenv("CONFLICT_WATCH_RETENTION_DAYS", "180"))

# Bump whenever a change alters how many conflict events the pipeline produces,
# or what severity means. escalation.py compares a 24h count against a 6-day
# baseline drawn only from the *same* version, so a pipeline improvement that
# multiplies event volume re-triggers escalation's own coverage guard and keeps
# it silent until it has comparable history -- instead of reporting a world-wide
# escalation because we got better at seeing.
#
# 2: violence pipeline rebuilt -- geographic precision, real event dates,
#    outlet-count corroboration, and GDELT no longer filtered through the news
#    popularity ranking (which was discarding 92% of violent events).
CONFLICT_PIPELINE_VERSION = int(os.getenv("CONFLICT_PIPELINE_VERSION", "2"))

# How long an entity can go without a fresh report before storage.py evicts
# it from entity_latest (see backend/storage.py). Separate from ais.py's own
# STALE_AFTER, which governs the in-memory live layer (/api/ships) -- these
# answer different questions and are allowed to diverge.
AIS_STALE_AFTER = int(os.getenv("AIS_STALE_AFTER", "1800"))
ADSB_STALE_AFTER = int(os.getenv("ADSB_STALE_AFTER", "1800"))

# Per-kind eviction windows, keyed by storage.py's `kind` column. Every point
# source now writes there (see the record_snapshot calls across
# backend/sources/), and they refresh on wildly different cadences -- a 30min
# window that suits a live AIS stream would continuously evict the cities
# index, which the backend only re-fetches once a day. Anything absent falls
# back to ENTITY_STALE_AFTER_DEFAULT.
ENTITY_STALE_AFTER = {
    "ais": AIS_STALE_AFTER,
    "adsb": ADSB_STALE_AFTER,
    "satellites": 3600,
    "gdelt": 86400,
    # Must outlive event_fusion's 3-day violence accumulator, since that
    # accumulator is rehydrated from this table on restart. "gdelt"'s own one
    # day is deliberately shorter -- the news layer has no reason to remember
    # that far back.
    "gdelt_conflict": 4 * 86400,
    # The Officials & Diplomacy inputs and their fusion. Two days rather than
    # one: all three carry a 24h live window, and a stale-after equal to the
    # window would start expiring rows the layer is still showing.
    "gdelt_officials": 2 * 86400,
    "official_feeds": 2 * 86400,
    "officials": 2 * 86400,
    "firms": 2 * 86400,
    "jamming": 2 * 86400,
    "acled": 7 * 86400,
    "events": 7 * 86400,
    "cities": 30 * 86400,
}
ENTITY_STALE_AFTER_DEFAULT = int(os.getenv("ENTITY_STALE_AFTER_DEFAULT", "86400"))

# Postgres connection (see backend/storage.py). docker-compose.yml sets this
# explicitly to reach the `postgres` service over the compose network, so
# this default only applies to runs outside compose -- hence localhost,
# which is the useful guess there (the compose hostname wouldn't resolve).
# Nothing breaks if it's wrong: storage retries in the background and the
# app runs live-only until it connects.
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://osint:osint@localhost:5432/osint")

# How long per-poll source outcomes are kept in storage.py's source_health
# table -- purely an operational log (what succeeded/failed, when, how many
# items), so it doesn't need the long window the event archive gets.
SOURCE_HEALTH_RETENTION_DAYS = int(os.getenv("SOURCE_HEALTH_RETENTION_DAYS", "14"))

# How long entity_history rows are kept before storage.py's retention sweep
# deletes them. 3 days, matching the replay timeline's range and ACLED's own
# fetch window -- no point keeping ship/aircraft history the rest of the
# replay range can't use anyway.
HISTORY_RETENTION_SECONDS = int(os.getenv("HISTORY_RETENTION_SECONDS", str(3 * 24 * 3600)))

# High-interest maritime chokepoints/conflict waters for the AIS layer, as
# "lat_min,lon_min,lat_max,lon_max" boxes separated by ";". Kept narrow (rather
# than the whole planet) to stay within aisstream.io's practical volume and to
# match the "high-risk waters" framing of the AIS layer.
_DEFAULT_AIS_BBOXES = (
    "40,27,47,42;"    # Black Sea
    "12,32,30,43;"    # Red Sea
    "10,43,15,52;"    # Gulf of Aden / Bab-el-Mandeb approach
    "24,48,30,57;"    # Strait of Hormuz / Persian Gulf
    "21,117,26,123;"  # Taiwan Strait
    "0,105,23,121;"   # South China Sea
    "31,20,37,36;"    # Eastern Mediterranean
    "29.5,32.0,31.5,33.0"  # Suez Canal -- outside every box above (the
                            # Eastern Mediterranean box stops at lat 31, the
                            # canal runs ~29.9-31.5N), so tanker/cargo traffic
                            # transiting it was invisible.
)


def _parse_bboxes(raw: str) -> list[tuple[float, float, float, float]]:
    boxes = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        lat_min, lon_min, lat_max, lon_max = (float(x) for x in chunk.split(","))
        boxes.append((lat_min, lon_min, lat_max, lon_max))
    return boxes


AIS_BBOXES = _parse_bboxes(os.getenv("AIS_BBOXES", _DEFAULT_AIS_BBOXES))

# airplanes.live has no world/bbox endpoint, only point+radius (max 250nm) --
# these regional centers stand in for global coverage. As "lat,lon,radius_nm"
# separated by ";", same parsing style as AIS_BBOXES.
_DEFAULT_AIRPLANES_LIVE_POINTS = (
    "50,10,250;"    # Western/Central Europe
    "49,35,250;"    # Eastern Europe / Black Sea
    "25,45,250;"    # Middle East / Persian Gulf
    "39,-98,250;"   # Central US
    "35,105,250;"   # East Asia
    "1,103,250;"    # Southeast Asia / South China Sea
    "24,54,250"     # Persian Gulf / Strait of Hormuz
)


def _parse_points(raw: str) -> list[tuple[float, float, float]]:
    points = []
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        lat, lon, radius_nm = (float(x) for x in chunk.split(","))
        points.append((lat, lon, radius_nm))
    return points


AIRPLANES_LIVE_POINTS = _parse_points(os.getenv("AIRPLANES_LIVE_POINTS", _DEFAULT_AIRPLANES_LIVE_POINTS))

FRONTEND_DIR = BASE_DIR / "frontend"
# `npm run build` (see frontend/package.json) compiles the React app into
# here -- index.html plus hashed assets/*.[hash].js|css. The backend serves
# this built output, not the frontend/src sources directly.
FRONTEND_DIST_DIR = FRONTEND_DIR / "dist"

# SQLite position store (see backend/storage.py) lives here, gitignored.
DATA_DIR = BASE_DIR / "data"
