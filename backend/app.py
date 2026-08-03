import asyncio
import hashlib
import logging
import time
import webbrowser
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import config, history, infrastructure, regions, replay
from backend.cache import registry

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("osint-globe")

_background_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    from backend.sources import gdelt, firms, ais, adsb, acled, countries, cities

    pollers = [
        gdelt.start(),
        firms.start(),
        ais.start(),
        adsb.start(),
        acled.start(),
        countries.start(),
        cities.start(),
        history.start(),
    ]
    for coro in pollers:
        _background_tasks.append(asyncio.create_task(coro))

    # Weather has no polling loop of its own -- it's proxied tile-by-tile on
    # demand below -- but is registered here so its key status shows up
    # alongside every other source in /api/health.
    registry.register("owm_weather", key_configured=bool(config.OWM_API_KEY))

    log.info("Started %d background source tasks", len(_background_tasks))
    yield

    for task in _background_tasks:
        task.cancel()
    await asyncio.gather(*_background_tasks, return_exceptions=True)


app = FastAPI(title="OSINT Live Globe", lifespan=lifespan)
# FIRMS/ACLED/cities responses run tens of thousands of JSON objects deep --
# gzip cuts that transfer size dramatically (highly repetitive keys/values)
# and is the cheapest available win for "loads slowly" on a real network.
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.get("/api/health")
async def health():
    return registry.health()


@app.get("/api/regions")
async def regions_list():
    # Static for the process lifetime (defined at import time in regions.py)
    # -- no version/ETag machinery needed, just tell the browser to hold on
    # to it.
    return JSONResponse(regions.serialize(), headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/infrastructure")
async def infrastructure_list():
    # Static for the process lifetime, same as /api/regions above.
    return JSONResponse(infrastructure.serialize(), headers={"Cache-Control": "public, max-age=86400"})


def _cached_source_response(request: Request, source_name: str, region: str | None, max_age: int, filter_fn):
    """Serves a source's (region-filtered) data with a version-based ETag.

    A source's data can only actually change when its background poller
    reassigns state.data (which bumps state.version -- see backend/cache.py),
    so "has the version changed" answers "did the data change" for free,
    without ever hashing or re-filtering the payload just to check -- that
    matters here since some of these run to 100k+ points (FIRMS) where
    touching the full payload on every poll would defeat the point of
    caching. max_age is set per-source to that source's own real refresh
    interval (see the callers below), so the browser stops asking entirely
    until there's actually a chance of new data.
    """
    state = registry.get(source_name)
    # Before a source's very first successful poll, state.data is still the
    # empty placeholder it was constructed with -- caching *that* for the
    # full max_age would strand an early page load on "no data" for the
    # entire window even though the real data lands moments later (a client
    # that requests before startup finishes would otherwise never see it
    # until the cache expired). Only apply the long cache once there's been
    # at least one real refresh; browsers additionally never cache no-store
    # at all, so this costs nothing once version ticks past 0.
    if state.version == 0:
        return JSONResponse(filter_fn(state.data, regions.bounds_for(region)), headers={"Cache-Control": "no-store"})
    etag = f'"{state.version}:{region or "world"}"'
    headers = {"Cache-Control": f"public, max-age={max_age}", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    payload = filter_fn(state.data, regions.bounds_for(region))
    return JSONResponse(payload, headers=headers)


@app.get("/api/conflict")
async def conflict(request: Request, region: str | None = None):
    return _cached_source_response(request, "acled", region, config.ACLED_POLL_INTERVAL, regions.filter_points)


@app.get("/api/fires")
async def fires(request: Request, region: str | None = None):
    return _cached_source_response(request, "firms", region, config.FIRMS_POLL_INTERVAL, regions.filter_points)


@app.get("/api/ships")
async def ships(request: Request, region: str | None = None):
    # AIS is a live websocket stream snapshotted every few seconds (see
    # backend/sources/ais.py) rather than a polled REST call -- there's no
    # external request to save by caching longer, and ship positions churn
    # fast, so this stays short purely to skip re-sending byte-identical
    # responses for the same instant.
    return _cached_source_response(request, "ais", region, 5, regions.filter_points)


@app.get("/api/news")
async def news(request: Request, region: str | None = None):
    return _cached_source_response(request, "gdelt", region, config.GDELT_POLL_INTERVAL, regions.filter_points)


@app.get("/api/aircraft")
async def aircraft(request: Request, region: str | None = None):
    authenticated = bool(config.OPENSKY_CLIENT_ID and config.OPENSKY_CLIENT_SECRET)
    max_age = config.ADSB_POLL_INTERVAL_AUTH if authenticated else config.ADSB_POLL_INTERVAL_ANON
    return _cached_source_response(request, "adsb", region, max_age, regions.filter_points)


@app.get("/api/countries")
async def countries(request: Request, region: str | None = None):
    # Refreshed server-side once/day (see backend/sources/countries.py) --
    # capped well under that so a dev-server restart's fresh data doesn't
    # sit invisible to an already-open tab for a full day.
    return _cached_source_response(request, "countries", region, 3600, regions.filter_geojson)


@app.get("/api/cities")
async def cities(request: Request, region: str | None = None):
    return _cached_source_response(request, "cities", region, 3600, regions.filter_points)


@app.get("/api/replay")
async def replay_at(at: float, region: str | None = None):
    """Point-in-time snapshot for the timeline scrubber: conflict/fires/news
    filtered to whatever was already true at or before `at` (a unix
    timestamp), plus the nearest captured ship/aircraft position snapshot.
    Not cached -- every drag of the scrubber is a distinct `at`, so an ETag
    would just be dead weight on every request.
    """
    bounds = regions.bounds_for(region)
    payload = {
        "at": at,
        "acled": regions.filter_points(replay.filter_up_to(registry.get("acled").data, replay.acled_ts, at), bounds),
        "firms": regions.filter_points(replay.filter_up_to(registry.get("firms").data, replay.firms_ts, at), bounds),
        "gdelt": regions.filter_points(replay.filter_up_to(registry.get("gdelt").data, replay.gdelt_ts, at), bounds),
        "ais": regions.filter_points(history.SHIP_HISTORY.at(at), bounds),
        "adsb": regions.filter_points(history.AIRCRAFT_HISTORY.at(at), bounds),
    }
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


# Wind arrows: no polling loop -- fetched on demand for whatever bbox the
# frontend is currently looking at (see backend/sources/wind.py). Cached per
# rounded bbox since Open-Meteo's own data only refreshes every 15 minutes
# anyway, and the map fires this on every pan/zoom. Snapped to a coarse 2deg
# grid (not 0.1deg) -- wind doesn't change meaningfully over a small pan, and
# Open-Meteo's free tier has a hard *daily* request cap that a fine-grained
# cache key burns through fast (every few-pixel pan was a fresh API call).
_WIND_CACHE: dict[tuple[float, float, float, float], tuple[float, list[dict], int]] = {}
_WIND_CACHE_TTL = 300
_WIND_CACHE_GRID_DEG = 2
_wind_version = 0  # bumped only on an actual re-fetch, same idea as SourceState.version


@app.get("/api/wind")
async def wind(request: Request, south: float, west: float, north: float, east: float):
    global _wind_version
    from backend.sources.wind import fetch_wind_velocity_grid

    def snap(v: float) -> float:
        return round(v / _WIND_CACHE_GRID_DEG) * _WIND_CACHE_GRID_DEG

    cache_key = (snap(south), snap(west), snap(north), snap(east))
    cached = _WIND_CACHE.get(cache_key)
    if not cached or time.time() - cached[0] >= _WIND_CACHE_TTL:
        if len(_WIND_CACHE) > 500:
            _WIND_CACHE.clear()
        try:
            data = await fetch_wind_velocity_grid(south, west, north, east)
        except Exception as exc:
            raise HTTPException(502, f"Wind data fetch failed: {exc}")
        _wind_version += 1
        cached = (time.time(), data, _wind_version)
        _WIND_CACHE[cache_key] = cached

    _, data, version = cached
    etag = '"{}:{}"'.format("-".join(str(v) for v in cache_key), version)
    headers = {"Cache-Control": f"public, max-age={_WIND_CACHE_TTL}", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(data, headers=headers)


# Weather tiles (clouds/wind, from OpenWeatherMap) are proxied through the
# backend so the API key never reaches the browser, same as every other
# source's credentials. Tiles are cached briefly since OWM's free tier only
# refreshes this data every few hours anyway -- no point re-fetching on every
# pan/zoom.
#
# That server-side cache alone doesn't stop the *browser* from re-requesting
# a tile it already has, though -- Leaflet's TileLayer re-issues a plain GET
# for every tile on every pan/zoom, and without cache headers on the
# response, the browser has no way to know it can reuse what it already
# fetched. So on top of the TTL cache, every tile is served with an ETag
# (a hash of its own bytes, computed once when it's fetched from OWM) and a
# matching Cache-Control -- the browser can skip the request entirely within
# max-age, and after that a revalidation costs a bare 304 instead of the
# full image, since OWM frequently re-serves an unchanged tile between polls.
_WEATHER_LAYERS = {"clouds_new", "wind_new", "precipitation_new", "temp_new", "pressure_new"}
_TILE_CACHE: dict[tuple[str, int, int, int], tuple[float, bytes, str]] = {}  # (fetched_at, content, etag)
_TILE_CACHE_TTL = 900


@app.get("/api/weather/tile/{layer}/{z}/{x}/{y}.png")
async def weather_tile(layer: str, z: int, x: int, y: int, request: Request):
    if layer not in _WEATHER_LAYERS:
        raise HTTPException(404, "Unknown weather layer")
    if not config.OWM_API_KEY:
        raise HTTPException(503, "OWM_API_KEY not set in .env")

    cache_key = (layer, z, x, y)
    cached = _TILE_CACHE.get(cache_key)
    if not cached or time.time() - cached[0] >= _TILE_CACHE_TTL:
        if len(_TILE_CACHE) > 8000:  # crude cap so a long-running session can't grow unbounded
            _TILE_CACHE.clear()

        url = f"https://tile.openweathermap.org/map/{layer}/{z}/{x}/{y}.png"
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params={"appid": config.OWM_API_KEY})
            resp.raise_for_status()
        etag = hashlib.sha256(resp.content).hexdigest()[:16]
        cached = (time.time(), resp.content, etag)
        _TILE_CACHE[cache_key] = cached

    _, content, etag = cached
    etag_header = f'"{etag}"'
    headers = {"Cache-Control": f"public, max-age={_TILE_CACHE_TTL}", "ETag": etag_header}
    if request.headers.get("if-none-match") == etag_header:
        return Response(status_code=304, headers=headers)
    return Response(content=content, media_type="image/png", headers=headers)


if not (config.FRONTEND_DIST_DIR / "index.html").exists():
    raise RuntimeError(
        f"{config.FRONTEND_DIST_DIR} has no build output -- run `npm install && npm run build` "
        "in frontend/ first (run.bat does this automatically)."
    )

# Vite's default build layout: hashed JS/CSS under dist/assets/, everything
# else (index.html, the favicon data-uri is inline so nothing else is needed)
# served from dist/ directly.
app.mount("/assets", StaticFiles(directory=str(config.FRONTEND_DIST_DIR / "assets")), name="assets")


@app.get("/")
async def index():
    return FileResponse(str(config.FRONTEND_DIST_DIR / "index.html"))


def run():
    import uvicorn

    threading_open_browser()
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")


def threading_open_browser():
    import threading

    def _open():
        import time

        time.sleep(1.5)
        webbrowser.open("http://127.0.0.1:8000")

    threading.Thread(target=_open, daemon=True).start()


if __name__ == "__main__":
    run()
