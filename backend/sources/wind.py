import math
from datetime import datetime, timezone

import httpx

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GRID_SIZE = 9  # 9x9 = 81 points per request -- leaflet-velocity interpolates between them smoothly


def _grid_points(south: float, west: float, north: float, east: float) -> tuple[list[float], list[float]]:
    # North-to-south row order, west-to-east columns -- matches the la1=north,
    # la2=south GRIB-style convention leaflet-velocity expects.
    lats = [north - (north - south) * i / (GRID_SIZE - 1) for i in range(GRID_SIZE)]
    lons = [west + (east - west) * j / (GRID_SIZE - 1) for j in range(GRID_SIZE)]
    return lats, lons


async def fetch_wind_velocity_grid(south: float, west: float, north: float, east: float) -> list[dict]:
    south = max(south, -85.0)
    north = min(north, 85.0)
    lats, lons = _grid_points(south, west, north, east)

    query_lats, query_lons = [], []
    for lat in lats:
        for lon in lons:
            query_lats.append(round(lat, 3))
            query_lons.append(round(((lon + 180) % 360) - 180, 3))  # normalize antimeridian wraparound

    params = {
        "latitude": ",".join(str(v) for v in query_lats),
        "longitude": ",".join(str(v) for v in query_lons),
        "current": "wind_speed_10m,wind_direction_10m",
        "wind_speed_unit": "ms",
        # Pin to NOAA's own GFS 0.25 deg model instead of Open-Meteo's blended
        # "best match" -- higher native resolution, and the actual model the
        # leaflet-velocity examples are built around.
        "models": "ncep_gfs025",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(FORECAST_URL, params=params)
        resp.raise_for_status()
        payload = resp.json()

    items = payload if isinstance(payload, list) else [payload]

    # Convert meteorological (speed, "from" direction) to u/v vector components,
    # which is what leaflet-velocity's particle field expects.
    u_data, v_data = [], []
    for item in items:
        current = item.get("current") or {}
        speed = current.get("wind_speed_10m") or 0.0
        direction = current.get("wind_direction_10m")
        if direction is None:
            u_data.append(0.0)
            v_data.append(0.0)
            continue
        rad = math.radians(direction)
        u_data.append(round(-speed * math.sin(rad), 2))
        v_data.append(round(-speed * math.cos(rad), 2))

    header = {
        "parameterUnit": "m.s-1",
        "parameterCategory": 2,
        "nx": GRID_SIZE,
        "ny": GRID_SIZE,
        "lo1": round(west, 3),
        "la1": round(north, 3),
        "lo2": round(east, 3),
        "la2": round(south, 3),
        "dx": round((east - west) / (GRID_SIZE - 1), 4),
        "dy": round((north - south) / (GRID_SIZE - 1), 4),
        "refTime": datetime.now(timezone.utc).isoformat(),
    }
    return [
        {"header": {**header, "parameterNumber": 2}, "data": u_data},  # U-component
        {"header": {**header, "parameterNumber": 3}, "data": v_data},  # V-component
    ]
