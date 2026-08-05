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
                        all (countries GeoJSON, HDX country->month series).
  source_health      -- one row per poll outcome, per source.

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
  corroboration, event_code, ingested_at, pipeline_version, first_seen, last_seen
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20,$21,$22,$23,$24,$25,$26,$27,$27)
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
        item_id = item.get("id")
        lat, lon = item.get("lat"), item.get("lon")
        if item_id is None or lat is None or lon is None:
            continue
        rows.append((
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
            now,
        ))
    if not rows:
        return
    try:
        async with _pool.acquire() as conn:
            async with conn.transaction():
                await conn.executemany(_UPSERT_CONFLICT, rows)
    except Exception:  # noqa: BLE001
        log.exception("Failed to record %d conflict events", len(rows))


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


async def history_at(kind: str, at: float) -> list[dict]:
    """Nearest recorded position at-or-before `at` (unix seconds), per entity."""
    if _pool is None:
        return []
    when = datetime.fromtimestamp(at, tz=timezone.utc)
    async with _pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT payload FROM (
              SELECT payload, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY ts DESC) AS rn
                FROM entity_history
               WHERE kind = $1 AND ts <= $2
            ) ranked WHERE rn = 1
            """,
            kind, when,
        )
        if not rows:
            # `at` predates everything kept -- fall back to each entity's
            # earliest known position, same as the old in-memory buffer's
            # "falls back to the oldest kept snapshot".
            rows = await conn.fetch(
                """
                SELECT payload FROM (
                  SELECT payload, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY ts ASC) AS rn
                    FROM entity_history WHERE kind = $1
                ) ranked WHERE rn = 1
                """,
                kind,
            )
    return [json.loads(r["payload"]) for r in rows]


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
