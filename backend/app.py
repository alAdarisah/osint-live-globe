import asyncio
import hashlib
import logging
import os
import time
import uuid
import webbrowser
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import config, escalation, history, infrastructure, regions, replay, storage
from backend.cache import registry
from backend.ratelimit import LruTtlCache, TokenBucket

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("osint-globe")

# httpx logs every request's full URL at INFO, and FIRMS takes its API key as a
# path segment -- so FIRMS_MAP_KEY was being written to the container logs in
# plaintext on every poll. Its own failures still surface: each source module
# catches and logs them itself.
logging.getLogger("httpx").setLevel(logging.WARNING)

_background_tasks: list[asyncio.Task] = []

# Every ETag below is derived from a source's `version` counter, which starts
# at 0 in each new process. Without a per-process component, a restarted
# backend re-issues ETags it already used -- so a browser holding a cached
# copy from the *previous* process sends If-None-Match, matches, gets a 304,
# and keeps showing data from before the restart. That's invisible in normal
# operation and actively misleading after a deploy or a data-filtering
# change. A token minted at import time makes every process's ETags distinct.
_PROCESS_TOKEN = uuid.uuid4().hex[:8]


_SOURCE_MODULES = (
    "gdelt", "firms", "ais", "adsb", "acled", "countries", "cities", "jamming", "satellites",
    "hdx_conflict_stats", "hapi_conflict", "event_fusion", "official_feeds", "officials",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Storage connects in the background rather than blocking startup. Every
    # write path already no-ops while the pool is None (see storage.py), so
    # the cost of connecting late is a few skipped snapshots, whereas
    # awaiting it here would hold the whole API hostage to the database:
    # with Postgres absent the retry budget alone stalled first response by
    # ~60s. Under compose the healthcheck means it connects on the first
    # attempt anyway; this only changes the degraded cases.
    _background_tasks.append(asyncio.create_task(storage.init_pool()))

    # Each source is imported and started independently -- one module with a
    # broken/missing dependency (e.g. jamming.py needing the `h3` package)
    # used to take the entire backend down at startup via a single shared
    # `from backend.sources import ...` line, silently breaking every other
    # source (and /api/regions, and therefore the Conflict Zone picker) along
    # with it. A bad source now just logs and sits inert instead.
    import importlib

    for name in _SOURCE_MODULES:
        try:
            module = importlib.import_module(f"backend.sources.{name}")
            _background_tasks.append(asyncio.create_task(module.start()))
        except Exception:
            log.exception("Failed to start source %r -- it will stay unavailable", name)

    _background_tasks.append(asyncio.create_task(storage.retention_sweep_loop()))

    # Weather has no polling loop of its own -- it's proxied tile-by-tile on
    # demand below -- but is registered here so its key status shows up
    # alongside every other source in /api/health.
    registry.register("owm_weather", key_configured=bool(config.OWM_API_KEY))

    log.info("Started %d background source tasks", len(_background_tasks))
    yield

    for task in _background_tasks:
        task.cancel()
    await asyncio.gather(*_background_tasks, return_exceptions=True)
    await storage.close_pool()


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


def _cached_source_response(request: Request, source_name: str, region: str | None, filter_fn, max_age: int | None = None):
    """Serves a source's (region-filtered) data with a version-based ETag.

    A source's data can only actually change when its background poller
    reassigns state.data (which bumps state.version -- see backend/cache.py),
    so "has the version changed" answers "did the data change" for free,
    without ever hashing or re-filtering the payload just to check -- that
    matters here since some of these run to 100k+ points (FIRMS) where
    touching the full payload on every poll would defeat the point of
    caching. `no-cache` (not a bare max-age) is deliberate: it still lets the
    browser skip re-downloading the body via the ETag/304 path below, but
    forces it to actually ask the server every time rather than serving a
    stale disk-cached response with no server round trip at all -- a bare
    `public, max-age={source's poll interval}` (e.g. ACLED's 30min) silently
    ate the frontend's own, much shorter poll interval (useOsintData.js polls
    every 3min), so a client could sit on a 30-minute-old snapshot with no
    way to notice a poll had even happened. `max_age` is only for sources
    whose poller itself runs far slower than any client poll could ever
    catch (countries/cities, ~once/day) -- there, skipping the round trip
    entirely for a while is safe and actually the point.
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
    etag = f'"{_PROCESS_TOKEN}:{state.version}:{region or "world"}"'
    cache_control = f"public, max-age={max_age}" if max_age else "no-cache"
    headers = {"Cache-Control": cache_control, "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    payload = filter_fn(state.data, regions.bounds_for(region))
    return JSONResponse(payload, headers=headers)


@app.get("/api/conflict")
async def conflict(request: Request, region: str | None = None):
    return _cached_source_response(request, "acled", region, regions.filter_points)


@app.get("/api/conflict-stats")
async def conflict_stats(request: Request):
    # Country-keyed monthly aggregate, not point data -- no region filter
    # (see backend/sources/hdx_conflict_stats.py), so this skips
    # _cached_source_response's regions.filter_points and just does its own
    # version-based ETag the same way.
    state = registry.get("hdx_conflict_stats")
    if state.version == 0:
        return JSONResponse(state.data, headers={"Cache-Control": "no-store"})
    etag = f'"{_PROCESS_TOKEN}:{state.version}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(state.data, headers=headers)


@app.get("/api/conflict-history")
async def conflict_history(request: Request, region: str | None = None):
    # UCDP's reviewed record, ungated by recency (see backend/sources/acled.py).
    # Every row carries as_of/lag_days; anything rendering this is expected to
    # show that it is not live.
    return _cached_source_response(request, "conflict_history", region, regions.filter_points)


@app.get("/api/conflict-districts")
async def conflict_districts(request: Request, country: str | None = None, months: int = 1):
    # ACLED at admin-2 resolution, monthly, keyless and un-embargoed (see
    # backend/sources/hapi_conflict.py). District-keyed rather than point data,
    # so the same no-region-filter treatment as /api/conflict-stats.
    #
    # `months` defaults to 1 deliberately. The full 24-month archive is ~23 MB
    # of JSON across 100k district-months; the frontend only reads the latest
    # month (for country cards), and shipping the archive to a browser that
    # discards 23/24ths of it would cost a multi-second parse on every load.
    # Pass months=0 for everything.
    state = registry.get("hapi_conflict")
    items = state.data or []
    if country:
        wanted = country.strip().upper()
        items = [r for r in items if (r.get("country_code") or "").upper() == wanted]
    if months and items:
        keep = sorted({r["month"] for r in items}, reverse=True)[:months]
        cutoff = keep[-1]
        items = [r for r in items if r["month"] >= cutoff]
    if state.version == 0:
        return JSONResponse(items, headers={"Cache-Control": "no-store"})
    etag = f'"{_PROCESS_TOKEN}:{state.version}:{country or ""}:{months}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(items, headers=headers)


# Ceiling on the *world* view only. A selected region is never capped -- if you
# have asked to look at Sudan you should see all of Sudan. Applied here at the
# serving boundary rather than in fusion, because the archive and escalation.py
# must go on seeing everything.
EVENTS_MAX_ITEMS = 2500


def _events_filter(items: list[dict], bounds) -> list[dict]:
    scoped = regions.filter_points(items, bounds)
    if bounds is None and len(scoped) > EVENTS_MAX_ITEMS:
        return sorted(scoped, key=lambda d: d.get("severity") or 0, reverse=True)[:EVENTS_MAX_ITEMS]
    return scoped


@app.get("/api/events")
async def events(request: Request, region: str | None = None):
    # The single canonical conflict/violence feed: ACLED + UCDP (via
    # registry "acled") and GDELT's structured conflict events, cross-
    # referenced and collapsed into one record per real-world incident. See
    # backend/sources/event_fusion.py. This replaces rendering ACLED/UCDP
    # and GDELT-derived conflict pins as separate, unmerged layers.
    return _cached_source_response(request, "events", region, _events_filter)


# Same world-view-only reasoning as EVENTS_MAX_ITEMS above. Lower because this
# layer is bounded by how much diplomacy actually happens in a day, not by how
# much of the world is on fire.
OFFICIALS_MAX_ITEMS = 1200


def _officials_filter(items: list[dict], bounds) -> list[dict]:
    scoped = regions.filter_points(items, bounds)
    if bounds is None and len(scoped) > OFFICIALS_MAX_ITEMS:
        # officials.py already sorted by its own recency-weighted rank, so the
        # cut here is a prefix rather than a re-sort -- which also means a
        # government's own release is never dropped in favour of a wire story
        # about it (see officials._rank).
        return scoped[:OFFICIALS_MAX_ITEMS]
    return scoped


@app.get("/api/officials")
async def officials(request: Request, region: str | None = None):
    # Statements, meetings, state visits, demands and threats by heads of
    # state, foreign ministries and international bodies -- CAMEO-coded from
    # trusted newsrooms and, separately, straight from the governments' own
    # press feeds. See backend/sources/officials.py; the per-record `origin`
    # field is what tells those two apart, and the popup says which it is.
    return _cached_source_response(request, "officials", region, _officials_filter)


@app.get("/api/fires")
async def fires(request: Request, region: str | None = None):
    return _cached_source_response(request, "firms", region, regions.filter_points)


@app.get("/api/jamming")
async def jamming_endpoint(request: Request, region: str | None = None):
    return _cached_source_response(request, "jamming", region, regions.filter_points)


@app.get("/api/satellites")
async def satellites(region: str | None = None):
    # Position is propagated fresh every poll (see backend/sources/
    # satellites.py) and changes continuously regardless of the underlying
    # orbital elements' own refresh cadence -- same reasoning /api/wind and
    # /api/replay already use for opting out of the version/ETag cache.
    state = registry.get("satellites")
    payload = regions.filter_points(state.data, regions.bounds_for(region))
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.get("/api/ships")
async def ships(request: Request, region: str | None = None):
    # AIS is a live websocket stream snapshotted every few seconds (see
    # backend/sources/ais.py) -- ETag/304 still saves the body bytes, `no-cache`
    # (see _cached_source_response) just means every poll actually asks.
    return _cached_source_response(request, "ais", region, regions.filter_points)


def _gdelt_filter(items: list[dict], bounds) -> list[dict]:
    # Only ever serve items with a real scraped article title -- a
    # CAMEO-coded fallback sentence isn't a headline and shouldn't be shown
    # as one. backend/sources/gdelt.py keeps title-less items in its own
    # accumulator (for the backfill and for event_fusion.py's direct read
    # of registry state), so this filter only applies at this public
    # serving boundary.
    #
    # This used to also drop anything event_fusion.py had folded into a fused
    # conflict event, to stop one story rendering as both a News pin and a
    # Conflict pin. That removed the duplicate marker by removing the article:
    # the headline then appeared nowhere at all, including on the conflict pin
    # that had absorbed it. The fused record now carries the headlines itself
    # (event_fusion._coverage_for) along with the news ids behind them, and the
    # map suppresses the duplicate marker from that -- so this endpoint serves
    # the full feed and the news panel stays complete.
    titled = [d for d in items if (d.get("real_title") or "").strip()]
    return regions.filter_points(titled, bounds)


@app.get("/api/news")
async def news(request: Request, region: str | None = None):
    return _cached_source_response(request, "gdelt", region, _gdelt_filter)


@app.get("/api/aircraft")
async def aircraft(request: Request, region: str | None = None):
    return _cached_source_response(request, "adsb", region, regions.filter_points)


@app.get("/api/countries")
async def countries(request: Request, region: str | None = None):
    # Refreshed server-side once/day (see backend/sources/countries.py) --
    # capped well under that so a dev-server restart's fresh data doesn't
    # sit invisible to an already-open tab for a full day.
    return _cached_source_response(request, "countries", region, regions.filter_geojson, max_age=3600)


@app.get("/api/cities")
async def cities(request: Request, region: str | None = None):
    return _cached_source_response(request, "cities", region, regions.filter_points, max_age=3600)


# Aggregates a week of conflict_events across every region, so it's far too
# expensive to recompute per request when the frontend polls it on a timer.
# The underlying data only moves when event_fusion.py writes (minutes apart),
# so a short TTL costs nothing in freshness.
_ESCALATION_CACHE = LruTtlCache(maxsize=1, ttl=120)


@app.get("/api/escalation")
async def escalation_endpoint():
    """Regions currently running above their own recent baseline.

    Returns an empty list -- not an error -- when there's no database or not
    enough history to compare against. "Nothing to report" and "we can't
    tell yet" both correctly render as a hidden panel rather than a claim.
    """
    cached = _ESCALATION_CACHE.get("all")
    if cached is None:
        cached = await escalation.compute()
        _ESCALATION_CACHE.set("all", cached)
    return JSONResponse(cached, headers={"Cache-Control": "no-store"})


@app.get("/api/replay")
async def replay_at(at: float, region: str | None = None):
    """Point-in-time snapshot for the timeline scrubber: conflict/fires/news
    filtered to whatever was already true at or before `at` (a unix
    timestamp), plus the nearest captured ship/aircraft position snapshot.
    Not cached -- every drag of the scrubber is a distinct `at`, so an ETag
    would just be dead weight on every request.
    """
    bounds = regions.bounds_for(region)

    # The conflict layer replays out of Postgres when there's history there,
    # and falls back to time-filtering the in-memory feed otherwise (a fresh
    # database, or the first minutes after a restart). Reading storage is
    # what makes the scrubber show the *fused* records the live map draws --
    # filtering registry data alone can only ever replay raw, pre-fusion
    # ACLED/UCDP rows, so scrubbing back used to swap the map's merged
    # events for un-deduplicated ones without saying so.
    events = regions.filter_points(await storage.history_at("events", at), bounds)
    if not events:
        events = regions.filter_points(
            replay.filter_up_to(registry.get("acled").data, replay.acled_ts, at), bounds
        )

    payload = {
        "at": at,
        "events": events,
        "firms": regions.filter_points(replay.filter_up_to(registry.get("firms").data, replay.firms_ts, at), bounds),
        "gdelt": regions.filter_points(replay.filter_up_to(registry.get("gdelt").data, replay.gdelt_ts, at), bounds),
        "ais": regions.filter_points(await history.SHIP_HISTORY.at(at), bounds),
        "adsb": regions.filter_points(await history.AIRCRAFT_HISTORY.at(at), bounds),
    }
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


# Wind arrows: no polling loop -- fetched on demand for whatever bbox the
# frontend is currently looking at (see backend/sources/wind.py). Cached per
# rounded bbox since Open-Meteo's own data only refreshes every 15 minutes
# anyway, and the map fires this on every pan/zoom. Snapped to a coarse 2deg
# grid (not 0.1deg) -- wind doesn't change meaningfully over a small pan, and
# Open-Meteo's free tier has a hard *daily* request cap that a fine-grained
# cache key burns through fast (every few-pixel pan was a fresh API call).
_WIND_CACHE_TTL = 600
_WIND_CACHE_GRID_DEG = 4
_WIND_CACHE = LruTtlCache(maxsize=500, ttl=_WIND_CACHE_TTL)
_wind_version = 0  # bumped only on an actual re-fetch, same idea as SourceState.version

# Guards Open-Meteo's daily quota. Only cache *misses* draw a token, since a
# hit costs the upstream nothing -- so this bounds the sustained outbound
# rate while leaving normal browsing (which is nearly all cache hits, thanks
# to the 4-degree snap above) completely unaffected. Burst of 30 covers a
# first load panning across fresh grid squares; 1/s sustained is far more
# than a human map session generates and far less than the daily cap.
_WIND_UPSTREAM_LIMIT = TokenBucket(capacity=30, refill_per_second=1.0)

# Open-Meteo's cap is a hard *daily* count, not a rate limit that recovers in
# seconds -- once it's exhausted (or the upstream is otherwise down), retrying
# on every pan/zoom just keeps failing and can't dig the quota back out. A
# short negative-cache means a burst of moveend-triggered requests during an
# outage costs one upstream call instead of one per request.
_WIND_ERROR_CACHE: dict[tuple[float, float, float, float], tuple[float, str]] = {}
_WIND_ERROR_TTL = 120


@app.get("/api/wind")
async def wind(request: Request, south: float, west: float, north: float, east: float):
    global _wind_version
    from backend.sources.wind import fetch_wind_velocity_grid

    def snap(v: float) -> float:
        return round(v / _WIND_CACHE_GRID_DEG) * _WIND_CACHE_GRID_DEG

    cache_key = (snap(south), snap(west), snap(north), snap(east))

    cached_error = _WIND_ERROR_CACHE.get(cache_key)
    if cached_error and time.time() - cached_error[0] < _WIND_ERROR_TTL:
        raise HTTPException(502, f"Wind data fetch failed: {cached_error[1]}")

    cached = _WIND_CACHE.get(cache_key)
    if cached is None:
        if not _WIND_UPSTREAM_LIMIT.take():
            # Deliberately 503 + Retry-After rather than 502: nothing is
            # broken, we're just declining to spend more of the daily quota
            # this second. The frontend already treats a failed wind fetch as
            # "unavailable right now" (see WeatherSection.jsx's notice).
            raise HTTPException(503, "Wind fetch rate limit reached", headers={"Retry-After": "5"})
        try:
            data = await fetch_wind_velocity_grid(south, west, north, east)
        except Exception as exc:
            # Type name included deliberately: httpx's timeout exceptions carry
            # an empty message, so the detail read "Wind data fetch failed: "
            # and the server logged nothing at all -- an outage that told you
            # neither what failed nor why. Now it says ConnectTimeout.
            reason = f"{type(exc).__name__}: {exc}".rstrip(": ")
            log.warning("Wind fetch failed for %s: %s", cache_key, reason, exc_info=True)
            _WIND_ERROR_CACHE[cache_key] = (time.time(), reason)
            raise HTTPException(502, f"Wind data fetch failed: {reason}")
        _wind_version += 1
        cached = (data, _wind_version)
        _WIND_CACHE.set(cache_key, cached)

    data, version = cached
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
_TILE_CACHE_TTL = 900
_TILE_CACHE = LruTtlCache(maxsize=8000, ttl=_TILE_CACHE_TTL)

# Same reasoning as the wind limiter above, sized for tiles: one screenful is
# roughly 10-20 tiles, so a 200-token burst absorbs several pans over unseen
# area, and 20/s sustained keeps a scripted crawl of the tile pyramid from
# quietly draining the OWM quota. Only misses draw tokens.
_TILE_UPSTREAM_LIMIT = TokenBucket(capacity=200, refill_per_second=20.0)

# z/x/y arrive straight off the URL. Web Mercator only defines 0 <= x,y < 2^z,
# and OWM serves nothing past z~20 -- without this, an out-of-range request
# was forwarded upstream to earn a 4xx, spending quota to learn what simple
# arithmetic already knows, and each distinct bad tuple got its own cache slot.
_TILE_MAX_ZOOM = 20


@app.get("/api/weather/tile/{layer}/{z}/{x}/{y}.png")
async def weather_tile(layer: str, z: int, x: int, y: int, request: Request):
    if layer not in _WEATHER_LAYERS:
        raise HTTPException(404, "Unknown weather layer")
    if not 0 <= z <= _TILE_MAX_ZOOM:
        raise HTTPException(404, "Zoom out of range")
    limit = 1 << z
    if not (0 <= x < limit and 0 <= y < limit):
        raise HTTPException(404, "Tile out of range")
    if not config.OWM_API_KEY:
        raise HTTPException(503, "OWM_API_KEY not set in .env")

    cache_key = (layer, z, x, y)
    cached = _TILE_CACHE.get(cache_key)
    if cached is None:
        if not _TILE_UPSTREAM_LIMIT.take():
            raise HTTPException(503, "Weather tile rate limit reached", headers={"Retry-After": "2"})

        url = f"https://tile.openweathermap.org/map/{layer}/{z}/{x}/{y}.png"
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params={"appid": config.OWM_API_KEY})
            resp.raise_for_status()
        etag = hashlib.sha256(resp.content).hexdigest()[:16]
        cached = (resp.content, etag)
        _TILE_CACHE.set(cache_key, cached)

    content, etag = cached
    etag_header = f'"{etag}"'
    headers = {"Cache-Control": f"public, max-age={_TILE_CACHE_TTL}", "ETag": etag_header}
    if request.headers.get("if-none-match") == etag_header:
        return Response(status_code=304, headers=headers)
    return Response(content=content, media_type="image/png", headers=headers)


# Serving the built frontend is optional. In the docker-compose split (see
# docker-compose.yml) the React app is its own nginx container that proxies
# /api here, so this image has no frontend/dist at all and must run as a
# pure API -- what used to be a hard RuntimeError at import time. The
# single-container path (root Dockerfile, render.yaml) still copies dist in,
# so it keeps serving the UI from here exactly as before.
_HAS_FRONTEND_BUILD = (config.FRONTEND_DIST_DIR / "index.html").exists()

if _HAS_FRONTEND_BUILD:
    # Vite's default build layout: hashed JS/CSS under dist/assets/, everything
    # else (index.html, the favicon data-uri is inline so nothing else is needed)
    # served from dist/ directly.
    app.mount("/assets", StaticFiles(directory=str(config.FRONTEND_DIST_DIR / "assets")), name="assets")

    @app.get("/")
    async def index():
        return FileResponse(str(config.FRONTEND_DIST_DIR / "index.html"))
else:
    log.info("No frontend build at %s -- serving API only", config.FRONTEND_DIST_DIR)

    @app.get("/")
    async def index():
        return JSONResponse({"service": "osint-live-globe", "mode": "api-only"})


def run():
    import uvicorn

    # Render (and most PaaS hosts) inject PORT and expect a bind on 0.0.0.0;
    # local runs keep the old 127.0.0.1:8000 default with an auto-opened tab.
    port = int(os.getenv("PORT", "8000"))
    is_cloud = "PORT" in os.environ
    host = "0.0.0.0" if is_cloud else "127.0.0.1"

    if not is_cloud:
        threading_open_browser(port)
    uvicorn.run(app, host=host, port=port, log_level="info")


def threading_open_browser(port: int):
    import threading

    def _open():
        import time

        time.sleep(1.5)
        webbrowser.open(f"http://127.0.0.1:{port}")

    threading.Thread(target=_open, daemon=True).start()


if __name__ == "__main__":
    run()
