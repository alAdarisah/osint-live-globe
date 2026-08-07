"""One-shot import of the legacy SQLite store into Postgres.

    docker compose --profile migrate run --rm migrate
    # or, against a reachable database, from the repo root:
    DATABASE_URL=postgresql://... python -m backend.migrate_sqlite_to_postgres

Reads data/positions.db read-only and copies entity_latest, entity_history
and conflict_watch_events into the Postgres schema storage.py now owns.
Nothing is deleted -- the SQLite file is left exactly as it was, so this
stays a safe, repeatable operation with an obvious rollback.

Batched throughout: the history table is millions of rows (1.5 GB of DB at
the time this was written), so rows are streamed from SQLite a chunk at a
time and pushed with executemany rather than materialising the table in
memory. Every insert is ON CONFLICT DO NOTHING, so an interrupted run can
simply be re-run.

Translations along the way, since the two schemas aren't identical:
  * unix-float timestamps            -> TIMESTAMPTZ
  * payload TEXT                     -> JSONB
  * corroborated INTEGER             -> BOOLEAN
  * corroborated_by "a,b" TEXT       -> TEXT[]
  * conflict_watch_events            -> conflict_events (+ the mentions/
    goldstein/avg_tone/source_url columns added later, left NULL for rows
    that predate them)

Imported conflict rows keep pipeline_version NULL, which is both accurate --
they were produced by a pipeline that predates the field -- and load-bearing:
backend/escalation.py filters on an exact version, so an imported archive is
readable and queryable without ever being counted as present-day escalation.
"""

import argparse
import asyncio
import json
import logging
import sqlite3
import sys
from datetime import datetime, timezone

import asyncpg

from backend import config, storage

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("migrate")

BATCH = 10_000


def _ts(value):
    """SQLite stored these as unix floats; Postgres wants aware datetimes."""
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def _date(value):
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _count(conn: sqlite3.Connection, table: str) -> int:
    return conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


async def _copy(pg: asyncpg.Connection, sqlite_conn: sqlite3.Connection, table: str,
                select_sql: str, insert_sql: str, row_mapper, total: int) -> int:
    """Streams one SQLite table into Postgres in BATCH-sized chunks."""
    cursor = sqlite_conn.execute(select_sql)
    copied = 0
    while True:
        rows = cursor.fetchmany(BATCH)
        if not rows:
            break
        mapped = [m for m in (row_mapper(r) for r in rows) if m is not None]
        if mapped:
            await pg.executemany(insert_sql, mapped)
        copied += len(rows)
        log.info("  %s: %d/%d", table, copied, total)
    return copied


async def migrate(skip_history: bool, conflict_only: bool = False) -> int:
    db_path = config.DATA_DIR / "positions.db"
    if not db_path.exists():
        log.info("No SQLite database at %s -- nothing to migrate.", db_path)
        return 0

    sqlite_conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    pg = await asyncpg.connect(config.DATABASE_URL)
    try:
        # Same DDL the app itself applies at startup, so this script can run
        # against a completely fresh database before the backend ever boots.
        await pg.execute(storage._SCHEMA)

        if conflict_only:
            log.info("entity_latest: skipped (--conflict-only)")
        elif _table_exists(sqlite_conn, "entity_latest"):
            total = _count(sqlite_conn, "entity_latest")
            log.info("entity_latest: %d rows", total)
            await _copy(
                pg, sqlite_conn, "entity_latest",
                "SELECT kind, entity_id, lat, lon, payload, updated_at, last_moved_at FROM entity_latest",
                """INSERT INTO entity_latest
                     (kind, entity_id, lat, lon, payload, updated_at, last_moved_at)
                   VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
                   ON CONFLICT (kind, entity_id) DO NOTHING""",
                lambda r: (r[0], str(r[1]), r[2], r[3], r[4], _ts(r[5]), _ts(r[6])),
                total,
            )

        if skip_history or conflict_only:
            log.info("entity_history: skipped (%s)",
                     "--conflict-only" if conflict_only else "--skip-history")
        elif _table_exists(sqlite_conn, "entity_history"):
            total = _count(sqlite_conn, "entity_history")
            log.info("entity_history: %d rows (this is the slow one)", total)
            await _copy(
                pg, sqlite_conn, "entity_history",
                "SELECT kind, entity_id, ts, lat, lon, payload FROM entity_history",
                """INSERT INTO entity_history (kind, entity_id, ts, lat, lon, payload)
                   VALUES ($1,$2,$3,$4,$5,$6::jsonb)""",
                lambda r: (r[0], str(r[1]), _ts(r[2]), r[3], r[4], r[5]),
                total,
            )

        if _table_exists(sqlite_conn, "conflict_watch_events"):
            total = _count(sqlite_conn, "conflict_watch_events")
            log.info("conflict_watch_events -> conflict_events: %d rows", total)
            await _copy(
                pg, sqlite_conn, "conflict_watch_events",
                """SELECT id, date, lat, lon, event_type, sub_event_type, actor1, actor2,
                          fatalities, country, notes, source, corroborated, corroborated_by,
                          first_seen, last_seen
                     FROM conflict_watch_events""",
                """INSERT INTO conflict_events
                     (id, date, lat, lon, event_type, sub_event_type, actor1, actor2,
                      fatalities, country, notes, source, corroborated, corroborated_by,
                      first_seen, last_seen)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                   ON CONFLICT (id) DO NOTHING""",
                lambda r: (
                    str(r[0]), _date(r[1]), r[2], r[3], r[4], r[5], r[6], r[7],
                    int(r[8] or 0), r[9], r[10], r[11], bool(r[12]),
                    [s for s in (r[13] or "").split(",") if s],
                    _ts(r[14]), _ts(r[15]),
                ),
                total,
            )

        latest = await pg.fetchval("SELECT count(*) FROM entity_latest")
        history = await pg.fetchval("SELECT count(*) FROM entity_history")
        events = await pg.fetchval("SELECT count(*) FROM conflict_events")
        log.info("Done. Postgres now holds %d entity_latest, %d entity_history, %d conflict_events",
                 latest, history, events)
        return 0
    finally:
        await pg.close()
        sqlite_conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-history",
        action="store_true",
        help="copy entity_latest + conflict events only, leaving the multi-million-row movement log behind",
    )
    parser.add_argument(
        "--conflict-only",
        action="store_true",
        help=(
            "copy the conflict archive and nothing else. Use this when the live database has "
            "moved on: the SQLite entity_latest holds positions from whenever collection stopped, "
            "and importing them puts hours-old ships and aircraft back on the map until eviction "
            "catches them. The conflict rows have no such problem -- they carry their own dates."
        ),
    )
    args = parser.parse_args()
    return asyncio.run(migrate(args.skip_history, args.conflict_only))


if __name__ == "__main__":
    sys.exit(main())
