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


async def close_pool() -> None:
    global _pool
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


async def record_reference(name: str, payload) -> None:
    """Stores a whole-document source (countries GeoJSON, HDX series dict).

    These have no per-row lat/lon to snapshot -- they're one big document
    that's replaced wholesale on each refresh, so they get their own table
    rather than being forced into entity_latest's point shape.
    """
    if _pool is None or payload is None:
        return
    try:
        async with _pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO reference_snapshots (name, payload, updated_at)
                   VALUES ($1, $2::jsonb, $3)
                   ON CONFLICT (name) DO UPDATE SET
                     payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at""",
                name, json.dumps(payload, default=str), datetime.now(timezone.utc),
            )
    except Exception:  # noqa: BLE001
        log.exception("Failed to record reference snapshot %r", name)


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
  SELECT entity_id, ts, lat, lon,
         LAG(ts)  OVER w AS prev_ts,
         LAG(lat) OVER w AS prev_lat,
         LAG(lon) OVER w AS prev_lon
    FROM entity_history
   WHERE kind = $1 AND ts >= $2
  WINDOW w AS (PARTITION BY entity_id ORDER BY ts)
)
SELECT entity_id, prev_ts, prev_lat, prev_lon, ts, lat, lon,
       EXTRACT(EPOCH FROM (ts - prev_ts)) AS gap_seconds
  FROM steps
 WHERE prev_ts IS NOT NULL
   AND EXTRACT(EPOCH FROM (ts - prev_ts)) >= $3
 ORDER BY gap_seconds DESC
 LIMIT $4
"""


async def position_gaps(kind: str, since: float, min_gap_seconds: float, limit: int = 500) -> list[dict]:
    """Where an entity stopped reporting and later reappeared.

    Each row is the pair of positions either side of the silence, so a caller
    can say both where it went quiet and where it came back.
    """
    if _pool is None:
        return []
    when = datetime.fromtimestamp(since, tz=timezone.utc)
    async with _pool.acquire() as conn:
        rows = await conn.fetch(_POSITION_GAPS, kind, when, float(min_gap_seconds), int(limit))
    return [
        {
            "entity_id": r["entity_id"],
            "from_ts": r["prev_ts"].timestamp(),
            "from_lat": r["prev_lat"],
            "from_lon": r["prev_lon"],
            "to_ts": r["ts"].timestamp(),
            "to_lat": r["lat"],
            "to_lon": r["lon"],
            "gap_seconds": float(r["gap_seconds"]),
        }
        for r in rows
    ]


async def entity_latest_with_times(kind: str) -> list[dict]:
    """entity_latest rows with their timestamps alongside the payload.

    `last_moved_at` is the field this exists for: it is how long an entity has
    been sitting still, which entity_latest maintains for free (see
    _UPSERT_LATEST) and which no amount of reading the payload can recover.
    """
    if _pool is None:
        return []
    async with _pool.acquire() as conn:
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


async def source_health_series(source: str, since: float) -> list[tuple[float, int | None, bool]]:
    """(timestamp, item_count, ok) per poll since `since`, oldest first.

    Read by the dark-vessel detector to tell "this ship switched its
    transponder off" from "our AIS feed dropped out", which look identical from
    a single ship's history.
    """
    if _pool is None:
        return []
    when = datetime.fromtimestamp(since, tz=timezone.utc)
    async with _pool.acquire() as conn:
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
        except Exception:  # noqa: BLE001
            log.exception("Retention sweep failed")
