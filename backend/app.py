import asyncio
import hashlib
import logging
import math
import os
import re
import time
import uuid
import webbrowser
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import (
    admin_config, cachestore, config, escalation, history, infrastructure, ingest, metrics, mirror,
    refine, regions, replay, storage,
)
from backend.cache import registry
from backend.ratelimit import LruTtlCache, TokenBucket
from backend.refine import flight_legs, lane_density, port_call_thresholds
# Aliased: this module already has a route handler literally named
# `satellites` (see /api/satellites below, unchanged from before this task),
# and that function def rebinds the bare module-level name `satellites` --
# so an unaliased import here would be shadowed by it for every reference
# below the route, the same reason admin1_boundaries/water_bodies's own
# route handlers are named *_endpoint rather than reusing their module's name.
from backend.sources import admin1_boundaries, admin2_boundaries, airfield_activity, sat_passes, water_bodies
from backend.sources import satellites as satellites_source

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

# Published as a label on osint_backend_info, so a restart is visible in the
# metrics as a changed label rather than only as counters resetting to zero.
metrics.set_process_token(_PROCESS_TOKEN)


# The sources this process still fetches for itself: every one of them is
# keyless and unmetered, so the cost of a restart re-polling them is bandwidth
# and nothing else. Everything credentialed or metered -- ACLED, FIRMS, ADS-B,
# AIS -- moved to the ingest process (see backend/ingest), because those were
# being re-paid for on every restart, redeploy and local dev run by whoever
# happened to be running the backend. osm_infra went with them: it is keyless,
# but Overpass is a volunteer service and a 20-minute sweep restarting from the
# top on every deploy is the same discourtesy in a different currency.
#
# Those five are read back from Postgres instead (see backend/mirror.py), which
# is what keeps /api/ships, /api/aircraft, /api/fires and the conflict layer
# serving exactly as before.
_SOURCE_MODULES = (
    # gazetteer sits with cities because it is the same GeoNames family, and
    # early in the list because its download is the slowest here and everything
    # in the placement path degrades to "no opinion" until it lands.
    "gdelt", "countries", "cities", "gazetteer",
    "jamming", "satellites", "hazards", "floods", "airports", "sanctions",
    # Two lookup tables that draw nothing of their own. icao_blocks turns an
    # aircraft's hex into a country and a military flag; maritime_watchlists
    # annotates ships the way sanctions does, and both are read cross-process
    # by the ingest pollers, so they sit beside sanctions rather than anywhere
    # more logical.
    "icao_blocks", "maritime_watchlists",
    "cables", "railways", "dams", "ports", "czib", "outages", "launches", "energy_flows",
    # 99.78% United States, and there is no US theatre -- so this layer is
    # visible only on the unfiltered World view, by design. See
    # backend/sources/deflock.py.
    "deflock",
    # Fintraffic / Digitraffic (Finland): live Baltic/Finnish AIS, live train
    # positions plus the station gazetteer, and weather-camera locations. All
    # keyless and unmetered, so backend-polled like the rest here. The AIS layer
    # lives in its own kind ("ais_digitraffic"), never aisstream's "ais" -- see
    # backend/sources/digitraffic_ais.py.
    "digitraffic_ais", "digitraffic_rail", "digitraffic_weathercams",
    "hdx_conflict_stats", "hapi_conflict", "humanitarian", "food_trade",
    "official_feeds", "officials",
    # Weekly, and only for the countries hapi_conflict covers in volume: the
    # geometry its district counts are drawn on.
    "admin2_boundaries",
    # Also weekly: states and provinces, drawn when a country that has them is
    # selected. Nine federations, one 2.3 MB file.
    "admin1_boundaries",
    # Also weekly, same mirror: seas, lakes and river centrelines -- the first
    # real water geometry on this map (see backend/sources/water_bodies.py).
    "water_bodies",
)

# Everything this process serves but does not produce: the ingest process's
# collected layers and the refine process's derived ones. Composed here rather
# than inside backend/mirror.py so that module stays a dependency of both
# pipelines without either becoming a dependency of it.
def _mirrored_specs():
    return (
        mirror.from_jobs(ingest.all_jobs(), producer="the ingest service")
        + mirror.from_jobs(refine.all_jobs(), producer="the refine service")
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

    # Before the mirror starts, so its first read can already hit a warm cache
    # after a restart instead of pulling every kind out of Postgres in full.
    # Never blocks: with no Redis configured or reachable, every call is a miss
    # and the mirror reads the database exactly as it did before.
    await cachestore.connect()

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

    # Follows what the ingest and refine processes write, for everything this one
    # no longer produces. Registered synchronously first so /api/ships and
    # friends can never be served before their state exists; the task then
    # fills it.
    specs = _mirrored_specs()
    mirror.register(specs)
    _background_tasks.append(asyncio.create_task(mirror.follow(specs)))

    _background_tasks.append(asyncio.create_task(storage.retention_sweep_loop()))

    # Keeps the one metric that lives in the database off the scrape path --
    # see backend/metrics.py for why /metrics does no I/O of its own.
    _background_tasks.append(asyncio.create_task(metrics.refresh_loop()))

    # Weather has no polling loop of its own -- it's proxied tile-by-tile on
    # demand below -- but is registered here so its key status shows up
    # alongside every other source in /api/health.
    registry.register("owm_weather", key_configured=bool(config.OWM_API_KEY))

    log.info("Started %d background source tasks", len(_background_tasks))
    yield

    for task in _background_tasks:
        task.cancel()
    await asyncio.gather(*_background_tasks, return_exceptions=True)
    await cachestore.close()
    await storage.close_pool()


app = FastAPI(title="OSINT Live Globe", lifespan=lifespan)
# FIRMS/ACLED/cities responses run tens of thousands of JSON objects deep --
# gzip cuts that transfer size dramatically (highly repetitive keys/values)
# and is the cheapest available win for "loads slowly" on a real network.
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def record_request_metrics(request: Request, call_next):
    """Time every request and count it against its route template.

    /metrics excludes itself. Counting a scrape produces a request rate that
    never falls to zero and a latency series dominated by the one endpoint
    nobody is waiting on -- it would be measuring the act of measuring.

    An exception on the way out is recorded as a 500 and re-raised: an endpoint
    that raises is exactly the case worth seeing, and swallowing it here to keep
    the counter tidy would change the response the client gets.
    """
    if request.url.path == "/metrics":
        return await call_next(request)

    started = time.perf_counter()
    metrics.http_requests_in_flight.inc()
    try:
        response = await call_next(request)
    except Exception:
        metrics.observe_request(
            request.method, metrics.route_label(request), 500, time.perf_counter() - started
        )
        raise
    finally:
        metrics.http_requests_in_flight.dec()
    metrics.observe_request(
        request.method, metrics.route_label(request), response.status_code,
        time.perf_counter() - started,
    )
    return response


@app.get("/metrics")
async def metrics_endpoint():
    """Prometheus exposition for this process.

    Not under /api, and so not proxied by the frontend's nginx (see
    frontend/nginx.conf, which forwards /api/ only) -- Prometheus reaches it at
    backend:8000 on the compose network, and nothing published to the host
    serves it. That is the intended boundary: this exposes route names, source
    names and error counts, which is operational detail rather than map data.
    """
    return Response(content=metrics.render(), media_type=metrics.CONTENT_TYPE)


@app.get("/api/health")
async def health():
    """Per-source status, plus whatever the cache worker is currently reporting.

    The `alerts` block is the part no registry state can carry: conditions about
    the infrastructure between the processes rather than about a source -- Redis
    evicting, a cached kind the backend has stopped following, a producer that
    stopped producing. Read from the alerts table rather than recomputed here,
    so the API and the worker cannot disagree about what is wrong.
    """
    return {**registry.health(), "alerts": await storage.active_alerts()}


@app.get("/api/admin-config")
async def admin_config_get():
    """The saved Admin Mode configuration (see backend/admin_config.py).

    Fetched once at startup by every client, before it paints anything from its
    own localStorage copy, which is what makes a configuration saved on one
    machine the configuration this deployment uses everywhere.

    Never cached: it is small, it is read once per page load, and a stale copy
    would silently un-apply a change someone just made.
    """
    return JSONResponse(
        {"config": admin_config.load(), "saved_at": admin_config.saved_at()},
        headers={"Cache-Control": "no-store"},
    )


# POST as well as PUT, and only for one caller: navigator.sendBeacon.
#
# The frontend debounces its writes, so a refresh inside that window would
# drop the change -- and a normal fetch issued from a document that is being
# torn down is cancelled with it. sendBeacon is the browser API built for
# exactly that hand-off, and it can only issue POST. Same handler either way:
# the body is the whole configuration in both cases, so there is nothing for
# the two verbs to disagree about.
@app.post("/api/admin-config")
@app.put("/api/admin-config")
async def admin_config_put(request: Request):
    """Store the configuration the client just changed.

    The whole object every time rather than a patch: it is a few kilobytes, the
    client already holds the authoritative merged copy, and a patch protocol
    would need conflict rules for a file that only ever has one editor.
    """
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError) as err:
        raise HTTPException(status_code=400, detail=f"Body is not valid JSON: {err}") from err
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    try:
        stamp = await asyncio.to_thread(admin_config.save, payload)
    except ValueError as err:
        raise HTTPException(status_code=413, detail=str(err)) from err
    except OSError as err:
        # A read-only volume or a full disk. Worth surfacing rather than
        # swallowing: the client shows "not saved" and keeps its own copy.
        log.warning("Could not save the admin configuration: %s", err)
        raise HTTPException(status_code=500, detail=f"Could not write the configuration: {err}") from err
    return JSONResponse({"ok": True, "saved_at": stamp}, headers={"Cache-Control": "no-store"})


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


# Filtered payloads, keyed by (source, version, region, bbox).
#
# There was no cache here at all: filter_fn ran on every request that was not a
# 304, over up to a quarter of a million FIRMS points, once per client per poll.
# The ETag path avoided re-serialising, never re-filtering. So this is not a cost
# the bbox work introduces -- it is one the bbox work is a good moment to stop
# paying, and N clients sharing a snapped cell now cost one filter pass between
# them instead of N.
#
# `version` in the key is what makes it self-invalidating: it only ticks when a
# poller reassigns a source's data (see backend/cache.py), so a stale entry is
# unreachable rather than merely unlikely. maxsize is generous because the key
# space is small by construction -- a handful of sources times a handful of
# snapped cells -- and each entry is a list of references to objects the source
# registry is already holding.
_FILTERED_CACHE = LruTtlCache(maxsize=256, ttl=300)
metrics.track_local_cache("filtered_source", _FILTERED_CACHE)


def _cached_source_response(
    request: Request,
    source_name: str,
    region: str | None,
    filter_fn,
    max_age: int | None = None,
    bbox: str | None = None,
    variant: str | None = None,
):
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
    # A viewport box narrows what the region already allows; it can never widen
    # it. So a reader inside a selected zone gets that zone clipped to what they
    # can see, and never a point from outside the zone they chose.
    box = regions.parse_bbox(bbox)
    bounds = regions.intersect(regions.bounds_for(region), box)
    box_key = ",".join(f"{v:g}" for v in box) if box else "-"
    # A caller-supplied name for a filter_fn that is not the source's default
    # one. It belongs in the ETag and the cache key for exactly the reason the
    # box does: two clients on the same source, version, region and box can
    # still be holding different bodies, and without this the second would be
    # handed a 304 telling it the body it has is the one it asked for.
    variant_key = variant or "-"

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
        return JSONResponse(filter_fn(state.data, bounds), headers={"Cache-Control": "no-store"})
    # The box belongs in the ETag: two clients on the same source and version
    # but different cells hold genuinely different bodies, and without it the
    # second would be told its stale one is still good.
    etag = f'"{_PROCESS_TOKEN}:{state.version}:{region or "world"}:{box_key}:{variant_key}"'
    cache_control = f"public, max-age={max_age}" if max_age else "no-cache"
    headers = {"Cache-Control": cache_control, "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)

    cache_key = (source_name, state.version, region or "world", box_key, variant_key)
    payload = _FILTERED_CACHE.get(cache_key)
    if payload is None:
        payload = filter_fn(state.data, bounds)
        _FILTERED_CACHE.set(cache_key, payload)
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
async def conflict_history(request: Request, region: str | None = None, bbox: str | None = None):
    # UCDP's reviewed record, ungated by recency (see backend/sources/acled.py).
    # Every row carries as_of/lag_days; anything rendering this is expected to
    # show that it is not live.
    return _cached_source_response(request, "conflict_history", region, regions.filter_points, bbox=bbox)


# District geometry is stored per country (see sources/admin2_boundaries.py) and
# served the same way. One country is roughly a megabyte of thinned polygons, so
# handing over all six because a reader opened the layer would be several
# megabytes for districts they are not looking at.
_DISTRICT_BOUNDARY_CACHE = LruTtlCache(maxsize=8, ttl=3600)
metrics.track_local_cache("district_boundaries", _DISTRICT_BOUNDARY_CACHE)


@app.get("/api/district-boundaries")
async def district_boundaries(country: str):
    """Admin-2 boundaries for one country, keyed by p-code.

    Empty -- not an error -- for a country with no stored geometry: the layer
    then simply has nothing to draw there, which is the truthful outcome and
    the one the frontend already handles.
    """
    iso3 = (country or "").strip().upper()
    if not iso3.isalpha() or len(iso3) != 3:
        raise HTTPException(status_code=400, detail="country must be an ISO3 code")
    cached = _DISTRICT_BOUNDARY_CACHE.get(iso3)
    if cached is None:
        cached = await storage.reference(f"{admin2_boundaries.SNAPSHOT_PREFIX}:{iso3}") or {
            "type": "FeatureCollection", "features": [],
        }
        _DISTRICT_BOUNDARY_CACHE.set(iso3, cached)
    return JSONResponse(cached, headers={"Cache-Control": "public, max-age=86400"})


# States and provinces, stored and served the same way as the districts above
# (see sources/admin1_boundaries.py). Split per country because the whole layer
# is 21.9 MB across 251 countries and a reader selects one or two: the largest
# single answer is Russia at 2.2 MB, the median country is under 60 KB.
#
# Sixteen entries, so the cache holds a session's worth of selections without
# being able to pin more than a few tens of megabytes of geometry in memory.
_ADMIN1_BOUNDARY_CACHE = LruTtlCache(maxsize=16, ttl=3600)
metrics.track_local_cache("admin1_boundaries", _ADMIN1_BOUNDARY_CACHE)


@app.get("/api/admin1-boundaries")
async def admin1_boundaries_endpoint(country: str):
    """Admin-1 subdivisions for one country, keyed by ISO 3166-2 code.

    Empty -- not an error -- for a country with no admin-1 level at all (city
    states, and the microstates Natural Earth cuts as a single shape). The
    frontend asks once per country and remembers the empty answer, so a country
    with no subdivisions costs one request per session rather than one a click.
    """
    iso3 = (country or "").strip().upper()
    if not iso3.isalpha() or len(iso3) != 3:
        raise HTTPException(status_code=400, detail="country must be an ISO3 code")
    cached = _ADMIN1_BOUNDARY_CACHE.get(iso3)
    if cached is None:
        cached = await storage.reference(f"{admin1_boundaries.SNAPSHOT_PREFIX}:{iso3}") or {
            "type": "FeatureCollection", "features": [],
        }
        _ADMIN1_BOUNDARY_CACHE.set(iso3, cached)
    return JSONResponse(cached, headers={"Cache-Control": "public, max-age=86400"})


# Seas, lakes and river centrelines, stored one reference_snapshots row per
# kind (see sources/water_bodies.py). This reads from Postgres per request,
# the same as the district/admin1 boundaries above and for the same reason:
# water_bodies.py deliberately does not warm its geometry into registry state
# (see its NOT_WARMED entry in test_persistence_coverage.py), so there is no
# SourceState.data/version for _cached_source_response to key an ETag off --
# that machinery assumes a registry-backed source, which this is not.
#
# Kind -> snapshot name is built from water_bodies.DATASETS rather than
# retyping "water_marine"/"water_lakes"/"water_rivers" here, so the two
# cannot drift apart.
_WATER_SNAPSHOT_BY_KIND = {key: snapshot for key, snapshot, *_rest in water_bodies.DATASETS}

# Keyed by (kind, bbox) the same way _FILTERED_CACHE above is keyed by
# (source, version, region, bbox) -- three kinds times however many distinct
# viewport cells are actually asked for inside an hour, which is small next
# to that cache's 256.
_WATER_CACHE = LruTtlCache(maxsize=64, ttl=3600)
metrics.track_local_cache("water", _WATER_CACHE)


def _water_bbox_overlaps(feature_bbox: list, bounds) -> bool:
    """Rectangle overlap between one water feature's stored bbox and a query
    box, antimeridian-aware.

    Every kind stores a bbox now (see water_bodies._build_collection) --
    a Task 5 review finding was that giving one to marine only forced this
    endpoint to fall back to regions.filter_geojson for lakes and rivers,
    which recomputes a bbox by walking every coordinate, and does it on
    *every* request: storage.reference() (backend/storage.py) does a fresh
    Postgres read plus json.loads every call, so filter_geojson's memo, keyed
    on Python object identity, never once fired for water traffic. The fix
    is this endpoint never walking geometry at all, for any kind -- not
    caching the walk harder.

    Only marine has features that actually wrap the antimeridian in the live
    data (west > east -- six named seas; see water_bodies._bbox's
    docstring), but the test itself doesn't need to know which kind it is
    looking at: it reads whatever bbox is stored, wrapped or not.
    regions.parse_bbox refuses a wrapped *query* box outright (a client
    wanting both halves of a wrap asks twice), so only the feature side ever
    needs the two-range treatment below.
    """
    f_south, f_west, f_north, f_east = feature_bbox
    q_south, q_west, q_north, q_east = bounds
    if f_south > q_north or q_south > f_north:
        return False
    if f_west <= f_east:
        return f_west <= q_east and q_west <= f_east
    return q_east >= f_west or q_west <= f_east


def _filter_water(collection: dict, bounds) -> dict:
    """Bbox-filter a water dataset against each feature's stored bbox, or
    hand the collection back whole when bounds is None (kind=rivers never
    reaches here with bounds None -- see the 400 in water_endpoint below).
    One path for all three kinds: every kind carries a stored bbox, so
    there is no geometry to fall back to walking and nothing kind-specific
    left in this function.
    """
    if not isinstance(collection, dict):
        return {"type": "FeatureCollection", "features": []}
    if bounds is None:
        return collection
    features = [
        f for f in collection.get("features", [])
        if _water_bbox_overlaps(f.get("properties", {}).get("bbox") or [0.0, 0.0, 0.0, 0.0], bounds)
    ]
    return {"type": "FeatureCollection", "features": features}


@app.get("/api/water")
async def water_endpoint(kind: str = "marine", bbox: str | None = None):
    """Seas, lakes or river centrelines, from Natural Earth via
    sources/water_bodies.py.

    kind=rivers must carry a bbox: the unfiltered dataset serialises to about
    5.12 MB (re-measured after lakes/rivers gained a stored bbox -- see
    water_bodies._build_collection -- since that grows every feature a
    little; up from 5.02 MB), the same order of size
    /api/district-boundaries and /api/admin1-boundaries avoid by requiring a
    country rather than serving every boundary at once. Marine (1.19 MB,
    unchanged) and lakes (3.19 MB, up from 3.10 MB) are small enough to
    still be served whole.
    """
    if kind not in _WATER_SNAPSHOT_BY_KIND:
        raise HTTPException(
            status_code=400,
            detail=f"kind must be one of: {', '.join(_WATER_SNAPSHOT_BY_KIND)}",
        )
    bounds = regions.parse_bbox(bbox)
    if kind == "rivers" and bounds is None:
        raise HTTPException(
            status_code=400,
            detail="kind=rivers requires a bbox parameter -- the unfiltered river "
                   "dataset is about 5 MB and is not served whole",
        )
    box_key = ",".join(f"{v:g}" for v in bounds) if bounds else "-"
    cache_key = (kind, box_key)
    payload = _WATER_CACHE.get(cache_key)
    if payload is None:
        raw = await storage.reference(_WATER_SNAPSHOT_BY_KIND[kind]) or {
            "type": "FeatureCollection", "features": [],
        }
        payload = _filter_water(raw, bounds)
        _WATER_CACHE.set(cache_key, payload)
    return JSONResponse(payload, headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/conflict-district-months")
async def conflict_district_months():
    """Every month the district archive holds, newest first.

    Its own endpoint because the alternative is asking for the archive to find
    out what is in it: the months are two dozen strings, and the records they
    describe are ~23 MB.
    """
    state = registry.get("hapi_conflict")
    months = sorted({r["month"] for r in (state.data or []) if r.get("month")}, reverse=True)
    return JSONResponse(months, headers={"Cache-Control": "no-cache"})


@app.get("/api/conflict-districts")
async def conflict_districts(
    request: Request, country: str | None = None, months: int = 1, month: str | None = None
):
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
    # `month` is exact and wins over the trailing-window `months`. The map's
    # district layer scrubs one month at a time and asking for "the last N" to
    # get the Nth is both wasteful and wrong the moment a new month lands: the
    # window slides under the scrubber and the same request starts answering
    # about a different month.
    if month:
        items = [r for r in items if r.get("month") == month]
    elif months and items:
        keep = sorted({r["month"] for r in items}, reverse=True)[:months]
        cutoff = keep[-1]
        items = [r for r in items if r["month"] >= cutoff]
    if state.version == 0:
        return JSONResponse(items, headers={"Cache-Control": "no-store"})
    etag = f'"{_PROCESS_TOKEN}:{state.version}:{country or ""}:{months}:{month or ""}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(items, headers=headers)


# Ceiling on the *world* view only. A selected region is never capped -- if you
# have asked to look at Sudan you should see all of Sudan. Applied here at the
# serving boundary rather than in fusion, because the archive and escalation.py
# must go on seeing everything.
EVENTS_MAX_ITEMS = 2500


def _events_filter_for(region: str | None):
    """The events filter, bound to whether this is the unscoped world view.

    The ceiling used to key on `bounds is None`, which was the same question
    while a named region was the only thing that could produce bounds. It stops
    being the same question the moment a viewport bbox can: a box covering a
    third of the planet would make `bounds` non-None and silently lift the cap,
    which is the exact opposite of what it is for. So the ceiling asks about the
    region directly, and a bbox narrows what is returned without ever widening
    it.
    """
    world = region is None

    def _filter(items: list[dict], bounds) -> list[dict]:
        scoped = regions.filter_points(items, bounds)
        if world and len(scoped) > EVENTS_MAX_ITEMS:
            return sorted(scoped, key=lambda d: d.get("severity") or 0, reverse=True)[:EVENTS_MAX_ITEMS]
        return scoped

    return _filter


@app.get("/api/events")
async def events(request: Request, region: str | None = None):
    # The single canonical conflict/violence feed: ACLED + UCDP (via
    # registry "acled") and GDELT's structured conflict events, cross-
    # referenced and collapsed into one record per real-world incident. See
    # backend/sources/event_fusion.py. This replaces rendering ACLED/UCDP
    # and GDELT-derived conflict pins as separate, unmerged layers.
    return _cached_source_response(request, "events", region, _events_filter_for(region))


# Same world-view-only reasoning as EVENTS_MAX_ITEMS above. Lower because this
# layer is bounded by how much diplomacy actually happens in a day, not by how
# much of the world is on fire.
OFFICIALS_MAX_ITEMS = 1200


def _officials_filter_for(region: str | None):
    """Same shape, and the same reason, as _events_filter_for above."""
    world = region is None

    def _filter(items: list[dict], bounds) -> list[dict]:
        scoped = regions.filter_points(items, bounds)
        if world and len(scoped) > OFFICIALS_MAX_ITEMS:
            # officials.py already sorted by its own recency-weighted rank, so
            # the cut here is a prefix rather than a re-sort -- which also means
            # a government's own release is never dropped in favour of a wire
            # story about it (see officials._rank).
            return scoped[:OFFICIALS_MAX_ITEMS]
        return scoped

    return _filter


@app.get("/api/officials")
async def officials(request: Request, region: str | None = None):
    # Statements, meetings, state visits, demands and threats by heads of
    # state, foreign ministries and international bodies -- CAMEO-coded from
    # trusted newsrooms and, separately, straight from the governments' own
    # press feeds. See backend/sources/officials.py; the per-record `origin`
    # field is what tells those two apart, and the popup says which it is.
    return _cached_source_response(request, "officials", region, _officials_filter_for(region))


@app.get("/api/fires")
async def fires(request: Request, region: str | None = None, bbox: str | None = None):
    return _cached_source_response(request, "firms", region, regions.filter_points, bbox=bbox)


@app.get("/api/jamming")
async def jamming_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    return _cached_source_response(request, "jamming", region, regions.filter_points, bbox=bbox)


@app.get("/api/osm-infrastructure")
async def osm_infrastructure_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    # Crowd-sourced, and served on its own endpoint rather than merged into
    # /api/infrastructure for exactly that reason -- see the module docstring in
    # backend/sources/osm_infra.py.
    return _cached_source_response(request, "osm_infra", region, regions.filter_points, max_age=3600, bbox=bbox)


@app.get("/api/humanitarian")
async def humanitarian_endpoint(request: Request):
    # Country-keyed aggregates over reference periods of months (see
    # backend/sources/humanitarian.py) -- read by the country card, never drawn
    # as points, so there is nothing for a region filter to narrow.
    return _cached_source_response(request, "humanitarian", None, lambda data, _bounds: data)


@app.get("/api/energy-flows")
async def energy_flows_endpoint(request: Request):
    # Cross-border electricity exchange, keyed by country (see
    # backend/sources/energy_flows.py). A flow is an edge between two countries
    # and has no location, so there is nothing to draw and nothing for a region
    # filter to narrow -- same treatment as /api/outages.
    return _cached_source_response(request, "energy_flows", None, lambda data, _bounds: data)


@app.get("/api/food-trade")
async def food_trade_endpoint(request: Request):
    # Marketing-year supply and trade estimates keyed by country (see
    # backend/sources/food_trade.py), on the same footing as /api/humanitarian:
    # an aggregate over a season, read by the country card and never drawn.
    # Three publishers estimate each figure and the record keeps them apart --
    # anything rendering this must not collapse them to one number.
    return _cached_source_response(request, "food_trade", None, lambda data, _bounds: data)


@app.get("/api/food-price-index")
async def food_price_index_endpoint(request: Request):
    # One global monthly series, not country-keyed at all -- served separately
    # from /api/food-trade rather than folded into it for that reason.
    return _cached_source_response(request, "food_price_index", None, lambda data, _bounds: data)


@app.get("/api/launches")
async def launches_endpoint(request: Request, region: str | None = None):
    # Placed at their pads (see backend/sources/launches.py), so this filters
    # like any other point source.
    return _cached_source_response(request, "launches", region, regions.filter_points)


@app.get("/api/cables")
async def cables_endpoint(request: Request):
    # Routes are lines and landing points are points, so this is served as one
    # payload the client splits -- same shape and the same hard cache as
    # /api/infrastructure, since neither changes more than a few times a year.
    # No region filter: a cable is a single object thousands of kilometres long
    # and clipping it to a bounding box would cut it in half.
    return _cached_source_response(request, "cables", None, lambda data, _bounds: data, max_age=86400)


@app.get("/api/railways")
async def railways_endpoint(request: Request):
    # Coarse Natural Earth line geometry, theatre-clipped and served whole (see
    # backend/sources/railways.py) -- same shape and hard cache as /api/cables,
    # and no region filter for the same reason: a rail line is one object the
    # client splits, not a set of points to clip. The station/yard/border POINTS
    # are a different thing entirely and ride /api/osm-infrastructure.
    return _cached_source_response(request, "railways", None, lambda data, _bounds: data, max_age=86400)


@app.get("/api/deflock")
async def deflock_endpoint(request: Request, region: str | None = None):
    # ALPR camera locations, worldwide (see backend/sources/deflock.py). 99.78%
    # United States and regions.py has no US theatre, so a region filter returns
    # nothing and this is really a World-view layer -- the filter is offered only
    # for consistency with the other point sources.
    return _cached_source_response(request, "deflock", region, regions.filter_points)


@app.get("/api/outages")
async def outages_endpoint(request: Request):
    # Country-keyed, not point data (see backend/sources/outages.py) -- no
    # region filter, same as /api/conflict-stats.
    return _cached_source_response(request, "outages", None, lambda data, _bounds: data)


@app.get("/api/dark-vessels")
async def dark_vessels_endpoint(request: Request, region: str | None = None):
    # Derived from this backend's own AIS history, not fetched from anywhere
    # (see backend/sources/dark_vessels.py). Every record is an inference and
    # says so; the layer renders them accordingly.
    return _cached_source_response(request, "dark_vessels", region, regions.filter_points)


@app.get("/api/gfw-gaps")
async def gfw_gaps_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    """AIS disabling events as Global Fishing Watch records them.

    The independent counterpart to /api/dark-vessels above, and the reason both
    exist: that layer is derived from one upstream, so when aisstream stops it
    goes quiet rather than red. This one has no such coupling. Global rather
    than clipped to the AIS watch boxes -- those bound a websocket subscription,
    not this -- and every record is GFW's claim rather than ours, carrying their
    dated attribution (see backend/sources/gfw_gaps.py).
    """
    return _cached_source_response(request, "gfw_gaps", region, regions.filter_points, bbox=bbox)


@app.get("/api/gfw-detections")
async def gfw_detections_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    """Radar and optical vessel detections as Global Fishing Watch publishes them.

    The only thing in this project's maritime stack entitled to say *detected*:
    an instrument measured a hull, whether or not anyone aboard wanted it
    measured (see backend/sources/gfw_detections.py). Whether that hull was
    also broadcasting AIS is a second and separate claim -- GFW's correlation,
    not a measurement -- and the layer keeps the two apart.

    Note what must not be read from an empty box here. The v3 API ships no
    coverage or footprint dataset, so every record carries
    `footprint_known: False` and this endpoint cannot distinguish water that
    was imaged and found empty from water that was never imaged. Absence is
    not evidence of absence at sea.
    """
    return _cached_source_response(request, "gfw_detections", region, regions.filter_points, bbox=bbox)


# Which payload fields travel with a track, per kind.
#
# Named rather than serving the whole payload: entity_history rows are the full
# source record, and a 900-point ADS-B track of complete payloads is about a
# megabyte of JSON to draw one line. These are the fields the line is actually
# drawn from -- altitude colours it, the rest answer "what was it doing here"
# when a reader hovers a segment.
TRACK_FIELDS = {
    "adsb": ("altitude", "velocity", "heading", "on_ground", "callsign"),
    "ais": ("speed", "course", "heading", "nav_status", "name"),
    "satellites": ("alt_km", "name"),
}


@app.get("/api/track/{kind}/{entity_id}")
async def track(kind: str, entity_id: str, points: int = 800):
    """One entity's recorded path over the retained history window.

    Deliberately not region-filtered and deliberately uncached: it is keyed by a
    single entity the reader has just clicked, so there is nothing to scope and
    no second caller to share a cache entry with.

    `kind` is checked against TRACK_FIELDS rather than passed through, which is
    what stops the URL naming an arbitrary table value -- gazetteer_places would
    otherwise be a perfectly valid 272,000-entity thing to ask about.
    """
    fields = TRACK_FIELDS.get(kind)
    if fields is None:
        raise HTTPException(status_code=404, detail=f"no track history is kept for '{kind}'")

    # The floor is the retention sweep's, not a preference: rows older than this
    # have been deleted (see storage's retention loop), so asking for more would
    # quietly return a track that starts wherever the sweep last ran.
    window_start = time.time() - config.HISTORY_RETENTION_SECONDS
    fixes = await storage.entity_track(
        kind, entity_id, window_start, max_points=points, fields=fields
    )
    return {
        "kind": kind,
        "entity_id": entity_id,
        "points": fixes,
        # Stated so the client can say "recorded since" rather than implying the
        # line is the whole flight. A track that begins at the window edge began
        # there because the older fixes were swept, not because the aircraft
        # took off there.
        "window_start": window_start,
        "retention_seconds": config.HISTORY_RETENTION_SECONDS,
        # entity_history only receives a row when an entity moved, so a track is
        # a record of movement. Worth saying once here rather than reasoning
        # about it again on the client.
        "truncated": len(fixes) >= min(points, storage.MAX_TRACK_POINTS),
    }


# What a port_calls row's `confidence` tier actually means, in the distance
# AIS gave no berth for. Read from backend/refine/port_call_thresholds.py --
# a leaf module with no other imports, split out of refine/port_calls.py
# specifically so this process could read these three numbers without also
# pulling in that module's ingest-side ProximityIndex/dark_vessels
# dependencies -- rather than duplicated as a second copy of the same
# floats, which a change to one and not the other would silently desync.
# vessel_port_calls itself stores only the tier, never the distance that
# produced it (see _classify in port_calls.py), so this is the one place
# that distance can still reach a card: sent with every response rather than
# hardcoded a third time in the frontend, so a reader sees the actual radius
# behind "exact"/"proximity"/"inferred" instead of just the word.
PORT_CALL_CONFIDENCE_KM = {
    "exact": port_call_thresholds.PORT_EXACT_RADIUS_KM,
    "proximity": port_call_thresholds.PORT_PROXIMITY_RADIUS_KM,
    "inferred": port_call_thresholds.PORT_SEARCH_RADIUS_KM,
}


def _curated_port_by_id() -> dict[str, dict]:
    """The curated harbours in backend/infrastructure.py, keyed by id -- the
    free half of the port-name lookup below, since these never touch
    Postgres. Mirrors the same filter backend/refine/vessel_profile.py's own
    _load_port_labels applies to the same list."""
    return {
        str(site.get("id") or site.get("name")): site
        for site in infrastructure.INFRA_SITES
        if site.get("type") == "port"
    }


async def _port_labels_for(port_ids: set[str]) -> dict[str, dict]:
    """port_id -> {"name", "country"} for a small, already-known set of ids.

    Same two sources vessel_profile.py's _load_port_labels combines (the
    curated list above, plus the World Port Index rows in entity_latest), but
    scoped to only the ids one card's rows actually name rather than every
    port this map knows. That module runs on a schedule and can afford
    entity_latest("ports") whole; this runs on a request path and reads one
    indexed row per still-unresolved id instead (storage.entity_latest_one).
    """
    if not port_ids:
        return {}
    curated = _curated_port_by_id()
    labels: dict[str, dict] = {}
    missing = []
    for port_id in port_ids:
        site = curated.get(port_id)
        if site:
            labels[port_id] = {"name": site.get("name") or port_id, "country": site.get("country")}
        else:
            missing.append(port_id)
    if missing:
        found = await asyncio.gather(*(storage.entity_latest_one("ports", pid) for pid in missing))
        for port_id, port in zip(missing, found):
            if port:
                labels[port_id] = {"name": port.get("name") or port_id, "country": port.get("country")}
    return labels


def _with_port_labels(rows: list[dict], labels: dict[str, dict]) -> list[dict]:
    out = []
    for row in rows:
        label = labels.get(str(row.get("port_id"))) or {}
        out.append({**row, "port_name": label.get("name"), "port_country": label.get("country")})
    return out


@app.get("/api/vessel/{mmsi}")
async def vessel_detail(mmsi: str):
    """One hull's identity, inferred cargo/laden profile and recent port calls.

    Per-entity route, following /api/track's shape above rather than
    _cached_source_response: no region filter, no ETag machinery, keyed by a
    single MMSI a reader just clicked, nothing for a second caller to share.

    Reads vessel_profiles (Task 16's refine/vessel_profile.py),
    vessel_port_calls (Task 15's refine/port_calls.py) and entity_latest --
    never entity_history. That table is read incrementally, on a schedule, by
    the two refine jobs above; a request path must never open it directly
    (see global-constraints.md), and nothing below does.
    """
    # storage.reference decodes the whole vessel_profiles document (one entry
    # per hull this map has ever profiled, capped at vessel_profile.HULL_CAP)
    # just to pick this one mmsi out of it -- the same whole-document read
    # entity_latest_one was added in this diff specifically to avoid for
    # entity_latest and ports. Left as-is because vessel_profiles has no
    # per-hull row to key a lookup against (see storage.record_reference: it
    # is one reference_snapshots document, not a table); a keyed table would
    # be real schema work, not a one-line fix, so this is a known scaling
    # edge rather than an oversight -- flagged in the task report.
    identity, profiles, port_calls, open_call = await asyncio.gather(
        storage.entity_latest_one("ais", mmsi),
        storage.reference("vessel_profiles"),
        storage.port_calls_for(mmsi, limit=10),
        storage.open_port_call(mmsi),
    )
    profile = profiles.get(mmsi) if isinstance(profiles, dict) else None
    if identity is None and profile is None and not port_calls and open_call is None:
        raise HTTPException(status_code=404, detail=f"no record for vessel '{mmsi}'")

    port_ids = {str(r["port_id"]) for r in port_calls if r.get("port_id")}
    if open_call and open_call.get("port_id"):
        port_ids.add(str(open_call["port_id"]))
    labels = await _port_labels_for(port_ids)

    return {
        "identity": identity,
        "profile": profile,
        "port_calls": _with_port_labels(port_calls, labels),
        "open_call": _with_port_labels([open_call], labels)[0] if open_call else None,
        "confidence_radius_km": PORT_CALL_CONFIDENCE_KM,
    }


@app.get("/api/vessel/port/{port_id}")
async def vessel_port_calls(port_id: str):
    """One port's recent traffic -- the port card's "recent arrivals and
    departures" section.

    A sibling of vessel_detail above rather than a query-param variant of it:
    the two live at the same prefix and read the same table
    (vessel_port_calls), but a port_id and an MMSI are different id spaces,
    and folding them into one path/shape would make the route's own URL say
    nothing about which one it expects. Kept in this module (not /api/ports)
    because it is one more read of the port-call table Task 15's
    refine/port_calls.py and storage.port_calls_at already define, not a new
    concern of the World Port Index endpoint's own.
    """
    port_calls = await storage.port_calls_at(port_id, limit=10)
    mmsis = {str(r["mmsi"]) for r in port_calls if r.get("mmsi")}
    identities = await asyncio.gather(*(storage.entity_latest_one("ais", mmsi) for mmsi in mmsis))
    names = {mmsi: (identity or {}).get("name") for mmsi, identity in zip(mmsis, identities)}
    return {
        "port_id": port_id,
        "port_calls": [
            {**row, "vessel_name": names.get(str(row.get("mmsi")))} for row in port_calls
        ],
        "confidence_radius_km": PORT_CALL_CONFIDENCE_KM,
    }


def _lane_course_deg(mean_sin: float, mean_cos: float) -> float | None:
    """atan2 over the stored unit-vector sum -- see the schema comment on
    lane_cells in backend/storage.py for why the table keeps mean_sin/mean_cos
    rather than a mean bearing column. Both exactly zero means this cell has
    no net directional evidence at all (every position in it either never
    reported a usable course or the courses it did report cancelled out), so
    None is returned rather than an arbitrary 0deg claiming due north."""
    if mean_sin == 0.0 and mean_cos == 0.0:
        return None
    return math.degrees(math.atan2(mean_sin, mean_cos)) % 360.0


@app.get("/api/lanes")
async def lanes_endpoint(bbox: str | None = None, min_transits: int = 1):
    """The AIS traffic grid: where this map's own AIS coverage has actually
    seen ships. Never a claim about where shipping lanes run in general --
    see backend/refine/lane_density.py's module docstring, and `note` below,
    which repeats that module's own NOTE constant verbatim so the wording
    served here can't quietly drift from the one explaining the job that
    built it.

    Reads storage.lane_cells only -- never entity_history, the 11 GB raw
    movement log the grid is derived from on a schedule (see global
    constraints: that table is never read on a request path). No ETag/version
    machinery: lane_cells changes at most once an hour
    (config.LANE_DENSITY_INTERVAL) and bbox/min_transits both vary per client,
    so there is nothing here for _cached_source_response's per-source version
    counter to usefully key off -- the same reasoning /api/replay's per-request
    `at` already gets.

    `min_transits` keeps storage.lane_cells's own parameter name -- it filters
    the stored `transits` column -- but each returned cell renames that same
    number to `sightings` (Task 19 review): a hull sitting in one cell for a
    month adds to it on every sweep that finds the hull still there, the same
    as a cell that saw that many different hulls pass through once each, so
    "transits" would claim a precision -- distinct ships -- this number does
    not have. See the column's own comment on lane_cells in backend/storage.py.
    """
    bounds = regions.parse_bbox(bbox)
    cells = await storage.lane_cells(bounds, min_transits=max(1, min_transits))
    return JSONResponse(
        {
            "note": lane_density.NOTE,
            "cells": [
                {
                    **{k: v for k, v in cell.items() if k != "transits"},
                    "sightings": cell["transits"],
                    "course_deg": _lane_course_deg(cell["mean_sin"], cell["mean_cos"]),
                }
                for cell in cells
            ],
        },
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/hazards")
async def hazards_endpoint(request: Request, region: str | None = None):
    # Earthquakes (USGS, ~5min) and volcanic activity (Smithsonian GVP, weekly)
    # in one feed, each record carrying its own `kind` and publisher -- see
    # backend/sources/hazards.py for why they share a layer but never a label.
    return _cached_source_response(request, "hazards", region, regions.filter_points)


@app.get("/api/floods")
async def floods_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    # GDACS flood alerts (see backend/sources/floods.py). A separate layer from
    # /api/hazards rather than a third kind inside it: these points are modelled
    # basin centroids, not the measured positions that module's docstring
    # promises, and an event stays open for weeks where a quake is instantaneous.
    return _cached_source_response(request, "floods", region, regions.filter_points, bbox=bbox)


@app.get("/api/dams")
async def dams_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    # Global Dam Watch barriers, clipped to the conflict theatres (see
    # backend/sources/dams.py). Filters like any other point source, but note
    # 81% of these coordinates are snapped to a river network rather than
    # published for the structure -- every record says which, via coord_source.
    return _cached_source_response(request, "dams", region, regions.filter_points, bbox=bbox)


@app.get("/api/ports")
async def ports_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    # NGA World Port Index, clipped to the theatres and the AIS watch boxes (see
    # backend/sources/ports.py). Also read by dark_vessels.py, which excludes
    # ship-to-ship candidates near a port -- that consumer reads Postgres
    # directly rather than this endpoint.
    return _cached_source_response(request, "ports", region, regions.filter_points, bbox=bbox)


@app.get("/api/czib")
async def czib_endpoint(request: Request, region: str | None = None):
    # EASA conflict zone bulletins -- which airspace a regulator is telling
    # airlines to avoid (see backend/sources/czib.py). Placed at country
    # precision on purpose: a bulletin is about a national airspace, and EASA's
    # own coordinates field geocodes the country *name* (Afghanistan's is
    # Kabul), so it is deliberately not read.
    return _cached_source_response(request, "czib", region, regions.filter_points)


@app.get("/api/satellites")
async def satellites(region: str | None = None):
    # Position is propagated fresh every poll (see backend/sources/
    # satellites.py) and changes continuously regardless of the underlying
    # orbital elements' own refresh cadence -- same reasoning /api/wind and
    # /api/replay already use for opting out of the version/ETag cache.
    state = registry.get("satellites")
    payload = regions.filter_points(state.data, regions.bounds_for(region))
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


def _satellite_elements_filter(layer_keys: set[str]):
    # A closure rather than a top-level function so _cached_source_response's
    # filter_fn(items, bounds) signature doesn't have to grow a third
    # argument just for this one caller -- same shape _ships_callsign_filter
    # above already uses. `bounds` is accepted and ignored: element sets
    # carry no lat/lon (see backend/sources/satellites.py's module docstring
    # on why positions are never stored), so there is nothing here for
    # regions.filter_points to do.
    def _filter(items: list[dict], bounds) -> list[dict]:
        return satellites_source.filter_elements_by_layer(items, layer_keys)
    return _filter


@app.get("/api/satellites/elements")
async def satellite_elements(request: Request, groups: str | None = None):
    """Stored OMM element sets for the client-propagated satellite layers
    (backend/sources/satellites.py's ELEMENT_LAYER_GROUPS) -- SGP4 runs in
    the browser via satellite.js (frontend/src/map/satPropagate.js), not
    here. See /api/satellites above for the two small groups this server
    still propagates itself, every ten seconds, exactly as before this
    endpoint existed.

    `groups` is a comma-separated list of *layer* keys (navigation, weather,
    imaging, science, geo, starlink, oneweb) -- the control panel's toggles,
    not CelesTrak's own group names, since one toggle can span more than one
    CelesTrak group and a reader turning on "navigation" should get
    gps-ops+galileo+glo-ops+beidou in one request, not four. Missing or
    empty answers empty, not "every group": a reader who has not asked for
    anything should not pull every stored element set (starlink and oneweb
    alone run to several thousand) just by omitting the parameter.
    """
    wanted = {g.strip() for g in (groups or "").split(",") if g.strip()}
    return _cached_source_response(
        request, "satellite_elements", None, _satellite_elements_filter(wanted),
        variant=f"groups:{','.join(sorted(wanted)) or '-'}",
    )


@app.get("/api/satellites/passes")
async def satellite_passes(lat: float, lon: float, hours: float = sat_passes.MAX_PASS_HOURS, groups: str | None = None):
    """Task 25's overpass prediction: the next passes of the requested
    satellite groups over (lat, lon), for a country, water body or point the
    reader currently has selected.

    Not cached through _cached_source_response like the sources above --
    this is a per-request computation over a caller-supplied lat/lon/hours,
    not a narrowing of one shared payload, the same reason /api/track/{kind}/
    {id} skips that machinery too. `groups` takes the same layer-key
    vocabulary as /api/satellites/elements above (navigation, weather,
    imaging, ...), not CelesTrak's own group names, and an empty or missing
    value answers "no satellites in scope" rather than "every group", for
    the identical reason that endpoint's own `groups` does.

    `hours` is silently clamped to sat_passes.MAX_PASS_HOURS (24, the
    brief's own window) rather than rejected -- a caller asking for more is
    narrowed, not errored, matching filter_elements_by_layer's own "narrow,
    don't error" contract for an unrecognised group name. See
    backend/sources/sat_passes.py's module docstring for the other cap (how
    many satellites a single request will actually run a real pass search
    for) and the benchmark behind its number.

    Every pass is derived, not observed: arithmetic (SGP4 plus a horizon
    search) over an orbital element set someone else reported, and it
    carries that element set's own `epoch` so the card can say how old the
    orbit behind the prediction is -- the same honesty point Task 25's card
    makes about the ground track and footprint.

    compute_passes is CPU-bound (a real SGP4 pass search per satellite, see
    that function's own docstring), and this app runs single-process,
    single-event-loop (no `workers=`, see uvicorn.run below). Called
    directly inside this `async def`, it would stall that one loop -- and
    with it every other client's AIS/ADS-B polling -- for however long the
    search itself takes, which review measured at ~0.68s for a full
    200-satellite cap. `asyncio.to_thread` moves the computation off the
    loop, the same fix admin_config_put above already applies to its own
    (much smaller) blocking call.
    """
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        raise HTTPException(status_code=400, detail="lat/lon out of range")
    wanted = {g.strip() for g in (groups or "").split(",") if g.strip()}
    elements = satellites_source.filter_elements_by_layer(registry.get("satellite_elements").data, wanted)
    result = await asyncio.to_thread(sat_passes.compute_passes, elements, lat, lon, hours)
    return JSONResponse(
        {"lat": lat, "lon": lon, "groups": sorted(wanted), **result},
        headers={"Cache-Control": "no-store"},
    )


def _matches_callsign_query(value, query: str) -> bool:
    """Case-insensitive, `*`-as-wildcard, implicit-prefix match on a callsign.

    The same rule frontend/src/utils/entityFilter.js's matchQuery applies to
    the client-side vessel filter, kept in step by hand (there is no shared
    module between a Python process and a browser bundle) rather than by
    import -- see `callsign` on the /api/ships endpoint below for which of
    the two filters is authoritative and why keeping this one narrow to
    *only* callsign, rather than growing it to match the client's callsign/
    name/mmsi/imo, is deliberate.

    An empty query matches everything, including a ship with no callsign at
    all -- checked before the value is, so the two clauses agree with
    matchQuery's own "no query is not a query about this field" rule instead
    of just happening to coincide with it. The route above only ever calls
    this when `callsign` is truthy, so this ordering is currently unreachable
    from the one caller this module has, not a live bug -- it is here so a
    future caller (or a test) reading this function in isolation gets the
    same answer matchQuery would, rather than one that only matches it by
    accident of how the route happens to guard the call.
    """
    haystack = str(value).strip().upper() if value else ""
    needle = query.strip().upper()
    if not needle:
        return True
    if not haystack:
        return False
    if "*" not in needle:
        return haystack.startswith(needle)
    pattern = "^" + re.escape(needle).replace(r"\*", ".*") + "$"
    return re.match(pattern, haystack) is not None


def _ships_callsign_filter(query: str):
    # A closure rather than a top-level function so _cached_source_response's
    # filter_fn(items, bounds) signature doesn't have to grow a third
    # argument just for this one caller -- same shape _gdelt_filter and
    # _aircraft_priority_filter above already use for a fixed predicate.
    def _filter(items: list[dict], bounds) -> list[dict]:
        matched = [d for d in items if _matches_callsign_query(d.get("callsign"), query)]
        return regions.filter_points(matched, bounds)
    return _filter


@app.get("/api/ships")
async def ships(request: Request, region: str | None = None, callsign: str | None = None):
    # AIS is a live websocket stream snapshotted every few seconds (see
    # backend/sources/ais.py) -- ETag/304 still saves the body bytes, `no-cache`
    # (see _cached_source_response) just means every poll actually asks.
    #
    # `callsign` is an *independent* narrowing, not a second copy of the
    # client-side vessel filter (frontend/src/utils/entityFilter.js), and the
    # two are not meant to be composed. This map's own poller
    # (useOsintData.js's POLL_CONFIG entry for "ais") never sends it -- the
    # client-side filter is what decides what a reader sees and what the
    # filter bar's own "N / total" count reads, and it matches four fields
    # (callsign, name, mmsi, imo) this parameter deliberately does not try to
    # widen to match. Composing the two would risk exactly the bug Task 12
    # spent two review rounds on for the conflict-event filters: a client
    # holding the *full* feed while believing it holds a server-narrowed one
    # (or vice versa) would show a match count measured against the wrong
    # total. This parameter exists for a caller that wants the server to do
    # the narrowing before the payload leaves it -- fetching the global feed
    # from outside this map's own client, where four-field client-side
    # filtering over the whole thing isn't an option in the first place.
    if callsign:
        return _cached_source_response(
            request, "ais", region, _ships_callsign_filter(callsign),
            variant=f"callsign:{callsign.strip().upper()}",
        )
    return _cached_source_response(request, "ais", region, regions.filter_points)


@app.get("/api/ais-digitraffic")
async def ais_digitraffic(request: Request, region: str | None = None):
    # Live AIS from Fintraffic/Digitraffic, Finnish and Baltic waters (see
    # backend/sources/digitraffic_ais.py). A separate layer from /api/ships
    # (aisstream) because they are different networks: every record here carries
    # source="digitraffic" and its own kind, so the two never share a (kind,
    # mmsi) key and neither can silently overwrite the other.
    return _cached_source_response(request, "ais_digitraffic", region, regions.filter_points)


@app.get("/api/rail-live")
async def rail_live(request: Request, region: str | None = None):
    # Live Finnish train positions (see backend/sources/digitraffic_rail.py).
    # Identity is the synthetic departureDate:trainNumber, since trainNumber is
    # reused daily; all in Finland, so the region filter is offered only for
    # consistency with the other point sources.
    return _cached_source_response(request, "rail_live", region, regions.filter_points)


@app.get("/api/rail-stations")
async def rail_stations(request: Request):
    # Finnish railway stations as static reference metadata (see
    # backend/sources/digitraffic_rail.py) -- stored as a whole document, not
    # per-row entity rows, and served whole for the client to place. No region
    # filter (a station gazetteer is reference data, not a scoped point layer),
    # and a longer cache since it refreshes only every few hours.
    return _cached_source_response(request, "rail_stations", None, lambda data, _bounds: data, max_age=3600)


@app.get("/api/weathercams")
async def weathercams(request: Request, region: str | None = None):
    # Finnish road weather-camera LOCATIONS only (see
    # backend/sources/digitraffic_weathercams.py) -- pins plus the public preset
    # image URLs, never the imagery itself. A DeFlock-shaped location layer; all
    # in Finland, so this is really a World-view layer.
    return _cached_source_response(request, "weathercams", region, regions.filter_points)


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


# Which aircraft a reader who cannot draw ordinary traffic still needs.
#
# Deliberately a superset of what the map draws below its civilian gate, and
# deliberately built from stored fields rather than re-deriving anything: the
# frontend classifies an aircraft as military from `military` or
# `callsign_military`, and puts it in the always-on flagged bucket for an
# emergency or an OFAC designation. Every one of those is checked here, plus
# two the client does not use directly (`hex_military`, `military_role`), which
# can only ever keep an extra aircraft.
#
# `display_limited` is the one status not here, and that is the whole point:
# a LADD or PIA listing is a fact about a registry entry, the map gates it at
# the same zoom as ordinary traffic, and it is ~640 of the ~17,000 aircraft in
# the feed -- the single largest group a zoomed-out reader is sent and cannot
# see. Getting this predicate wrong in the other direction is the dangerous
# case: an aircraft dropped here is simply absent from the map, with no error
# and no empty layer to notice.
def _aircraft_priority(item: dict) -> bool:
    return bool(
        item.get("military")
        or item.get("callsign_military")
        or item.get("hex_military")
        or item.get("military_role")
        or item.get("emergency")
        or item.get("emergency_squawk")
        or item.get("sanctions")
    )


def _aircraft_priority_filter(items: list[dict], bounds) -> list[dict]:
    return regions.filter_points([d for d in items if _aircraft_priority(d)], bounds)


@app.get("/api/aircraft")
async def aircraft(request: Request, region: str | None = None, civilian: str | None = None):
    # The largest payload this API serves -- ~17,000 aircraft, ~6.6 MB -- and
    # the one a zoomed-out reader has least use for: below zoom 9 the map draws
    # only military, emergency and designated aircraft, a few hundred of them.
    # `civilian=0` asks for that slice.
    #
    # An opt-out rather than an opt-in, so a caller that knows nothing about the
    # parameter (curl, an old cached bundle, anything that is not our client)
    # keeps getting the whole feed. Typed as a string and compared to exactly
    # "0" rather than declared an int, for the same reason parse_bbox refuses a
    # malformed box instead of erroring on it: this is a browser query parameter
    # and a typo in one must cost a larger correct answer, never a 422 and never
    # a layer that silently loses its aircraft.
    if civilian != "0":
        return _cached_source_response(request, "adsb", region, regions.filter_points)
    return _cached_source_response(
        request, "adsb", region, _aircraft_priority_filter, variant="nocivil"
    )


@app.get("/api/aircraft/{icao24}")
async def aircraft_detail(icao24: str):
    """One airframe's identity and its recent flight legs (Task 23).

    Per-entity route, following /api/vessel/{mmsi}'s shape (Task 17) rather
    than _cached_source_response: no region filter, no ETag machinery, keyed
    by a single icao24 a reader just clicked, nothing for a second caller to
    share.

    Reads flight_legs (backend/refine/flight_legs.py, via flight_legs_for /
    open_flight_leg) and entity_latest -- never entity_history. That table is
    read incrementally, on a schedule, by the refine job above; a request
    path must never open it directly (see global-constraints.md), and
    nothing below does.
    """
    identity, legs, current_leg = await asyncio.gather(
        storage.entity_latest_one("adsb", icao24),
        storage.flight_legs_for(icao24, limit=20),
        storage.open_flight_leg(icao24),
    )
    if identity is None and not legs and current_leg is None:
        raise HTTPException(status_code=404, detail=f"no record for aircraft '{icao24}'")

    # Route context for the cargo hint below: the leg still in progress, if
    # there is one, otherwise the most recently completed leg -- `legs` is
    # already newest-departure-first (see flight_legs_for), so index 0 is it.
    route = current_leg or (legs[0] if legs else {})
    identity_fields = identity or {}
    cargo_hint = flight_legs.aircraft_cargo_hint(
        identity_fields.get("type_code"),
        identity_fields.get("type_desc"),
        identity_fields.get("operator"),
        route.get("origin_code"),
        route.get("dest_code"),
    )

    return {
        "identity": identity,
        "legs": legs,
        "current_leg": current_leg,
        "cargo_hint": cargo_hint,
    }


@app.get("/api/countries")
async def countries(request: Request, region: str | None = None):
    # Refreshed server-side once/day (see backend/sources/countries.py) --
    # capped well under that so a dev-server restart's fresh data doesn't
    # sit invisible to an already-open tab for a full day.
    return _cached_source_response(request, "countries", region, regions.filter_geojson, max_age=3600)


@app.get("/api/cities")
async def cities(request: Request, region: str | None = None, bbox: str | None = None):
    return _cached_source_response(request, "cities", region, regions.filter_points, max_age=3600, bbox=bbox)


@app.get("/api/airports")
async def airports_endpoint(request: Request, region: str | None = None, bbox: str | None = None):
    # Reference data on the same footing as cities: it refreshes once a day, so
    # a client may sit on a cached copy for an hour rather than revalidating on
    # every poll. Only the served slice is here -- the wider index ADS-B popups
    # query never leaves the backend (see backend/sources/airports.py).
    return _cached_source_response(request, "airports", region, regions.filter_points, max_age=3600, bbox=bbox)


# The ranking is computed by the refine process now, so this is a read of one
# stored document rather than a week of conflict_events aggregated across every
# region. The TTL stays anyway: the document only changes when the refine
# process writes it (minutes apart), and a cache here keeps a frontend polling
# on a timer from hitting the database for an answer it already has.
_ESCALATION_CACHE = LruTtlCache(maxsize=1, ttl=120)
metrics.track_local_cache("escalation", _ESCALATION_CACHE)


@app.get("/api/escalation")
async def escalation_endpoint():
    """Regions currently running above their own recent baseline.

    Returns an empty list -- not an error -- when there's no database or the
    refine process has not written a ranking yet. "Nothing to report" and "we
    can't tell yet" both correctly render as a hidden panel rather than a claim.
    """
    cached = _ESCALATION_CACHE.get("all")
    if cached is None:
        cached = await storage.reference(escalation.REFERENCE_NAME) or []
        _ESCALATION_CACHE.set("all", cached)
    return JSONResponse(cached, headers={"Cache-Control": "no-store"})


# Same shape and the same reasoning as the escalation cache above: one stored
# document written by the refine process every half hour, read by a frontend on
# its own timer. The TTL is what stops those two cadences multiplying into a
# database read per client per poll.
_AIRFIELD_ACTIVITY_CACHE = LruTtlCache(maxsize=1, ttl=300)
metrics.track_local_cache("airfield_activity", _AIRFIELD_ACTIVITY_CACHE)


@app.get("/api/airfield-activity")
async def airfield_activity_endpoint():
    """Recent traffic per airfield, derived from our own ADS-B history.

    Keyed by the airfield code the airports layer already carries (see
    backend/sources/airfield_activity.py), so this attaches to existing pins
    rather than being a layer of its own.

    An empty object -- not an error -- when there is no database or the refine
    process has not written a pass yet. "No movements recorded" and "not
    computed yet" both correctly render as an unadorned airfield pin.
    """
    cached = _AIRFIELD_ACTIVITY_CACHE.get("all")
    if cached is None:
        cached = await storage.reference(airfield_activity.SNAPSHOT_NAME) or {}
        _AIRFIELD_ACTIVITY_CACHE.set("all", cached)
    return JSONResponse(cached, headers={"Cache-Control": "no-store"})


async def _replay_source(kind, registry_key, ts_fn, at, bounds, window_seconds=None):
    """One replayed layer: the live payload time-filtered to `at`, falling back
    to what the database recorded by then once `at` predates the live window.

    That order matters. The live payload is exactly what the map draws now, so
    filtering it keeps recent replay identical to live. But FIRMS fetches one
    day and GDELT one day, so past that the filter can only ever return
    nothing -- which is why the fire and news layers used to sit empty across
    the whole older half of the scrubber however much history was stored.
    Storage answers a slightly different question (what we had *recorded* by
    then, not what one upstream fetch held), so it is the fallback rather than
    the primary, and it gets time-filtered too.
    """
    items = replay.filter_up_to(registry.get(registry_key).data, ts_fn, at)
    if not items:
        stored = await storage.history_at(kind, at, window_seconds=window_seconds)
        items = replay.filter_up_to(stored, ts_fn, at)
    return regions.filter_points(items, bounds)


async def _replay_positions(kind, buffer, at, bounds):
    """Ships/aircraft for one moment: what was recorded around it, falling back
    to the live payload only when `at` is inside the window a fix stays good
    for and nothing was recorded across it.

    That fallback is what keeps the live edge of the scrubber agreeing with the
    live map. Both feeds keep serving their last successful fetch while the
    upstream is failing -- OpenSky answering 429 for an hour doesn't clear the
    aircraft layer -- so without it, scrubbing to *now* during an outage
    emptied a map that was drawing several thousand aircraft a second earlier.
    Bounded by the same window, so it can only ever stand in for a gap we
    would still call current, never paper over a stretch of missing history.
    """
    items = await buffer.at(at)
    if not items and time.time() - at <= config.REPLAY_WINDOW_SECONDS.get(kind, 0):
        items = registry.get(kind).data
    return regions.filter_points(items, bounds)


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

    # Fires and news reach back past their own live windows via storage --
    # see _replay_source. FIRMS is read over a narrower window than its rows
    # are kept for: NASA's NRT file is nominally a day (day_range=1) but is
    # continuously pruned, so what it actually holds at any moment is about
    # six hours of detections -- measured against this database, a 6h read
    # returns ~7.5k points where the live layer holds ~7.6k, and a 24h read
    # returns ~99k. Matching the window is what keeps replayed fire density
    # the same as live instead of an order of magnitude heavier.
    firms = await _replay_source("firms", "firms", replay.firms_ts, at, bounds, window_seconds=6 * 3600)
    gdelt = await _replay_source("gdelt", "gdelt", replay.gdelt_ts, at, bounds)

    payload = {
        "at": at,
        "events": events,
        "firms": firms,
        "gdelt": gdelt,
        "ais": await _replay_positions("ais", history.SHIP_HISTORY, at, bounds),
        "adsb": await _replay_positions("adsb", history.AIRCRAFT_HISTORY, at, bounds),
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
metrics.track_local_cache("wind", _WIND_CACHE)
_wind_version = 0  # bumped only on an actual re-fetch, same idea as SourceState.version

# Guards Open-Meteo's daily quota. Only cache *misses* draw a token, since a
# hit costs the upstream nothing -- so this bounds the sustained outbound
# rate while leaving normal browsing (which is nearly all cache hits, thanks
# to the 4-degree snap above) completely unaffected. Burst of 30 covers a
# first load panning across fresh grid squares; 1/s sustained is far more
# than a human map session generates and far less than the daily cap.
_WIND_UPSTREAM_LIMIT = TokenBucket(capacity=30, refill_per_second=1.0)
metrics.track_token_bucket("wind", _WIND_UPSTREAM_LIMIT)

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
    if cached is not None:
        metrics.upstream_requests.labels(upstream="open_meteo_wind", result="hit").inc()
    if cached is None:
        if not _WIND_UPSTREAM_LIMIT.take():
            metrics.upstream_requests.labels(upstream="open_meteo_wind", result="rate_limited").inc()
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
            metrics.upstream_requests.labels(upstream="open_meteo_wind", result="error").inc()
            raise HTTPException(502, f"Wind data fetch failed: {reason}")
        metrics.upstream_requests.labels(upstream="open_meteo_wind", result="success").inc()
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
metrics.track_local_cache("weather_tile", _TILE_CACHE)

# Same reasoning as the wind limiter above, sized for tiles: one screenful is
# roughly 10-20 tiles, so a 200-token burst absorbs several pans over unseen
# area, and 20/s sustained keeps a scripted crawl of the tile pyramid from
# quietly draining the OWM quota. Only misses draw tokens.
_TILE_UPSTREAM_LIMIT = TokenBucket(capacity=200, refill_per_second=20.0)
metrics.track_token_bucket("weather_tile", _TILE_UPSTREAM_LIMIT)

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
    if cached is not None:
        metrics.upstream_requests.labels(upstream="owm_tile", result="hit").inc()
    if cached is None:
        if not _TILE_UPSTREAM_LIMIT.take():
            metrics.upstream_requests.labels(upstream="owm_tile", result="rate_limited").inc()
            raise HTTPException(503, "Weather tile rate limit reached", headers={"Retry-After": "2"})

        url = f"https://tile.openweathermap.org/map/{layer}/{z}/{x}/{y}.png"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(url, params={"appid": config.OWM_API_KEY})
                resp.raise_for_status()
        except Exception:
            # Counted, then re-raised unchanged: this endpoint deliberately has
            # no negative cache (unlike wind above), and adding error handling
            # here beyond the counter would change that behaviour.
            metrics.upstream_requests.labels(upstream="owm_tile", result="error").inc()
            raise
        metrics.upstream_requests.labels(upstream="owm_tile", result="success").inc()
        etag = hashlib.sha256(resp.content).hexdigest()[:16]
        cached = (resp.content, etag)
        _TILE_CACHE.set(cache_key, cached)

    content, etag = cached
    etag_header = f'"{etag}"'
    headers = {"Cache-Control": f"public, max-age={_TILE_CACHE_TTL}", "ETag": etag_header}
    if request.headers.get("if-none-match") == etag_header:
        return Response(status_code=304, headers=headers)
    return Response(content=content, media_type="image/png", headers=headers)


# Serving the built frontend is optional. Under compose (see
# docker-compose.yml) the React app is its own nginx container that proxies
# /api here, so this image has no frontend/dist at all and must run as a
# pure API -- what used to be a hard RuntimeError at import time. Kept for the
# case where someone has run `npm run build` and wants one process to serve
# both, which is how a local `python -m backend.app` behaves.
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
