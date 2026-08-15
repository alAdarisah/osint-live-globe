"""Durable Postgres-backed storage for everything the app observes.

The live layer (registry.get(...).data, served by /api/ships, /api/aircraft,
/api/events, ...) stays exactly as it was: an in-memory "what's on the map
right now" list. This module is the separate "what has been seen, and when"
store that sits behind it. Every point source writes its snapshots here,
deduped against the last known position so a stationary ship reporting the
same lat/lon every 5s doesn't bloat the movement log.

Five tables:
  entity_latest      -- one row per (kind, entity_id), always current.
  entity_history     -- append-only, one row per position *change*.
  conflict_events    -- the fused ACLED/UCDP/GDELT archive, with the richer
                        queryable columns entity_latest's generic shape
                        can't express (see backend/sources/event_fusion.py).
  reference_snapshots-- whole-document sources that aren't lat/lon rows at
                        all (countries GeoJSON, HDX country->month series,
                        cable routes, the OFAC SDN list).
  source_health      -- one row per poll outcome, per source.

Everything a source collects lands in one of these, and every source reads its
own back at startup through warm_points/warm_reference below, so a restart
serves the last known state immediately instead of an empty map.

`kind` is what makes the first two generic: "ais", "adsb", "events",
"acled", "gdelt", "satellites", "firms", "jamming", "cities". Adding a
source is one record_snapshot() call in its poll loop, no schema change.

asyncpg throughout (native async -- no thread pool), one pool for the
process, created by init_pool() from app.py's lifespan before any source
starts. Writes are deliberately failure-tolerant: the live layer is the
source of truth for what's on screen, and a Postgres hiccup must never take
a poller down with it, so write paths log and continue. Reads (/api/replay)
surface their errors normally.
"""

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime, timedelta, timezone

import asyncpg

from backend import config

log = logging.getLogger("osint-globe.storage")

# ~1m of latitude/longitude at the equator -- fine enough that genuine drift
# (even a slowly drifting anchored ship) counts as movement, coarse enough
# that GPS/decoder jitter on a truly stationary entity doesn't.
_COORD_EPSILON = 0.00001

# Rows per round trip. Big enough that a 100k-point FIRMS snapshot is a
# handful of statements, small enough that no single statement builds a
# huge parameter array in memory.
_BATCH = 5000

_pool: asyncpg.Pool | None = None

# Optional read-only pool against the physical replica (Phase 2 of
# docs/plans/2026-08-09-read-replica.md). Stays None unless READ_REPLICA_URL is
# set AND the replica opened; get_read_pool() falls back to the primary in every
# other case, so nothing downstream has to know whether a replica exists.
_read_pool: asyncpg.Pool | None = None

# The channel every writer announces on and the backend listens to (see
# backend/mirror.py). One channel for all kinds, with the kind as the payload,
# rather than a channel each: asyncpg registers listeners per channel name, and
# a channel per kind would mean re-registering whenever the set of mirrored
# kinds changed, for no gain -- the payload already says which one moved.
#
# Every NOTIFY below is issued *inside* the writing transaction. Postgres holds
# notifications until commit, so a listener can never be woken for a change it
# would not yet be able to read.
NOTIFY_CHANNEL = "osint_ingest"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS entity_latest (
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_moved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_latest_kind_moved ON entity_latest (kind, last_moved_at DESC);
-- Serves kind_watermark()'s max(updated_at), which the backend runs on every
-- mirror tick to decide whether a kind is worth re-reading at all. Without it
-- that "has anything changed?" question is a full scan of the kind -- 100k+
-- rows for FIRMS -- several times a minute, which costs more than the read it
-- is trying to avoid.
CREATE INDEX IF NOT EXISTS idx_latest_kind_updated ON entity_latest (kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS entity_history (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_lookup ON entity_history (kind, ts);
CREATE INDEX IF NOT EXISTS idx_history_entity ON entity_history (kind, entity_id, ts DESC);
-- Serves entity_history_since()'s cursor read: "every row of this kind past
-- id N", in id order. id is a BIGSERIAL shared across every kind this table
-- holds, so a plain PK scan filtered by kind would walk past every adsb/
-- satellite/etc row sitting between two ais ids before it could apply the
-- filter -- this index makes the (kind, id) range itself the scan.
CREATE INDEX IF NOT EXISTS idx_history_kind_id ON entity_history (kind, id);

CREATE TABLE IF NOT EXISTS conflict_events (
  id TEXT PRIMARY KEY,
  date DATE,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  event_type TEXT,
  sub_event_type TEXT,
  actor1 TEXT,
  actor2 TEXT,
  fatalities INTEGER,
  country TEXT,
  notes TEXT,
  source TEXT,
  corroborated BOOLEAN,
  corroborated_by TEXT[],
  mentions INTEGER,
  -- DOUBLE PRECISION rather than REAL: these arrive as Python floats, which
  -- asyncpg binds as float8, and matching the column type avoids relying on
  -- an implicit float8 -> float4 narrowing on every insert.
  goldstein DOUBLE PRECISION,
  avg_tone DOUBLE PRECISION,
  source_url TEXT,
  -- 0-100, see event_fusion.py's _severity_for. Persisted (not just derived
  -- at serve time) because escalation.py sums it over historical windows.
  severity INTEGER,
  -- "locality" | "region" | "country" | "unknown". How precisely this event is
  -- actually placed; a "country" row sits on a national centroid and its true
  -- location is unknown. geo_feature_id is GDELT's own stable place id.
  geo_precision TEXT,
  geo_feature_id TEXT,
  -- Distinct news outlets reporting this event (GDELT Mentions table), as
  -- opposed to corroborated_by, which counts distinct *datasets*. Two
  -- different axes of confidence; see event_fusion._merge_cluster.
  outlet_count INTEGER,
  corroboration TEXT,
  -- Full CAMEO event code (e.g. "195" aerial bombardment) rather than only the
  -- 20-bucket root, so the archive keeps the specific act.
  event_code TEXT,
  -- When we first observed it, at full timestamp resolution. `date` is the
  -- day the event happened; this is what age-based rendering needs.
  ingested_at TIMESTAMPTZ,
  -- config.CONFLICT_PIPELINE_VERSION at insert time. Insert-only on purpose:
  -- escalation.py compares counts only within one version, so a change that
  -- alters event volume can't read as a world-wide escalation. Updating it on
  -- conflict would relabel old rows as current and defeat that.
  pipeline_version INTEGER,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflict_events_date ON conflict_events (date);
CREATE INDEX IF NOT EXISTS idx_conflict_events_last_seen ON conflict_events (last_seen);
-- escalation.py's baseline query filters by first_seen and then by bounding
-- box, so leading with first_seen is what keeps that window scan cheap.
CREATE INDEX IF NOT EXISTS idx_conflict_events_first_seen ON conflict_events (first_seen);

-- Added after the table shipped, so existing databases need it backfilled
-- rather than only new ones getting it from the CREATE above.
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS severity INTEGER;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS geo_precision TEXT;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS geo_feature_id TEXT;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS outlet_count INTEGER;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS corroboration TEXT;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS event_code TEXT;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS pipeline_version INTEGER;

-- How the coordinate was arrived at, and how far it can be trusted. See
-- backend/sources/geoverify.py: "confirmed" | "refined" | "contested" |
-- "dateline_suspect" | "unverified" | "structured".
--
-- geo_confidence (0-100) is deliberately separate from severity. Severity says
-- how big the event was; this says how sure we are it happened where the pin
-- is, and one number cannot carry both -- collapsing them is what made a large
-- unplaceable event and a small well-placed one score alike.
--
-- geo_radius_km is the real uncertainty of the coordinate, in kilometres, and
-- is what the map draws as the ring around a pin. A country-centroid row is a
-- 400 km circle whether or not anyone renders it as one.
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS geo_verdict TEXT;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS geo_confidence INTEGER;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS geo_radius_km DOUBLE PRECISION;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS geo_text_place TEXT;
-- Where the pin was before a refinement moved it. Present only on refined rows,
-- which makes them the auditable set: every placement this pipeline changed can
-- be recovered and re-measured against its original.
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS original_lat DOUBLE PRECISION;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS original_lon DOUBLE PRECISION;
ALTER TABLE conflict_events ADD COLUMN IF NOT EXISTS original_geo_precision TEXT;
-- escalation.py filters every window by (pipeline_version, first_seen); this
-- is the index that keeps that from degrading into a full scan.
CREATE INDEX IF NOT EXISTS idx_conflict_events_version_seen
  ON conflict_events (pipeline_version, first_seen);

CREATE TABLE IF NOT EXISTS reference_snapshots (
  name TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS source_health (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  item_count INTEGER,
  ok BOOLEAN NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_health_lookup ON source_health (source, ts DESC);

-- What the cache worker has found wrong (see backend/cacheworker). One row per
-- (subject, condition) rather than one per observation: a cache that has been
-- missing for six hours is one fact, and appending it every 60 seconds would
-- turn the useful question -- "what is wrong right now" -- into an aggregate
-- over 360 identical rows. occurrences and first_seen keep the duration; the
-- primary key keeps the count at one.
--
-- resolved_at is set rather than the row deleted, so "this broke overnight and
-- fixed itself" stays answerable in the morning.
CREATE TABLE IF NOT EXISTS alerts (
  subject TEXT NOT NULL,
  condition TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (subject, condition)
);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts (resolved_at, last_seen DESC);

-- Grid-cell accumulator for the AIS lane-density refine job
-- (backend/refine/lane_density.py). entity_history holds the raw movement
-- log (11 GB and rising with a global AIS subscription), and no request path
-- may scan it (see backend/tests -- global project constraint); this compact
-- table is what GET /api/lanes actually reads.
--
-- cell_key is the caller's own grid quantization (lat/lon rounded to `res`
-- degrees, encoded as text) -- computed by the refine job, not derived here,
-- since only it knows the resolution a given sweep used. One row per cell,
-- accumulated across every sweep rather than replaced by the newest one, so
-- the layer represents traffic over time rather than one snapshot.
--
-- by_class counts transits per vessel class (cargo, tanker, fishing, ...) so
-- the layer can be filtered without a join back to entity_history.
--
-- transits is a count of distinct hulls *within one sweep*, added onto the
-- running total on every later sweep that finds the same cell occupied
-- (see _combine_lane_cell below) -- so a hull that sits in one cell for a
-- month adds to this column on every sweep that finds it still there, the
-- same as a cell that sees that many different hulls pass through once
-- each. Nothing here deduplicates a loiterer against itself across sweeps
-- (see backend/refine/lane_density.py's module docstring for why not, and
-- what a fix would need), which is why GET /api/lanes exposes this column
-- as `sightings`, not `transits` -- see backend/app.py's lanes_endpoint.
CREATE TABLE IF NOT EXISTS lane_cells (
  cell_key    TEXT PRIMARY KEY,
  lat         DOUBLE PRECISION NOT NULL,
  lon         DOUBLE PRECISION NOT NULL,
  res         DOUBLE PRECISION NOT NULL,
  transits    INTEGER NOT NULL,
  positions   INTEGER NOT NULL,
  by_class    JSONB NOT NULL,
  -- Summed sin/cos of every transit's course, not a mean bearing -- courses
  -- are angles, and averaging degrees across the 0/360 seam gives nonsense
  -- (a cell split evenly between 359deg and 1deg would average to 180deg,
  -- the opposite direction). Store the unit-vector sum and let the reader
  -- take atan2(mean_sin, mean_cos).
  mean_sin    DOUBLE PRECISION NOT NULL,
  mean_cos    DOUBLE PRECISION NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
-- Serves lane_cells()'s bbox filter -- a viewport query against a global grid.
CREATE INDEX IF NOT EXISTS idx_lane_cells_bbox ON lane_cells (lat, lon);
-- Serves any future "how stale is the grid" read. Not exercised by this
-- task's own helpers, but updated_at is otherwise unindexed and freshness is
-- exactly the question an operator asks about an accumulator that has no
-- per-row timestamp of its own.
CREATE INDEX IF NOT EXISTS idx_lane_cells_updated ON lane_cells (updated_at);

-- One row per vessel visit to a port, derived from the AIS movement log by a
-- future port-call detection refine job (schema only in this task). Kept
-- separate from entity_history for the same reason lane_cells is: a call is
-- a single fact -- one arrival, maybe one departure -- and deriving "when did
-- this hull last call here" from the raw log on a request would mean
-- scanning the 11 GB table live.
--
-- (mmsi, port_id, arrived_at) as the key rather than a surrogate id: a hull
-- can only be arriving at a given port once at a given moment, and this
-- shape is what makes record_port_calls's upsert -- a departure observed
-- later overwriting the same open call -- a plain ON CONFLICT rather than a
-- lookup-then-update.
--
-- draught_in/draught_out are the vessel's reported draught on arrival and
-- departure; a laden ship that leaves lighter than it arrived took on cargo,
-- and the reverse discharged it -- the detail that makes a port call more
-- than a dwell time.
--
-- confidence is the detector's own judgement of how sure this call really
-- is -- moored-at-anchor and slow-passage-nearby both look similar in a raw
-- movement log -- so this stays a plain text tier rather than a boolean
-- until the detector that populates it (a later task) settles its own
-- vocabulary.
CREATE TABLE IF NOT EXISTS vessel_port_calls (
  mmsi        TEXT NOT NULL,
  port_id     TEXT NOT NULL,
  arrived_at  TIMESTAMPTZ NOT NULL,
  departed_at TIMESTAMPTZ,
  draught_in  DOUBLE PRECISION,
  draught_out DOUBLE PRECISION,
  confidence  TEXT NOT NULL,
  PRIMARY KEY (mmsi, port_id, arrived_at)
);
-- Serves port_calls_for(): one vessel's recent calls, newest first.
CREATE INDEX IF NOT EXISTS idx_port_calls_mmsi ON vessel_port_calls (mmsi, arrived_at DESC);
-- Serves port_calls_at(): one port's recent traffic, newest first.
CREATE INDEX IF NOT EXISTS idx_port_calls_port ON vessel_port_calls (port_id, arrived_at DESC);

-- One row per aircraft flight leg, derived from the ADS-B movement log the
-- same way vessel_port_calls is derived from AIS -- schema only in this
-- task, and the same reasoning: entity_history is not something a request
-- path may scan, so a future flight-leg detection refine job writes the
-- compact summary here instead.
--
-- (icao24, departed_at) as the key: one aircraft can only depart once at a
-- given moment. origin_code/dest_code are nullable because a leg is first
-- recorded when a departure is detected, before an airport can always be
-- resolved from the track.
--
-- max_alt_ft and distance_km are what the raw log can't answer without a
-- scan of its own: how high the flight actually got, and how far it flew --
-- both used to tell a training circuit from a genuine transit.
CREATE TABLE IF NOT EXISTS flight_legs (
  icao24       TEXT NOT NULL,
  departed_at  TIMESTAMPTZ NOT NULL,
  arrived_at   TIMESTAMPTZ,
  origin_code  TEXT,
  dest_code    TEXT,
  callsign     TEXT,
  max_alt_ft   INTEGER,
  distance_km  DOUBLE PRECISION,
  confidence   TEXT NOT NULL,
  PRIMARY KEY (icao24, departed_at)
);
-- Serves flight_legs_for(): one aircraft's recent legs, newest first.
CREATE INDEX IF NOT EXISTS idx_flight_legs_icao ON flight_legs (icao24, departed_at DESC);
-- Added after the table above: the ts of the most recent entity_history row
-- that actually contributed to this leg, open or closed. Task 23 review
-- (Important 1) -- an open leg with no arrival looked identical whether the
-- airframe was ten minutes into a long flight or had gone dark eleven weeks
-- ago; this is the field a reader (and GET /api/aircraft/{icao24}) can
-- compare against "now" to tell the two apart. Nullable so a pre-migration
-- row (there should be none in practice -- this table is new in this same
-- task -- but ADD COLUMN IF NOT EXISTS is the established, non-destructive
-- pattern this file already uses for conflict_events) reads as "unknown"
-- rather than a fabricated value.
ALTER TABLE flight_legs ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
"""


async def init_pool(retries: int = 30, delay: float = 2.0) -> None:
    """Opens the pool and creates the schema, retrying while Postgres boots.

    Scheduled as a background task by app.py's lifespan, deliberately not
    awaited: writes no-op while `_pool` is None, so connecting late costs a
    few skipped snapshots, whereas blocking on it would make the API's
    availability depend on the database's. That matters because the retry
    budget is generous on purpose -- docker-compose's healthcheck covers the
    normal case, but a Postgres container restart can still race the backend,
    and a backend that gave up permanently on that race would need manual
    intervention to start recording again.
    """
    global _pool
    if _pool is not None:
        return
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            _pool = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=10)
            async with _pool.acquire() as conn:
                await conn.execute(_SCHEMA)
            log.info("Postgres storage ready")
            return
        except Exception as exc:  # noqa: BLE001 - any connect failure is worth retrying
            last_error = exc
            if attempt < retries:
                log.warning("Postgres not ready (attempt %d/%d): %s", attempt, retries, exc)
                await asyncio.sleep(delay)
    log.error("Giving up connecting to Postgres: %s -- running without durable storage", last_error)


async def wait_for_pool(timeout: float = 30.0) -> bool:
    """Block until the pool is up, for the few readers that actually need it.

    init_pool is deliberately not awaited by app.py's lifespan (see above), and
    every *write* path no-ops harmlessly while `_pool` is None. Reads at
    startup are the exception: a source rehydrating its window gets an empty
    list instead of an error, so the race is silent -- the layer simply comes
    back cold and nothing says why. Both rehydrate paths (gdelt.py's news
    window and event_fusion.py's violence window) hit this.

    Bounded, and returns a bool rather than raising: a run with no database at
    all must still start promptly rather than stalling every source for the
    full connect budget.
    """
    deadline = time.monotonic() + timeout
    while _pool is None and time.monotonic() < deadline:
        await asyncio.sleep(0.25)
    return _pool is not None


def get_pool() -> asyncpg.Pool | None:
    """The live pool, or None while storage is unavailable.

    Exposed for modules that run their own aggregate queries rather than
    going through this module's record/read helpers (see escalation.py) --
    they need to distinguish "no database" from "no results", and reaching
    into _pool directly from outside would make that coupling invisible.
    """
    return _pool


def _redact_dsn(dsn: str) -> str:
    """A DSN with the password stripped, for logs -- keeps user/host/db so a line
    still says which replica, without ever printing the credential."""
    if "://" not in dsn or "@" not in dsn:
        return dsn
    scheme, rest = dsn.split("://", 1)
    auth, tail = rest.split("@", 1)
    user = auth.split(":", 1)[0]
    return f"{scheme}://{user}@{tail}"


async def init_read_pool(retries: int = 60, delay: float = 10.0) -> None:
    """Open the read-only pool against READ_REPLICA_URL, if one is configured.

    Additive and non-fatal by design: no replica set, or a replica that will not
    connect, leaves `_read_pool` None and get_read_pool() falls back to the
    primary -- exactly today's behaviour. So this is scheduled the same way as
    init_pool (a background task nobody awaits), and a failure here degrades to
    "reads use the primary", never to a stalled or dead process.

    It retries because a *single* attempt is the wrong shape for what the standby
    actually does at startup. The replica is not merely slow to accept
    connections: on a fresh volume it runs a full pg_basebackup first, so for
    several minutes the name does not resolve at all. One attempt loses that race
    every time, and because nothing retries afterwards the process stays pinned to
    the primary until someone restarts it -- the replica streaming healthily beside
    it, unused. Observed exactly that: refine logged "Temporary failure in name
    resolution" once at boot and read from the primary for the rest of its life.

    The budget is generous (ten minutes by default) and the loop is quiet after
    the first failure, since the normal case for a cold stack is a few minutes of
    seeding. Giving up is still safe: reads keep working on the primary, and the
    next restart tries again.
    """
    global _read_pool
    if _read_pool is not None or not config.READ_REPLICA_URL:
        return
    dsn = _redact_dsn(config.READ_REPLICA_URL)
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            _read_pool = await asyncpg.create_pool(config.READ_REPLICA_URL, min_size=1, max_size=5)
            log.info("Read replica pool ready (%s)", dsn)
            return
        except Exception as exc:  # noqa: BLE001 - a missing replica must not break reads
            _read_pool = None
            last_error = exc
            if attempt == 1:
                log.warning(
                    "Read replica not ready (%s); reads use the primary while we wait: %s",
                    dsn, exc,
                )
            if attempt < retries:
                await asyncio.sleep(delay)
    log.warning(
        "Gave up opening the read replica (%s) after %d attempts; reads stay on the primary: %s",
        dsn, retries, last_error,
    )


def get_read_pool() -> asyncpg.Pool | None:
    """Pool for lag-tolerant, read-ONLY queries; the primary when no replica.

    Intended only for heavy background reads that tolerate replication lag --
    backups, monitoring, analytics, and (Phase 3) refine's bulk reads. It must
    never be handed a write, kind_watermark, or the mirror's serve read: those
    stay on the primary, because LISTEN/NOTIFY does not reach a replica and a
    lagging replica split from the watermark serves stale data as fresh (see the
    plan's "two landmines"). Returns None only when the primary itself is down,
    matching get_pool(), so callers keep the one "no database" check they have.
    """
    return _read_pool or _pool


def _reader(prefer_replica: bool) -> "asyncpg.Pool | None":
    """The pool a read should use: the replica when the caller opts in and one
    is open, otherwise the primary. Only lag-tolerant reads that never read
    their own recent writes may pass prefer_replica=True (see get_read_pool)."""
    return get_read_pool() if prefer_replica else _pool


async def close_pool() -> None:
    global _pool, _read_pool
    if _read_pool is not None:
        await _read_pool.close()
        _read_pool = None
    if _pool is not None:
        await _pool.close()
        _pool = None


def _stale_after(kind: str) -> int:
    return config.ENTITY_STALE_AFTER.get(kind, config.ENTITY_STALE_AFTER_DEFAULT)


def _replay_window(kind: str) -> int:
    """How old a recorded fix may be and still answer "where was it then".
    Falls back to the eviction window for kinds that don't need their own --
    reference layers refresh so slowly that the two are the same question."""
    return config.REPLAY_WINDOW_SECONDS.get(kind, _stale_after(kind))


def _synthetic_id(item: dict) -> str:
    """Stable id for sources whose rows carry no identifier of their own.

    FIRMS detections, GPSJam cells and GeoNames cities are all plain
    observations -- there is no upstream key to dedup on, but the same
    detection *does* reappear across consecutive polls, so hashing the
    fields that identify it keeps that from creating a new row every time.
    """
    basis = "|".join(
        str(item.get(k)) for k in ("lat", "lon", "acq_date", "acq_time", "name", "country_code")
    )
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:20]


def _rows_for(items: list[dict], id_field: str | None, id_fn) -> tuple[list, list, list, list]:
    """Flattens items into the parallel arrays _UPSERT_LATEST unnests.

    Deduplicated by id, last occurrence winning: Postgres rejects an
    `ON CONFLICT DO UPDATE` whose source rows touch the same key twice
    ("cannot affect row a second time"), which a snapshot can genuinely do
    -- two FIRMS detections sharing a lat/lon/time collapse to one synthetic
    id, and an upstream feed can repeat an entity within a single response.
    A dict keyed by id is also what makes "last wins" the natural behaviour,
    matching the live layer, where a later reading supersedes an earlier one.
    """
    rows: dict[str, tuple[float, float, str]] = {}
    for item in items:
        lat, lon = item.get("lat"), item.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if id_fn is not None:
            raw_id = id_fn(item)
        elif id_field is not None:
            raw_id = item.get(id_field)
        else:
            raw_id = _synthetic_id(item)
        if raw_id is None:
            continue
        rows[str(raw_id)] = (float(lat), float(lon), json.dumps(item, default=str))

    ids = list(rows)
    lats = [rows[i][0] for i in ids]
    lons = [rows[i][1] for i in ids]
    payloads = [rows[i][2] for i in ids]
    return ids, lats, lons, payloads


# One statement upserts a whole batch and reports back which rows actually
# moved, via unnest() over parallel arrays. The SQLite version this replaces
# did a SELECT-then-INSERT per row, which is what made large snapshots slow;
# here the movement test lives in the ON CONFLICT clause itself, and
# last_moved_at coming back equal to this poll's timestamp is precisely the
# "it moved (or it's new)" signal used to decide which history rows to write.
_UPSERT_LATEST = """
INSERT INTO entity_latest (kind, entity_id, lat, lon, payload, updated_at, last_moved_at)
SELECT $1, u.entity_id, u.lat, u.lon, u.payload::jsonb, $2, $2
  FROM unnest($3::text[], $4::float8[], $5::float8[], $6::text[])
       AS u(entity_id, lat, lon, payload)
ON CONFLICT (kind, entity_id) DO UPDATE SET
  lat = EXCLUDED.lat,
  lon = EXCLUDED.lon,
  payload = EXCLUDED.payload,
  updated_at = EXCLUDED.updated_at,
  last_moved_at = CASE
    WHEN abs(entity_latest.lat - EXCLUDED.lat) > $7
      OR abs(entity_latest.lon - EXCLUDED.lon) > $7
    THEN EXCLUDED.updated_at
    ELSE entity_latest.last_moved_at
  END
RETURNING entity_id, last_moved_at
"""

_INSERT_HISTORY = """
INSERT INTO entity_history (kind, entity_id, ts, lat, lon, payload)
SELECT $1, u.entity_id, $2, u.lat, u.lon, u.payload::jsonb
  FROM unnest($3::text[], $4::float8[], $5::float8[], $6::text[])
       AS u(entity_id, lat, lon, payload)
"""


async def record_snapshot(kind: str, items: list[dict], id_field: str | None = None, id_fn=None) -> None:
    """Persists one poll's worth of points for `kind`.

    `id_field` names the item key holding the entity's own id ("mmsi",
    "icao24", ...). Sources whose rows have no such key (FIRMS, jamming,
    cities) pass neither and get _synthetic_id; `id_fn` is the escape hatch
    for anything needing a bespoke rule.
    """
    if _pool is None or not items:
        return
    ids, lats, lons, payloads = _rows_for(items, id_field, id_fn)
    if not ids:
        return
    now = datetime.now(timezone.utc)
    try:
        async with _pool.acquire() as conn:
            async with conn.transaction():
                for start in range(0, len(ids), _BATCH):
                    end = start + _BATCH
                    chunk_ids = ids[start:end]
                    chunk_lats = lats[start:end]
                    chunk_lons = lons[start:end]
                    chunk_payloads = payloads[start:end]

                    moved_rows = await conn.fetch(
                        _UPSERT_LATEST, kind, now, chunk_ids, chunk_lats, chunk_lons,
                        chunk_payloads, _COORD_EPSILON,
                    )
                    moved = {r["entity_id"] for r in moved_rows if r["last_moved_at"] == now}
                    if not moved:
                        continue

                    by_id = {i: n for n, i in enumerate(chunk_ids)}
                    h_ids, h_lats, h_lons, h_payloads = [], [], [], []
                    for entity_id in moved:
                        idx = by_id.get(entity_id)
                        if idx is None:
                            continue
                        h_ids.append(entity_id)
                        h_lats.append(chunk_lats[idx])
                        h_lons.append(chunk_lons[idx])
                        h_payloads.append(chunk_payloads[idx])
                    if h_ids:
                        await conn.execute(_INSERT_HISTORY, kind, now, h_ids, h_lats, h_lons, h_payloads)

                cutoff = now - timedelta(seconds=_stale_after(kind))
                await conn.execute(
                    "DELETE FROM entity_latest WHERE kind = $1 AND updated_at < $2", kind, cutoff
                )
                await conn.execute("SELECT pg_notify($1, $2)", NOTIFY_CHANNEL, kind)
    except Exception:  # noqa: BLE001 - storage must never take a poller down
        log.exception("Failed to record %s snapshot (%d items)", kind, len(ids))


# Hand-numbered placeholders. New columns go immediately before first_seen,
# never in the middle, so existing positions never shift. first_seen and
# last_seen deliberately share the last placeholder: first_seen is written once
# at insert and never updated, which is what makes it mean "when we first heard
# about this incident" -- the quantity escalation.py counts.
_UPSERT_CONFLICT = """
INSERT INTO conflict_events (
  id, date, lat, lon, event_type, sub_event_type, actor1, actor2, fatalities,
  country, notes, source, corroborated, corroborated_by, mentions, goldstein,
  avg_tone, source_url, severity, geo_precision, geo_feature_id, outlet_count,
  corroboration, event_code, ingested_at, pipeline_version,
  geo_verdict, geo_confidence, geo_radius_km, geo_text_place,
  original_lat, original_lon, original_geo_precision,
  first_seen, last_seen
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$34)
ON CONFLICT (id) DO UPDATE SET
  date = EXCLUDED.date, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
  event_type = EXCLUDED.event_type, sub_event_type = EXCLUDED.sub_event_type,
  actor1 = EXCLUDED.actor1, actor2 = EXCLUDED.actor2,
  fatalities = EXCLUDED.fatalities, country = EXCLUDED.country,
  notes = EXCLUDED.notes, source = EXCLUDED.source,
  corroborated = EXCLUDED.corroborated, corroborated_by = EXCLUDED.corroborated_by,
  mentions = EXCLUDED.mentions, goldstein = EXCLUDED.goldstein,
  avg_tone = EXCLUDED.avg_tone, source_url = EXCLUDED.source_url,
  severity = EXCLUDED.severity,
  geo_precision = EXCLUDED.geo_precision, geo_feature_id = EXCLUDED.geo_feature_id,
  outlet_count = EXCLUDED.outlet_count, corroboration = EXCLUDED.corroboration,
  event_code = EXCLUDED.event_code, ingested_at = EXCLUDED.ingested_at,
  geo_verdict = EXCLUDED.geo_verdict, geo_confidence = EXCLUDED.geo_confidence,
  geo_radius_km = EXCLUDED.geo_radius_km, geo_text_place = EXCLUDED.geo_text_place,
  original_lat = EXCLUDED.original_lat, original_lon = EXCLUDED.original_lon,
  original_geo_precision = EXCLUDED.original_geo_precision,
  last_seen = EXCLUDED.last_seen
"""


_DELETE_CONFLICT = "DELETE FROM conflict_events WHERE id = ANY($1::text[])"


async def delete_conflict_events(ids: list[str]) -> None:
    """Remove rows whose cluster was absorbed into another one.

    Called when a new report bridges two previously separate clusters (see
    event_fusion._stable_cluster_id): the surviving cluster keeps the older id,
    and leaving the loser behind would let escalation.py count one incident
    twice.
    """
    if _pool is None or not ids:
        return
    try:
        async with _pool.acquire() as conn:
            await conn.execute(_DELETE_CONFLICT, list(ids))
    except Exception:  # noqa: BLE001 - archive hygiene, never worth failing a poll
        log.exception("Failed to delete %d superseded conflict events", len(ids))


def _parse_date(value):
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _to_timestamp(value):
    """Unix seconds -> aware datetime, for asyncpg's TIMESTAMPTZ binding."""
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return None


async def record_conflict_events(items: list[dict]) -> None:
    """Archives the fused conflict feed (see backend/sources/event_fusion.py).

    Kept separate from entity_latest's generic shape because these rows are
    the ones actually worth querying by actor/fatalities/corroboration, and
    first_seen/last_seen answer "when did we first hear about this" -- which
    a snapshot table structurally can't.
    """
    if _pool is None or not items:
        return
    now = datetime.now(timezone.utc)
    rows = []
    for item in items:
        row = _conflict_row(item, now)
        if row is not None:
            rows.append(row)
    if not rows:
        return
    try:
        async with _pool.acquire() as conn:
            async with conn.transaction():
                await conn.executemany(_UPSERT_CONFLICT, rows)
                await conn.execute("SELECT pg_notify($1, $2)", NOTIFY_CHANNEL, "conflict_events")
    except Exception:  # noqa: BLE001
        log.exception("Failed to record %d conflict events", len(rows))


def _conflict_row(item: dict, now: datetime) -> tuple | None:
    """One fused event as the bind tuple _UPSERT_CONFLICT expects, or None.

    Split out from record_conflict_events so its arity can be tested without a
    database. The write path swallows exceptions by design, so a tuple that no
    longer matches the statement would otherwise fail silently for as long as it
    took someone to query the archive and find it empty.
    """
    item_id = item.get("id")
    lat, lon = item.get("lat"), item.get("lon")
    if item_id is None or lat is None or lon is None:
        return None
    return (
        str(item_id), _parse_date(item.get("date")), lat, lon,
        item.get("event_type"), item.get("sub_event_type"),
        item.get("actor1"), item.get("actor2"),
        int(item.get("fatalities") or 0), item.get("country"),
        item.get("notes"), item.get("source"),
        bool(item.get("corroborated")), list(item.get("corroborated_by") or []),
        int(item.get("mentions") or 0) or None,
        item.get("goldstein"), item.get("avg_tone"), item.get("source_url"),
        int(item.get("severity") or 0) or None,
        item.get("geo_precision"), item.get("geo_feature_id"),
        int(item.get("outlet_count") or 0) or None, item.get("corroboration"),
        item.get("event_code"),
        _to_timestamp(item.get("ingested_at")),
        config.CONFLICT_PIPELINE_VERSION,
        # How the coordinate was arrived at and how far it can be trusted
        # (see backend/sources/geoverify.py). original_* is only populated
        # when a verdict actually moved the pin, so it doubles as the audit
        # trail for every refinement the pipeline has ever made.
        item.get("geo_verdict"),
        int(item["geo_confidence"]) if item.get("geo_confidence") is not None else None,
        item.get("geo_radius_km"),
        item.get("geo_text_place"),
        item.get("original_lat"), item.get("original_lon"),
        item.get("original_geo_precision"),
        now,
    )


async def record_reference(name: str, payload) -> bool:
    """Stores a whole-document source (countries GeoJSON, HDX series dict).

    These have no per-row lat/lon to snapshot -- they're one big document
    that's replaced wholesale on each refresh, so they get their own table
    rather than being forced into entity_latest's point shape.

    Returns whether the write is now durable, the same bool
    record_port_calls/upsert_lane_cells return and for the same reason: most
    of this function's ~30 callers just fire the write and move on (a stale
    document is fine until the next poll overwrites it), but a caller reading
    an ever-advancing cursor over a pruned table -- backend/refine/
    lane_density.py's chokepoint accounting is the first one -- cannot make
    that assumption, and needs to know a write actually landed before it can
    safely let the cursor move past the rows that produced it. `payload is
    None` returns True (nothing to persist is not a failure, the same
    reasoning upsert_lane_cells's `if not rows: return True` gives); no pool
    returns False, matching upsert_lane_cells's own "can't confirm durability
    without one".
    """
    if payload is None:
        return True
    if _pool is None:
        return False
    try:
        async with _pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO reference_snapshots (name, payload, updated_at)
                   VALUES ($1, $2::jsonb, $3)
                   ON CONFLICT (name) DO UPDATE SET
                     payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at""",
                name, json.dumps(payload, default=str), datetime.now(timezone.utc),
            )
        return True
    except Exception:  # noqa: BLE001
        log.exception("Failed to record reference snapshot %r", name)
        return False


async def reference(name: str):
    """The last stored document for `name`, or None if there isn't one.

    The read counterpart to record_reference. Without it those sources were
    write-only: the document was saved on every poll and never looked at, so a
    restart still showed an empty layer until the next successful fetch --
    which for a 24-hour refresh that fails is the rest of the day.
    """
    if _pool is None:
        return None
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT payload FROM reference_snapshots WHERE name = $1", name
            )
    except Exception:  # noqa: BLE001 - a cold read is not worth failing a boot over
        log.exception("Failed to read reference snapshot %r", name)
        return None
    return json.loads(row["payload"]) if row else None


# --- boot warming ---------------------------------------------------------
#
# Every source's poll loop runs its first fetch immediately, so in the happy
# case a layer is blank only for as long as that fetch takes. Two things make
# that a bad assumption in practice:
#
#   - Some first fetches are genuinely slow. osm_infra runs an Overpass query
#     that takes minutes and frequently times out; gazetteer and cities pull
#     multi-megabyte GeoNames archives; countries pulls a world GeoJSON.
#   - When a fetch fails the retry backs off to the source's full refresh
#     interval, which for airports, cables, osm_infra, sanctions and gazetteer
#     is 24 hours. A single failed boot fetch means a blank layer all day.
#
# In both cases Postgres already holds a perfectly good copy of what the layer
# last looked like. Serving that immediately and letting the live fetch
# overwrite it is strictly better than showing nothing: the data is real, it is
# attributed exactly as it was when collected, and /api/health still reports
# last_success as null until a fetch actually succeeds, so a warmed layer is
# never mistaken for a fresh one.
#
# Both helpers take the SourceState duck-typed rather than importing the
# registry, which would point this module at backend.cache and invert the
# dependency the rest of the file is careful to keep one-way.


# Much shorter than wait_for_pool's own default, and deliberately so. Warming
# runs before a source's first fetch, so every second spent waiting here is a
# second the live poll has not started -- and on a run with no database at all
# (a bare `python -m backend.app` with no DATABASE_URL reachable) that cost is
# paid by every source for nothing.
# init_pool connects on its first attempt whenever Postgres is actually
# reachable, and under compose the backend does not even start until the
# database reports healthy, so five seconds is generous for the case this can
# help and cheap for the case it cannot.
_WARM_POOL_WAIT = 5.0


async def wait_for_warm_pool() -> bool:
    """wait_for_pool on the warming budget, for sources that warm by hand.

    Most sources go through warm_points/warm_reference below. The three that
    rebuild something more structured than a state payload -- gazetteer's name
    index, osm_infra's per-theatre map, satellites' orbital elements -- call
    this directly so they wait exactly as long as everything else does.
    """
    return await wait_for_pool(timeout=_WARM_POOL_WAIT)


async def _warm(state, load, label: str) -> bool:
    if state.data:
        return False  # a live fetch already won the race; never overwrite it
    if not await wait_for_warm_pool():
        return False
    stored = await load()
    if not stored:
        return False
    # Re-checked after the await: waiting for the pool can take seconds, and a
    # fast first fetch landing in that window must not be clobbered by an older
    # snapshot.
    if state.data:
        return False
    state.data = stored
    log.info("%s: warmed from storage while the first fetch runs", label)
    return True


async def warm_reference(state, name: str, label: str | None = None) -> bool:
    """Fill a still-empty whole-document source from its last stored copy."""
    return await _warm(state, lambda: reference(name), label or name)


async def warm_points(state, kind: str, label: str | None = None) -> bool:
    """Fill a still-empty point source from entity_latest."""
    return await _warm(state, lambda: entity_latest(kind), label or kind)


async def record_source_health(source: str, item_count: int | None, ok: bool, error: str | None = None) -> None:
    """One row per poll outcome -- the history behind /api/health's snapshot."""
    if _pool is None:
        return
    try:
        async with _pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO source_health (source, ts, item_count, ok, error) VALUES ($1,$2,$3,$4,$5)",
                source, datetime.now(timezone.utc), item_count, ok, (error or None),
            )
    except Exception:  # noqa: BLE001
        log.exception("Failed to record source health for %r", source)


async def kind_watermark(kind: str) -> datetime | None:
    """The newest updated_at in entity_latest for `kind`, or None if empty.

    The cheap half of the mirror's read (see backend/mirror.py): one row out of
    idx_latest_kind_updated answers "did anything change since last time", so
    the expensive half -- pulling every row of the kind and reassigning
    state.data -- runs only when the answer is yes. That gate is what keeps
    HTTP ETags stable: state.data's setter bumps state.version (see
    backend/cache.py), version is the ETag, and re-reading an unchanged kind on
    every tick would invalidate every client's cached copy of a 100k-point
    payload several times a minute for no new data.

    Raises rather than swallowing: unlike the write paths, a mirror that cannot
    tell whether data moved must keep what it has, not silently republish.
    """
    if _pool is None:
        return None
    async with _pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT max(updated_at) FROM entity_latest WHERE kind = $1", kind
        )


async def source_health_latest(source: str) -> tuple[dict | None, dict | None]:
    """`(newest row, newest successful row)` for `source`; either may be None.

    Both come from idx_source_health_lookup (source, ts DESC), one row each.
    Two queries rather than one because they answer different questions and the
    newest row is usually the successful one anyway: the newest says whether the
    producing process is currently working, the newest successful says when data
    last actually arrived. A source failing for an hour needs both -- "erroring
    since 10:04" and "last real data 09:58" -- and either alone reads as a
    healthier or deader source than it is.
    """
    if _pool is None:
        return None, None
    async with _pool.acquire() as conn:
        newest = await conn.fetchrow(
            "SELECT ts, item_count, ok, error FROM source_health"
            " WHERE source = $1 ORDER BY ts DESC LIMIT 1",
            source,
        )
        newest_ok = await conn.fetchrow(
            "SELECT ts, item_count FROM source_health"
            " WHERE source = $1 AND ok ORDER BY ts DESC LIMIT 1",
            source,
        )
    return (dict(newest) if newest else None), (dict(newest_ok) if newest_ok else None)


async def record_alert(subject: str, condition: str, severity: str, detail: str) -> bool:
    """Upsert one alert. Returns True only the first time it starts firing.

    That return value is what keeps the webhook quiet: a condition that stays
    true for hours is one notification, not one per probe. A condition that
    clears and returns is a new notification, because it is genuinely new
    information -- which is why resolve_alerts below clears first_seen's row
    rather than leaving it to be re-upserted.
    """
    if _pool is None:
        return False
    now = datetime.now(timezone.utc)
    try:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO alerts (subject, condition, severity, detail, first_seen, last_seen)
                   VALUES ($1,$2,$3,$4,$5,$5)
                   ON CONFLICT (subject, condition) DO UPDATE SET
                     severity = EXCLUDED.severity,
                     detail = EXCLUDED.detail,
                     last_seen = EXCLUDED.last_seen,
                     occurrences = alerts.occurrences + 1,
                     -- A row that had been resolved starts a fresh episode, so
                     -- first_seen moves and resolved_at clears. Without this a
                     -- recurring problem would report a first_seen from days
                     -- ago and read as one continuous outage.
                     first_seen = CASE WHEN alerts.resolved_at IS NOT NULL
                                       THEN EXCLUDED.first_seen ELSE alerts.first_seen END,
                     resolved_at = NULL
                   RETURNING occurrences, (xmax = 0) AS inserted, first_seen""",
                subject, condition, severity, detail, now,
            )
            # Newly firing means either a brand new row or one that had been
            # resolved and just came back.
            return bool(row["inserted"] or row["first_seen"] == now)
    except Exception:  # noqa: BLE001 - alerting must never take the worker down
        log.exception("Failed to record alert %s/%s", subject, condition)
        return False


async def resolve_alerts(active: set[tuple[str, str]]) -> list[tuple[str, str]]:
    """Close every firing alert not in `active`. Returns what was closed."""
    if _pool is None:
        return []
    now = datetime.now(timezone.utc)
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT subject, condition FROM alerts WHERE resolved_at IS NULL"
            )
            stale = [
                (r["subject"], r["condition"]) for r in rows
                if (r["subject"], r["condition"]) not in active
            ]
            for subject, condition in stale:
                await conn.execute(
                    "UPDATE alerts SET resolved_at = $1 WHERE subject = $2 AND condition = $3",
                    now, subject, condition,
                )
            return stale
    except Exception:  # noqa: BLE001
        log.exception("Failed to resolve alerts")
        return []


async def active_alerts() -> list[dict]:
    """Everything currently firing, worst first. Served on /api/health."""
    if _pool is None:
        return []
    try:
        async with _pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT subject, condition, severity, detail, first_seen, last_seen, occurrences
                     FROM alerts WHERE resolved_at IS NULL
                    ORDER BY severity = 'critical' DESC, last_seen DESC"""
            )
        return [
            {
                "subject": r["subject"],
                "condition": r["condition"],
                "severity": r["severity"],
                "detail": r["detail"],
                "first_seen": r["first_seen"].timestamp(),
                "last_seen": r["last_seen"].timestamp(),
                "occurrences": r["occurrences"],
            }
            for r in rows
        ]
    except Exception:  # noqa: BLE001 - health must answer even when this table cannot
        log.exception("Failed to read active alerts")
        return []


# --- lane_cells, vessel_port_calls, flight_legs ----------------------------
#
# The compact tables behind the refine tier's derived-from-AIS/ADS-B products
# (lane density, port-call detection, flight-leg detection). lane_cells' own
# helpers are now driven by backend/refine/lane_density.py; the other two
# tables are still ahead of their jobs -- see the schema comments above for
# why each table exists and is shaped the way it is. They land together so
# every one of those jobs builds on a settled schema rather than each
# inventing its own.


def _sum_by_class(a: dict, b: dict) -> dict:
    """Key-wise sum of two by_class counts, e.g. {"cargo": 4} + {"cargo": 1,
    "tanker": 2} -> {"cargo": 5, "tanker": 2}. Never replaces a key that only
    one side has."""
    out = dict(a)
    for cls, count in b.items():
        out[cls] = out.get(cls, 0) + count
    return out


def _combine_lane_cell(existing: dict | None, incoming: dict) -> dict:
    """One cell's totals after adding one more observation to them.

    `existing` is the row already in lane_cells (or None for a cell seen for
    the first time this sweep); `incoming` is what this sweep itself
    observed for the same cell_key. transits/positions/mean_sin/mean_cos add;
    by_class merges key-wise rather than being replaced -- a sweep reports
    only the traffic *it* saw, and replacing would forget every class the
    cell had accumulated before it.
    """
    if existing is None:
        return dict(incoming)
    return {
        "cell_key": incoming["cell_key"],
        "lat": incoming["lat"], "lon": incoming["lon"], "res": incoming["res"],
        "transits": existing["transits"] + incoming["transits"],
        "positions": existing["positions"] + incoming["positions"],
        "by_class": _sum_by_class(existing["by_class"], incoming["by_class"]),
        "mean_sin": existing["mean_sin"] + incoming["mean_sin"],
        "mean_cos": existing["mean_cos"] + incoming["mean_cos"],
    }


def _lane_cell_row(item: dict) -> dict | None:
    """One incoming cell observation normalized to _combine_lane_cell's
    shape, or None if it is missing something that can't be defaulted or
    carries a value that can't be coerced to the type its column needs --
    mirroring _conflict_row/_port_call_row/_flight_leg_row's reasoning: the
    write path swallows exceptions by design, so a malformed row is better
    skipped here than left to raise a KeyError past the caller's try/except."""
    if not isinstance(item, dict):
        return None
    cell_key = item.get("cell_key")
    if cell_key is None:
        return None
    by_class_raw = item.get("by_class") or {}
    if not isinstance(by_class_raw, dict):
        return None
    try:
        return {
            "cell_key": str(cell_key), "lat": float(item["lat"]), "lon": float(item["lon"]),
            "res": float(item["res"]), "transits": int(item["transits"]),
            "positions": int(item["positions"]),
            "by_class": {str(k): int(v) for k, v in by_class_raw.items()},
            "mean_sin": float(item["mean_sin"]), "mean_cos": float(item["mean_cos"]),
        }
    except (KeyError, TypeError, ValueError):
        return None


def _prepare_lane_cell_rows(rows: list[dict]) -> dict[str, dict]:
    """Normalizes input rows and merges duplicate cell_keys within one call.

    A single sweep can legitimately report the same cell twice -- adjoining
    tiles of its own scan overlapping, for instance -- and merging here first
    is what keeps the batched statement in upsert_lane_cells from touching
    the same cell_key twice in one INSERT, which Postgres rejects the same
    way _rows_for's dedup exists for entity_latest ("cannot affect row a
    second time").
    """
    combined: dict[str, dict] = {}
    for item in rows:
        row = _lane_cell_row(item)
        if row is None:
            continue
        combined[row["cell_key"]] = _combine_lane_cell(combined.get(row["cell_key"]), row)
    return combined


_SELECT_LANE_CELLS_EXISTING = """
SELECT cell_key, transits, positions, by_class, mean_sin, mean_cos
  FROM lane_cells WHERE cell_key = ANY($1::text[])
"""

_UPSERT_LANE_CELLS = """
INSERT INTO lane_cells (cell_key, lat, lon, res, transits, positions, by_class, mean_sin, mean_cos, updated_at)
SELECT u.cell_key, u.lat, u.lon, u.res, u.transits, u.positions, u.by_class::jsonb, u.mean_sin, u.mean_cos, $10
  FROM unnest($1::text[], $2::float8[], $3::float8[], $4::float8[], $5::int[], $6::int[], $7::text[], $8::float8[], $9::float8[])
       AS u(cell_key, lat, lon, res, transits, positions, by_class, mean_sin, mean_cos)
ON CONFLICT (cell_key) DO UPDATE SET
  lat = EXCLUDED.lat, lon = EXCLUDED.lon, res = EXCLUDED.res,
  transits = EXCLUDED.transits, positions = EXCLUDED.positions,
  by_class = EXCLUDED.by_class, mean_sin = EXCLUDED.mean_sin, mean_cos = EXCLUDED.mean_cos,
  updated_at = EXCLUDED.updated_at
"""


async def upsert_lane_cells(rows: list[dict]) -> bool:
    """Adds one refine sweep's grid cells to the running lane-density totals.

    Read-merge-write rather than arithmetic in the UPSERT's SET clause (the
    way _UPSERT_LATEST tests movement), so the accumulation lives in
    _combine_lane_cell where it can be tested without a database. That
    assumes at most one sweep is ever writing at a time -- true of a single
    scheduled refine job, the only writer this table has today -- and would
    need to move into the statement itself if a second concurrent writer
    were ever added, the same way a concurrent entity_latest writer would
    need to.

    Batched at _BATCH for the same reason record_snapshot is: a full-planet
    sweep can be many thousand cells, and this keeps both the existing-row
    lookup and the write's parameter arrays bounded.

    Returns whether the batch is now durably written, the same bool
    record_port_calls returns and for the same reason: backend/refine/
    lane_density.py reads entity_history exactly once through an
    ever-advancing id cursor, so "logged and moved on" on a failed write
    would mean "logged and lost" for that slice of the movement log, not
    merely stale until the next poll. That caller holds its cursor back on
    False and retries the same batch next pass.
    """
    if not rows:
        return True
    if _pool is None:
        return False
    now = datetime.now(timezone.utc)
    try:
        # Normalizing/merging happens inside the same try as the write:
        # _lane_cell_row already skips anything it can't coerce rather than
        # raising, but this is the same belt-and-suspenders placement
        # _conflict_row's callers use -- a write path must never propagate a
        # bad row past its own "storage must never take a refine job down"
        # guarantee, whatever produces the exception.
        incoming = _prepare_lane_cell_rows(rows)
        if not incoming:
            return True
        async with _pool.acquire() as conn:
            async with conn.transaction():
                keys = list(incoming)
                for start in range(0, len(keys), _BATCH):
                    chunk = keys[start:start + _BATCH]
                    existing_rows = await conn.fetch(_SELECT_LANE_CELLS_EXISTING, chunk)
                    existing = {
                        r["cell_key"]: {
                            "transits": r["transits"], "positions": r["positions"],
                            "by_class": json.loads(r["by_class"]),
                            "mean_sin": r["mean_sin"], "mean_cos": r["mean_cos"],
                        }
                        for r in existing_rows
                    }
                    final = [_combine_lane_cell(existing.get(key), incoming[key]) for key in chunk]
                    await conn.execute(
                        _UPSERT_LANE_CELLS,
                        [f["cell_key"] for f in final],
                        [f["lat"] for f in final],
                        [f["lon"] for f in final],
                        [f["res"] for f in final],
                        [f["transits"] for f in final],
                        [f["positions"] for f in final],
                        [json.dumps(f["by_class"]) for f in final],
                        [f["mean_sin"] for f in final],
                        [f["mean_cos"] for f in final],
                        now,
                    )
        return True
    except Exception:  # noqa: BLE001 - storage must never take a refine job down
        log.exception("Failed to upsert %d lane cells", len(rows))
        return False


async def lane_cells(bbox: tuple | None, min_transits: int = 1) -> list[dict]:
    """The stored grid, optionally clipped to a viewport.

    `bbox` is (lat_min, lon_min, lat_max, lon_max), the same shape as
    config.WATCHED_WATERS, filtered on the plain lat/lon columns -- there is
    no PostGIS here, so a viewport query is exactly the range predicate
    idx_lane_cells_bbox serves.
    """
    if _pool is None:
        return []
    if bbox is not None:
        lat_min, lon_min, lat_max, lon_max = bbox
        query = (
            "SELECT cell_key, lat, lon, res, transits, positions, by_class, mean_sin, mean_cos, updated_at"
            " FROM lane_cells WHERE transits >= $1 AND lat >= $2 AND lat <= $3 AND lon >= $4 AND lon <= $5"
        )
        args = [int(min_transits), float(lat_min), float(lat_max), float(lon_min), float(lon_max)]
    else:
        query = (
            "SELECT cell_key, lat, lon, res, transits, positions, by_class, mean_sin, mean_cos, updated_at"
            " FROM lane_cells WHERE transits >= $1"
        )
        args = [int(min_transits)]
    async with _pool.acquire() as conn:
        rows = await conn.fetch(query, *args)
    return [
        {
            "cell_key": r["cell_key"], "lat": r["lat"], "lon": r["lon"], "res": r["res"],
            "transits": r["transits"], "positions": r["positions"],
            "by_class": json.loads(r["by_class"]),
            "mean_sin": r["mean_sin"], "mean_cos": r["mean_cos"],
            "updated_at": r["updated_at"].timestamp(),
        }
        for r in rows
    ]


_DECAY_LANE_CELLS = """
UPDATE lane_cells SET
  -- $1 is cast explicitly everywhere it's used below. Left bare, Postgres
  -- infers an untyped parameter's type from its *first* use -- here
  -- `transits * $1` with transits an integer column -- and resolves $1 as
  -- integer for the whole statement, silently truncating a fractional decay
  -- factor like 0.5 to 0 before it ever reaches the multiplication. Found by
  -- running this against a real Postgres: every fake-connection test in
  -- backend/tests passed regardless, because none of them can see a
  -- parameter type Postgres itself only infers at plan time.
  transits = GREATEST(0, ROUND(transits * $1::float8))::integer,
  positions = GREATEST(0, ROUND(positions * $1::float8))::integer,
  mean_sin = mean_sin * $1::float8,
  mean_cos = mean_cos * $1::float8,
  -- by_class counts transits *per class*, so it has to age down in step
  -- with transits itself -- leaving it untouched would let the per-class
  -- breakdown drift above the total it is supposed to sum to after a few
  -- decay cycles, ending in a class count the cell's own transits column
  -- can no longer account for.
  by_class = COALESCE(
    (SELECT jsonb_object_agg(key, GREATEST(0, ROUND((value #>> '{}')::numeric * $1::float8))::integer)
       FROM jsonb_each(by_class)),
    '{}'::jsonb
  )
"""


async def decay_lane_cells(factor: float, floor: int) -> int:
    """Ages every cell down by `factor` and drops what falls below `floor`.

    This *is* lane_cells' pruning -- unlike every other table here it gets no
    entry in retention_sweep_loop, because a cell's relevance isn't a
    function of when it was last touched but of how much traffic it still
    represents. A quiet cell that hasn't decayed below the floor is still
    worth showing; a once-busy cell that hasn't been reinforced decays out on
    its own schedule. Called by its own job (not yet built) on its own
    cadence.
    """
    if _pool is None:
        return 0
    try:
        async with _pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(_DECAY_LANE_CELLS, float(factor))
                status = await conn.execute(
                    "DELETE FROM lane_cells WHERE transits < $1", int(floor)
                )
        return _deleted_count(status)
    except Exception:  # noqa: BLE001 - storage must never take the decay job down
        log.exception("Failed to decay lane cells (factor=%s floor=%s)", factor, floor)
        return 0


_UPSERT_PORT_CALL = """
INSERT INTO vessel_port_calls (mmsi, port_id, arrived_at, departed_at, draught_in, draught_out, confidence)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (mmsi, port_id, arrived_at) DO UPDATE SET
  departed_at = EXCLUDED.departed_at,
  draught_in = COALESCE(vessel_port_calls.draught_in, EXCLUDED.draught_in),
  draught_out = EXCLUDED.draught_out,
  confidence = EXCLUDED.confidence
"""


def _port_call_row(item: dict) -> tuple | None:
    """One detected call as the bind tuple _UPSERT_PORT_CALL expects, or None
    if the row is missing something that can't be defaulted -- mirroring
    _conflict_row's reasoning: the write path swallows exceptions by design,
    so a malformed row is better skipped here than bound and failing silently."""
    mmsi, port_id, confidence = item.get("mmsi"), item.get("port_id"), item.get("confidence")
    arrived_at = _to_timestamp(item.get("arrived_at"))
    if mmsi is None or port_id is None or arrived_at is None or confidence is None:
        return None
    return (
        str(mmsi), str(port_id), arrived_at,
        _to_timestamp(item.get("departed_at")),
        item.get("draught_in"), item.get("draught_out"), str(confidence),
    )


async def record_port_calls(rows: list[dict]) -> bool:
    """Upserts a batch of detected vessel port calls.

    Keyed on (mmsi, port_id, arrived_at): a second write for the same key --
    typically the same call seen again once a departure is detected -- updates
    the existing row in place, which is what turns an arrival and a departure
    observed hours apart into a single call record instead of two.

    Returns whether the batch is now durably written -- True when there was
    nothing to write, or the write succeeded; False otherwise, still without
    raising (every write in this module logs and returns on failure rather
    than taking its caller down -- see the module docstring). The return
    value exists for the one caller that cannot treat "did not raise" as
    "succeeded": backend/refine/port_calls.py reads entity_history exactly
    once through an ever-advancing id cursor over a table that is pruned at
    three days, so unlike a snapshot source -- where the next poll simply
    re-supplies the same live state -- a write this function silently drops
    would be gone for good rather than merely stale. That caller holds its
    cursor back on False and retries the same batch next pass.
    """
    if not rows:
        return True
    tuples = [t for t in (_port_call_row(r) for r in rows) if t is not None]
    if not tuples:
        return True
    if _pool is None:
        return False
    try:
        async with _pool.acquire() as conn:
            async with conn.transaction():
                for start in range(0, len(tuples), _BATCH):
                    await conn.executemany(_UPSERT_PORT_CALL, tuples[start:start + _BATCH])
        return True
    except Exception:  # noqa: BLE001 - storage must never take a refine job down
        log.exception("Failed to record %d port calls", len(tuples))
        return False


def _port_call_dict(r) -> dict:
    return {
        "mmsi": r["mmsi"], "port_id": r["port_id"],
        "arrived_at": r["arrived_at"].timestamp(),
        "departed_at": r["departed_at"].timestamp() if r["departed_at"] else None,
        "draught_in": r["draught_in"], "draught_out": r["draught_out"],
        "confidence": r["confidence"],
    }


_PORT_CALL_COLUMNS = "mmsi, port_id, arrived_at, departed_at, draught_in, draught_out, confidence"


async def port_calls_for(mmsi: str, limit: int = 20) -> list[dict]:
    """One vessel's most recent port calls, newest arrival first."""
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_PORT_CALL_COLUMNS} FROM vessel_port_calls WHERE mmsi = $1"
            f" ORDER BY arrived_at DESC LIMIT $2",
            str(mmsi), int(limit),
        )
    return [_port_call_dict(r) for r in rows]


async def port_calls_at(port_id: str, limit: int = 50) -> list[dict]:
    """One port's most recent traffic, newest arrival first."""
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_PORT_CALL_COLUMNS} FROM vessel_port_calls WHERE port_id = $1"
            f" ORDER BY arrived_at DESC LIMIT $2",
            str(port_id), int(limit),
        )
    return [_port_call_dict(r) for r in rows]


async def open_port_call(mmsi: str) -> dict | None:
    """The vessel's current call, if it hasn't been seen to depart -- or None."""
    if _pool is None:
        return None
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_PORT_CALL_COLUMNS} FROM vessel_port_calls"
            f" WHERE mmsi = $1 AND departed_at IS NULL ORDER BY arrived_at DESC LIMIT 1",
            str(mmsi),
        )
    return _port_call_dict(row) if row else None


_UPSERT_FLIGHT_LEG = """
INSERT INTO flight_legs (icao24, departed_at, arrived_at, origin_code, dest_code, callsign, max_alt_ft, distance_km, confidence, last_seen_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
ON CONFLICT (icao24, departed_at) DO UPDATE SET
  arrived_at = EXCLUDED.arrived_at,
  -- origin_code/dest_code/callsign are resolved progressively as a leg's
  -- track fills in, the same way max_alt_ft below is -- a leg is first
  -- written the moment a departure is detected, before either airport can
  -- always be resolved (see the schema comment on flight_legs). COALESCE
  -- keeps whichever write actually resolved a value: a later write that
  -- hasn't (yet) resolved dest_code -- the closing arrival write in
  -- record_flight_legs is exactly this shape -- must not erase one a
  -- previous write already found, and a write that *has* resolved a real
  -- value still overwrites the old one, so a closing write that does look
  -- the arrival airport up still corrects an earlier guess.
  origin_code = COALESCE(EXCLUDED.origin_code, flight_legs.origin_code),
  dest_code = COALESCE(EXCLUDED.dest_code, flight_legs.dest_code),
  callsign = COALESCE(EXCLUDED.callsign, flight_legs.callsign),
  -- The highest altitude seen across every write for this leg, not the
  -- latest one: a leg written once mid-flight and again after landing each
  -- saw only part of its altitude profile, and GREATEST ignores a NULL side
  -- rather than propagating it, so a leg with no altitude yet doesn't erase
  -- one already recorded.
  max_alt_ft = GREATEST(EXCLUDED.max_alt_ft, flight_legs.max_alt_ft),
  distance_km = EXCLUDED.distance_km,
  confidence = EXCLUDED.confidence,
  -- Same GREATEST-ignores-NULL treatment as max_alt_ft, and for the same
  -- reason it must never go backwards: this is "how recently did we last
  -- actually hear from this leg", and a write cannot un-hear something a
  -- previous write already recorded.
  last_seen_at = GREATEST(EXCLUDED.last_seen_at, flight_legs.last_seen_at)
"""


def _flight_leg_row(item: dict) -> tuple | None:
    """One detected leg as the bind tuple _UPSERT_FLIGHT_LEG expects, or None
    if the row is missing something that can't be defaulted."""
    icao24, confidence = item.get("icao24"), item.get("confidence")
    departed_at = _to_timestamp(item.get("departed_at"))
    if icao24 is None or departed_at is None or confidence is None:
        return None
    return (
        str(icao24), departed_at,
        _to_timestamp(item.get("arrived_at")),
        item.get("origin_code"), item.get("dest_code"), item.get("callsign"),
        int(item["max_alt_ft"]) if item.get("max_alt_ft") is not None else None,
        item.get("distance_km"), str(confidence),
        _to_timestamp(item.get("last_seen_at")),
    )


async def record_flight_legs(rows: list[dict]) -> bool:
    """Upserts a batch of detected flight legs.

    Keyed on (icao24, departed_at): a later write for the same key -- the
    same leg tracked further, with an arrival now resolved -- updates the row
    in place rather than creating a second one.

    Returns whether the batch is now durably written, following
    record_port_calls' own contract exactly (True when there was nothing to
    write or the write succeeded, False otherwise, never raising). The same
    justification applies here as there: backend/refine/flight_legs.py reads
    entity_history exactly once through an ever-advancing id cursor over a
    table with its own retention, so "logged and moved on" would mean "logged
    and lost", not "stale until the next poll re-supplies it". That caller
    holds its cursor back on False and retries the same batch next pass.
    """
    if not rows:
        return True
    tuples = [t for t in (_flight_leg_row(r) for r in rows) if t is not None]
    if not tuples:
        return True
    if _pool is None:
        return False
    try:
        async with _pool.acquire() as conn:
            async with conn.transaction():
                for start in range(0, len(tuples), _BATCH):
                    await conn.executemany(_UPSERT_FLIGHT_LEG, tuples[start:start + _BATCH])
        return True
    except Exception:  # noqa: BLE001 - storage must never take a refine job down
        log.exception("Failed to record %d flight legs", len(tuples))
        return False


def _flight_leg_dict(r) -> dict:
    return {
        "icao24": r["icao24"],
        "departed_at": r["departed_at"].timestamp(),
        "arrived_at": r["arrived_at"].timestamp() if r["arrived_at"] else None,
        "origin_code": r["origin_code"], "dest_code": r["dest_code"], "callsign": r["callsign"],
        "max_alt_ft": r["max_alt_ft"], "distance_km": r["distance_km"], "confidence": r["confidence"],
        # None for a leg recorded before this column existed (see the ALTER
        # TABLE above) -- a card reads that the same way it reads any other
        # unknown staleness, not as "just now".
        "last_seen_at": r["last_seen_at"].timestamp() if r["last_seen_at"] else None,
    }


_FLIGHT_LEG_COLUMNS = (
    "icao24, departed_at, arrived_at, origin_code, dest_code, callsign, max_alt_ft, distance_km, confidence, last_seen_at"
)


async def flight_legs_for(icao24: str, limit: int = 20) -> list[dict]:
    """One aircraft's most recent legs, newest departure first."""
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_FLIGHT_LEG_COLUMNS} FROM flight_legs WHERE icao24 = $1"
            f" ORDER BY departed_at DESC LIMIT $2",
            str(icao24), int(limit),
        )
    return [_flight_leg_dict(r) for r in rows]


async def open_flight_leg(icao24: str) -> dict | None:
    """The aircraft's current leg, if it hasn't been seen to land -- or None."""
    if _pool is None:
        return None
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_FLIGHT_LEG_COLUMNS} FROM flight_legs"
            f" WHERE icao24 = $1 AND arrived_at IS NULL ORDER BY departed_at DESC LIMIT 1",
            str(icao24),
        )
    return _flight_leg_dict(row) if row else None


# Positions as of one moment, measured from the last time we actually looked
# rather than from the moment asked for. `anchor` is that look: the newest
# recorded timestamp at or before `at`. Everything then hangs off it, which is
# what keeps the answer stable as the scrubber moves *between* polls -- read
# straight from `at`, a moment landing 25 minutes after the last poll returned
# only whatever happened to move in the 5 minutes before it, so the fleet
# thinned and refilled with every drag. The anchor is still required to be
# recent (see the HAVING), or a scrub into a stretch we never recorded would
# answer with an old snapshot dressed up as the present.
#
# Two stages on purpose as well: the inner DISTINCT ON runs entirely inside
# idx_history_entity (kind, entity_id, ts DESC) and touches no payload, so
# only the few thousand winning rows are read off the heap. Ranking payloads
# directly -- SELECT payload, ROW_NUMBER() OVER (PARTITION BY entity_id ...)
# over the whole kind -- made the planner sort every JSONB row in the window,
# which on a warm database (millions of ADSB rows over 3 days) took
# /api/replay past 30 seconds per scrub.
_HISTORY_AT = """
WITH anchor AS (
  SELECT max(ts) AS ts
    FROM entity_history
   WHERE kind = $1 AND ts <= $2 AND ts >= $2::timestamptz - $3::interval
)
SELECT h.payload
  FROM (
    SELECT DISTINCT ON (e.entity_id) e.id
      FROM entity_history e, anchor a
     WHERE e.kind = $1 AND a.ts IS NOT NULL
       AND e.ts <= a.ts AND e.ts >= a.ts - $3::interval
     ORDER BY e.entity_id, e.ts DESC
  ) latest
  JOIN entity_history h ON h.id = latest.id
"""


async def history_at(kind: str, at: float, window_seconds: int | None = None) -> list[dict]:
    """Where each entity was at `at` (unix seconds): its most recent recorded
    position at or before that moment, ignoring anything whose last fix is
    older than `window_seconds` -- by default config.REPLAY_WINDOW_SECONDS for
    that kind, falling back to its eviction window. Callers override it when
    the live layer draws a narrower window than the rows are kept for.

    That window is what makes this a *moment* rather than an accumulation.
    Without it the query answered "every entity ever recorded up to `at`", so
    scrubbing to yesterday drew 18k aircraft -- every plane seen in the
    preceding days, all at once, at whatever position it was last seen. It
    also does the disappearing act the scrubber is for: drag back past when a
    vessel was first heard and it goes, drag into a window it was live in and
    it returns, wherever it happens to be gone from now.

    Empty when nothing was recorded within the window before `at` -- either
    the timestamp predates the log or a poller was down across it. It used to
    fall back to each entity's earliest kept position, which meant every
    timestamp older than the log returned one identical payload: dragging
    across the whole left-hand side of the scrubber changed nothing on the
    map, because the answer really was the same bytes each time.
    """
    if _pool is None:
        return []
    when = datetime.fromtimestamp(at, tz=timezone.utc)
    window = timedelta(seconds=window_seconds or _replay_window(kind))
    async with _pool.acquire() as conn:
        rows = await conn.fetch(_HISTORY_AT, kind, when, window)
    return [json.loads(r["payload"]) for r in rows]


# Consecutive recorded positions for one kind, keeping only the pairs far apart
# in time. Written as a window function rather than pulled into Python because
# the input is every position ever recorded for the window -- millions of rows
# for AIS -- while the answer is a few dozen. LAG over (entity_id ORDER BY ts)
# is served directly by idx_history_entity.
#
# Note that entity_history only receives a row when an entity actually *moved*
# (see record_snapshot), which is what makes this meaningful: a stationary ship
# writes nothing, so a large ts difference means "we stopped hearing it", not
# "it sat still".
_POSITION_GAPS = """
WITH steps AS (
  SELECT entity_id, ts, lat, lon, payload,
         LAG(ts)      OVER w AS prev_ts,
         LAG(lat)     OVER w AS prev_lat,
         LAG(lon)     OVER w AS prev_lon,
         LAG(payload) OVER w AS prev_payload
    FROM entity_history
   WHERE kind = $1 AND ts >= $2
  WINDOW w AS (PARTITION BY entity_id ORDER BY ts)
)
SELECT entity_id, prev_ts, prev_lat, prev_lon, prev_payload, ts, lat, lon,
       EXTRACT(EPOCH FROM (ts - prev_ts)) AS gap_seconds
  FROM steps
 WHERE prev_ts IS NOT NULL
   AND EXTRACT(EPOCH FROM (ts - prev_ts)) >= $3
 ORDER BY gap_seconds DESC
 LIMIT $4
"""


async def position_gaps(
    kind: str, since: float, min_gap_seconds: float, limit: int = 500, prefer_replica: bool = False
) -> list[dict]:
    """Where an entity stopped reporting and later reappeared.

    Each row is the pair of positions either side of the silence, so a caller
    can say both where it went quiet and where it came back. `from_payload` is
    the full recorded payload of the fix immediately before the silence --
    speed, course, ship type, declared destination, whatever record_snapshot
    was given at that moment -- which is what lets a caller (see
    backend/sources/dark_vessels.py's reachability model) reason about "the
    last thing we knew before it went dark" rather than the hull's current
    state, which by the time this row exists already reflects whatever
    happened after it reappeared.

    The heaviest read in the system -- a self-join over entity_history's 15M
    rows -- and a lag-tolerant one (it reads AIS other producers wrote, never
    its own output), so the dark-vessel detector passes prefer_replica=True to
    take this scan off the write-heavy primary.
    """
    pool = _reader(prefer_replica)
    if pool is None:
        return []
    when = datetime.fromtimestamp(since, tz=timezone.utc)
    async with pool.acquire() as conn:
        rows = await conn.fetch(_POSITION_GAPS, kind, when, float(min_gap_seconds), int(limit))
    return [
        {
            "entity_id": r["entity_id"],
            "from_ts": r["prev_ts"].timestamp(),
            "from_lat": r["prev_lat"],
            "from_lon": r["prev_lon"],
            "from_payload": json.loads(r["prev_payload"]) if r["prev_payload"] else {},
            "to_ts": r["ts"].timestamp(),
            "to_lat": r["lat"],
            "to_lon": r["lon"],
            "gap_seconds": float(r["gap_seconds"]),
        }
        for r in rows
    ]


# Per-hull speed statistics immediately before a given moment, batched across
# many (entity_id, before_ts) pairs in one round trip rather than one query per
# vessel -- dark_vessels.py's reachability model needs this for up to
# MAX_GAP_RECORDS hulls every pass. `idx` carries the caller's own row number
# through the join and back out, because GROUP BY entity_id alone would merge
# two different `before_ts` windows for the same hull (a vessel with two
# separate gaps in the retained window) into one answer.
#
# The combined FROM unnest($a, $b, $c) AS t(...) form, matching
# _UPSERT_LATEST/_INSERT_HISTORY/_UPSERT_LANE_CELLS above rather than three
# independent unnest() calls in the SELECT list. Both forms actually pad a
# shorter array with NULLs on a length mismatch rather than raising -- that
# is not the reason to prefer this one. The reason is consistency: every
# other batched query in this file already writes it this way, and there is
# no cause for the next one written to have two idioms to choose between.
# Harmless either way today, since idx/ids/befores are all built from the
# same Python list in speed_stats_before below.
#
# The speed cast excludes AIS's own "not available" sentinel (102.3 kn, the
# raw SOG field's all-ones value) so a decoder that ever forwards it raw does
# not pull a hull's 95th-percentile speed up to a value nothing measured.
_SPEED_STATS_BEFORE = """
WITH targets AS (
  SELECT * FROM unnest($2::int[], $3::text[], $4::timestamptz[]) AS t(idx, entity_id, before_ts)
)
SELECT t.idx,
       percentile_cont($5) WITHIN GROUP (ORDER BY (h.payload->>'speed')::float) AS p,
       stddev_samp((h.payload->>'speed')::float) AS sd,
       count(*) AS n
  FROM targets t
  JOIN entity_history h
    ON h.kind = $1 AND h.entity_id = t.entity_id
   AND h.ts <= t.before_ts
   AND h.ts >= t.before_ts - ($6 * INTERVAL '1 second')
   AND h.payload->>'speed' IS NOT NULL
   AND h.payload->>'speed' ~ '^-?[0-9]+(\\.[0-9]+)?$'
   AND (h.payload->>'speed')::float < 102.3
 GROUP BY t.idx
"""


async def speed_stats_before(
    kind: str, targets: list[tuple[str, float]], lookback_seconds: float, pct: float
) -> list[dict | None]:
    """95th-percentile (or `pct`) speed, its sample stdev, and how many samples
    fed both -- one entry per `(entity_id, before_ts)` pair in `targets`, in
    the same order, over the `lookback_seconds` immediately before each
    `before_ts`. A caller zips this straight back onto the list it built
    `targets` from (see backend/sources/dark_vessels.py's `add_reachability`).

    None where nothing in entity_history matched at all -- a hull with no
    decoded speed reports in the window -- which is a different case from
    "matched, but not enough of them" (a real dict with a low `sample_count`),
    and the caller's own REACH_MIN_SPEED_SAMPLES threshold is what tells the
    two apart rather than this function silently treating them the same.
    """
    if _pool is None or not targets:
        return [None] * len(targets)
    idxs = list(range(len(targets)))
    ids = [str(t[0]) for t in targets]
    befores = [datetime.fromtimestamp(t[1], tz=timezone.utc) for t in targets]
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            _SPEED_STATS_BEFORE, kind, idxs, ids, befores, float(pct), float(lookback_seconds)
        )
    by_idx = {
        r["idx"]: {
            "p_kn": float(r["p"]) if r["p"] is not None else None,
            "stdev_kn": float(r["sd"]) if r["sd"] is not None else None,
            "sample_count": int(r["n"]),
        }
        for r in rows
    }
    return [by_idx.get(i) for i in idxs]


_HISTORY_SINCE_ID = """
SELECT id, entity_id, ts, lat, lon, payload
  FROM entity_history
 WHERE kind = $1 AND id > $2
 ORDER BY id
 LIMIT $3
"""


async def entity_history_since(kind: str, after_id: int, limit: int) -> list[dict]:
    """Every recorded position for `kind` with id > `after_id`, oldest first.

    The cursor read a refine job takes to derive something from the movement
    log without ever scanning it whole (see backend/refine/port_calls.py and
    the global constraint that entity_history -- 11 GB and rising -- is never
    read on a request path, and never read in one pass either). `id` is the
    table's own BIGSERIAL, so it is already the arrival order within one kind
    and a caller can persist the last id it saw as its high-water mark instead
    of tracking a timestamp, which a concurrent write near the boundary could
    duplicate or skip.

    `limit` is mandatory rather than defaulted: the caller owns the tradeoff
    between catching up fast and running one query short of a full scan, and a
    silent default here would hide which one a given job chose.
    """
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
        rows = await conn.fetch(_HISTORY_SINCE_ID, kind, int(after_id), int(limit))
    return [
        {
            "id": r["id"],
            "entity_id": r["entity_id"],
            "ts": r["ts"].timestamp(),
            "lat": r["lat"],
            "lon": r["lon"],
            "payload": json.loads(r["payload"]),
        }
        for r in rows
    ]


# One entity's recorded path, thinned to at most N points before it leaves the
# database.
#
# The thinning is here rather than in the caller, and that is the whole point of
# the query. entity_history is 5+ GB and 11M rows; the busiest single aircraft
# holds ~800 points over three days, but nothing about the shape of this table
# guarantees that for every kind -- satellites write a row every ten seconds
# each -- so an endpoint that fetched the rows and sliced them in Python would
# be one URL away from streaming a hundred thousand JSONB payloads out of the
# heap. Bucketing in SQL means the cap is enforced before any payload is read.
#
# Both stages ride idx_history_entity (kind, entity_id, ts DESC): the bounds CTE
# is an index-only min/max, and the outer scan is the same range again. The
# bucket is a floor over seconds, so DISTINCT ON takes the first fix in each time
# slice -- an even sample along the *clock*, not along the rows, which is what
# keeps a burst of reports from spending the whole budget on one minute.
#
# Bucketed relative to the track's own first fix rather than to the unix epoch.
# Absolute-epoch buckets are not aligned to t0, so a span of exactly N slices
# straddles N+1 of them and the query returned budget+1 points -- which quietly
# put MAX_TRACK_POINTS one over its own ceiling. Measuring from t0 makes the
# bucket index run 0..budget-1 by construction.
_ENTITY_TRACK = """
WITH bounds AS (
  SELECT min(ts) AS t0, max(ts) AS t1
    FROM entity_history
   WHERE kind = $1 AND entity_id = $2 AND ts >= $3
),
step AS (
  SELECT t0,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM (t1 - t0)) / $4::float))::bigint AS secs
    FROM bounds
   WHERE t0 IS NOT NULL
)
SELECT DISTINCT ON (bucket) ts, lat, lon, payload
  FROM (
    SELECT e.ts, e.lat, e.lon, e.payload,
           FLOOR(EXTRACT(EPOCH FROM (e.ts - s.t0)) / s.secs)::bigint AS bucket
      FROM entity_history e, step s
     WHERE e.kind = $1 AND e.entity_id = $2 AND e.ts >= $3
  ) sampled
 ORDER BY bucket, ts
"""

# A hard ceiling on what any caller can ask for, independent of the query
# parameter. 2000 points is already more than a polyline can usefully draw at
# any zoom -- past that the samples are closer together than a screen pixel.
MAX_TRACK_POINTS = 2000


async def entity_track(
    kind: str,
    entity_id: str,
    since: float,
    max_points: int = 800,
    fields: tuple[str, ...] = (),
) -> list[dict]:
    """One entity's recorded path, oldest first, at most `max_points` long.

    `fields` are payload keys to carry alongside each fix. Named by the caller
    rather than returning the whole payload: these rows are the full source
    record (see record_snapshot), and a 900-point track of complete ADS-B
    payloads is a megabyte of JSON to draw one line.

    Note what entity_history does and does not hold: a row is written only when
    an entity actually *moved* (see record_snapshot's moved-set), so a track is
    a record of movement rather than of reporting. A stationary aircraft
    contributes one point no matter how long it is heard for -- which is the
    same property position_gaps relies on, read the other way round.
    """
    if _pool is None:
        return []
    when = datetime.fromtimestamp(since, tz=timezone.utc)
    budget = max(2, min(int(max_points), MAX_TRACK_POINTS))
    async with _pool.acquire() as conn:
        rows = await conn.fetch(_ENTITY_TRACK, kind, str(entity_id), when, float(budget))
    track = []
    for r in rows:
        point = {"ts": r["ts"].timestamp(), "lat": r["lat"], "lon": r["lon"]}
        if fields:
            payload = json.loads(r["payload"])
            for key in fields:
                value = payload.get(key)
                if value is not None:
                    point[key] = value
        track.append(point)
    return track


# How busy each airfield has been, from the ADS-B movement log.
#
# adsb.py already resolves a nearest airfield for every aircraft below 10,000 ft
# or on the ground (see its proximity index), and that field has been written to
# every history row it appears on -- 2.07M of the last 24 hours' 5.1M rows -- and
# read by nothing. This turns it into "how much traffic has this field seen, and
# how much of it was military", which is the question the airfields layer exists
# to support and could not previously answer.
#
# Two statements rather than one, deliberately. The full per-field per-hour
# aggregate is 297k rows across 43,388 airfields -- most of them a single light
# aircraft that passed overhead once -- and transferring all of it to throw
# nearly all of it away is the expensive part, not the scan. So: totals first,
# pick which fields are worth an hourly series, then fetch series for those only.
_AIRFIELD_TOTALS = """
SELECT payload->'nearest_airfield'->>'code' AS code,
       max(payload->'nearest_airfield'->>'name') AS name,
       bool_or(COALESCE((payload->'nearest_airfield'->>'military_name')::boolean, false)) AS military_field,
       count(DISTINCT entity_id) AS aircraft,
       count(DISTINCT entity_id) FILTER (
         WHERE COALESCE((payload->>'military')::boolean, false)) AS military_aircraft
  FROM entity_history
 WHERE kind = 'adsb' AND ts >= $1
   AND payload ? 'nearest_airfield'
   AND payload->'nearest_airfield'->>'code' IS NOT NULL
 GROUP BY 1
"""

_AIRFIELD_HOURLY = """
SELECT payload->'nearest_airfield'->>'code' AS code,
       date_trunc('hour', ts) AS hour,
       count(DISTINCT entity_id) AS aircraft,
       count(DISTINCT entity_id) FILTER (
         WHERE COALESCE((payload->>'military')::boolean, false)) AS military
  FROM entity_history
 WHERE kind = 'adsb' AND ts >= $1
   AND payload->'nearest_airfield'->>'code' = ANY($2::text[])
 GROUP BY 1, 2
"""

# Task 29: which aircraft types actually made up a field's traffic, for the
# airfield-activity panel's "top aircraft types" column -- adsb.py already
# writes `type_code` (readsb's own ICAO type designator, e.g. "A320", "C130")
# onto every history row (see its own note on `t`/type_desc), and this is the
# first thing that reads it back. Scoped to the same `keep` set the hourly
# query above is, for the same reason: the full per-field per-type breakdown
# across 8,867 fields is exactly the "computed the whole world to throw away
# 97% of it" shape airfield_activity's own docstring already rejected for
# hourly.
_AIRFIELD_TYPES = """
SELECT payload->'nearest_airfield'->>'code' AS code,
       payload->>'type_code' AS type_code,
       count(DISTINCT entity_id) AS n
  FROM entity_history
 WHERE kind = 'adsb' AND ts >= $1
   AND payload->'nearest_airfield'->>'code' = ANY($2::text[])
   AND payload->>'type_code' IS NOT NULL
 GROUP BY 1, 2
"""

# How many of a field's most-seen types to keep. Three is enough to answer
# "what actually flies here" (a fighter type crowding out a field's usual
# trainers is visible at three) without turning every row of the panel into
# its own small table.
TOP_TYPES_PER_FIELD = 3


async def airfield_activity(
    since: float, hours: int = 24, top: int = 300, prefer_replica: bool = False
) -> dict:
    """Traffic per airfield over the recent ADS-B log, as one document.

    Ranked on two axes and capped on both: the `top` busiest fields by total
    traffic, and the `top` busiest by *military* traffic. The second list is the
    point of the whole aggregate -- a training field with sixty movements of
    which fifty-nine are military never enters the top 300 by volume, and
    ranking on volume alone would keep only a recitation of large civil
    airports.

    Ranking rather than a "has any military movement" filter, which is what this
    first did: one military aircraft passing overhead tags whichever field it
    was nearest, so that clause matched 8,703 of 8,867 fields and produced a
    2.8 MB document. A single overflight is not military activity at a field.

    Returns {code: {...}} rather than a list because every consumer looks a
    field up by the code its pin already carries (see sources/airports.py).

    prefer_replica routes both aggregates to the read replica for the refine job
    that computes this: they scan roughly five million ADS-B history rows written
    by other processes, and the answer is a 24-hour rolling count, so seconds of
    replication lag change nothing about it.
    """
    pool = _reader(prefer_replica)
    if pool is None:
        return {}
    when = datetime.fromtimestamp(since, tz=timezone.utc)
    async with pool.acquire() as conn:
        totals = await conn.fetch(_AIRFIELD_TOTALS, when)
        by_traffic = sorted(totals, key=lambda r: r["aircraft"], reverse=True)
        by_military = sorted(totals, key=lambda r: r["military_aircraft"], reverse=True)
        keep = {r["code"] for r in by_traffic[:top]}
        keep.update(r["code"] for r in by_military[:top] if r["military_aircraft"])
        if not keep:
            return {}
        hourly = await conn.fetch(_AIRFIELD_HOURLY, when, list(keep))
        types = await conn.fetch(_AIRFIELD_TYPES, when, list(keep))

    # Bucket index 0 is the oldest hour in the window, so the series reads
    # left-to-right as time -- the order a sparkline is drawn in.
    start = when.replace(minute=0, second=0, microsecond=0)
    series: dict[str, list[int]] = {}
    mil_series: dict[str, list[int]] = {}
    for r in hourly:
        idx = int((r["hour"] - start).total_seconds() // 3600)
        if not 0 <= idx < hours:
            continue
        series.setdefault(r["code"], [0] * hours)[idx] = r["aircraft"]
        mil_series.setdefault(r["code"], [0] * hours)[idx] = r["military"]

    # Per field, most-seen type first. Ties broken on the type code itself so
    # two runs over the same data always order a tie the same way, rather than
    # however Postgres happened to return the rows.
    by_code: dict[str, list] = {}
    for r in types:
        by_code.setdefault(r["code"], []).append(r)
    top_types: dict[str, list[dict]] = {
        code: [
            {"type_code": r["type_code"], "aircraft": r["n"]}
            for r in sorted(rows, key=lambda r: (-r["n"], r["type_code"]))[:TOP_TYPES_PER_FIELD]
        ]
        for code, rows in by_code.items()
    }

    out = {}
    for r in totals:
        code = r["code"]
        if code not in keep:
            continue
        out[code] = {
            "code": code,
            "name": r["name"],
            "military_field": r["military_field"],
            "aircraft": r["aircraft"],
            "military_aircraft": r["military_aircraft"],
            "hourly": series.get(code, [0] * hours),
            "window_hours": hours,
        }
        # Only carried where there is something to carry. Most kept fields are
        # busy civil airports with no military traffic at all, and shipping 300
        # arrays of twenty-four zeros to say so is a third of the document.
        mil_hourly = mil_series.get(code)
        if mil_hourly and any(mil_hourly):
            out[code]["hourly_military"] = mil_hourly
        # Same "only where there is something to carry" rule: a light aircraft
        # with no readsb-reported type code at all leaves this field's
        # top_types absent rather than an empty list.
        if top_types.get(code):
            out[code]["top_types"] = top_types[code]
    return out


async def entity_latest_with_times(kind: str, prefer_replica: bool = False) -> list[dict]:
    """entity_latest rows with their timestamps alongside the payload.

    `last_moved_at` is the field this exists for: it is how long an entity has
    been sitting still, which entity_latest maintains for free (see
    _UPSERT_LATEST) and which no amount of reading the payload can recover.

    prefer_replica routes to the read replica for the dark-vessel detector,
    which reads AIS it did not write and tolerates seconds of lag against an
    hours-long stillness window.
    """
    pool = _reader(prefer_replica)
    if pool is None:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT payload, updated_at, last_moved_at
                 FROM entity_latest WHERE kind = $1""",
            kind,
        )
    out = []
    for r in rows:
        payload = json.loads(r["payload"])
        payload["_updated_at"] = r["updated_at"].timestamp()
        payload["_last_moved_at"] = r["last_moved_at"].timestamp()
        out.append(payload)
    return out


async def source_health_series(
    source: str, since: float, prefer_replica: bool = False
) -> list[tuple[float, int | None, bool]]:
    """(timestamp, item_count, ok) per poll since `since`, oldest first.

    Read by the dark-vessel detector to tell "this ship switched its
    transponder off" from "our AIS feed dropped out", which look identical from
    a single ship's history. Routed to the replica alongside that detector's
    other reads (prefer_replica) so its whole read side leaves the primary.
    """
    pool = _reader(prefer_replica)
    if pool is None:
        return []
    when = datetime.fromtimestamp(since, tz=timezone.utc)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT ts, item_count, ok FROM source_health
                WHERE source = $1 AND ts >= $2 ORDER BY ts ASC""",
            source, when,
        )
    return [(r["ts"].timestamp(), r["item_count"], r["ok"]) for r in rows]


async def entity_latest(kind: str, order_by_recency: bool = False) -> list[dict]:
    if _pool is None:
        return []
    order = "last_moved_at DESC" if order_by_recency else "entity_id"
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT payload FROM entity_latest WHERE kind = $1 ORDER BY {order}", kind
        )
    return [json.loads(r["payload"]) for r in rows]


async def entity_latest_one(kind: str, entity_id: str) -> dict | None:
    """One entity's current entity_latest payload, or None if it isn't tracked.

    A single lookup on entity_latest's own primary key (kind, entity_id) --
    see the CREATE TABLE at the top of this module -- rather than the
    whole-kind scan entity_latest() above does. Task 17's vessel detail
    endpoint (and its port-card sibling) use this so opening one ship's card,
    or resolving one port_id to a name, costs one indexed row read rather
    than a fetch of every contact this map currently holds for that kind.
    """
    if _pool is None:
        return None
    async with _pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT payload FROM entity_latest WHERE kind = $1 AND entity_id = $2",
            kind, str(entity_id),
        )
    return json.loads(row["payload"]) if row else None


def _deleted_count(status: str) -> int:
    """Row count out of asyncpg's "DELETE n" command tag."""
    try:
        return int(status.rsplit(" ", 1)[1])
    except (IndexError, ValueError):
        return 0


async def sweep_stale_entities(conn, now: datetime) -> dict[str, int]:
    """Evicts rows past their kind's ENTITY_STALE_AFTER, whatever the producer is doing.

    record_snapshot() applies the same cutoff, but only as part of writing a
    poll -- and it returns early when a poll yields nothing, which is exactly
    the case where eviction matters. A source that dies leaves its last
    positions in entity_latest indefinitely: AIS stopped on 2026-08-05 and 839
    ships stayed on the map for 28 hours against a 30-minute window, with the
    dark-vessel detector still reading gaps out of them. The alert was right and
    active the whole time; nothing acted on it, because acting was the dead
    poller's job.

    So the cutoff is enforced from here too, on a loop that keeps running when
    every source is down. Kinds come from the table rather than from a list, so
    a kind that stops being produced is still swept -- a hand-maintained list
    would have the same blind spot as the poller.
    """
    evicted: dict[str, int] = {}
    kinds = [r["kind"] for r in await conn.fetch("SELECT DISTINCT kind FROM entity_latest")]
    for kind in kinds:
        status = await conn.execute(
            "DELETE FROM entity_latest WHERE kind = $1 AND updated_at < $2",
            kind, now - timedelta(seconds=_stale_after(kind)),
        )
        count = _deleted_count(status)
        if count:
            evicted[kind] = count
            # Same announcement a write makes. Without it the mirror keeps
            # serving the evicted rows until its fallback tick notices the
            # watermark moved -- correct eventually, but the whole point here is
            # that nothing else is going to speak for a dead source.
            await conn.execute("SELECT pg_notify($1, $2)", NOTIFY_CHANNEL, kind)
    return evicted


async def retention_sweep_loop() -> None:
    """Prunes each table by its own window. Postgres reclaims space via
    autovacuum, so unlike the SQLite version there's no WAL checkpoint to
    schedule here."""
    while True:
        await asyncio.sleep(600)
        if _pool is None:
            continue
        now = datetime.now(timezone.utc)
        try:
            async with _pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM entity_history WHERE ts < $1",
                    now - timedelta(seconds=config.HISTORY_RETENTION_SECONDS),
                )
                await conn.execute(
                    "DELETE FROM conflict_events WHERE last_seen < $1",
                    now - timedelta(days=config.CONFLICT_WATCH_RETENTION_DAYS),
                )
                await conn.execute(
                    "DELETE FROM source_health WHERE ts < $1",
                    now - timedelta(days=config.SOURCE_HEALTH_RETENTION_DAYS),
                )
                await conn.execute(
                    "DELETE FROM vessel_port_calls WHERE arrived_at < $1",
                    now - timedelta(days=config.PORT_CALL_RETENTION_DAYS),
                )
                await conn.execute(
                    "DELETE FROM flight_legs WHERE departed_at < $1",
                    now - timedelta(days=config.FLIGHT_LEG_RETENTION_DAYS),
                )
                # lane_cells is not time-pruned here: its own decay job (not
                # yet built) is what governs it, since a cell's relevance is a
                # function of how much traffic it still represents, not of
                # when it was last touched. See decay_lane_cells.
                evicted = await sweep_stale_entities(conn, now)
            if evicted:
                # Logged rather than silent: rows disappearing from a layer is
                # something you want to be able to point at afterwards, and for
                # a dead source this line is the only record that its last
                # positions were dropped rather than lost.
                log.info(
                    "Retention sweep evicted stale rows: %s",
                    ", ".join(f"{k} {n}" for k, n in sorted(evicted.items())),
                )
        except Exception:  # noqa: BLE001
            log.exception("Retention sweep failed")
