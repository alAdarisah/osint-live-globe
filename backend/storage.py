"""Durable SQLite-backed position storage for ships (AIS) and aircraft
(ADS-B), sitting behind history.py's replay buffers. The live layer
(registry.get("ais"/"adsb").data, served by /api/ships and /api/aircraft)
stays exactly as it was -- an in-memory "what's on the map right now" list.
This module is the separate "where has it been" store: every live snapshot
gets written here too, deduped against the last known position so a
stationary ship reporting the same lat/lon every 5s doesn't bloat the
movement log, with per-kind stale eviction and time-based retention so
neither table grows without bound.

Two tables, matching the "keep only latest valid position for inactive
entities" vs "movement history separate from live layer" split:
  entity_latest  -- one row per (kind, entity_id), always current.
  entity_history -- append-only, one row per position *change*, pruned by
                    retention_sweep_loop().

stdlib sqlite3 only, WAL mode (readers -- /api/replay -- don't block the
writer, and vice versa). A single writer connection is reused for the
process lifetime, serialized by _write_lock since sqlite3 connections
aren't safe for concurrent use from multiple threads/tasks at once; every
call into it runs off the event loop via asyncio.to_thread. Reads use a
short-lived connection per call -- cheap at this data volume and avoids any
contention on the writer connection.
"""

import asyncio
import json
import logging
import sqlite3
import time

from backend import config

log = logging.getLogger("osint-globe.storage")

# ~1m of latitude/longitude at the equator -- fine enough that genuine drift
# (even a slowly drifting anchored ship) counts as movement, coarse enough
# that GPS/decoder jitter on a truly stationary entity doesn't.
_COORD_EPSILON = 0.00001

_write_lock = asyncio.Lock()
_conn: sqlite3.Connection | None = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS entity_latest (
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  payload TEXT NOT NULL,
  updated_at REAL NOT NULL,
  last_moved_at REAL NOT NULL,
  PRIMARY KEY (kind, entity_id)
);
CREATE TABLE IF NOT EXISTS entity_history (
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  ts REAL NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_lookup ON entity_history(kind, ts);
CREATE INDEX IF NOT EXISTS idx_history_entity ON entity_history(kind, entity_id, ts);
"""


def _connect() -> sqlite3.Connection:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DATA_DIR / "positions.db", check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


def _writer() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = _connect()
    return _conn


def _stale_after(kind: str) -> int:
    return config.AIS_STALE_AFTER if kind == "ais" else config.ADSB_STALE_AFTER


def _record_snapshot_sync(kind: str, items: list[dict], id_field: str) -> None:
    conn = _writer()
    now = time.time()
    cur = conn.cursor()
    cur.execute("BEGIN")
    try:
        for item in items:
            raw_id = item.get(id_field)
            if raw_id is None:
                continue
            entity_id = str(raw_id)
            lat, lon = item.get("lat"), item.get("lon")
            if lat is None or lon is None:
                continue
            payload = json.dumps(item)

            row = cur.execute(
                "SELECT lat, lon, last_moved_at FROM entity_latest WHERE kind=? AND entity_id=?",
                (kind, entity_id),
            ).fetchone()

            if row is not None:
                prev_lat, prev_lon, prev_moved_at = row
                moved = abs(prev_lat - lat) > _COORD_EPSILON or abs(prev_lon - lon) > _COORD_EPSILON
                last_moved_at = now if moved else prev_moved_at
            else:
                moved = True
                last_moved_at = now

            cur.execute(
                """INSERT INTO entity_latest (kind, entity_id, lat, lon, payload, updated_at, last_moved_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(kind, entity_id) DO UPDATE SET
                     lat=excluded.lat, lon=excluded.lon, payload=excluded.payload,
                     updated_at=excluded.updated_at, last_moved_at=excluded.last_moved_at""",
                (kind, entity_id, lat, lon, payload, now, last_moved_at),
            )

            if moved:
                cur.execute(
                    "INSERT INTO entity_history (kind, entity_id, ts, lat, lon, payload) VALUES (?, ?, ?, ?, ?, ?)",
                    (kind, entity_id, now, lat, lon, payload),
                )

        cutoff = now - _stale_after(kind)
        cur.execute("DELETE FROM entity_latest WHERE kind=? AND updated_at < ?", (kind, cutoff))

        conn.commit()
    except Exception:
        conn.rollback()
        raise


async def record_snapshot(kind: str, items: list[dict], id_field: str) -> None:
    async with _write_lock:
        await asyncio.to_thread(_record_snapshot_sync, kind, items, id_field)


def _history_at_sync(kind: str, at: float) -> list[dict]:
    conn = sqlite3.connect(config.DATA_DIR / "positions.db", check_same_thread=False)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        rows = conn.execute(
            """
            SELECT payload FROM (
              SELECT payload, ts,
                     ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY ts DESC) AS rn
              FROM entity_history
              WHERE kind = ? AND ts <= ?
            ) WHERE rn = 1
            """,
            (kind, at),
        ).fetchall()

        if not rows:
            # `at` predates everything we've kept -- fall back to each
            # entity's earliest known position, same as the old in-memory
            # HistoryBuffer's "falls back to the oldest kept snapshot".
            rows = conn.execute(
                """
                SELECT payload FROM (
                  SELECT payload, ts,
                         ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY ts ASC) AS rn
                  FROM entity_history
                  WHERE kind = ?
                ) WHERE rn = 1
                """,
                (kind,),
            ).fetchall()

        return [json.loads(r[0]) for r in rows]
    finally:
        conn.close()


async def history_at(kind: str, at: float) -> list[dict]:
    return await asyncio.to_thread(_history_at_sync, kind, at)


def _entity_latest_sync(kind: str, order_by_recency: bool) -> list[dict]:
    conn = sqlite3.connect(config.DATA_DIR / "positions.db", check_same_thread=False)
    try:
        order = "last_moved_at DESC" if order_by_recency else "entity_id"
        rows = conn.execute(
            f"SELECT payload FROM entity_latest WHERE kind = ? ORDER BY {order}", (kind,)
        ).fetchall()
        return [json.loads(r[0]) for r in rows]
    finally:
        conn.close()


async def entity_latest(kind: str, order_by_recency: bool = False) -> list[dict]:
    return await asyncio.to_thread(_entity_latest_sync, kind, order_by_recency)


def _retention_sweep_sync(checkpoint: bool) -> None:
    conn = _writer()
    cutoff = time.time() - config.HISTORY_RETENTION_SECONDS
    conn.execute("DELETE FROM entity_history WHERE ts < ?", (cutoff,))
    conn.commit()
    if checkpoint:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")


async def retention_sweep_loop() -> None:
    sweep_count = 0
    while True:
        await asyncio.sleep(600)
        async with _write_lock:
            # WAL checkpointing is a bigger operation than a plain DELETE --
            # only worth doing roughly once/hour, not on every 600s sweep.
            sweep_count += 1
            checkpoint = sweep_count % 6 == 0
            try:
                await asyncio.to_thread(_retention_sweep_sync, checkpoint)
            except Exception:
                log.exception("Retention sweep failed")
