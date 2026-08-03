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
