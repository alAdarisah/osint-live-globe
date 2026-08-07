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
GFW_API_TOKEN = os.getenv("GFW_API_TOKEN", "").strip()

# Poll intervals, in seconds. Tuned to each source's data freshness and rate limits.
FIRMS_POLL_INTERVAL = int(os.getenv("FIRMS_POLL_INTERVAL", "900"))       # FIRMS updates a few times/day
GDELT_POLL_INTERVAL = int(os.getenv("GDELT_POLL_INTERVAL", "900"))        # GDELT updates every 15 min
ADSB_POLL_INTERVAL_ANON = int(os.getenv("ADSB_POLL_INTERVAL_ANON", "900"))    # 100 calls/day anonymous limit
# OpenSky charges credits, not calls, and a global states/all is its dearest
# request at 4 of them -- so the 4000/day budget is really 1000 polls, and the
# old 60s interval asked for 1440. It ran dry every afternoon and answered 429
# until the next reset. 120s fits inside the budget with room for restarts.
ADSB_POLL_INTERVAL_AUTH = int(os.getenv("ADSB_POLL_INTERVAL_AUTH", "120"))
ACLED_POLL_INTERVAL = int(os.getenv("ACLED_POLL_INTERVAL", "1800"))
UCDP_POLL_INTERVAL = int(os.getenv("UCDP_POLL_INTERVAL", "21600"))  # UCDP's candidate file only updates monthly
# Cross-border electricity exchange from Energy-Charts (see
# backend/sources/energy_flows.py). Hourly, and there is nothing to gain from
# faster: the physical-flow half advances in 15-minute steps and lags wall clock
# by several hours -- that is ENTSO-E's own publication delay, not the API's --
# so a tighter interval re-fetches a window that has not moved. Each sweep is 76
# paced requests (38 countries x 2 endpoints) because `country=all` answers 404.
ENERGY_FLOWS_POLL_INTERVAL = int(os.getenv("ENERGY_FLOWS_POLL_INTERVAL", "3600"))
# Global Fishing Watch satellite vessel detections (see
# backend/sources/gfw_detections.py). Six hours is already generous against the
# product: GFW serves these tiles with Cache-Control: max-age=86400, and the
# optical batch was four days behind wall clock when this was measured, so a
# tighter interval re-downloads a window that has not moved. Quota is not the
# constraint -- a 46-request sweep four times a day is 0.5% of the 50,000/day
# the response headers report -- payload is, at roughly 5-8 MB per optical sweep.
GFW_POLL_INTERVAL = int(os.getenv("GFW_POLL_INTERVAL", str(6 * 3600)))

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
    # Derived from the AIS movement log, so it can only ever be as old as the
    # window that log keeps -- matching HISTORY_RETENTION_SECONDS means a
    # finding is evicted exactly when the evidence behind it is.
    "dark_vessels": 3 * 86400,
    # Satellite detections are the one kind here where every row is a distinct
    # immutable entity -- a poll cannot update a detection, only add another --
    # so this table would grow forever without an eviction that bites. The real
    # retention control is the source's own 7-day request window: every sweep
    # re-upserts every detection still inside it, so a row only starts ageing
    # once it leaves. Two days is what governs after that, and it is the trailing
    # edge of two things -- a detection that has aged out of the window, and an
    # ingest container that has stopped. Short on purpose for the second case:
    # the failure this layer risks is a weeks-old radar return rendering like a
    # live position, so an empty layer is the safer way to be wrong.
    "gfw_detections": 2 * 86400,
    # Earthquakes drop out of USGS's own 1-day feed after 24h, but the weekly
    # volcano report in the same payload stays current for a full week -- the
    # longer of the two governs, or every volcano pin would be evicted six days
    # before its report is superseded.
    "hazards": 8 * 86400,
    "acled": 7 * 86400,
    # UCDP's reviewed record, which lags a month or more by design. It was
    # falling through to the 1-day default, which happened to be harmless only
    # because it is re-fetched every poll: pause collection for a day -- an
    # ingest container down over a weekend, an ACLED outage -- and a verified
    # archive would evict itself for want of a refresh it does not conceptually
    # need. 30 days, like the other slow-moving reference data below.
    "conflict_history": 30 * 86400,
    "events": 7 * 86400,
    "cities": 30 * 86400,
    # Same family and same cadence as cities: GeoNames reference data, refetched
    # daily, and the rows are places that by definition do not move. A short
    # window would evict the whole placement index between downloads.
    "gazetteer_places": 30 * 86400,
    # Same reasoning as cities: reference data the backend only refetches once a
    # day, so a 30-minute window would evict it continuously.
    "airports": 30 * 86400,
    "cable_landings": 30 * 86400,
    # Long enough to outlive the "previous launches" window this source serves,
    # which runs weeks back when launches are sparse.
    "launches": 30 * 86400,
    # Swept once a day and only when Overpass cooperates, so a short window
    # would evict theatres between successful sweeps.
    "osm_infra": 30 * 86400,
    # A GDACS event stays open for weeks and is revised across dozens of
    # episodes, so the window has to outlive the event rather than the poll.
    # The 30-minute poll rewrites every row it still sees, which means this
    # only governs two cases: a flood that has dropped off the feed, and a
    # poller that is down. The 1-day default was wrong for the second -- pause
    # collection for a day and the layer evicts itself whole.
    "floods": 14 * 86400,
    # Refetched weekly at most, and then only when figshare says the file
    # changed -- which it has not since 2024-08-28. Same reasoning as airports
    # and cable_landings: reference data about structures that do not move, so
    # the window has to clear the refresh interval by a wide margin.
    "dams": 30 * 86400,
    # Ports do not move and the file is refetched twice a day at most. Same
    # reasoning as airports and cable_landings.
    "ports": 30 * 86400,
    # A conflict-zone bulletin runs for years -- the Ukraine one has been open
    # since 2022 and is valid until 2027 -- and EASA revises rather than
    # reissues. The window has to outlive the poll, not the bulletin.
    "czib": 7 * 86400,
}
ENTITY_STALE_AFTER_DEFAULT = int(os.getenv("ENTITY_STALE_AFTER_DEFAULT", "86400"))

# How stale a recorded fix may be and still count as "where this thing was"
# when the replay scrubber asks for a moment (see storage.history_at). Kept
# apart from ENTITY_STALE_AFTER above, which answers a different question --
# when to forget a row entirely -- and is measured from *now* rather than from
# the moment being replayed.
#
# Wider than the eviction windows on purpose. entity_history only receives a
# row when an entity actually moves, so a 30-minute read drops every vessel
# that was moored, drifting slowly, or simply between position reports at that
# moment -- which is what made the ship and aircraft layers thin out and
# flicker as the scrubber crossed a poll boundary. Anything absent falls back
# to that kind's ENTITY_STALE_AFTER.
REPLAY_WINDOW_SECONDS = {
    # An aircraft's position is meaningless within the hour, but so is a gap:
    # this is the ceiling on how old a fix may be, not how old it usually is.
    # With a healthy poller every airborne aircraft is re-recorded each minute,
    # so what an hour actually admits is the ones that landed or left coverage.
    "adsb": 3600,
    # Ships report far less often than aircraft, and a moored one can go hours
    # without moving a metre -- a window as tight as the aircraft's would
    # replay a busy anchorage as empty water.
    "ais": 3 * 3600,
}

# How often the backend re-checks whether a mirrored kind has changed (see
# backend/mirror.py). This is the *fallback* tick, not the normal path: writers
# announce on Postgres NOTIFY and the mirror wakes on that within milliseconds,
# so this only governs how long a dropped listener connection can hide new data.
# Cheap to keep short -- an unchanged kind costs one indexed row and does not
# touch the payload.
INGEST_MIRROR_INTERVAL = int(os.getenv("INGEST_MIRROR_INTERVAL", "20"))

# How many of its own intervals a source may miss before /api/health calls the
# ingest service overdue. Above 2 so that one slow poll (an ACLED login retrying,
# an Overpass sweep running long) isn't reported as a failure; low enough that a
# dead ingest container is visible within a couple of minutes for the fast
# sources rather than after an hour.
INGEST_STALE_MULTIPLIER = float(os.getenv("INGEST_STALE_MULTIPLIER", "2.5"))

# How often the ingest process re-reads the airports/sanctions indexes it needs
# to annotate aircraft and ships (see backend/ingest/__main__.py). Those are
# collected by the *backend*, so the ingest process reads them out of Postgres
# rather than fetching them again -- this interval is about picking up the
# backend's daily refresh, not about calling anyone.
INGEST_REFERENCE_REFRESH = int(os.getenv("INGEST_REFERENCE_REFRESH", "3600"))

# How often the refine process recomputes the escalation ranking (see
# backend/escalation.py). It aggregates a week of conflict_events across every
# region, which is why it is precomputed at all rather than run per request --
# app.py used to do exactly that behind a 2-minute cache. Matched to the cadence
# of its only input: event_fusion writes on GDELT's interval, so recomputing
# faster would re-derive the same answer from the same rows.
ESCALATION_REFRESH_INTERVAL = int(os.getenv("ESCALATION_REFRESH_INTERVAL", str(GDELT_POLL_INTERVAL)))

# Redis, in front of Postgres for the payloads the backend serves (see
# backend/cachestore.py). Empty disables caching entirely and everything is
# served straight from Postgres, which is the correct behaviour for a local
# `python -m backend.app` and the fallback whenever Redis is unreachable.
REDIS_URL = os.getenv("REDIS_URL", "")

# How long a cached payload lives. Longer than any producing interval, since the
# entry is invalidated by its watermark rather than by expiry -- the TTL is only
# there so a kind that stops being produced eventually stops occupying memory.
CACHE_TTL = int(os.getenv("CACHE_TTL", str(6 * 3600)))

# Payloads above this are not cached at all. A single FIRMS snapshot runs to
# 175k points; one entry big enough to push Redis past maxmemory would evict
# every other kind to hold itself, which is a worse outcome than that one kind
# being read from Postgres.
CACHE_MAX_PAYLOAD_BYTES = int(os.getenv("CACHE_MAX_PAYLOAD_BYTES", str(64 * 1024 * 1024)))

# How often the cache worker looks (see backend/cacheworker). It only reads
# counters and a handful of keys, so this is cheap; a minute is fast enough that
# a problem is visible before anyone reports it and slow enough that the alert
# table records episodes rather than samples.
CACHE_WORKER_INTERVAL = int(os.getenv("CACHE_WORKER_INTERVAL", "60"))

# Fraction of maxmemory at which Redis is reported as about to evict, and the
# hit ratio below which something is reported as wrong. The ratio threshold is
# high on purpose: entries here are invalidated by watermark rather than by
# expiry, so in normal operation almost every lookup should hit -- a low ratio
# means keys are vanishing, not that the cache is working hard.
CACHE_MEMORY_WARN_FRACTION = float(os.getenv("CACHE_MEMORY_WARN_FRACTION", "0.85"))
CACHE_HIT_RATIO_WARN = float(os.getenv("CACHE_HIT_RATIO_WARN", "0.5"))
# Below this many lookups a ratio is noise -- two misses on a fresh Redis is
# 0%, and reporting that would train everyone to ignore the alert.
CACHE_MIN_SAMPLES_FOR_RATIO = int(os.getenv("CACHE_MIN_SAMPLES_FOR_RATIO", "50"))

# How many consecutive probes a kind must be uncached before that is reported.
# An empty cache is normal after any Redis restart -- the backend fills it on
# the read path, and only reads on a change, so a daily source is legitimately
# uncached for hours. At 60s probes, 30 is half an hour: long past a deploy,
# well short of the slowest producer.
CACHE_UNCACHED_PROBES = int(os.getenv("CACHE_UNCACHED_PROBES", "30"))

# Where alerts are pushed, in addition to the log and the alerts table. A
# Discord or Slack incoming-webhook URL; unset means those two sinks only, which
# is the default because a webhook is the one sink that can reach someone who is
# not looking at the map.
ALERT_WEBHOOK_URL = os.getenv("ALERT_WEBHOOK_URL", "").strip()

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
