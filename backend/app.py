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

from backend import (
    admin_config, cachestore, config, escalation, history, infrastructure, ingest, mirror, refine,
    regions, replay, storage,
)
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
    "jamming", "satellites", "hazards", "airports", "sanctions",
    "cables", "outages", "launches",
    "hdx_conflict_stats", "hapi_conflict", "humanitarian", "official_feeds", "officials",
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


@app.get("/api/osm-infrastructure")
async def osm_infrastructure_endpoint(request: Request, region: str | None = None):
    # Crowd-sourced, and served on its own endpoint rather than merged into
    # /api/infrastructure for exactly that reason -- see the module docstring in
    # backend/sources/osm_infra.py.
    return _cached_source_response(request, "osm_infra", region, regions.filter_points, max_age=3600)


@app.get("/api/humanitarian")
async def humanitarian_endpoint(request: Request):
    # Country-keyed aggregates over reference periods of months (see
    # backend/sources/humanitarian.py) -- read by the country card, never drawn
    # as points, so there is nothing for a region filter to narrow.
    return _cached_source_response(request, "humanitarian", None, lambda data, _bounds: data)


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


@app.get("/api/hazards")
async def hazards_endpoint(request: Request, region: str | None = None):
    # Earthquakes (USGS, ~5min) and volcanic activity (Smithsonian GVP, weekly)
    # in one feed, each record carrying its own `kind` and publisher -- see
    # backend/sources/hazards.py for why they share a layer but never a label.
    return _cached_source_response(request, "hazards", region, regions.filter_points)


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


@app.get("/api/airports")
async def airports_endpoint(request: Request, region: str | None = None):
    # Reference data on the same footing as cities: it refreshes once a day, so
    # a client may sit on a cached copy for an hour rather than revalidating on
    # every poll. Only the served slice is here -- the wider index ADS-B popups
    # query never leaves the backend (see backend/sources/airports.py).
    return _cached_source_response(request, "airports", region, regions.filter_points, max_age=3600)


# The ranking is computed by the refine process now, so this is a read of one
# stored document rather than a week of conflict_events aggregated across every
# region. The TTL stays anyway: the document only changes when the refine
# process writes it (minutes apart), and a cache here keeps a frontend polling
# on a timer from hitting the database for an answer it already has.
_ESCALATION_CACHE = LruTtlCache(maxsize=1, ttl=120)


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
